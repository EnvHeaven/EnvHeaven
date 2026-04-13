"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPreferences = loadPreferences;
exports.savePreferences = savePreferences;
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function getPreferencesPath() {
    return node_path_1.default.join(node_os_1.default.homedir(), ".envheaven", "preferences.json");
}
async function loadPreferences() {
    try {
        const raw = await node_fs_1.promises.readFile(getPreferencesPath(), "utf8");
        const parsed = JSON.parse(raw);
        return {
            autoStartUi: typeof parsed.autoStartUi === "boolean" ? parsed.autoStartUi : false,
        };
    }
    catch {
        return null;
    }
}
async function savePreferences(prefs) {
    const prefsPath = getPreferencesPath();
    await node_fs_1.promises.mkdir(node_path_1.default.dirname(prefsPath), { recursive: true });
    await node_fs_1.promises.writeFile(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf8");
}
