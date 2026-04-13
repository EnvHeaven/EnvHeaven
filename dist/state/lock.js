"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLockFilePath = getLockFilePath;
exports.readLockFile = readLockFile;
exports.writeLockFile = writeLockFile;
exports.clearLockFile = clearLockFile;
exports.isPortOpen = isPortOpen;
exports.waitForLockFile = waitForLockFile;
const node_fs_1 = require("node:fs");
const node_net_1 = __importDefault(require("node:net"));
const node_path_1 = __importDefault(require("node:path"));
function getLockFilePath(paths) {
    return node_path_1.default.join(paths.stateDirectory, "running.lock.json");
}
async function readLockFile(paths) {
    try {
        const raw = await node_fs_1.promises.readFile(getLockFilePath(paths), "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.daemonPort !== "number")
            return null;
        return {
            daemonPort: parsed.daemonPort,
            uiPort: typeof parsed.uiPort === "number" ? parsed.uiPort : null,
            startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
            daemonPid: typeof parsed.daemonPid === "number" ? parsed.daemonPid : undefined,
            uiPid: typeof parsed.uiPid === "number" ? parsed.uiPid : undefined,
        };
    }
    catch {
        return null;
    }
}
async function writeLockFile(paths, lock) {
    const lockPath = getLockFilePath(paths);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(lockPath), { recursive: true });
    await node_fs_1.promises.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}
async function clearLockFile(paths) {
    try {
        await node_fs_1.promises.unlink(getLockFilePath(paths));
    }
    catch {
        // ignore if already gone
    }
}
function isPortOpen(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const socket = node_net_1.default.createConnection({ port, host });
        socket.setTimeout(1500);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => {
            resolve(false);
        });
    });
}
/**
 * Poll until lock file exists and daemon port is reachable.
 * Pass requireUiPort=true to also wait until uiPort is present and reachable.
 */
async function waitForLockFile(paths, timeoutMs = 18000, pollIntervalMs = 300, requireUiPort = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const lock = await readLockFile(paths);
        if (lock && lock.daemonPort > 0 && (await isPortOpen(lock.daemonPort))) {
            if (!requireUiPort)
                return lock;
            if (lock.uiPort && lock.uiPort > 0 && (await isPortOpen(lock.uiPort)))
                return lock;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return null;
}
