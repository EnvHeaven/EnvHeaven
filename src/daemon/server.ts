import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
type NodePty = typeof import("node-pty");
let _pty: NodePty | undefined;
async function loadPty(): Promise<NodePty> {
  if (!_pty) {
    _pty = await import("node-pty");
  }
  return _pty;
}
import { buildRepoModel } from "../envrepo/model";
import { discoverEnvRepo } from "../envrepo/discovery";
import { resolvePlan } from "../envrepo/resolver";
import { loadPlugin } from "../plugins/loader";
import { computeNextVersionSuggestion, readPackageMetadata } from "../deploy/runtime";
import {
  EnvHeavenStateStore,
  incrementPatchVersion,
  incrementMinorVersion,
  incrementExpVersion,
  isValidVersionString,
  type ArtifactVersionRecord,
  type RepoStateRecord,
} from "../state/store";
import { loadActions, saveAction, deleteAction, moveAction, loadActionOrder, saveActionOrder, loadArtifactMeta, saveArtifactMeta, normalizePageHeaderOptions, type ActionDefinition } from "../actions/loader";
import { loadPinnedArtifactIds, savePinnedArtifactIds } from "../local-user/preferences";
import type { RepoModel, SupportedTarget } from "../types";

const SUPPORTED_TARGETS: SupportedTarget[] = ["default", "local", "local-01", "fake-local", "fake-local-01"];

interface ParsedRequestBody {
  [key: string]: unknown;
}

export interface DaemonWsEvent {
  type: string;
  payload: unknown;
}

interface ActionRun {
  runId: string;
  actionId: string;
  repoRoot: string;
  startedAt: string;
  status: "running" | "success" | "error" | "stopped";
  exitCode: number | null;
  lines: Array<{ stream: "stdout" | "stderr" | "system"; data: string; ts: string }>;
  sseClients: Set<http.ServerResponse>;
  helpers: ActionDefinition["successHelpers"];
  process: ReturnType<typeof spawn> | null;
}

const MAX_PTY_REPLAY_BYTES = 2 * 1024 * 1024;
const MAX_COMPLETED_RUNS = 50;

interface PtyRun {
  runId: string;
  actionId: string;
  repoRoot: string;
  startedAt: string;
  status: "running" | "success" | "error" | "stopped";
  exitCode: number | null;
  helpers: ActionDefinition["successHelpers"];
  ptyProcess: import("node-pty").IPty | null;
  wsClients: Set<WebSocket>;
  replayBuffer: string[];
  replayBytes: number;
}

function readOwnPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export async function startDaemon(
  rootDirectory: string,
  port = 0,
  stateStore = new EnvHeavenStateStore(),
  daemonVersion?: string,
): Promise<{ server: http.Server; killAllRuns: () => void }> {
  const resolvedDaemonVersion = daemonVersion ?? readOwnPackageVersion();
  const normalizedRootDirectory = path.resolve(rootDirectory);
  await stateStore.rememberRepo(normalizedRootDirectory);
  const repoModelCache = new Map<string, RepoModel>();

  // In-memory action runs registry
  const actionRuns = new Map<string, ActionRun>();

  function pruneCompletedRuns(): void {
    const completedPipe = Array.from(actionRuns.values()).filter((r) => r.status !== "running");
    if (completedPipe.length > MAX_COMPLETED_RUNS) {
      completedPipe
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(0, completedPipe.length - MAX_COMPLETED_RUNS)
        .forEach((r) => actionRuns.delete(r.runId));
    }
    const completedPty = Array.from(ptyRuns.values()).filter((r) => r.status !== "running");
    if (completedPty.length > MAX_COMPLETED_RUNS) {
      completedPty
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(0, completedPty.length - MAX_COMPLETED_RUNS)
        .forEach((r) => {
          r.replayBuffer.length = 0;
          r.replayBytes = 0;
          ptyRuns.delete(r.runId);
        });
    }
  }

  function killAllRuns(): void {
    for (const run of actionRuns.values()) {
      if (run.status === "running" && run.process) {
        try { run.process.kill("SIGTERM"); } catch { /* ignore */ }
        run.status = "stopped";
      }
    }
    for (const run of ptyRuns.values()) {
      if (run.status === "running" && run.ptyProcess) {
        try { run.ptyProcess.kill(); } catch { /* ignore */ }
        run.status = "stopped";
      }
    }
  }

  const ensureRepoModel = async (repoRoot = normalizedRootDirectory): Promise<RepoModel> => {
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

  const wsClients = new Set<WebSocket>();

  function broadcastEvent(event: DaemonWsEvent): void {
    const json = JSON.stringify(event);
    for (const client of wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  function sendSseLine(run: ActionRun, line: ActionRun["lines"][number]): void {
    run.lines.push(line);
    if (run.lines.length > 2000) {
      run.lines.shift();
    }
    const payload = `data: ${JSON.stringify({ type: "line", stream: line.stream, data: line.data })}\n\n`;
    for (const client of run.sseClients) {
      try {
        client.write(payload);
      } catch {
        run.sseClients.delete(client);
      }
    }
  }

  function sendSseResult(run: ActionRun): void {
    const payload = `data: ${JSON.stringify({ type: "result", exitCode: run.exitCode, status: run.status, helpers: run.helpers })}\n\n`;
    for (const client of run.sseClients) {
      try {
        client.write(payload);
        client.end();
      } catch {
        // ignore
      }
    }
    run.sseClients.clear();
  }

  function dispatchAction(actionId: string, action: ActionDefinition, repoRoot: string): ActionRun {
    const runId = randomUUID();
    if (!action.runCommand.trim()) throw new Error(`Action "${actionId}" has an empty runCommand.`);

    // Use shell=true so the full runCommand string (including quoted args and shell
    // operators like &&, pipes, etc.) is parsed by the OS shell rather than split naively.
    const child = spawn(action.runCommand, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    const run: ActionRun = {
      runId,
      actionId,
      repoRoot,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      lines: [],
      sseClients: new Set(),
      helpers: [],
      process: child,
    };
    actionRuns.set(runId, run);

    const ts = (): string => new Date().toISOString();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line) sendSseLine(run, { stream: "stdout", data: line, ts: ts() });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line) sendSseLine(run, { stream: "stderr", data: line, ts: ts() });
      }
    });

    child.on("close", (exitCode) => {
      run.exitCode = exitCode ?? -1;
      run.status = (exitCode ?? -1) === 0 ? "success" : "error";
      run.helpers = run.status === "success" ? action.successHelpers : action.failHelpers;
      run.process = null;
      sendSseResult(run);
      pruneCompletedRuns();
      broadcastEvent({ type: "action:complete", payload: { runId, actionId, exitCode: run.exitCode, status: run.status } });
    });

    child.on("error", (err: Error) => {
      sendSseLine(run, { stream: "system", data: `Process error: ${err.message}`, ts: ts() });
      run.exitCode = -1;
      run.status = "error";
      run.helpers = action.failHelpers;
      run.process = null;
      sendSseResult(run);
    });

    broadcastEvent({ type: "action:started", payload: { runId, actionId } });
    return run;
  }

  const ptyRuns = new Map<string, PtyRun>();

  async function dispatchPtyAction(actionId: string, action: ActionDefinition, repoRoot: string): Promise<PtyRun> {
    const runId = randomUUID();
    if (!action.runCommand.trim()) throw new Error(`Action "${actionId}" has an empty runCommand.`);

    const ptyMod = await loadPty();
    const shell = process.env.SHELL ?? "sh";
    const ptyProcess = ptyMod.spawn(shell, ["-lc", action.runCommand], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: repoRoot,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
      handleFlowControl: true,
    });

    const run: PtyRun = {
      runId,
      actionId,
      repoRoot,
      startedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      helpers: [],
      ptyProcess,
      wsClients: new Set(),
      replayBuffer: [],
      replayBytes: 0,
    };
    ptyRuns.set(runId, run);

    ptyProcess.onData((data: string) => {
      run.replayBuffer.push(data);
      run.replayBytes += Buffer.byteLength(data, "utf8");
      while (run.replayBytes > MAX_PTY_REPLAY_BYTES && run.replayBuffer.length > 1) {
        const removed = run.replayBuffer.shift()!;
        run.replayBytes -= Buffer.byteLength(removed, "utf8");
      }
      if (run.replayBytes > MAX_PTY_REPLAY_BYTES && run.replayBuffer.length === 1) {
        run.replayBuffer[0] = run.replayBuffer[0].slice(-MAX_PTY_REPLAY_BYTES);
        run.replayBytes = Buffer.byteLength(run.replayBuffer[0], "utf8");
      }
      const msg = JSON.stringify({ type: "output", data });
      for (const ws of run.wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(msg); } catch { run.wsClients.delete(ws); }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      run.exitCode = exitCode;
      run.status = exitCode === 0 ? "success" : "error";
      run.helpers = run.status === "success" ? action.successHelpers : action.failHelpers;
      run.ptyProcess = null;
      const msg = JSON.stringify({ type: "exit", exitCode, status: run.status, helpers: run.helpers });
      for (const ws of run.wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(msg);
            ws.close(1000, "process exited");
          } catch { /* ignore */ }
        }
      }
      run.wsClients.clear();
      pruneCompletedRuns();
      broadcastEvent({ type: "action:complete", payload: { runId, actionId, exitCode, status: run.status } });
    });

    broadcastEvent({ type: "action:started", payload: { runId, actionId, terminalMode: "pty" } });
    return run;
  }

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 404, { error: "Missing request URL." });
        return;
      }

      const url = new URL(request.url, "http://localhost");

      // OPTIONS preflight: allow only trusted (localhost) origins for mutations
      if (request.method === "OPTIONS") {
        if (isTrustedOrigin(request)) {
          const origin = request.headers["origin"] ?? "";
          response.setHeader("access-control-allow-origin", origin || "*");
          response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
          response.setHeader("access-control-allow-headers", "content-type");
          response.setHeader("access-control-max-age", "86400");
          response.statusCode = 204;
          response.end();
        } else {
          response.statusCode = 403;
          response.end();
        }
        return;
      }

      // ─── GET / ───────────────────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(response, 200, buildLandingPage());
        return;
      }

      // ─── GET /repo/discovery ─────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/repo/discovery") {
        const repoModel = await ensureRepoModel();
        sendJson(response, 200, repoModel.discovery, true);
        return;
      }

      // ─── GET /plugin/status ──────────────────────────────────────────────
      if (request.method === "GET" && url.pathname === "/plugin/status") {
        const repoModel = await ensureRepoModel();
        const statuses = await Promise.all(
          SUPPORTED_TARGETS.map(async (target) => {
            const plan = resolvePlan(repoModel, target);
            if (!plan.pluginPackage) {
              return { target, pluginPackage: null, diagnostics: plan.diagnostics };
            }
            const plugin = await loadPlugin(plan.pluginPackage, normalizedRootDirectory);
            return {
              target,
              pluginPackage: plan.pluginPackage,
              resolvedPath: plugin.resolvedPath,
              diagnostics: [...plan.diagnostics, ...plugin.diagnostics],
            };
          }),
        );
        sendJson(response, 200, { targets: statuses }, true);
        return;
      }

      // ─── GET /plans/:target ──────────────────────────────────────────────
      if (request.method === "GET" && url.pathname.startsWith("/plans/")) {
        const target = url.pathname.replace("/plans/", "") as SupportedTarget;
        if (!SUPPORTED_TARGETS.includes(target)) {
          sendJson(response, 404, { error: `Unsupported target "${target}".` }, true);
          return;
        }
        const repoModel = await ensureRepoModel();
        sendJson(response, 200, resolvePlan(repoModel, target), true);
        return;
      }

      // ─── GET /api/status ─────────────────────────────────────────────────
      if (url.pathname === "/api/status" && request.method === "GET") {
        const repoModel = await ensureRepoModel();
        const address = server.address();
        const daemonPort = typeof address === "object" && address ? address.port : null;
        sendJson(response, 200, {
          ok: true,
          version: resolvedDaemonVersion,
          daemon: {
            port: daemonPort,
            repoRoot: normalizedRootDirectory,
          },
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
            "websocket real-time events",
            "actions api",
          ],
          websocket: "/ws",
          plugins: Object.values(repoModel.artifacts)
            .map((artifact) => artifact.PackageName ?? artifact.packageName)
            .filter(Boolean),
        }, true);
        return;
      }

      // ─── GET /api/repos ──────────────────────────────────────────────────
      if (url.pathname === "/api/repos" && request.method === "GET") {
        const repos = await stateStore.listRepos();

        const reposWithMeta = await Promise.all(
          repos.map(async (repo) => {
            const meta = await loadArtifactMeta(repo.repoRoot);
            return { ...repo, meta };
          }),
        );

        sendJson(response, 200, {
          repos: reposWithMeta,
        }, true);
        return;
      }

      // ─── GET /api/repos/pinned ───────────────────────────────────────────
      if (url.pathname === "/api/repos/pinned" && request.method === "GET") {
        const artifactIds = await loadPinnedArtifactIds(normalizedRootDirectory);
        sendJson(response, 200, { artifactIds }, true);
        return;
      }

      // ─── PUT /api/repos/pinned ───────────────────────────────────────────
      if (url.pathname === "/api/repos/pinned" && request.method === "PUT") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const artifactIds = Array.isArray(payload.artifactIds)
          ? payload.artifactIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        await savePinnedArtifactIds(normalizedRootDirectory, artifactIds);
        sendJson(response, 200, { ok: true, artifactIds });
        broadcastEvent({ type: "repos:pinned-updated", payload: { artifactIds } });
        return;
      }

      // ─── PUT /api/repos/meta ─────────────────────────────────────────────
      if (url.pathname === "/api/repos/meta" && request.method === "PUT") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const metaRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!metaRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        const meta = {
          icon: typeof payload.icon === "string" ? payload.icon : undefined,
          internalName: typeof payload.internalName === "string" ? payload.internalName : undefined,
          labelName: typeof payload.labelName === "string" ? payload.labelName : undefined,
          instanceLabelName: typeof payload.instanceLabelName === "string" ? payload.instanceLabelName : undefined,
        };
        await saveArtifactMeta(metaRepoRoot, meta);
        sendJson(response, 200, { ok: true, meta });
        broadcastEvent({ type: "repo:meta-updated", payload: { repoRoot: metaRepoRoot, meta } });
        return;
      }

      // ─── GET /api/versions ───────────────────────────────────────────────
      if (url.pathname === "/api/versions" && request.method === "GET") {
        const versionsRepoRoot = url.searchParams.get("repoRoot");
        if (!versionsRepoRoot) {
          sendJson(response, 400, { error: "repoRoot query parameter is required." });
          return;
        }
        const resolvedVersionsRoot = path.resolve(versionsRepoRoot);
        stateStore.invalidateCache();
        const repoModel = await ensureRepoModel(resolvedVersionsRoot);
        const versions = await buildVersionPayload(repoModel, resolvedVersionsRoot, stateStore);
        sendJson(response, 200, { repoRoot: resolvedVersionsRoot, versions }, true);
        return;
      }

      // ─── POST /api/versions/set ──────────────────────────────────────────
      if (url.pathname === "/api/versions/set" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const setVersionRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!setVersionRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
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

        const updated = await stateStore.setArtifactVersion(setVersionRepoRoot, artifactName, packageName, { lastVersion, nextVersion });
        sendJson(response, 200, { ok: true, record: updated });
        broadcastEvent({ type: "version:set", payload: { artifactName, record: updated } });
        return;
      }

      // ─── POST /api/versions/increment ────────────────────────────────────
      if (url.pathname === "/api/versions/increment" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const incrRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!incrRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        const artifactName = typeof payload.artifactName === "string" ? payload.artifactName : "";
        const packageName = typeof payload.packageName === "string" ? payload.packageName : undefined;
        const baseVersion = typeof payload.baseVersion === "string" ? payload.baseVersion : undefined;

        if (!artifactName) {
          sendJson(response, 400, { error: "artifactName is required." });
          return;
        }

        const record = await stateStore.incrementArtifactNextVersion(incrRepoRoot, artifactName, packageName, baseVersion);
        sendJson(response, 200, { ok: true, record });
        broadcastEvent({ type: "version:incremented", payload: { artifactName, record } });
        return;
      }

      // ─── POST /api/versions/increment-minor ─────────────────────────────
      if (url.pathname === "/api/versions/increment-minor" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const incrRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!incrRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        const artifactName = typeof payload.artifactName === "string" ? payload.artifactName : "";
        const packageName = typeof payload.packageName === "string" ? payload.packageName : undefined;

        if (!artifactName) {
          sendJson(response, 400, { error: "artifactName is required." });
          return;
        }

        const record = await stateStore.incrementArtifactMinorVersion(incrRepoRoot, artifactName, packageName);
        sendJson(response, 200, { ok: true, record });
        broadcastEvent({ type: "version:incremented", payload: { artifactName, record, track: "minor" } });
        return;
      }

      // ─── POST /api/versions/increment-exp ───────────────────────────────
      if (url.pathname === "/api/versions/increment-exp" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const incrRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!incrRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        const artifactName = typeof payload.artifactName === "string" ? payload.artifactName : "";
        const packageName = typeof payload.packageName === "string" ? payload.packageName : undefined;

        if (!artifactName) {
          sendJson(response, 400, { error: "artifactName is required." });
          return;
        }

        const record = await stateStore.incrementArtifactExpVersion(incrRepoRoot, artifactName, packageName);
        sendJson(response, 200, { ok: true, record });
        broadcastEvent({ type: "version:incremented", payload: { artifactName, record, track: "exp" } });
        return;
      }

      // ─── GET /api/actions ────────────────────────────────────────────────
      if (url.pathname === "/api/actions" && request.method === "GET") {
        const actionsRepoRoot = url.searchParams.get("repoRoot");
        if (!actionsRepoRoot) {
          sendJson(response, 400, { error: "repoRoot query parameter is required." });
          return;
        }
        const resolvedActionsRoot = path.resolve(actionsRepoRoot);
        const actions = await loadActions(resolvedActionsRoot);
        const actionOrder = await loadActionOrder(resolvedActionsRoot);
        sendJson(response, 200, { repoRoot: resolvedActionsRoot, actions, actionOrder }, true);
        return;
      }

      // ─── PUT /api/actions/order ──────────────────────────────────────────
      if (url.pathname === "/api/actions/order" && request.method === "PUT") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const orderRepoRoot = typeof payload.repoRoot === "string" ? payload.repoRoot : null;
        if (!orderRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        const actionIds = Array.isArray(payload.actionIds)
          ? payload.actionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        const orderScope = payload.scope === "header" ? "header" : "actions";
        const resolvedOrderRoot = path.resolve(orderRepoRoot);
        const actionOrder = await saveActionOrder(
          resolvedOrderRoot,
          orderScope === "header" ? { headerActionIds: actionIds } : { actionIds },
        );
        const actions = await loadActions(resolvedOrderRoot);
        sendJson(response, 200, { ok: true, repoRoot: resolvedOrderRoot, actions, actionOrder });
        broadcastEvent({ type: "actions:updated", payload: { repoRoot: resolvedOrderRoot } });
        return;
      }

      // ─── POST /api/actions/dispatch ──────────────────────────────────────
      if (url.pathname === "/api/actions/dispatch" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const actionId = typeof payload.actionId === "string" ? payload.actionId : "";
        const repoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";

        if (!repoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }

        if (!actionId) {
          sendJson(response, 400, { error: "actionId is required." });
          return;
        }

        const actions = await loadActions(repoRoot);
        const action = actions.find((a) => a.id === actionId);
        if (!action) {
          sendJson(response, 404, { error: `Action "${actionId}" not found.` });
          return;
        }

        const terminalMode = action.terminalMode ?? "pty";
        if (terminalMode === "pty") {
          try {
            const ptyRun = await dispatchPtyAction(actionId, action, repoRoot);
            sendJson(response, 200, { ok: true, runId: ptyRun.runId, actionId, status: "running", terminalMode: "pty" });
          } catch (ptyErr) {
            const msg = ptyErr instanceof Error ? ptyErr.message : String(ptyErr);
            if (msg.includes("native module") || msg.includes("pty.node") || msg.includes("Cannot find module")) {
              const run = dispatchAction(actionId, action, repoRoot);
              sendJson(response, 200, { ok: true, runId: run.runId, actionId, status: "running", terminalMode: "pipe", ptyUnavailable: true });
            } else {
              throw ptyErr;
            }
          }
        } else {
          const run = dispatchAction(actionId, action, repoRoot);
          sendJson(response, 200, { ok: true, runId: run.runId, actionId, status: "running", terminalMode: "pipe" });
        }
        return;
      }

      // ─── GET /api/actions/stream/:runId ─────────────────────────────────
      if (request.method === "GET" && url.pathname.startsWith("/api/actions/stream/")) {
        const runId = url.pathname.replace("/api/actions/stream/", "").replace(/^\/+|\/+$/g, "");
        const run = actionRuns.get(runId);

        if (!run) {
          sendJson(response, 404, { error: `Run "${runId}" not found.` });
          return;
        }

        const sseOrigin = request.headers["origin"];
        const allowedSseOrigin = sseOrigin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(sseOrigin) ? sseOrigin : "*";

        // Set SSE headers
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          "access-control-allow-origin": allowedSseOrigin,
          "x-accel-buffering": "no",
        });

        // Replay buffered lines for late joiners
        for (const line of run.lines) {
          response.write(`data: ${JSON.stringify({ type: "line", stream: line.stream, data: line.data })}\n\n`);
        }

        if (run.status !== "running") {
          // Already finished — send result and close immediately
          response.write(`data: ${JSON.stringify({ type: "result", exitCode: run.exitCode, status: run.status, helpers: run.helpers })}\n\n`);
          response.end();
          return;
        }

        // Subscribe to live events
        run.sseClients.add(response);

        request.once("close", () => {
          run.sseClients.delete(response);
        });
        return;
      }

      // ─── PUT /api/actions/config ─────────────────────────────────────────
      if (url.pathname === "/api/actions/config" && request.method === "PUT") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const configRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        if (!configRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }

        if (typeof payload.id !== "string" || typeof payload.runCommand !== "string") {
          sendJson(response, 400, { error: "action.id and action.runCommand are required." });
          return;
        }

        const safeId = sanitizeActionId(payload.id);
        if (!safeId) {
          sendJson(response, 400, { error: "action.id must be 1-64 characters: letters, digits, hyphens, and underscores only." });
          return;
        }

        const action: ActionDefinition = {
          id: safeId,
          label: typeof payload.label === "string" ? payload.label : payload.id,
          runCommand: payload.runCommand,
          stopCommand: typeof payload.stopCommand === "string" ? payload.stopCommand : null,
          icon: typeof payload.icon === "string" ? payload.icon : "play",
          description: typeof payload.description === "string" ? payload.description : "",
          runLabel: typeof payload.runLabel === "string" ? payload.runLabel : "Run",
          stopLabel: typeof payload.stopLabel === "string" ? payload.stopLabel : "Stop",
          successHelpers: normalizeHelperArray(payload.successHelpers),
          failHelpers: normalizeHelperArray(payload.failHelpers),
          pageHeaderOptions: normalizePageHeaderOptions(payload.pageHeaderOptions),
          isLocalUser: payload.isLocalUser === true,
          buttonColor: typeof payload.buttonColor === "string" ? payload.buttonColor : undefined,
          terminalMode: payload.terminalMode === "pipe" ? "pipe" : payload.terminalMode === "pty" ? "pty" : undefined,
          runMode: payload.runMode === "background" ? "background" : payload.runMode === "stream" ? "stream" : undefined,
        };

        await saveAction(configRepoRoot, action);
        sendJson(response, 200, { ok: true, action });
        broadcastEvent({ type: "actions:updated", payload: { repoRoot: configRepoRoot } });
        return;
      }

      // ─── GET /api/actions/runs ───────────────────────────────────────────
      if (url.pathname === "/api/actions/runs" && request.method === "GET") {
        const pipeRuns = Array.from(actionRuns.values()).map((run) => ({
          runId: run.runId,
          actionId: run.actionId,
          status: run.status,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
          lineCount: run.lines.length,
          terminalMode: "pipe" as const,
        }));
        const termRuns = Array.from(ptyRuns.values()).map((run) => ({
          runId: run.runId,
          actionId: run.actionId,
          status: run.status,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
          lineCount: run.replayBuffer.length,
          terminalMode: "pty" as const,
        }));
        sendJson(response, 200, { runs: [...pipeRuns, ...termRuns] }, true);
        return;
      }

      // ─── POST /api/actions/stop/:runId ───────────────────────────────────
      if (request.method === "POST" && url.pathname.startsWith("/api/actions/stop/")) {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const runId = url.pathname.replace("/api/actions/stop/", "").replace(/^\/+|\/+$/g, "");
        const run = actionRuns.get(runId);
        const ptyRun = ptyRuns.get(runId);

        if (!run && !ptyRun) {
          sendJson(response, 404, { error: `Run "${runId}" not found.` });
          return;
        }

        if (run) {
          if (run.process && run.status === "running") {
            run.process.kill("SIGTERM");
            run.status = "stopped";
          }
          sendJson(response, 200, { ok: true, runId, status: run.status });
        } else if (ptyRun) {
          if (ptyRun.ptyProcess && ptyRun.status === "running") {
            ptyRun.ptyProcess.kill();
            ptyRun.status = "stopped";
          }
          sendJson(response, 200, { ok: true, runId, status: ptyRun.status });
        }
        return;
      }

      // ─── DELETE /api/actions/config/:id ─────────────────────────────────
      if (request.method === "DELETE" && url.pathname.startsWith("/api/actions/config/")) {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const rawId = url.pathname.replace("/api/actions/config/", "").replace(/^\/+|\/+$/g, "");
        if (!rawId) {
          sendJson(response, 400, { error: "action id is required in the path." });
          return;
        }
        let deleteRepoRootRaw = url.searchParams.get("repoRoot") ?? "";
        if (!deleteRepoRootRaw) {
          try {
            const deleteBody = await readJsonBody(request);
            deleteRepoRootRaw = typeof deleteBody.repoRoot === "string" ? deleteBody.repoRoot : "";
          } catch { /* no body — handled below */ }
        }
        if (!deleteRepoRootRaw) {
          sendJson(response, 400, { error: "repoRoot is required (body or query string)." });
          return;
        }
        const resolvedDeleteRoot = path.resolve(deleteRepoRootRaw);
        try {
          await deleteAction(resolvedDeleteRoot, rawId);
        } catch {
          sendJson(response, 404, { error: `Action "${rawId}" not found.` });
          return;
        }
        sendJson(response, 200, { ok: true, actionId: rawId });
        broadcastEvent({ type: "actions:updated", payload: { repoRoot: resolvedDeleteRoot } });
        return;
      }

      // ─── POST /api/actions/move ─────────────────────────────────────────
      if (url.pathname === "/api/actions/move" && request.method === "POST") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin mutation requests are not allowed." });
          return;
        }
        const payload = await readJsonBody(request);
        const moveRepoRoot = typeof payload.repoRoot === "string" ? path.resolve(payload.repoRoot) : "";
        const moveActionId = typeof payload.actionId === "string" ? payload.actionId : "";
        const toLocalUser = payload.toLocalUser === true;

        if (!moveRepoRoot) {
          sendJson(response, 400, { error: "repoRoot is required." });
          return;
        }
        if (!moveActionId) {
          sendJson(response, 400, { error: "actionId is required." });
          return;
        }

        try {
          await moveAction(moveRepoRoot, moveActionId, toLocalUser);
          sendJson(response, 200, { ok: true, actionId: moveActionId, toLocalUser });
          broadcastEvent({ type: "actions:updated", payload: { repoRoot: moveRepoRoot } });
        } catch (err) {
          sendJson(response, 500, { error: err instanceof Error ? err.message : "Failed to move action." });
        }
        return;
      }

      // ─── GET /api/actions/runs/logs ─────────────────────────────────────
      if (url.pathname === "/api/actions/runs/logs" && request.method === "GET") {
        const pipeRunsWithLogs = Array.from(actionRuns.values()).map((run) => ({
          runId: run.runId,
          actionId: run.actionId,
          status: run.status,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
          helpers: run.helpers,
          lines: run.lines.map((l) => ({ stream: l.stream, data: l.data, ts: l.ts })),
          terminalMode: "pipe" as const,
        }));
        const ptyRunsWithLogs = Array.from(ptyRuns.values()).map((run) => ({
          runId: run.runId,
          actionId: run.actionId,
          status: run.status,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
          helpers: run.helpers,
          lines: [],
          terminalMode: "pty" as const,
        }));
        sendJson(response, 200, { runs: [...pipeRunsWithLogs, ...ptyRunsWithLogs] }, true);
        return;
      }

      if (request.method === "POST" && url.pathname === "/daemon/shutdown") {
        if (!isTrustedOrigin(request)) {
          sendJson(response, 403, { error: "Cross-origin shutdown requests are not allowed." });
          return;
        }
        killAllRuns();
        sendJson(response, 200, { ok: true, message: "Service shutting down." });
        // Give the response time to flush before exiting
        setTimeout(() => process.exit(0), 150);
        return;
      }

      sendJson(response, 404, { error: "Unknown endpoint." });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown daemon error.",
      });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("close", () => {
      wsClients.delete(ws);
    });
    ws.on("error", () => {
      wsClients.delete(ws);
    });
    ws.send(JSON.stringify({ type: "connected", payload: { clients: wsClients.size } }));
  });

  terminalWss.on("connection", (ws, request) => {
    const reqUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const runId = reqUrl.pathname.replace("/api/actions/terminal/", "").replace(/^\/+|\/+$/g, "");
    const run = ptyRuns.get(runId);

    if (!run) {
      ws.send(JSON.stringify({ type: "error", message: `Run "${runId}" not found.` }));
      ws.close();
      return;
    }

    run.wsClients.add(ws);

    for (const chunk of run.replayBuffer) {
      ws.send(JSON.stringify({ type: "output", data: chunk }));
    }

    if (run.status !== "running") {
      ws.send(JSON.stringify({ type: "exit", exitCode: run.exitCode, status: run.status, helpers: run.helpers }));
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string; data?: string; cols?: number; rows?: number };
        if (msg.type === "stdin" && typeof msg.data === "string" && run.ptyProcess) {
          run.ptyProcess.write(msg.data);
        }
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number" && run.ptyProcess) {
          run.ptyProcess.resize(msg.cols, msg.rows);
        }
      } catch { /* ignore */ }
    });

    ws.on("close", () => {
      run.wsClients.delete(ws);
    });
    ws.on("error", () => {
      run.wsClients.delete(ws);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const urlPath = request.url ?? "/";
    if (urlPath === "/ws" || urlPath.startsWith("/ws?")) {
      const wsOrigin = request.headers.origin;
      const wsAllowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
      if (wsOrigin && !wsAllowed.test(wsOrigin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else if (urlPath.startsWith("/api/actions/terminal/")) {
      const origin = request.headers.origin;
      const allowedOrigins = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
      if (origin && !allowedOrigins.test(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => {
    // Bind to loopback only — the daemon is an internal service (UI connects via 127.0.0.1).
    // Exposing command-execution endpoints on 0.0.0.0 would be a network-level RCE vector.
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return { server, killAllRuns };
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
          suggestedNextVersion: computeNextVersionSuggestion(
            registryRecord?.nextVersion ?? registryRecord?.lastVersion ?? packageVersion ?? "0.1.0",
          ),
        };
      }),
  );
}

function normalizeHelperArray(raw: unknown): ActionDefinition["successHelpers"] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is ActionDefinition["successHelpers"][number] => {
    if (typeof h !== "object" || h === null) return false;
    const entry = h as Record<string, unknown>;
    return (
      (entry["kind"] === "open-url" || entry["kind"] === "copy-text") &&
      typeof entry["label"] === "string" &&
      typeof entry["value"] === "string"
    );
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<ParsedRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (rawBody.length === 0) return {};
  return JSON.parse(rawBody) as ParsedRequestBody;
}

/** Send a JSON response. Set cors=true only for read-only (GET) endpoints. */
function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown, cors = false): void {
  response.statusCode = statusCode;
  if (cors) response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

/**
 * Returns true if the request originates from a trusted local context.
 * Requests with no Origin header (CLI, curl, same-origin) are trusted.
 * Browser cross-origin requests from any non-localhost domain are rejected.
 */
function isTrustedOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers["origin"];
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Validate action id — only allow safe filename characters, prevent path traversal. */
function sanitizeActionId(id: string): string | null {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
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
      :root { color-scheme: light; font-family: "Segoe UI", sans-serif; }
      body { margin: 2rem; line-height: 1.5; }
      h1 { margin-bottom: 0.5rem; }
      ul { padding-left: 1.25rem; }
      code { background: #f3f4f6; padding: 0.1rem 0.3rem; }
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
      <li><a href="/api/actions">/api/actions</a></li>
      <li><a href="/api/actions/runs">/api/actions/runs</a></li>
      <li><a href="/repo/discovery">/repo/discovery</a></li>
      <li><a href="/plugin/status">/plugin/status</a></li>
      <li><a href="/plans/default">/plans/default</a></li>
    </ul>
    <p>WebSocket: connect to <code>/ws</code> for real-time state events.</p>
  </body>
</html>`;
}
