#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const readline = __importStar(require("node:readline"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const cli_flags_1 = require("./cli-flags");
const cli_output_1 = require("./cli-output");
const intent_1 = require("./commands/intent");
const server_1 = require("./daemon/server");
const runtime_1 = require("./deploy/runtime");
const dynamic_version_1 = require("./deploy/dynamic-version");
const plan_filter_1 = require("./deploy/plan-filter");
const selection_1 = require("./deploy/selection");
const diagnostics_1 = require("./diagnostics");
const discovery_1 = require("./envrepo/discovery");
const model_1 = require("./envrepo/model");
const resolver_1 = require("./envrepo/resolver");
const workspace_routing_1 = require("./envrepo/workspace-routing");
const spawn_1 = require("./execution/spawn");
const port_utils_1 = require("./execution/port-utils");
const challenge_1 = require("./guards/challenge");
const launcher_1 = require("./offiline/launcher");
const loader_1 = require("./plugins/loader");
const store_1 = require("./state/store");
const preferences_1 = require("./state/preferences");
const lock_1 = require("./state/lock");
const PACKAGE_VERSION = (() => {
    const store = new store_1.EnvHeavenStateStore();
    const installed = store.readInstalledCliVersionSync();
    if (installed)
        return installed;
    try {
        const pkgPath = node_path_1.default.join(__dirname, "..", "package.json");
        return JSON.parse((0, node_fs_1.readFileSync)(pkgPath, "utf8")).version;
    }
    catch {
        return "0.1.0";
    }
})();
const BG_MODE = process.env["ENVHEAVEN_BG_MODE"] === "1";
function promptConfirm(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
async function main() {
    const rawArgs = process.argv.slice(2);
    const { options, remainingArgs } = (0, cli_flags_1.parseGlobalFlags)(rawArgs);
    (0, cli_output_1.verboseLog)("flags parsed", options);
    if (options.version) {
        process.stdout.write(`EnvHeaven v${PACKAGE_VERSION}\n`);
        process.exitCode = 0;
        return;
    }
    let intentArgs = remainingArgs;
    let intent = null;
    let intentDiagnostics = [];
    if (options.jsonRequest) {
        const jsonArg = remainingArgs.find((a) => a.trimStart().startsWith("{"));
        if (!jsonArg) {
            (0, cli_output_1.writeOutput)({
                diagnostics: [
                    (0, diagnostics_1.createDiagnostic)("error", "json-request-missing", "--json-request requires a JSON string argument, e.g. '{\"kind\":\"run\",\"target\":\"local\"}'."),
                ],
            }, 1, options);
            return;
        }
        const parsed = parseJsonRequestArg(jsonArg);
        if (!parsed.intent) {
            (0, cli_output_1.writeOutput)({ diagnostics: parsed.diagnostics }, 1, options);
            return;
        }
        intent = parsed.intent;
        intentDiagnostics = [];
        intentArgs = [];
    }
    else {
        const inferred = (0, intent_1.inferCommandIntent)(intentArgs);
        intent = inferred.intent ?? null;
        intentDiagnostics = inferred.diagnostics;
    }
    (0, cli_output_1.verboseLog)("intent resolved", options);
    if (!intent) {
        (0, cli_output_1.writeOutput)({ diagnostics: intentDiagnostics }, 1, options);
        return;
    }
    const workspaceResult = await (0, workspace_routing_1.resolveWorkspaceRoot)(process.cwd());
    const repoRoot = workspaceResult.envRepoRoot;
    const stateStore = new store_1.EnvHeavenStateStore();
    const paths = stateStore.getPaths();
    await stateStore.rememberRepo(repoRoot);
    if (intent.kind === "daemon") {
        if (BG_MODE) {
            const { server, killAllRuns } = await (0, server_1.startDaemon)(repoRoot, 42990, stateStore, PACKAGE_VERSION);
            const address = server.address();
            const daemonPort = typeof address === "object" && address ? address.port : 0;
            let uiPort = null;
            const bgPrefs = await (0, preferences_1.loadPreferences)();
            if (bgPrefs?.autoStartUi) {
                try {
                    const launched = await (0, launcher_1.launchOffilineWebUi)(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore, 42991);
                    const uiAddr = launched.server.address();
                    uiPort = typeof uiAddr === "object" && uiAddr ? uiAddr.port : null;
                }
                catch {
                    // non-fatal
                }
            }
            await (0, lock_1.writeLockFile)(paths, {
                daemonPort,
                uiPort,
                startedAt: new Date().toISOString(),
                daemonPid: process.pid,
                uiPid: uiPort !== null ? process.pid : undefined,
            });
            process.once("SIGTERM", () => {
                killAllRuns();
                void (0, lock_1.clearLockFile)(paths).then(() => server.close(() => process.exit(0)));
            });
            process.once("SIGINT", () => {
                killAllRuns();
                void (0, lock_1.clearLockFile)(paths).then(() => server.close(() => process.exit(0)));
            });
            return;
        }
        // ── daemon subcommand handling (stop / restart / status) ──────────────
        if (intent.subcommand === "status" || intent.subcommand === "stop" || intent.subcommand === "restart") {
            const lock = await (0, lock_1.readLockFile)(paths);
            const alive = !!(lock && lock.daemonPort > 0 && (await (0, lock_1.isPortOpen)(lock.daemonPort)));
            if (intent.subcommand === "status") {
                (0, cli_output_1.writeOutput)({
                    mode: "daemon",
                    running: alive,
                    port: alive ? lock.daemonPort : null,
                    uiPort: alive && lock.uiPort ? lock.uiPort : null,
                    diagnostics: [
                        (0, diagnostics_1.createDiagnostic)("info", alive ? "daemon-running" : "daemon-stopped", alive
                            ? `Service running on port ${String(lock.daemonPort)}.`
                            : "Service is not running."),
                    ],
                }, 0, options);
                return;
            }
            if (!alive) {
                const msg = intent.subcommand === "restart" ? "Service is not running — starting fresh." : "Service is not running.";
                if (intent.subcommand === "stop") {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "daemon-already-stopped", msg)] }, 0, options);
                    return;
                }
                // restart with no running daemon → fall through to start
            }
            else {
                if (intent.subcommand === "stop" && !options.jsonRequest && process.stdin.isTTY) {
                    const confirmed = await promptConfirm("Service is running. Stop it? (y/N) ");
                    if (!confirmed) {
                        (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "daemon-stop-cancelled", "Stop cancelled.")] }, 0, options);
                        return;
                    }
                }
                // Stop the daemon via its PID
                const stopped = await killProcess(lock.daemonPid ?? null, lock.daemonPort);
                if (!stopped) {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("error", "daemon-stop-failed", "Service did not stop within 5 seconds.")] }, 1, options);
                    return;
                }
                await (0, lock_1.clearLockFile)(paths);
                if (intent.subcommand === "stop") {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "daemon-stopped", "Service stopped.")] }, 0, options);
                    return;
                }
                // restart: fall through to start logic below (after this if-block)
            }
        }
        // ──────────────────────────────────────────────────────────────────────
        let prefs = await (0, preferences_1.loadPreferences)();
        if (prefs === null) {
            const autoStart = await promptYesNo("  EnvHeaven — first-run setup\n" +
                "  ─────────────────────────────────────────\n" +
                "  Start the Offline GUI automatically each time? (Y/n) ");
            await (0, preferences_1.savePreferences)({ autoStartUi: autoStart });
            prefs = { autoStartUi: autoStart };
            process.stdout.write(autoStart
                ? "  Saved: the Offline GUI will auto-start with the service.\n"
                : "  Saved: Offline GUI will not auto-start (run `envheaven offiline-web-ui` anytime).\n");
        }
        const existingLock = await (0, lock_1.readLockFile)(paths);
        const daemonAlive = !!(existingLock && existingLock.daemonPort > 0 && (await (0, lock_1.isPortOpen)(existingLock.daemonPort)));
        if (daemonAlive) {
            const uiAlreadyUp = !!(existingLock.uiPort && existingLock.uiPort > 0 && (await (0, lock_1.isPortOpen)(existingLock.uiPort)));
            if (prefs.autoStartUi && !uiAlreadyUp) {
                // Daemon alive but UI missing — spawn UI-only
                const uiChild = (0, node_child_process_1.spawn)(process.execPath, [process.argv[1], "offiline-web-ui"], {
                    detached: true,
                    stdio: ["ignore", "ignore", "ignore"],
                    env: {
                        ...process.env,
                        ENVHEAVEN_BG_MODE: "1",
                        ENVHEAVEN_UI_ONLY_DAEMON_PORT: String(existingLock.daemonPort),
                    },
                });
                uiChild.unref();
                const uiLock = await (0, lock_1.waitForLockFile)(paths, 18000, 300, true);
                const lanIp = getLanIp();
                (0, cli_output_1.writeOutput)({
                    mode: "daemon",
                    already_running: true,
                    port: existingLock.daemonPort,
                    daemonUrls: buildUrlList(existingLock.daemonPort, lanIp),
                    uiUrls: uiLock?.uiPort ? buildUrlList(uiLock.uiPort, lanIp) : [],
                    diagnostics: [
                        (0, diagnostics_1.createDiagnostic)("info", "daemon-already-running", `EnvHeaven service already running on port ${String(existingLock.daemonPort)}.`),
                        ...(uiLock?.uiPort
                            ? [(0, diagnostics_1.createDiagnostic)("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(uiLock.uiPort)}.`)]
                            : []),
                    ],
                }, 0, options);
                return;
            }
            const lanIp = getLanIp();
            (0, cli_output_1.writeOutput)({
                mode: "daemon",
                already_running: true,
                port: existingLock.daemonPort,
                daemonUrls: buildUrlList(existingLock.daemonPort, lanIp),
                uiUrls: existingLock.uiPort ? buildUrlList(existingLock.uiPort, lanIp) : [],
                diagnostics: [
                    (0, diagnostics_1.createDiagnostic)("info", "daemon-already-running", `EnvHeaven service already running on port ${String(existingLock.daemonPort)}.`),
                ],
            }, 0, options);
            return;
        }
        const child = (0, node_child_process_1.spawn)(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            env: { ...process.env, ENVHEAVEN_BG_MODE: "1" },
        });
        child.unref();
        const requireUi = prefs.autoStartUi === true;
        const lock = await (0, lock_1.waitForLockFile)(paths, 18000, 300, requireUi);
        if (!lock) {
            (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("error", "daemon-start-timeout", "EnvHeaven service did not become reachable within 18 seconds.")] }, 1, options);
            return;
        }
        const lanIp = getLanIp();
        (0, cli_output_1.writeOutput)({
            mode: "daemon",
            port: lock.daemonPort,
            daemonUrls: buildUrlList(lock.daemonPort, lanIp),
            uiUrls: lock.uiPort ? buildUrlList(lock.uiPort, lanIp) : [],
            diagnostics: [
                (0, diagnostics_1.createDiagnostic)("info", "daemon-started", `EnvHeaven service started on port ${String(lock.daemonPort)}.`),
                ...(lock.uiPort
                    ? [(0, diagnostics_1.createDiagnostic)("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(lock.uiPort)}.`)]
                    : [(0, diagnostics_1.createDiagnostic)("info", "offiline-web-ui-hint", "Tip: run `envheaven offiline-web-ui` to launch the Offline GUI.")]),
            ],
        }, 0, options);
        return;
    }
    if (intent.kind === "version") {
        process.stdout.write(`EnvHeaven v${PACKAGE_VERSION}\n`);
        process.exitCode = 0;
        return;
    }
    if (intent.kind === "offiline-web-ui") {
        if (BG_MODE) {
            const uiOnlyDaemonPortStr = process.env["ENVHEAVEN_UI_ONLY_DAEMON_PORT"];
            if (uiOnlyDaemonPortStr) {
                // Reuse existing daemon — only start UI
                const existingDaemonPort = parseInt(uiOnlyDaemonPortStr, 10);
                const launched = await (0, launcher_1.launchOffilineWebUi)(repoRoot, `http://127.0.0.1:${String(existingDaemonPort)}`, stateStore, 42991);
                const uiAddress = launched.server.address();
                const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;
                // Update lock file to record uiPort (daemon port and PID preserved)
                const existingLockForPid = await (0, lock_1.readLockFile)(paths);
                await (0, lock_1.writeLockFile)(paths, {
                    daemonPort: existingDaemonPort,
                    uiPort: uiPort ?? null,
                    startedAt: new Date().toISOString(),
                    daemonPid: existingLockForPid?.daemonPid,
                    uiPid: process.pid,
                });
                process.once("SIGTERM", () => {
                    // On UI-only shutdown: null out uiPort in lock but leave daemon entry intact
                    void (0, lock_1.writeLockFile)(paths, { daemonPort: existingDaemonPort, uiPort: null, startedAt: new Date().toISOString() })
                        .then(() => launched.server.close(() => process.exit(0)));
                });
                process.once("SIGINT", () => {
                    void (0, lock_1.writeLockFile)(paths, { daemonPort: existingDaemonPort, uiPort: null, startedAt: new Date().toISOString() })
                        .then(() => launched.server.close(() => process.exit(0)));
                });
                return;
            }
            // Full mode: start daemon + UI
            const { server: daemonServer, killAllRuns: killDaemonRuns } = await (0, server_1.startDaemon)(repoRoot, 42990, stateStore, PACKAGE_VERSION);
            const daemonAddress = daemonServer.address();
            const daemonPort = typeof daemonAddress === "object" && daemonAddress ? daemonAddress.port : 0;
            const launched = await (0, launcher_1.launchOffilineWebUi)(repoRoot, `http://127.0.0.1:${String(daemonPort)}`, stateStore, 42991);
            const uiAddress = launched.server.address();
            const uiPort = typeof uiAddress === "object" && uiAddress ? uiAddress.port : null;
            await (0, lock_1.writeLockFile)(paths, {
                daemonPort,
                uiPort: uiPort ?? null,
                startedAt: new Date().toISOString(),
                daemonPid: process.pid,
                uiPid: process.pid,
            });
            const cleanup = () => {
                killDaemonRuns();
                void (0, lock_1.clearLockFile)(paths).then(() => {
                    daemonServer.close(() => undefined);
                    launched.server.close(() => process.exit(0));
                });
            };
            process.once("SIGTERM", cleanup);
            process.once("SIGINT", cleanup);
            return;
        }
        // Check per-service if already running
        const existingLock = await (0, lock_1.readLockFile)(paths);
        const daemonAliveUi = !!(existingLock && existingLock.daemonPort > 0 && (await (0, lock_1.isPortOpen)(existingLock.daemonPort)));
        const uiAlive = !!(daemonAliveUi && existingLock.uiPort && existingLock.uiPort > 0 && (await (0, lock_1.isPortOpen)(existingLock.uiPort)));
        if (daemonAliveUi && uiAlive) {
            const lanIp = getLanIp();
            (0, cli_output_1.writeOutput)({
                mode: "offiline-web-ui",
                already_running: true,
                daemonUrls: buildUrlList(existingLock.daemonPort, lanIp),
                uiUrls: buildUrlList(existingLock.uiPort, lanIp),
                diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "already-running", "EnvHeaven service and Offline GUI are already running.")],
            }, 0, options);
            return;
        }
        const spawnEnv = { ...process.env, ENVHEAVEN_BG_MODE: "1" };
        if (daemonAliveUi && !uiAlive) {
            // Daemon running, only launch missing UI
            spawnEnv["ENVHEAVEN_UI_ONLY_DAEMON_PORT"] = String(existingLock.daemonPort);
        }
        const child = (0, node_child_process_1.spawn)(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            env: spawnEnv,
        });
        child.unref();
        const lock = await (0, lock_1.waitForLockFile)(paths, 18000, 300, true);
        if (!lock) {
            (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("error", "offiline-web-ui-start-timeout", "EnvHeaven Offline GUI did not become reachable within 18 seconds.")] }, 1, options);
            return;
        }
        const lanIp = getLanIp();
        (0, cli_output_1.writeOutput)({
            mode: "offiline-web-ui",
            daemonUrls: buildUrlList(lock.daemonPort, lanIp),
            uiUrls: lock.uiPort ? buildUrlList(lock.uiPort, lanIp) : [],
            diagnostics: [
                ...(daemonAliveUi
                    ? [(0, diagnostics_1.createDiagnostic)("info", "daemon-reused", `EnvHeaven service reused on port ${String(lock.daemonPort)}.`)]
                    : [(0, diagnostics_1.createDiagnostic)("info", "daemon-started", `EnvHeaven service started on port ${String(lock.daemonPort)}.`)]),
                (0, diagnostics_1.createDiagnostic)("info", "offiline-web-ui-started", `EnvHeaven Offline GUI started on port ${String(lock.uiPort ?? 0)}.`),
            ],
        }, 0, options);
        return;
    }
    // ── ui [stop|restart|status] ──────────────────────────────────────────
    if (intent.kind === "ui") {
        const lock = await (0, lock_1.readLockFile)(paths);
        const uiAlive = !!(lock && lock.uiPort && lock.uiPort > 0 && (await (0, lock_1.isPortOpen)(lock.uiPort)));
        const daemonAlive = !!(lock && lock.daemonPort > 0 && (await (0, lock_1.isPortOpen)(lock.daemonPort)));
        if (intent.subcommand === "status") {
            (0, cli_output_1.writeOutput)({
                mode: "ui",
                running: uiAlive,
                uiPort: uiAlive ? lock.uiPort : null,
                daemonPort: daemonAlive ? lock.daemonPort : null,
                diagnostics: [
                    (0, diagnostics_1.createDiagnostic)("info", uiAlive ? "ui-running" : "ui-stopped", uiAlive
                        ? `Offline GUI running on port ${String(lock.uiPort)}.`
                        : "Offline GUI is not running."),
                ],
            }, 0, options);
            return;
        }
        if (intent.subcommand === "stop" || intent.subcommand === "restart") {
            if (!uiAlive) {
                if (intent.subcommand === "stop") {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "ui-already-stopped", "Offline GUI is not running.")] }, 0, options);
                    return;
                }
                // restart with UI not running → fall through to start
            }
            else {
                const stopped = await killProcess(lock.uiPid ?? null, lock.uiPort, 6000, lock.daemonPort);
                if (!stopped) {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("error", "ui-stop-failed", "Offline GUI did not stop within 5 seconds.")] }, 1, options);
                    return;
                }
                // Clear uiPort from lock file (preserve daemonPort)
                await (0, lock_1.writeLockFile)(paths, {
                    daemonPort: lock.daemonPort,
                    uiPort: null,
                    startedAt: lock.startedAt,
                    daemonPid: lock.daemonPid,
                    uiPid: undefined,
                });
                if (intent.subcommand === "stop") {
                    (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "ui-stopped", "Offline GUI stopped.")] }, 0, options);
                    return;
                }
                // restart: fall through to start below
            }
        }
        // No subcommand (or restart after stop): start the UI.
        // This is the same logic as the offiline-web-ui start path.
        const existingLock2 = await (0, lock_1.readLockFile)(paths);
        const daemonAlive2 = !!(existingLock2 && existingLock2.daemonPort > 0 && (await (0, lock_1.isPortOpen)(existingLock2.daemonPort)));
        const uiAlive2 = !!(daemonAlive2 && existingLock2.uiPort && existingLock2.uiPort > 0 && (await (0, lock_1.isPortOpen)(existingLock2.uiPort)));
        if (daemonAlive2 && uiAlive2 && !intent.subcommand) {
            const lanIp = getLanIp();
            (0, cli_output_1.writeOutput)({
                mode: "ui",
                already_running: true,
                daemonUrls: buildUrlList(existingLock2.daemonPort, lanIp),
                uiUrls: buildUrlList(existingLock2.uiPort, lanIp),
                diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "already-running", "EnvHeaven service and Offline GUI are already running.")],
            }, 0, options);
            return;
        }
        const spawnEnv2 = { ...process.env, ENVHEAVEN_BG_MODE: "1" };
        if (daemonAlive2 && !uiAlive2) {
            spawnEnv2["ENVHEAVEN_UI_ONLY_DAEMON_PORT"] = String(existingLock2.daemonPort);
        }
        const uiChild = (0, node_child_process_1.spawn)(process.execPath, [process.argv[1], "offiline-web-ui"], {
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
            env: spawnEnv2,
        });
        uiChild.unref();
        const uiLock = await (0, lock_1.waitForLockFile)(paths, 18000, 300, true);
        if (!uiLock) {
            (0, cli_output_1.writeOutput)({ diagnostics: [(0, diagnostics_1.createDiagnostic)("error", "ui-start-timeout", "Offline GUI did not become reachable within 18 seconds.")] }, 1, options);
            return;
        }
        const lanIp = getLanIp();
        (0, cli_output_1.writeOutput)({
            mode: "ui",
            daemonUrls: buildUrlList(uiLock.daemonPort, lanIp),
            uiUrls: uiLock.uiPort ? buildUrlList(uiLock.uiPort, lanIp) : [],
            diagnostics: [(0, diagnostics_1.createDiagnostic)("info", "ui-started", `Offline GUI started on port ${String(uiLock.uiPort ?? 0)}.`)],
        }, 0, options);
        return;
    }
    // ──────────────────────────────────────────────────────────────────────
    if (intent.kind === "apply" && intent.subcommand === "version") {
        const discovery = await (0, discovery_1.discoverEnvRepo)(repoRoot);
        const repoModel = (0, model_1.buildRepoModel)(discovery);
        const versionRecords = await stateStore.getVersionRecords(repoRoot);
        const applyResults = [];
        const applyDiagnostics = [...intentDiagnostics];
        for (const record of versionRecords) {
            const targetVersion = record.nextVersion ?? record.lastVersion;
            if (!targetVersion)
                continue;
            const artifactConfig = repoModel.artifacts[record.artifactName];
            let pkgDir;
            if (artifactConfig && typeof artifactConfig["RepoCloneFolderPath"] === "string") {
                pkgDir = node_path_1.default.resolve(repoRoot, artifactConfig["RepoCloneFolderPath"]);
            }
            if (!pkgDir) {
                const candidates = discovery.files
                    .filter((f) => f.fileName === "package.json" && f.payload && f.payload["name"] === record.packageName)
                    .map((f) => node_path_1.default.dirname(f.sourcePath));
                pkgDir = candidates[0];
            }
            if (!pkgDir)
                continue;
            const packageJsonPath = node_path_1.default.join(pkgDir, "package.json");
            try {
                const raw = (0, node_fs_1.readFileSync)(packageJsonPath, "utf8");
                const parsed = JSON.parse(raw);
                parsed.version = targetVersion;
                const { promises: fsAsync } = await Promise.resolve().then(() => __importStar(require("node:fs")));
                await fsAsync.writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
                applyResults.push({ artifactName: record.artifactName, packageName: record.packageName, version: targetVersion, packageJsonPath, applied: true });
                applyDiagnostics.push((0, diagnostics_1.createDiagnostic)("info", "version-applied", `Applied version "${targetVersion}" to ${packageJsonPath}.`));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : "Unknown error";
                applyResults.push({ artifactName: record.artifactName, packageName: record.packageName, version: targetVersion, packageJsonPath, applied: false, error: msg });
                applyDiagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "version-apply-failed", `Failed to apply version to ${packageJsonPath}: ${msg}`));
            }
        }
        (0, cli_output_1.writeOutput)({ intent, applyResults, diagnostics: applyDiagnostics }, (0, diagnostics_1.hasErrors)(applyDiagnostics) ? 1 : 0, options);
        return;
    }
    if (!intent.target) {
        (0, cli_output_1.writeOutput)({
            diagnostics: [
                ...intentDiagnostics,
                (0, diagnostics_1.createDiagnostic)("error", "intent-target-missing", "Command intent is missing a supported target."),
            ],
        }, 1, options);
        return;
    }
    (0, cli_output_1.verboseLog)("repo discovery started", options);
    const discovery = await (0, discovery_1.discoverEnvRepo)(repoRoot);
    (0, cli_output_1.verboseLog)("repo discovery done", options);
    const repoModel = (0, model_1.buildRepoModel)(discovery);
    const plan = (0, resolver_1.resolvePlan)(repoModel, intent.target, intent.kind);
    (0, cli_output_1.verboseLog)("plan resolved", options);
    const diagnostics = [...intentDiagnostics, ...plan.diagnostics];
    const runtimeContext = {
        repoRoot,
        platform: process.platform,
        diagnostics,
        spawnExecution: spawn_1.spawnExecution,
    };
    if (intent.kind === "run") {
        const selection = (0, selection_1.resolveArtifactSelection)(plan.artifactExecutions, intent.artifactSelectors ?? []);
        diagnostics.push(...selection.diagnostics);
        if (!(0, diagnostics_1.hasErrors)(diagnostics)) {
            plan.selectedArtifacts = selection.artifactNames;
            plan.artifactExecutions = plan.artifactExecutions.filter((entry) => selection.artifactNames.includes(entry.artifactName));
            plan.execution =
                plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
                    plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
                    null;
            plan.pluginPackage = plan.execution?.pluginPackage;
        }
        const hydratedArtifactExecutions = await Promise.all(plan.artifactExecutions.map(async (artifactExecution) => {
            if (artifactExecution.status !== "runnable" || !artifactExecution.execution) {
                return artifactExecution;
            }
            const hydrated = await hydrateArtifactExecution(artifactExecution, runtimeContext.repoRoot, diagnostics, stateStore, plan.resolvedTarget);
            return {
                ...artifactExecution,
                execution: hydrated.execution,
            };
        }));
        plan.artifactExecutions = hydratedArtifactExecutions;
        plan.execution =
            plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
                plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
                null;
        plan.pluginPackage = plan.execution?.pluginPackage;
        const runnableArtifacts = plan.artifactExecutions.filter((a) => a.status === "runnable" && a.execution);
        for (const entry of runnableArtifacts) {
            const exec = entry.execution;
            const port = (0, port_utils_1.extractPortFromExecution)(exec.args, exec.env);
            if (port) {
                const portResult = await (0, port_utils_1.killPortHolder)(port);
                if (portResult.wasInUse && portResult.killed) {
                    diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "port-conflict-resolved", `Port ${String(port)} was in use (PID ${String(portResult.pid ?? "?")}) — process terminated before starting.`));
                }
                else if (portResult.wasInUse && !portResult.killed) {
                    diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "port-conflict-unresolved", `Port ${String(port)} is in use and could not be freed. Please stop the process manually.`));
                    (0, cli_output_1.writeOutput)({ intent, plan, diagnostics }, 1, options);
                    return;
                }
            }
        }
        if (plan.repoExecutions.length > 0) {
            const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options);
            (0, cli_output_1.verboseLog)("output written", options);
            (0, cli_output_1.writeOutput)({ intent, plan, deploy: deployResults.payload, deploySummary: deployResults.deploySummary, diagnostics }, (0, diagnostics_1.hasErrors)(diagnostics) ? 1 : deployResults.exitCode, options);
            return;
        }
        if (runnableArtifacts.length > 1 && !(0, diagnostics_1.hasErrors)(diagnostics)) {
            const waitForPortOpen = async (port, timeoutMs = 15000, pollMs = 300) => {
                const deadline = Date.now() + timeoutMs;
                while (Date.now() < deadline) {
                    if (await (0, lock_1.isPortOpen)(port))
                        return true;
                    await new Promise((r) => setTimeout(r, pollMs));
                }
                return false;
            };
            const pluginCache = new Map();
            const promises = runnableArtifacts.map(async (entry) => {
                const exec = entry.execution;
                const port = (0, port_utils_1.extractPortFromExecution)(exec.args, exec.env);
                const artifactMeta = repoModel.artifacts[entry.artifactName];
                const publicName = (artifactMeta?.PublicName ?? artifactMeta?.publicName ?? entry.artifactName);
                const url = port ? `http://localhost:${String(port)}/` : null;
                process.stdout.write(`  [starting] ${publicName}${url ? ` — ${url}` : ""}\n`);
                const spawnPromise = (async () => {
                    const pkg = exec.pluginPackage;
                    if (!pkg) {
                        const spawnResult = await (0, spawn_1.spawnExecution)({
                            command: exec.command,
                            args: exec.args,
                            env: exec.env,
                            cwd: exec.cwd,
                        });
                        return spawnResult.exitCode;
                    }
                    let loaded = pluginCache.get(pkg);
                    if (!loaded) {
                        loaded = await (0, loader_1.loadPlugin)(pkg, repoRoot);
                        pluginCache.set(pkg, loaded);
                    }
                    if (loaded.plugin.execute) {
                        const singlePlan = {
                            ...plan,
                            execution: exec,
                            pluginPackage: pkg,
                        };
                        const result = await loaded.plugin.execute(singlePlan, runtimeContext);
                        return result.exitCode ?? 1;
                    }
                    return 1;
                })();
                if (port) {
                    const ready = await Promise.race([
                        waitForPortOpen(port),
                        spawnPromise.then(() => false),
                    ]);
                    if (ready) {
                        process.stdout.write(`  [ok] ${publicName}${url ? ` — ${url}` : ""}\n`);
                    }
                }
                return spawnPromise;
            });
            const results = await Promise.all(promises);
            const exitCode = results.some((c) => c !== 0) ? 1 : 0;
            (0, cli_output_1.writeOutput)({ intent, plan, diagnostics }, exitCode, options);
            return;
        }
    }
    if (intent.kind === "deploy") {
        const challengeRequirement = (0, challenge_1.buildChallengeFromResolvedModel)(plan.resolvedModel, plan.resolvedTarget);
        if (challengeRequirement) {
            if (options.jsonResponse) {
                diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "challenge-required-non-interactive", `Deploy to "${plan.resolvedTarget}" requires interactive confirmation (challenge: "${challengeRequirement.phrase}"). ` +
                    `Cannot proceed in JSON/non-interactive mode.`));
                (0, cli_output_1.writeOutput)({ intent, plan, diagnostics }, 1, options);
                return;
            }
            const challengeResult = await (0, challenge_1.executeCliChallenge)(challengeRequirement);
            diagnostics.push(...challengeResult.diagnostics);
            if (!challengeResult.passed) {
                (0, cli_output_1.writeOutput)({ intent, plan, diagnostics }, 1, options);
                return;
            }
        }
        const selection = (0, selection_1.resolveArtifactSelection)(plan.artifactExecutions, intent.artifactSelectors ?? []);
        diagnostics.push(...selection.diagnostics);
        if (!(0, diagnostics_1.hasErrors)(diagnostics)) {
            plan.selectedArtifacts = selection.artifactNames;
            plan.artifactExecutions = plan.artifactExecutions.filter((entry) => selection.artifactNames.includes(entry.artifactName));
            plan.execution =
                plan.repoExecutions.find((repoExecution) => repoExecution.status === "runnable")?.execution ??
                    plan.artifactExecutions.find((artifactExecution) => artifactExecution.status === "runnable")?.execution ??
                    null;
        }
        const deployResults = await executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options);
        const exitCode = (0, diagnostics_1.hasErrors)(diagnostics) ? 1 : deployResults.exitCode;
        (0, cli_output_1.verboseLog)("output written", options);
        (0, cli_output_1.writeOutput)({ intent, plan, deploy: deployResults.payload, deploySummary: deployResults.deploySummary, diagnostics }, exitCode, options);
        return;
    }
    let pluginDetails;
    let executionResult;
    if (plan.pluginPackage) {
        (0, cli_output_1.verboseLog)(`plugin load: ${plan.pluginPackage}`, options);
        const loadedPlugin = await (0, loader_1.loadPlugin)(plan.pluginPackage, repoRoot);
        (0, cli_output_1.verboseLog)(`plugin loaded: ${plan.pluginPackage}`, options);
        diagnostics.push(...loadedPlugin.diagnostics);
        if (loadedPlugin.plugin.inspect) {
            const inspected = await loadedPlugin.plugin.inspect(runtimeContext);
            if (inspected.diagnostics) {
                diagnostics.push(...inspected.diagnostics);
            }
            pluginDetails = inspected.details;
        }
        if (!(0, diagnostics_1.hasErrors)(diagnostics)) {
            if (!loadedPlugin.plugin.execute) {
                diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "plugin-execute-missing", `Plugin "${plan.pluginPackage}" does not export execute().`));
            }
            else {
                (0, cli_output_1.verboseLog)("spawn started", options);
                const executed = await loadedPlugin.plugin.execute(plan, runtimeContext);
                (0, cli_output_1.verboseLog)("spawn done", options);
                if (executed.diagnostics) {
                    diagnostics.push(...executed.diagnostics);
                }
                executionResult = { exitCode: executed.exitCode, details: executed.details };
            }
        }
    }
    const exitCode = (0, diagnostics_1.hasErrors)(diagnostics)
        ? 1
        : typeof executionResult?.exitCode === "number"
            ? executionResult.exitCode
            : 0;
    (0, cli_output_1.verboseLog)("output written", options);
    (0, cli_output_1.writeOutput)({ intent, plan, plugin: pluginDetails, execution: executionResult, diagnostics }, exitCode, options);
}
async function promptYesNo(prompt) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(prompt, (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();
            // (Y/n) semantics: empty or non-"n" resolves to true
            resolve(trimmed !== "n" && trimmed !== "no");
        });
    });
}
function parseJsonRequestArg(jsonString) {
    let parsed;
    try {
        parsed = JSON.parse(jsonString);
    }
    catch {
        return {
            intent: null,
            diagnostics: [
                (0, diagnostics_1.createDiagnostic)("error", "json-request-parse-error", `--json-request argument is not valid JSON: ${jsonString}`),
            ],
        };
    }
    if (typeof parsed["kind"] !== "string") {
        return {
            intent: null,
            diagnostics: [
                (0, diagnostics_1.createDiagnostic)("error", "json-request-missing-kind", '--json-request JSON must contain a "kind" field (e.g. "run", "deploy", "service").'),
            ],
        };
    }
    const kind = parsed["kind"];
    const kindAlias = { service: "daemon" };
    const resolvedKind = kindAlias[kind] ?? kind;
    const supportedKinds = new Set(["daemon", "run", "deploy", "offiline-web-ui", "apply"]);
    if (!supportedKinds.has(resolvedKind)) {
        return {
            intent: null,
            diagnostics: [
                (0, diagnostics_1.createDiagnostic)("error", "json-request-invalid-kind", `--json-request "kind" must be one of: service, run, deploy, offiline-web-ui. Got: "${kind}".`),
            ],
        };
    }
    const target = typeof parsed["target"] === "string" ? parsed["target"] : undefined;
    const selectors = Array.isArray(parsed["selectors"]) ? parsed["selectors"] : undefined;
    return {
        intent: {
            kind: resolvedKind,
            target,
            rawArgs: [jsonString],
            normalizedTokens: [resolvedKind, ...(target ? [target] : [])],
            artifactSelectors: selectors,
        },
        diagnostics: [],
    };
}
async function killProcess(pid, port, timeoutMs = 6000, shutdownApiPort) {
    // Phase 1 — SIGTERM by PID if available
    if (pid !== null) {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { /* already dead */ }
    }
    // Phase 2 — HTTP shutdown endpoint (daemon API port, works for new daemons)
    const apiPort = shutdownApiPort ?? port;
    try {
        await fetch(`http://127.0.0.1:${apiPort}/daemon/shutdown`, {
            method: "POST",
            signal: AbortSignal.timeout(1500),
        });
    }
    catch { /* endpoint may not exist on old daemons */ }
    // Phase 3 — OS-level fallback: find PID via fuser and send SIGTERM
    if (pid === null) {
        try {
            const { execFileSync } = await Promise.resolve().then(() => __importStar(require("node:child_process")));
            const raw = execFileSync("fuser", [`${port}/tcp`], { stdio: ["ignore", "pipe", "ignore"] })
                .toString()
                .trim();
            for (const token of raw.split(/\s+/).filter(Boolean)) {
                const fuserPid = Number(token);
                if (fuserPid > 0) {
                    try {
                        process.kill(fuserPid, "SIGTERM");
                    }
                    catch { /* already dead */ }
                }
            }
        }
        catch { /* fuser not available or no matching process */ }
    }
    // Phase 4 — poll until port closes
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await (0, lock_1.isPortOpen)(port)))
            return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Phase 5 — last resort SIGKILL
    if (pid !== null) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch { /* already dead */ }
    }
    else {
        try {
            const { execFileSync } = await Promise.resolve().then(() => __importStar(require("node:child_process")));
            execFileSync("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
        }
        catch { /* fuser not available */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return !(await (0, lock_1.isPortOpen)(port));
}
function getLanIp() {
    const interfaces = node_os_1.default.networkInterfaces();
    for (const ifaces of Object.values(interfaces)) {
        if (!ifaces)
            continue;
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}
function buildUrlList(port, lanIp) {
    if (port === null)
        return [];
    const urls = [`http://localhost:${String(port)}`, `http://127.0.0.1:${String(port)}`];
    if (lanIp) {
        urls.push(`http://${lanIp}:${String(port)}`);
    }
    return urls;
}
void main().catch((error) => {
    const diagnostics = [
        (0, diagnostics_1.createDiagnostic)("error", "cli-failure", error instanceof Error ? error.message : "Unknown CLI failure."),
    ];
    process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
    process.exitCode = 1;
});
async function executeDeployPlan(plan, runtimeContext, diagnostics, stateStore, options) {
    const repoResults = [];
    const artifactResults = [];
    const deploySummary = [];
    let exitCode = 0;
    for (const repoExecution of plan.repoExecutions) {
        (0, cli_output_1.verboseLog)(`deploy step start: ${repoExecution.name}`, options);
        const filteredExecution = (0, plan_filter_1.applyPnpmRecursiveFilter)(repoExecution.execution, plan.artifactExecutions, plan.selectedArtifacts);
        const result = await executePlanItem(repoExecution.name, filteredExecution, runtimeContext, diagnostics);
        (0, cli_output_1.verboseLog)(`deploy step done: ${repoExecution.name} (exit ${String(result["exitCode"] ?? 0)})`, options);
        repoResults.push({ name: repoExecution.name, status: repoExecution.status, result });
        if ((result.exitCode ?? 0) !== 0) {
            exitCode = result.exitCode;
            return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults }, deploySummary };
        }
    }
    for (const artifactExecution of plan.artifactExecutions) {
        (0, cli_output_1.verboseLog)(`deploy step start: ${artifactExecution.runnerName}`, options);
        const existingRecord = await stateStore.getVersionRecord(runtimeContext.repoRoot, artifactExecution.artifactName, artifactExecution.packageName);
        const lastVersionBefore = existingRecord?.lastVersion ?? null;
        const hydrated = await hydrateArtifactExecution(artifactExecution, runtimeContext.repoRoot, diagnostics, stateStore, plan.resolvedTarget);
        const result = await executeArtifactDeploy(artifactExecution, hydrated.execution, hydrated.resolvedVersion, runtimeContext, diagnostics, stateStore, plan.resolvedTarget);
        (0, cli_output_1.verboseLog)(`deploy step done: ${artifactExecution.runnerName} (exit ${String(result.exitCode)})`, options);
        artifactResults.push(result.payload);
        if (result.exitCode === 0) {
            deploySummary.push({
                artifactName: artifactExecution.artifactName,
                packageName: result.payload["packageName"] ?? artifactExecution.packageName ?? artifactExecution.artifactName,
                lastVersion: lastVersionBefore,
                newVersion: hydrated.resolvedVersion,
            });
        }
        if (result.exitCode !== 0) {
            exitCode = result.exitCode;
            break;
        }
    }
    return { exitCode, payload: { repoExecutions: repoResults, artifactExecutions: artifactResults }, deploySummary };
}
async function hydrateArtifactExecution(artifactExecution, repoRoot, diagnostics, stateStore, deployTarget) {
    if (!artifactExecution.execution)
        return { execution: null, resolvedVersion: "0.1.0" };
    const packageDirectory = artifactExecution.repoCloneFolderPath
        ? node_path_1.default.resolve(repoRoot, artifactExecution.repoCloneFolderPath)
        : artifactExecution.execution.cwd;
    const existingRecord = await stateStore.getVersionRecord(repoRoot, artifactExecution.artifactName, artifactExecution.packageName);
    let resolvedVersionValue;
    if (existingRecord?.nextVersion) {
        resolvedVersionValue = existingRecord.nextVersion;
    }
    else if (existingRecord?.lastVersion) {
        resolvedVersionValue = existingRecord.lastVersion;
    }
    else {
        let packageJsonVersion = "0.1.0";
        if (packageDirectory) {
            try {
                const packageMetadata = await (0, runtime_1.readPackageMetadata)(packageDirectory);
                packageJsonVersion = packageMetadata.version;
            }
            catch {
                packageJsonVersion = "0.1.0";
            }
        }
        const { record } = await stateStore.bootstrapArtifactVersion(repoRoot, artifactExecution.artifactName, artifactExecution.packageName, packageJsonVersion);
        resolvedVersionValue = record.nextVersion ?? record.lastVersion ?? packageJsonVersion;
        diagnostics.push((0, diagnostics_1.createDiagnostic)("info", "version-bootstrapped", `Artifact "${artifactExecution.artifactName}" version initialized to "${resolvedVersionValue}" (derived from package.json "${packageJsonVersion}").`));
    }
    return {
        execution: (0, dynamic_version_1.materializeDynamicVersionExecution)(artifactExecution.execution, artifactExecution.artifactName, resolvedVersionValue),
        resolvedVersion: resolvedVersionValue,
    };
}
async function executeArtifactDeploy(artifactExecution, hydratedExecution, hydratedVersion, runtimeContext, diagnostics, stateStore, deployTarget) {
    if (!hydratedExecution) {
        return {
            exitCode: 1,
            payload: {
                artifactName: artifactExecution.artifactName,
                runnerName: artifactExecution.runnerName,
                status: artifactExecution.status,
                result: { exitCode: 1, skipped: true },
            },
        };
    }
    const isProductionPublish = deployTarget === "production-01" &&
        hydratedExecution.command === "npm" &&
        hydratedExecution.args[0] === "publish";
    const isLocalGlobalInstall_ = (0, plan_filter_1.isLocalGlobalInstall)(hydratedExecution.command, hydratedExecution.args);
    const needsVersionedInstall = isProductionPublish || isLocalGlobalInstall_;
    const packageDirectory = artifactExecution.repoCloneFolderPath
        ? node_path_1.default.resolve(runtimeContext.repoRoot, artifactExecution.repoCloneFolderPath)
        : hydratedExecution.cwd;
    if (!needsVersionedInstall || !packageDirectory) {
        const result = await executePlanItem(artifactExecution.runnerName, hydratedExecution, runtimeContext, diagnostics);
        return {
            exitCode: result.exitCode ?? 1,
            payload: {
                artifactName: artifactExecution.artifactName,
                runnerName: artifactExecution.runnerName,
                status: artifactExecution.status,
                result,
            },
        };
    }
    const packageMetadata = await (0, runtime_1.readPackageMetadata)(packageDirectory);
    const resolvedVersionValue = hydratedVersion;
    const executionToRun = {
        ...hydratedExecution,
        env: { ...hydratedExecution.env, EH_ARTIFACT_VERSION: resolvedVersionValue },
    };
    let result;
    if (isLocalGlobalInstall_) {
        const persistentCacheDir = stateStore.getPaths().cacheDirectory;
        const staged = await (0, runtime_1.stageAndPackLocal)(packageDirectory, resolvedVersionValue, persistentCacheDir);
        try {
            const tarballArgs = executionToRun.args.map((arg) => {
                if (arg === packageDirectory || node_path_1.default.resolve(arg) === node_path_1.default.resolve(packageDirectory)) {
                    return staged.tarballPath;
                }
                return arg;
            });
            const tarballExecution = { ...executionToRun, args: tarballArgs };
            result = await executePlanItem(artifactExecution.runnerName, tarballExecution, runtimeContext, diagnostics);
        }
        finally {
            await staged.cleanup();
        }
    }
    else {
        result = await (0, runtime_1.withTemporaryPackageVersion)(packageDirectory, resolvedVersionValue, async () => {
            return await executePlanItem(artifactExecution.runnerName, executionToRun, runtimeContext, diagnostics);
        });
    }
    const payload = {
        artifactName: artifactExecution.artifactName,
        packageName: artifactExecution.packageName ?? packageMetadata.name,
        runnerName: artifactExecution.runnerName,
        status: artifactExecution.status,
        version: resolvedVersionValue,
        result,
    };
    if ((result.exitCode ?? 0) === 0) {
        const updatedVersion = await stateStore.advanceArtifactVersion(runtimeContext.repoRoot, artifactExecution.artifactName, artifactExecution.packageName ?? packageMetadata.name, resolvedVersionValue, deployTarget);
        payload.versionRegistry = updatedVersion;
        const installedPackageName = artifactExecution.packageName ?? packageMetadata.name;
        if (installedPackageName === "envheaven") {
            await stateStore.writeInstalledCliVersion(resolvedVersionValue);
        }
        if (packageDirectory) {
            const tagResult = await (0, runtime_1.createArtifactDeployTag)(runtimeContext.repoRoot, packageDirectory, resolvedVersionValue, deployTarget);
            payload.tag = tagResult;
            if (tagResult.message) {
                diagnostics.push((0, diagnostics_1.createDiagnostic)("warning", "artifact-tag-warning", tagResult.message));
            }
        }
    }
    return { exitCode: result.exitCode ?? 1, payload };
}
async function executePlanItem(name, execution, runtimeContext, diagnostics) {
    if (!execution)
        return { skipped: true, exitCode: 0 };
    if (execution.pluginPackage) {
        const loadedPlugin = await (0, loader_1.loadPlugin)(execution.pluginPackage, runtimeContext.repoRoot);
        diagnostics.push(...loadedPlugin.diagnostics);
        if (loadedPlugin.plugin.inspect) {
            const inspected = await loadedPlugin.plugin.inspect(runtimeContext);
            if (inspected.diagnostics)
                diagnostics.push(...inspected.diagnostics);
        }
        if (!loadedPlugin.plugin.execute) {
            diagnostics.push((0, diagnostics_1.createDiagnostic)("error", "plugin-execute-missing", `Plugin "${execution.pluginPackage}" does not export execute().`));
            return { exitCode: 1 };
        }
        const executed = await loadedPlugin.plugin.execute({
            kind: "run",
            requestedTarget: "default",
            resolvedTarget: "default",
            targetResolutionTrace: [],
            mergeOrder: [],
            selectedArtifacts: [],
            diagnostics: [],
            trace: [],
            repoExecutions: [],
            artifactExecutions: [],
            execution,
            pluginPackage: execution.pluginPackage,
            resolvedModel: {},
        }, runtimeContext);
        if (executed.diagnostics)
            diagnostics.push(...executed.diagnostics);
        return { exitCode: executed.exitCode, details: executed.details };
    }
    if (!execution.command)
        return { skipped: true, exitCode: 0 };
    const result = await runtimeContext.spawnExecution({
        command: execution.command,
        args: execution.args,
        env: execution.env,
        cwd: execution.cwd,
    });
    return { exitCode: result.exitCode };
}
