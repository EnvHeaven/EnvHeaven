"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadActions = loadActions;
exports.deleteAction = deleteAction;
exports.saveAction = saveAction;
exports.moveAction = moveAction;
exports.loadArtifactMeta = loadArtifactMeta;
exports.saveArtifactMeta = saveArtifactMeta;
exports.normalizePageHeaderOptions = normalizePageHeaderOptions;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const ENV_DIR = ".envheaven";
const ACTIONS_SUBDIR = "actions";
const LOCAL_USER_SUBDIR = "local-user";
const ACTION_SUFFIX = ".envheaven.action.json";
const ARTIFACT_META_FILE = "artifact-meta.json";
async function loadActions(repoRoot) {
    const actionsDir = node_path_1.default.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
    const localUserDir = node_path_1.default.join(actionsDir, LOCAL_USER_SUBDIR);
    const actions = [];
    const baseActions = await loadActionsFromDir(actionsDir, false);
    actions.push(...baseActions);
    const localActions = await loadActionsFromDir(localUserDir, true);
    actions.push(...localActions);
    return actions;
}
async function loadActionsFromDir(dir, isLocalUser) {
    try {
        const files = await node_fs_1.promises.readdir(dir);
        const actionFiles = files.filter((f) => f.endsWith(ACTION_SUFFIX));
        if (actionFiles.length === 0) {
            return [];
        }
        const actions = [];
        for (const file of actionFiles.sort()) {
            try {
                const raw = await node_fs_1.promises.readFile(node_path_1.default.join(dir, file), "utf8");
                const parsed = JSON.parse(raw);
                const action = normalizeAction(parsed, isLocalUser);
                if (action) {
                    actions.push(action);
                }
            }
            catch {
                // skip malformed files
            }
        }
        return actions;
    }
    catch {
        return [];
    }
}
async function deleteAction(repoRoot, actionId) {
    const actionsDir = node_path_1.default.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
    const basePath = node_path_1.default.join(actionsDir, `${actionId}${ACTION_SUFFIX}`);
    const localPath = node_path_1.default.join(actionsDir, LOCAL_USER_SUBDIR, `${actionId}${ACTION_SUFFIX}`);
    try {
        await node_fs_1.promises.unlink(localPath);
        return;
    }
    catch {
        // not in local-user, try base
    }
    await node_fs_1.promises.unlink(basePath);
}
async function saveAction(repoRoot, action) {
    const actionsDir = node_path_1.default.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
    const targetDir = action.isLocalUser
        ? node_path_1.default.join(actionsDir, LOCAL_USER_SUBDIR)
        : actionsDir;
    await node_fs_1.promises.mkdir(targetDir, { recursive: true });
    const filePath = node_path_1.default.join(targetDir, `${action.id}${ACTION_SUFFIX}`);
    const toWrite = { ...action };
    delete toWrite.isLocalUser;
    await node_fs_1.promises.writeFile(filePath, JSON.stringify(toWrite, null, 2) + "\n", "utf8");
}
async function moveAction(repoRoot, actionId, toLocalUser) {
    const actionsDir = node_path_1.default.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
    const basePath = node_path_1.default.join(actionsDir, `${actionId}${ACTION_SUFFIX}`);
    const localDir = node_path_1.default.join(actionsDir, LOCAL_USER_SUBDIR);
    const localPath = node_path_1.default.join(localDir, `${actionId}${ACTION_SUFFIX}`);
    if (toLocalUser) {
        await node_fs_1.promises.mkdir(localDir, { recursive: true });
        const raw = await node_fs_1.promises.readFile(basePath, "utf8");
        await node_fs_1.promises.writeFile(localPath, raw, "utf8");
        await node_fs_1.promises.unlink(basePath);
    }
    else {
        const raw = await node_fs_1.promises.readFile(localPath, "utf8");
        await node_fs_1.promises.writeFile(basePath, raw, "utf8");
        await node_fs_1.promises.unlink(localPath);
    }
}
async function loadArtifactMeta(repoRoot) {
    const metaPath = node_path_1.default.join(repoRoot, ENV_DIR, ARTIFACT_META_FILE);
    try {
        const raw = await node_fs_1.promises.readFile(metaPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
async function saveArtifactMeta(repoRoot, meta) {
    const envDir = node_path_1.default.join(repoRoot, ENV_DIR);
    await node_fs_1.promises.mkdir(envDir, { recursive: true });
    const metaPath = node_path_1.default.join(envDir, ARTIFACT_META_FILE);
    await node_fs_1.promises.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}
function normalizeAction(parsed, isLocalUser = false) {
    if (typeof parsed["id"] !== "string" || typeof parsed["runCommand"] !== "string") {
        return null;
    }
    return {
        id: parsed["id"],
        label: typeof parsed["label"] === "string" ? parsed["label"] : parsed["id"],
        runCommand: parsed["runCommand"],
        stopCommand: typeof parsed["stopCommand"] === "string" ? parsed["stopCommand"] : null,
        icon: typeof parsed["icon"] === "string" ? parsed["icon"] : "play",
        description: typeof parsed["description"] === "string" ? parsed["description"] : "",
        runLabel: typeof parsed["runLabel"] === "string" ? parsed["runLabel"] : "Run",
        stopLabel: typeof parsed["stopLabel"] === "string" ? parsed["stopLabel"] : "Stop",
        successHelpers: normalizeHelpers(parsed["successHelpers"]),
        failHelpers: normalizeHelpers(parsed["failHelpers"]),
        pageHeaderOptions: normalizePageHeaderOptions(parsed["pageHeaderOptions"]),
        isLocalUser,
        buttonColor: typeof parsed["buttonColor"] === "string" ? parsed["buttonColor"] : undefined,
    };
}
function normalizePageHeaderOptions(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const r = raw;
    if (r["isFixedOnHeader"] !== true)
        return undefined;
    return {
        isFixedOnHeader: true,
        hasToReplaceActionText: r["hasToReplaceActionText"] === true,
        actionTextToReplace: typeof r["actionTextToReplace"] === "string" ? r["actionTextToReplace"] : "",
    };
}
function normalizeHelpers(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.filter(isHelper);
}
function isHelper(h) {
    if (typeof h !== "object" || h === null)
        return false;
    const hh = h;
    return ((hh["kind"] === "open-url" || hh["kind"] === "copy-text") &&
        typeof hh["label"] === "string" &&
        typeof hh["value"] === "string");
}
