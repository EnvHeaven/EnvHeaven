import http from "node:http";
import { buildRepoModel } from "../envrepo/model";
import { discoverEnvRepo } from "../envrepo/discovery";
import { resolvePlan } from "../envrepo/resolver";
import { loadPlugin } from "../plugins/loader";
import type { RepoModel, SupportedTarget } from "../types";

const SUPPORTED_TARGETS: SupportedTarget[] = ["default", "local", "local-01", "fake-local", "fake-local-01"];

export async function startDaemon(rootDirectory: string, port = 0): Promise<http.Server> {
  let cachedRepoModel: RepoModel | null = null;

  const ensureRepoModel = async (): Promise<RepoModel> => {
    if (!cachedRepoModel) {
      const discovery = await discoverEnvRepo(rootDirectory);
      cachedRepoModel = buildRepoModel(discovery);
    }

    return cachedRepoModel;
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        sendJson(response, 404, { error: "Missing request URL." });
        return;
      }

      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }

      if (url.pathname === "/repo/discovery") {
        const repoModel = await ensureRepoModel();
        sendJson(response, 200, repoModel.discovery);
        return;
      }

      if (url.pathname === "/plugin/status") {
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

            const plugin = await loadPlugin(plan.pluginPackage, rootDirectory);
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

      if (url.pathname.startsWith("/plans/")) {
        const target = url.pathname.replace("/plans/", "") as SupportedTarget;
        if (!SUPPORTED_TARGETS.includes(target)) {
          sendJson(response, 404, { error: `Unsupported target "${target}".` });
          return;
        }

        const repoModel = await ensureRepoModel();
        sendJson(response, 200, resolvePlan(repoModel, target));
        return;
      }

      sendJson(response, 404, { error: "Unknown endpoint." });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown daemon error.",
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return server;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}
