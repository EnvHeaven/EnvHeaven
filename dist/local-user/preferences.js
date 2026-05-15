"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPinnedArtifactIds = loadPinnedArtifactIds;
exports.savePinnedArtifactIds = savePinnedArtifactIds;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const ENV_DIR = ".envheaven";
const LOCAL_USER_SUBDIR = "local-user";
const PINNED_ARTIFACTS_FILE = "pinned-artifacts.json";
async function loadPinnedArtifactIds(repoRoot) {
    try {
        const raw = await node_fs_1.promises.readFile(pinnedArtifactsPath(repoRoot), "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed["artifactIds"])
            ? parsed["artifactIds"].filter((id) => typeof id === "string" && id.length > 0)
            : [];
    }
    catch {
        return [];
    }
}
async function savePinnedArtifactIds(repoRoot, artifactIds) {
    const filePath = pinnedArtifactsPath(repoRoot);
    await ensureLocalUserGitIgnore(repoRoot);
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    const uniqueIds = [...new Set(artifactIds.filter((id) => typeof id === "string" && id.length > 0))];
    await node_fs_1.promises.writeFile(filePath, JSON.stringify({ artifactIds: uniqueIds }, null, 2) + "\n", "utf8");
}
function pinnedArtifactsPath(repoRoot) {
    return node_path_1.default.join(repoRoot, ENV_DIR, LOCAL_USER_SUBDIR, PINNED_ARTIFACTS_FILE);
}
async function ensureLocalUserGitIgnore(repoRoot) {
    const gitIgnorePath = node_path_1.default.join(repoRoot, ENV_DIR, ".gitignore");
    const localUserIgnoreBlock = [
        "",
        "# local-user data (user-specific, not committed to repo)",
        "**/local-user/**/*",
        "!**/.keep",
        "",
    ].join("\n");
    try {
        const existing = await node_fs_1.promises.readFile(gitIgnorePath, "utf8");
        if (existing.includes("**/local-user/**/*"))
            return;
        await node_fs_1.promises.writeFile(gitIgnorePath, `${existing.replace(/\s*$/, "")}\n${localUserIgnoreBlock}`, "utf8");
    }
    catch {
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(gitIgnorePath), { recursive: true });
        await node_fs_1.promises.writeFile(gitIgnorePath, localUserIgnoreBlock.trimStart(), "utf8");
    }
}
