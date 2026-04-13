"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvHeavenStateStore = void 0;
exports.resolveEnvHeavenPaths = resolveEnvHeavenPaths;
exports.buildRepoId = buildRepoId;
exports.buildArtifactKey = buildArtifactKey;
exports.incrementPatchVersion = incrementPatchVersion;
exports.incrementMinorVersion = incrementMinorVersion;
exports.incrementExpVersion = incrementExpVersion;
exports.parseExpVersion = parseExpVersion;
exports.isValidVersionString = isValidVersionString;
exports.isValidExpVersionString = isValidExpVersionString;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const STATE_SCHEMA_VERSION = 1;
class EnvHeavenStateStore {
    paths;
    cache = null;
    constructor(paths = resolveEnvHeavenPaths(process.platform, process.env)) {
        this.paths = paths;
    }
    getPaths() {
        return this.paths;
    }
    async listRepos() {
        const state = await this.loadState();
        return state.recentRepoIds
            .map((repoId) => state.repos[repoId])
            .filter((entry) => Boolean(entry));
    }
    async rememberRepo(repoRoot) {
        // Always force-reload from disk before writing so that concurrent processes
        // (daemon + CLI) do not overwrite each other's state with a stale cache.
        const state = await this.loadState(true);
        const repoId = buildRepoId(repoRoot);
        const existing = state.repos[repoId];
        const repoRecord = existing ?? {
            repoId,
            repoRoot,
            artifacts: {},
            updatedAt: new Date().toISOString(),
        };
        repoRecord.repoRoot = repoRoot;
        repoRecord.updatedAt = new Date().toISOString();
        state.repos[repoId] = repoRecord;
        state.recentRepoIds = [repoId, ...state.recentRepoIds.filter((entry) => entry !== repoId)].slice(0, 25);
        state.selectedRepoId = repoId;
        await this.saveState(state);
        return repoRecord;
    }
    async setSelectedRepo(repoRoot) {
        return await this.rememberRepo(repoRoot);
    }
    async getSelectedRepo(preferredRepoRoot) {
        const state = await this.loadState();
        if (preferredRepoRoot) {
            return state.repos[buildRepoId(preferredRepoRoot)] ?? null;
        }
        if (state.selectedRepoId) {
            return state.repos[state.selectedRepoId] ?? null;
        }
        const firstRepoId = state.recentRepoIds[0];
        return firstRepoId ? state.repos[firstRepoId] ?? null : null;
    }
    invalidateCache() {
        this.cache = null;
    }
    async getVersionRecords(repoRoot) {
        const repoRecord = await this.ensureRepo(repoRoot);
        return Object.values(repoRecord.artifacts).sort((left, right) => left.artifactName.localeCompare(right.artifactName));
    }
    async getVersionRecord(repoRoot, artifactName, packageName) {
        const repoRecord = await this.ensureRepo(repoRoot);
        return repoRecord.artifacts[buildArtifactKey(artifactName, packageName)] ?? null;
    }
    async setArtifactVersion(repoRoot, artifactName, packageName, updates) {
        // Force reload from disk on every write so that concurrent processes
        // (e.g. daemon and CLI running simultaneously) do not overwrite each
        // other's state with a stale in-memory cache.
        const state = await this.loadState(true);
        const repoRecord = await this.requireRepo(state, repoRoot);
        const recordKey = buildArtifactKey(artifactName, packageName);
        const existing = repoRecord.artifacts[recordKey];
        const nextRecord = {
            artifactName,
            packageName,
            lastVersion: updates.lastVersion ?? existing?.lastVersion,
            nextVersion: updates.nextVersion ?? existing?.nextVersion,
            updatedAt: new Date().toISOString(),
        };
        repoRecord.artifacts[recordKey] = nextRecord;
        repoRecord.updatedAt = nextRecord.updatedAt;
        await this.saveState(state);
        return nextRecord;
    }
    async incrementArtifactNextVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
        const nextVersion = incrementPatchVersion(baseVersion);
        return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
            lastVersion: existing?.lastVersion,
            nextVersion,
        });
    }
    async resolveArtifactVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const record = await this.getVersionRecord(repoRoot, artifactName, packageName);
        if (record?.nextVersion) {
            return {
                value: record.nextVersion,
                source: "registry-next",
                record,
            };
        }
        if (record?.lastVersion) {
            return {
                value: record.lastVersion,
                source: "registry-last",
                record,
            };
        }
        return {
            value: fallbackVersion,
            source: "fallback",
        };
    }
    async bootstrapArtifactVersion(repoRoot, artifactName, packageName, packageJsonVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        if (existing?.nextVersion || existing?.lastVersion) {
            return { record: existing, bootstrapped: false };
        }
        const nextVersion = incrementPatchVersion(packageJsonVersion);
        const record = await this.setArtifactVersion(repoRoot, artifactName, packageName, { nextVersion });
        return { record, bootstrapped: true };
    }
    async incrementArtifactExpVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
        const nextVersion = incrementExpVersion(baseVersion);
        return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
            lastVersion: existing?.lastVersion,
            nextVersion,
        });
    }
    async incrementArtifactMinorVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
        const nextVersion = incrementMinorVersion(baseVersion);
        return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
            lastVersion: existing?.lastVersion,
            nextVersion,
        });
    }
    async advanceArtifactVersion(repoRoot, artifactName, packageName, deployedVersion, deployTarget) {
        const isLocalTarget = deployTarget?.toLowerCase().includes("local") ?? false;
        const nextVersion = isLocalTarget
            ? incrementExpVersion(deployedVersion)
            : incrementPatchVersion(deployedVersion);
        return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
            lastVersion: deployedVersion,
            nextVersion,
        });
    }
    async ensureRepo(repoRoot) {
        await this.rememberRepo(repoRoot);
        const state = await this.loadState();
        return await this.requireRepo(state, repoRoot);
    }
    async requireRepo(state, repoRoot) {
        const repoId = buildRepoId(repoRoot);
        const repoRecord = state.repos[repoId];
        if (repoRecord) {
            return repoRecord;
        }
        await this.rememberRepo(repoRoot);
        const refreshed = await this.loadState(true);
        return refreshed.repos[repoId];
    }
    async loadState(forceReload = false) {
        if (this.cache && !forceReload) {
            return this.cache;
        }
        await node_fs_1.promises.mkdir(this.paths.stateDirectory, { recursive: true });
        try {
            const raw = await node_fs_1.promises.readFile(this.paths.stateFilePath, "utf8");
            const parsed = JSON.parse(raw);
            const normalized = normalizeStateFile(parsed);
            this.cache = normalized;
            return normalized;
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
        const emptyState = {
            schemaVersion: STATE_SCHEMA_VERSION,
            recentRepoIds: [],
            repos: {},
        };
        this.cache = emptyState;
        await this.saveState(emptyState);
        return emptyState;
    }
    async saveState(state) {
        this.cache = normalizeStateFile(state);
        await node_fs_1.promises.mkdir(this.paths.stateDirectory, { recursive: true });
        await node_fs_1.promises.writeFile(this.paths.stateFilePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    }
    async writeInstalledCliVersion(version) {
        await node_fs_1.promises.mkdir(this.paths.stateDirectory, { recursive: true });
        const versionFilePath = node_path_1.default.join(this.paths.stateDirectory, "cli-version");
        await node_fs_1.promises.writeFile(versionFilePath, version, "utf8");
    }
    readInstalledCliVersionSync() {
        try {
            const versionFilePath = node_path_1.default.join(this.paths.stateDirectory, "cli-version");
            return (0, node_fs_1.readFileSync)(versionFilePath, "utf8").trim() || null;
        }
        catch {
            return null;
        }
    }
}
exports.EnvHeavenStateStore = EnvHeavenStateStore;
function resolveEnvHeavenPaths(platform, env, homeDirectory = node_os_1.default.homedir()) {
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA ?? env.APPDATA ?? node_path_1.default.join(homeDirectory, "AppData", "Local");
        const appRoot = node_path_1.default.join(localAppData, "EnvHeaven");
        return {
            cacheDirectory: node_path_1.default.join(appRoot, "cache"),
            configDirectory: node_path_1.default.join(appRoot, "config"),
            stateDirectory: node_path_1.default.join(appRoot, "state"),
            stateFilePath: node_path_1.default.join(appRoot, "state", "state.json"),
            toolsDirectory: node_path_1.default.join(appRoot, "cache", "tools"),
        };
    }
    const configHome = env.XDG_CONFIG_HOME ?? node_path_1.default.join(homeDirectory, ".config");
    const stateHome = env.XDG_STATE_HOME ?? node_path_1.default.join(homeDirectory, ".local", "state");
    const cacheHome = env.XDG_CACHE_HOME ?? node_path_1.default.join(homeDirectory, ".cache");
    return {
        cacheDirectory: node_path_1.default.join(cacheHome, "envheaven"),
        configDirectory: node_path_1.default.join(configHome, "envheaven"),
        stateDirectory: node_path_1.default.join(stateHome, "envheaven"),
        stateFilePath: node_path_1.default.join(stateHome, "envheaven", "state.json"),
        toolsDirectory: node_path_1.default.join(cacheHome, "envheaven", "tools"),
    };
}
function buildRepoId(repoRoot) {
    return (0, node_crypto_1.createHash)("sha1").update(node_path_1.default.resolve(repoRoot)).digest("hex");
}
function buildArtifactKey(artifactName, packageName) {
    return packageName ? `${artifactName}::${packageName}` : artifactName;
}
function incrementPatchVersion(version) {
    const parsed = parseVersion(version);
    if (!parsed) {
        return "0.1.0";
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}
function incrementMinorVersion(version) {
    const exp = parseExpVersion(version);
    if (exp) {
        return `${exp.major}.${exp.minor + 1}.0`;
    }
    const parsed = parseVersion(version);
    if (!parsed) {
        return "0.2.0";
    }
    return `${parsed.major}.${parsed.minor + 1}.0`;
}
function incrementExpVersion(version) {
    const exp = parseExpVersion(version);
    if (exp) {
        return `${exp.major}.${exp.minor}.${exp.patch}-exp.${exp.exp + 1}`;
    }
    const parsed = parseVersion(version);
    if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-exp.0`;
    }
    return "0.1.1-exp.0";
}
function parseExpVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)[.\-]exp\.(0|[1-9]\d*)$/.exec(value.trim());
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        exp: Number(match[4]),
    };
}
function isValidVersionString(value) {
    return parseVersion(value) !== null || parseExpVersion(value) !== null;
}
function isValidExpVersionString(value) {
    return parseExpVersion(value) !== null;
}
function normalizeStateFile(input) {
    const repos = isRecord(input.repos) ? input.repos : {};
    const normalizedRepos = {};
    for (const [repoId, repoValue] of Object.entries(repos)) {
        if (!isRecord(repoValue) || typeof repoValue.repoRoot !== "string") {
            continue;
        }
        const artifacts = isRecord(repoValue.artifacts) ? repoValue.artifacts : {};
        const normalizedArtifacts = {};
        for (const [artifactKey, artifactValue] of Object.entries(artifacts)) {
            if (!isRecord(artifactValue) || typeof artifactValue.artifactName !== "string") {
                continue;
            }
            normalizedArtifacts[artifactKey] = {
                artifactName: artifactValue.artifactName,
                packageName: typeof artifactValue.packageName === "string" ? artifactValue.packageName : undefined,
                lastVersion: typeof artifactValue.lastVersion === "string" ? artifactValue.lastVersion : undefined,
                nextVersion: typeof artifactValue.nextVersion === "string" ? artifactValue.nextVersion : undefined,
                updatedAt: typeof artifactValue.updatedAt === "string" ? artifactValue.updatedAt : new Date(0).toISOString(),
            };
        }
        normalizedRepos[repoId] = {
            repoId,
            repoRoot: repoValue.repoRoot,
            artifacts: normalizedArtifacts,
            updatedAt: typeof repoValue.updatedAt === "string" ? repoValue.updatedAt : new Date(0).toISOString(),
        };
    }
    const recentRepoIds = Array.isArray(input.recentRepoIds)
        ? input.recentRepoIds.filter((entry) => typeof entry === "string")
        : [];
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        selectedRepoId: typeof input.selectedRepoId === "string" ? input.selectedRepoId : undefined,
        recentRepoIds: recentRepoIds.filter((repoId) => repoId in normalizedRepos),
        repos: normalizedRepos,
    };
}
function parseVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
