import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { buildRepoModel } from "../envrepo/model";
import { discoverEnvRepo } from "../envrepo/discovery";
import { resolvePlan } from "../envrepo/resolver";
import { loadPlugin } from "../plugins/loader";
import { computeNextVersionSuggestion, readPackageMetadata } from "../deploy/runtime";
import {
  EnvHeavenStateStore,
  incrementPatchVersion,
  isValidVersionString,
  type ArtifactVersionRecord,
  type RepoStateRecord,
} from "../state/store";
import type { RepoModel, SupportedTarget } from "../types";

const SUPPORTED_TARGETS: SupportedTarget[] = ["default", "local", "local-01", "fake-local", "fake-local-01"];

interface ParsedRequestBody {
  [key: string]: unknown;
}

type DaemonEvent =
  | {
      type: "repo:selected";
      selectedRepo: RepoStateRecord | null;
      repoRoot: string;
    }
  | {
      type: "version:set" | "version:incremented";
      repoRoot: string;
      record: ArtifactVersionRecord;
    };

export async function startDaemon(
  rootDirectory: string,
  port = 0,
  stateStore = new EnvHeavenStateStore(),
): Promise<http.Server> {
  const normalizedRootDirectory = path.resolve(rootDirectory);
  await stateStore.rememberRepo(normalizedRootDirectory);
  let selectedRepoRoot = normalizedRootDirectory;
  const repoModelCache = new Map<string, RepoModel>();
  const webSocketClients = new Set<WebSocket>();

  const ensureRepoModel = async (repoRoot = selectedRepoRoot): Promise<RepoModel> => {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const cached = repoModelCache.get(normalizedRepoRoot);
    if (cached) {
      return cached;
    }

    const discovery = await discoverEnvRepo(normalizedRepoRoot);
    const repoModel = buildRepoModel(discovery);
    repoModelCache.set(normalizedRepoRoot, repoModel);
    return repoModel;
  };

  const webSocketServer = new WebSocketServer({ noServer: true });
  webSocketServer.on("connection", (socket: WebSocket) => {
    webSocketClients.add(socket);
    socket.on("close", () => {
      webSocketClients.delete(socket);
    });
  });

  const broadcastEvent = (event: DaemonEvent): void => {
    const payload = JSON.stringify(event);
    for (const client of webSocketClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 404, { error: "Missing request URL." });
        return;
      }

      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, 200, buildLandingPage());
        return;
      }

      if (request.method === "GET" && url.pathname === "/repo/discovery") {
        const repoModel = await ensureRepoModel();
        sendJson(response, 200, repoModel.discovery);
        return;
      }

      if (request.method === "GET" && url.pathname === "/plugin/status") {
        const repoModel = await ensureRepoModel();
        const statuses = await Promise.all(
          SUPPORTED_TARGETS.map(async (target) => {
            const plan = resolvePlan(repoModel, target);
            if (!plan.pluginPackage) {
              return {
                target,
                pluginPackage: null,
                diagnostics: plan.diagnostics,
              };
            }

            const plugin = await loadPlugin(plan.pluginPackage, selectedRepoRoot);
            return {
              target,
              pluginPackage: plan.pluginPackage,
              resolvedPath: plugin.resolvedPath,
              diagnostics: [...plan.diagnostics, ...plugin.diagnostics],
            };
          }),
        );

        sendJson(response, 200, { targets: statuses });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/plans/")) {
        const target = url.pathname.replace("/plans/", "") as SupportedTarget;
        if (!SUPPORTED_TARGETS.includes(target)) {
          sendJson(response, 404, { error: `Unsupported target "${target}".` });
          return;
        }

        const repoModel = await ensureRepoModel();
        sendJson(response, 200, resolvePlan(repoModel, target));
        return;
      }

      if (url.pathname === "/api/status" && request.method === "GET") {
        const repoModel = await ensureRepoModel();
        const address = server.address();
        const daemonPort = typeof address === "object" && address ? address.port : null;
        const selectedRepo = await stateStore.getSelectedRepo(selectedRepoRoot);
        const daemonUrls = daemonPort === null ? [] : buildUrlList(daemonPort, "http");
        const wsUrls = daemonPort === null ? [] : buildUrlList(daemonPort, "ws", "/ws");
        sendJson(response, 200, {
          ok: true,
          daemon: {
            port: daemonPort,
            repoRoot: selectedRepoRoot,
          },
          daemonUrls,
          daemonUrl: daemonUrls[0] ?? null,
          wsUrls,
          wsUrl: wsUrls[0] ?? null,
          selectedRepo,
          repoDiagnostics: repoModel.diagnostics,
          commands: [
            "envheaven",
            "envheaven offiline-web-ui",
            "envheaven deploy local",
            "envheaven deploy development",
            "envheaven deploy beta",
            "envheaven deploy production",
          ],
          features: [
            "env-repo discovery",
            "deploy planning",
            "artifact version registry",
            "dynamic-artifact-version resolution",
            "offline UI support",
          ],
          plugins: Object.values(repoModel.artifacts).map((artifact) => artifact.PackageName ?? artifact.packageName).filter(Boolean),
        });
        return;
      }

      if (url.pathname === "/api/repos" && request.method === "GET") {
        const repos = await stateStore.listRepos();
        const selectedRepo = await stateStore.getSelectedRepo(selectedRepoRoot);
        sendJson(response, 200, {
          selectedRepoId: selectedRepo?.repoId ?? null,
          selectedRepoRoot,
          repos,
        });
        return;
      }

      if (url.pathname === "/api/repos/select" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const requestedRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!requestedRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }

        const discovery = await discoverEnvRepo(requestedRepoRoot);
        const repoModel = buildRepoModel(discovery);
        if (repoModel.diagnostics.some((diagnostic) => diagnostic.code === "base-layer-missing")) {
          sendJson(response, 400, { error: `No valid EnvHeaven repo was found at "${requestedRepoRoot}".`, diagnostics: repoModel.diagnostics });
          return;
        }

        selectedRepoRoot = requestedRepoRoot;
        repoModelCache.set(requestedRepoRoot, repoModel);
        const selectedRepo = await stateStore.setSelectedRepo(requestedRepoRoot);
        broadcastEvent({
          type: "repo:selected",
          selectedRepo,
          repoRoot: selectedRepoRoot,
        });
        sendJson(response, 200, {
          ok: true,
          selectedRepo,
        });
        return;
      }

      if (url.pathname === "/api/versions" && request.method === "GET") {
        const repoModel = await ensureRepoModel();
        const versions = await buildVersionPayload(repoModel, selectedRepoRoot, stateStore);
        sendJson(response, 200, {
          repoRoot: selectedRepoRoot,
          versions,
        });
        return;
      }

      if (url.pathname === "/api/versions/set" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const artifactName = typeof payload.artifactName === "string" ? payload.artifactName : "";
        const packageName = typeof payload.packageName === "string" ? payload.packageName : undefined;
        const nextVersion = typeof payload.nextVersion === "string" ? payload.nextVersion.trim() : undefined;
        const lastVersion = typeof payload.lastVersion === "string" ? payload.lastVersion.trim() : undefined;

        if (!artifactName) {
          sendJson(response, 400, { error: "artifactName is required." });
          return;
        }

        if ((nextVersion && !isValidVersionString(nextVersion)) || (lastVersion && !isValidVersionString(lastVersion))) {
          sendJson(response, 400, { error: "lastVersion and nextVersion must be valid semantic versions." });
          return;
        }

        const updated = await stateStore.setArtifactVersion(selectedRepoRoot, artifactName, packageName, {
          lastVersion,
          nextVersion,
        });
        broadcastEvent({
          type: "version:set",
          repoRoot: selectedRepoRoot,
          record: updated,
        });
        sendJson(response, 200, { ok: true, record: updated });
        return;
      }

      if (url.pathname === "/api/versions/increment" && request.method === "POST") {
        const payload = await readJsonBody(request);
        const artifactName = typeof payload.artifactName === "string" ? payload.artifactName : "";
        const packageName = typeof payload.packageName === "string" ? payload.packageName : undefined;
        const baseVersion = typeof payload.baseVersion === "string" ? payload.baseVersion : undefined;
        if (!artifactName) {
          sendJson(response, 400, { error: "artifactName is required." });
          return;
        }

        const record = await stateStore.incrementArtifactNextVersion(selectedRepoRoot, artifactName, packageName, baseVersion);
        broadcastEvent({
          type: "version:incremented",
          repoRoot: selectedRepoRoot,
          record,
        });
        sendJson(response, 200, { ok: true, record });
        return;
      }

      sendJson(response, 404, { error: "Unknown endpoint." });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown daemon error.",
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== "/ws") {
        socket.destroy();
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, (client: WebSocket) => {
        webSocketServer.emit("connection", client, request);
      });
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve());
  });

  server.on("close", () => {
    webSocketServer.close();
  });

  return server;
}

