"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPortInUse = isPortInUse;
exports.findPidOnPort = findPidOnPort;
exports.killPortHolder = killPortHolder;
exports.extractPortFromExecution = extractPortFromExecution;
const node_child_process_1 = require("node:child_process");
const node_net_1 = require("node:net");
async function isPortInUse(port) {
    return new Promise((resolve) => {
        const socket = (0, node_net_1.createConnection)({ port, host: "127.0.0.1" });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            resolve(false);
        });
        socket.setTimeout(800, () => {
            socket.destroy();
            resolve(false);
        });
    });
}
function findPidOnPort(port) {
    try {
        const raw = (0, node_child_process_1.execFileSync)("fuser", [`${port}/tcp`], {
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
        const pids = raw
            .split(/\s+/)
            .filter(Boolean)
            .map(Number)
            .filter((n) => n > 0);
        return pids[0] ?? null;
    }
    catch {
        return null;
    }
}
async function killPortHolder(port, timeoutMs = 4000) {
    const inUse = await isPortInUse(port);
    if (!inUse) {
        return { port, wasInUse: false, killed: false, pid: null };
    }
    const pid = findPidOnPort(port);
    if (pid !== null) {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch {
            /* already dead */
        }
    }
    else {
        try {
            (0, node_child_process_1.execFileSync)("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
        }
        catch {
            /* fuser unavailable */
        }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isPortInUse(port))) {
            return { port, wasInUse: true, killed: true, pid };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (pid !== null) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            /* already dead */
        }
    }
    else {
        try {
            (0, node_child_process_1.execFileSync)("fuser", ["-k", "-9", `${port}/tcp`], { stdio: "ignore" });
        }
        catch {
            /* fuser unavailable */
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stillInUse = await isPortInUse(port);
    return { port, wasInUse: true, killed: !stillInUse, pid };
}
function extractPortFromExecution(args, env) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port" && i + 1 < args.length) {
            const parsed = parseInt(args[i + 1], 10);
            if (parsed > 0)
                return parsed;
        }
        const portMatch = /^--port[=:](\d+)$/.exec(args[i]);
        if (portMatch) {
            const parsed = parseInt(portMatch[1], 10);
            if (parsed > 0)
                return parsed;
        }
    }
    for (const [key, value] of Object.entries(env)) {
        if (/^(.*_)?PORT$/i.test(key) && value) {
            const parsed = parseInt(value, 10);
            if (parsed > 0)
                return parsed;
        }
    }
    return null;
}