async function buildVersionPayload(
  repoModel: RepoModel,
  repoRoot: string,
  stateStore: EnvHeavenStateStore,
): Promise<Array<Record<string, unknown>>> {
  const records = await stateStore.getVersionRecords(repoRoot);
  const recordByArtifact = new Map<string, ArtifactVersionRecord>(records.map((record) => [record.artifactName, record]));

  return await Promise.all(
    Object.entries(repoModel.artifacts)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(async ([artifactName, artifactValue]) => {
        const rawPackageName = artifactValue.PackageName ?? artifactValue.packageName;
        const rawRepoCloneFolderPath = artifactValue.RepoCloneFolderPath ?? artifactValue.repoCloneFolderPath;
        const packageName = typeof rawPackageName === "string" ? rawPackageName : undefined;
        const repoCloneFolderPath =
          typeof rawRepoCloneFolderPath === "string" ? path.resolve(repoRoot, rawRepoCloneFolderPath) : undefined;
        const registryRecord = recordByArtifact.get(artifactName);

        let packageVersion: string | undefined;
        if (repoCloneFolderPath) {
          try {
            packageVersion = (await readPackageMetadata(repoCloneFolderPath)).version;
          } catch {
            packageVersion = undefined;
          }
        }

        return {
          artifactName,
          packageName,
          repoCloneFolderPath,
          packageVersion,
          lastVersion: registryRecord?.lastVersion,
          nextVersion: registryRecord?.nextVersion ?? packageVersion ?? incrementPatchVersion("0.1.0"),
          suggestedNextVersion: computeNextVersionSuggestion(registryRecord?.nextVersion ?? registryRecord?.lastVersion ?? packageVersion ?? "0.1.0"),
        };
      }),
  );
}

async function readJsonBody(request: http.IncomingMessage): Promise<ParsedRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (rawBody.length === 0) {
    return {};
  }

  return JSON.parse(rawBody) as ParsedRequestBody;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: http.ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function buildLandingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>EnvHeaven Daemon</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Segoe UI", sans-serif;
      }
      body {
        margin: 2rem;
        line-height: 1.5;
      }
      h1 {
        margin-bottom: 0.5rem;
      }
      ul {
        padding-left: 1.25rem;
      }
      code {
        background: #f3f4f6;
        padding: 0.1rem 0.3rem;
      }
    </style>
  </head>
  <body>
    <h1>EnvHeaven Daemon</h1>
    <p>Daemon status: running.</p>
    <p>Tip: run <code>envheaven offiline-web-ui</code> to install and launch the offline UI.</p>
    <p>JSON endpoints:</p>
    <ul>
      <li><a href="/api/status">/api/status</a></li>
      <li><a href="/api/repos">/api/repos</a></li>
      <li><a href="/api/versions">/api/versions</a></li>
      <li><a href="/repo/discovery">/repo/discovery</a></li>
      <li><a href="/plugin/status">/plugin/status</a></li>
      <li><a href="/plans/default">/plans/default</a></li>
      <li><a href="/plans/local">/plans/local</a></li>
      <li><a href="/plans/local-01">/plans/local-01</a></li>
      <li><a href="/plans/fake-local">/plans/fake-local</a></li>
      <li><a href="/plans/fake-local-01">/plans/fake-local-01</a></li>
    </ul>
    <p>Use <code>envheaven deploy local</code>, <code>envheaven deploy development</code>, <code>envheaven deploy beta</code>, or <code>envheaven deploy production</code> from the repo root for deploy workflows.</p>
  </body>
</html>`;
}

function buildUrlList(port: number, protocol: "http" | "ws", pathname = ""): string[] {
  const urls = [
    `${protocol}://localhost:${String(port)}${pathname}`,
    `${protocol}://127.0.0.1:${String(port)}${pathname}`,
  ];
  const lanIp = getLanIp();
  if (lanIp) {
    urls.push(`${protocol}://${lanIp}:${String(port)}${pathname}`);
  }

  return [...new Set(urls)];
}

function getLanIp(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }

  return null;
}
