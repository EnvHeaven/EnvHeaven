"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvHeavenStateStore = exports.PERSISTED_VERSION_TRACKS = void 0;
exports.resolveEnvHeavenPaths = resolveEnvHeavenPaths;
exports.buildRepoId = buildRepoId;
exports.buildArtifactKey = buildArtifactKey;
exports.incrementPatchVersion = incrementPatchVersion;
exports.decrementPatchVersion = decrementPatchVersion;
exports.incrementMinorVersion = incrementMinorVersion;
exports.incrementExpVersion = incrementExpVersion;
exports.incrementBetaVersion = incrementBetaVersion;
exports.parseExpVersion = parseExpVersion;
exports.parseBetaVersion = parseBetaVersion;
exports.isValidVersionString = isValidVersionString;
exports.isValidExpVersionString = isValidExpVersionString;
exports.normalizeArtifactVersionRecord = normalizeArtifactVersionRecord;
exports.getTrackState = getTrackState;
exports.toPersistedTrack = toPersistedTrack;
exports.isVersionTrack = isVersionTrack;
exports.versionMatchesTrack = versionMatchesTrack;
exports.incrementVersionForTrack = incrementVersionForTrack;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const STATE_SCHEMA_VERSION = 1;
exports.PERSISTED_VERSION_TRACKS = ["exp", "canary", "alpha", "beta", "rc", "release"];
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
            controlPanelPresets: {},
            updatedAt: new Date().toISOString(),
        };
        repoRecord.repoRoot = repoRoot;
        repoRecord.controlPanelPresets ??= {};
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
    async listControlPanelPresets(repoRoot, artifactId) {
        const state = await this.loadState(true);
        const repos = repoRoot
            ? [state.repos[buildRepoId(repoRoot)]].filter((repo) => Boolean(repo))
            : Object.values(state.repos);
        return repos
            .flatMap((repo) => Object.values(repo.controlPanelPresets ?? {}))
            .filter((preset) => !artifactId || preset.artifactId === artifactId)
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    async upsertControlPanelPreset(repoRoot, preset) {
        await this.rememberRepo(repoRoot);
        const state = await this.loadState(true);
        const repoRecord = state.repos[buildRepoId(repoRoot)];
        const now = Date.now();
        const existing = repoRecord.controlPanelPresets[preset.id];
        const nextPreset = {
            ...preset,
            repoRoot,
            createdAt: existing?.createdAt ?? preset.createdAt ?? now,
            updatedAt: now,
        };
        repoRecord.controlPanelPresets[preset.id] = nextPreset;
        repoRecord.updatedAt = new Date(now).toISOString();
        await this.saveState(state);
        return nextPreset;
    }
    async deleteControlPanelPreset(repoRoot, presetId) {
        await this.rememberRepo(repoRoot);
        const state = await this.loadState(true);
        const repoRecord = state.repos[buildRepoId(repoRoot)];
        const existed = presetId in repoRecord.controlPanelPresets;
        if (existed) {
            delete repoRecord.controlPanelPresets[presetId];
            repoRecord.updatedAt = new Date().toISOString();
            await this.saveState(state);
        }
        return existed;
    }
    async getVersionRecords(repoRoot) {
        const repoRecord = await this.ensureRepo(repoRoot);
        return Object.values(repoRecord.artifacts).sort((left, right) => left.artifactName.localeCompare(right.artifactName));
    }
    async getVersionRecord(repoRoot, artifactName, packageName) {
        const repoRecord = await this.ensureRepo(repoRoot);
        const record = repoRecord.artifacts[buildArtifactKey(artifactName, packageName)] ?? null;
        return record ? normalizeArtifactVersionRecord(record) : null;
    }
    async setArtifactVersion(repoRoot, artifactName, packageName, updates) {
        return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "release", updates);
    }
    async setArtifactTrackVersion(repoRoot, artifactName, packageName, track, updates) {
        // Force reload from disk on every write so that concurrent processes
        // (e.g. daemon and CLI running simultaneously) do not overwrite each
        // other's state with a stale in-memory cache.
        const state = await this.loadState(true);
        const repoRecord = await this.requireRepo(state, repoRoot);
        const recordKey = buildArtifactKey(artifactName, packageName);
        const existing = normalizeArtifactVersionRecord(repoRecord.artifacts[recordKey] ?? {
            artifactName,
            packageName,
            updatedAt: new Date(0).toISOString(),
        });
        const nextRecord = withTrackUpdates(existing, track, updates);
        repoRecord.artifacts[recordKey] = nextRecord;
        repoRecord.updatedAt = nextRecord.updatedAt;
        await this.saveState(state);
        return nextRecord;
    }
    async incrementArtifactNextVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const releaseState = getTrackState(existing, "release");
        const baseVersion = releaseState?.nextVersion ?? releaseState?.lastVersion ?? fallbackVersion ?? "0.1.0";
        const nextVersion = incrementPatchVersion(baseVersion);
        return await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
            lastVersion: releaseState?.lastVersion,
            nextVersion,
        });
    }
    async resolveArtifactVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const record = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const releaseState = getTrackState(record, "release");
        if (releaseState?.nextVersion) {
            return {
                value: releaseState.nextVersion,
                source: "registry-next",
                record: record ?? undefined,
            };
        }
        if (releaseState?.lastVersion) {
            return {
                value: releaseState.lastVersion,
                source: "registry-last",
                record: record ?? undefined,
            };
        }
        return {
            value: fallbackVersion,
            source: "fallback",
        };
    }
    async bootstrapArtifactVersion(repoRoot, artifactName, packageName, packageJsonVersion, track = "patch") {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const persistedTrack = toPersistedTrack(track);
        const trackState = getTrackState(existing, persistedTrack);
        if (trackState?.nextVersion || trackState?.lastVersion) {
            return { record: existing, bootstrapped: false };
        }
        let record = existing;
        const releaseState = getTrackState(existing, "release");
        const releaseNext = releaseState?.nextVersion ??
            releaseState?.lastVersion ??
            incrementPatchVersion(packageJsonVersion);
        if (!releaseState?.nextVersion && !releaseState?.lastVersion) {
            record = await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
                nextVersion: releaseNext,
            });
        }
        const nextVersion = persistedTrack === "release"
            ? incrementVersionForTrack(packageJsonVersion, track)
            : derivePrereleaseFromReleaseBase(releaseNext, persistedTrack);
        record = await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, persistedTrack, { nextVersion });
        return { record, bootstrapped: true };
    }
    async incrementArtifactExpVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const expState = getTrackState(existing, "exp");
        const releaseState = getTrackState(existing, "release");
        const baseVersion = expState?.nextVersion ??
            expState?.lastVersion ??
            releaseState?.nextVersion ??
            releaseState?.lastVersion ??
            fallbackVersion ??
            "0.1.0";
        const nextVersion = expState?.nextVersion || expState?.lastVersion
            ? incrementExpVersion(baseVersion)
            : derivePrereleaseFromReleaseBase(baseVersion, "exp");
        return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "exp", {
            lastVersion: expState?.lastVersion,
            nextVersion,
        });
    }
    async incrementArtifactMinorVersion(repoRoot, artifactName, packageName, fallbackVersion) {
        const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
        const releaseState = getTrackState(existing, "release");
        const baseVersion = releaseState?.nextVersion ?? releaseState?.lastVersion ?? fallbackVersion ?? "0.1.0";
        const nextVersion = incrementMinorVersion(baseVersion);
        return await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
            lastVersion: releaseState?.lastVersion,
            nextVersion,
        });
    }
    async advanceArtifactVersion(repoRoot, artifactName, packageName, deployedVersion, track = "patch") {
        const persistedTrack = toPersistedTrack(track);
        if (persistedTrack !== "release") {
            const nextVersion = incrementVersionForTrack(deployedVersion, track);
            return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, persistedTrack, {
                lastVersion: deployedVersion,
                nextVersion,
            });
        }
        const nextReleaseVersion = incrementVersionForTrack(deployedVersion, track);
        let record = await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
            lastVersion: deployedVersion,
            nextVersion: nextReleaseVersion,
        });
        for (const prereleaseTrack of exports.PERSISTED_VERSION_TRACKS.filter((track) => track !== "release")) {
            await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, prereleaseTrack, {
                lastVersion: undefined,
                nextVersion: derivePrereleaseFromReleaseBase(nextReleaseVersion, prereleaseTrack),
            });
        }
        return await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
            lastVersion: deployedVersion,
            nextVersion: nextReleaseVersion,
        });
    }
    async setReleaseTrackVersion(repoRoot, artifactName, packageName, updates) {
        return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "release", updates);
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
function decrementPatchVersion(version) {
    const parsed = parseVersion(version);
    if (!parsed || parsed.patch === 0) {
        return undefined;
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
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
    const beta = parseBetaVersion(version);
    if (beta) {
        return `${beta.major}.${beta.minor}.${beta.patch + 1}-exp.0`;
    }
    const parsed = parseVersion(version);
    if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-exp.0`;
    }
    return "0.1.1-exp.0";
}
function incrementBetaVersion(version) {
    const beta = parseBetaVersion(version);
    if (beta) {
        return `${beta.major}.${beta.minor}.${beta.patch}-beta.${beta.beta + 1}`;
    }
    const exp = parseExpVersion(version);
    if (exp) {
        return `${exp.major}.${exp.minor}.${exp.patch}-beta.0`;
    }
    const parsed = parseVersion(version);
    if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-beta.0`;
    }
    return "0.1.1-beta.0";
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
function parseBetaVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)[.\-]beta\.(0|[1-9]\d*)$/.exec(value.trim());
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        beta: Number(match[4]),
    };
}
function isValidVersionString(value) {
    return parseVersion(value) !== null || parseExpVersion(value) !== null || parseBetaVersion(value) !== null;
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
                tracks: normalizeTrackStates(artifactValue),
                updatedAt: typeof artifactValue.updatedAt === "string" ? artifactValue.updatedAt : new Date(0).toISOString(),
            };
        }
        normalizedRepos[repoId] = {
            repoId,
            repoRoot: repoValue.repoRoot,
            artifacts: normalizedArtifacts,
            controlPanelPresets: normalizeControlPanelPresets(repoValue.controlPanelPresets, repoValue.repoRoot),
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
function normalizeControlPanelPresets(value, repoRoot) {
    if (!isRecord(value)) {
        return {};
    }
    const presets = {};
    for (const [presetId, rawPreset] of Object.entries(value)) {
        if (!isRecord(rawPreset)) {
            continue;
        }
        const id = typeof rawPreset.id === "string" ? rawPreset.id : presetId;
        const name = typeof rawPreset.name === "string" ? rawPreset.name.trim() : "";
        if (!isValidControlPanelId(id) || !name) {
            continue;
        }
        const layout = normalizeControlLayout(rawPreset.layout);
        const blocks = Array.isArray(rawPreset.blocks)
            ? rawPreset.blocks.flatMap((block) => {
                const normalized = normalizeControlBlock(block);
                return normalized ? [normalized] : [];
            })
            : [];
        if (!layout) {
            continue;
        }
        presets[id] = {
            id,
            artifactId: typeof rawPreset.artifactId === "string" ? rawPreset.artifactId : undefined,
            repoRoot: typeof rawPreset.repoRoot === "string" ? rawPreset.repoRoot : repoRoot,
            name,
            layout,
            blocks,
            createdAt: typeof rawPreset.createdAt === "number" ? rawPreset.createdAt : Date.now(),
            updatedAt: typeof rawPreset.updatedAt === "number" ? rawPreset.updatedAt : Date.now(),
        };
    }
    return presets;
}
function normalizeControlLayout(value) {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }
    if (value.type === "block" && typeof value.blockId === "string" && isValidControlPanelId(value.blockId)) {
        return { type: "block", blockId: value.blockId };
    }
    if (value.type === "stack" && Array.isArray(value.blockIds)) {
        return {
            type: "stack",
            activeBlockId: typeof value.activeBlockId === "string" ? value.activeBlockId : undefined,
            blockIds: value.blockIds.filter((blockId) => typeof blockId === "string" && isValidControlPanelId(blockId)),
        };
    }
    if (value.type === "split" &&
        (value.direction === "horizontal" || value.direction === "vertical") &&
        Array.isArray(value.children)) {
        const children = value.children.flatMap((child) => {
            const normalized = normalizeControlLayout(child);
            return normalized ? [normalized] : [];
        });
        if (children.length === 0) {
            return null;
        }
        return {
            type: "split",
            direction: value.direction,
            sizes: Array.isArray(value.sizes) ? value.sizes.filter((size) => typeof size === "number") : undefined,
            children,
        };
    }
    return null;
}
function normalizeControlBlock(value) {
    if (!isRecord(value) || typeof value.id !== "string" || !isValidControlPanelId(value.id)) {
        return null;
    }
    const kind = typeof value.kind === "string" && value.kind.trim() ? value.kind.trim() : "placeholder";
    return {
        id: value.id,
        kind,
        title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : value.id,
        terminal: isRecord(value.terminal) ? value.terminal : undefined,
        status: isRecord(value.status) ? value.status : undefined,
        externalLinks: Array.isArray(value.externalLinks)
            ? value.externalLinks.filter((link) => isRecord(link) &&
                typeof link.id === "string" &&
                typeof link.label === "string" &&
                typeof link.url === "string")
            : undefined,
    };
}
function isValidControlPanelId(value) {
    return /^[a-zA-Z0-9_-]{1,96}$/.test(value);
}
function normalizeTrackStates(value) {
    const tracksValue = isRecord(value.tracks) ? value.tracks : {};
    const states = Object.fromEntries(exports.PERSISTED_VERSION_TRACKS.map((track) => [track, normalizeSingleTrackState(tracksValue[track])]));
    const legacyLastVersion = typeof value.lastVersion === "string" ? value.lastVersion : undefined;
    const legacyNextVersion = typeof value.nextVersion === "string" ? value.nextVersion : undefined;
    const legacyUpdatedAt = typeof value.updatedAt === "string" ? value.updatedAt : undefined;
    const legacyTrack = detectLegacyTrack(legacyNextVersion ?? legacyLastVersion);
    const fallbackRelease = {
        nextVersion: legacyTrack === "release"
            ? legacyNextVersion
            : stripPrereleaseToStable(legacyNextVersion ?? legacyLastVersion),
        lastVersion: legacyTrack === "release" ? legacyLastVersion : undefined,
        updatedAt: legacyUpdatedAt,
    };
    const fallbackTrack = legacyTrack !== "release"
        ? {
            lastVersion: legacyLastVersion,
            nextVersion: legacyNextVersion,
            updatedAt: legacyUpdatedAt,
        }
        : {};
    states.release =
        states.release.lastVersion || states.release.nextVersion
            ? states.release
            : fallbackRelease.lastVersion || fallbackRelease.nextVersion
                ? fallbackRelease
                : {};
    if (legacyTrack !== "release") {
        states[legacyTrack] =
            states[legacyTrack].lastVersion || states[legacyTrack].nextVersion
                ? states[legacyTrack]
                : fallbackTrack.nextVersion || fallbackTrack.lastVersion
                    ? fallbackTrack
                    : {};
    }
    // Repair older records where prerelease values were accidentally written
    // into the hidden release lane. Move them back to their real lane and keep
    // the release lane on the stable base.
    const releaseLaneType = detectLegacyTrack(states.release.nextVersion ?? states.release.lastVersion);
    if (releaseLaneType !== "release") {
        if (!states[releaseLaneType].lastVersion && !states[releaseLaneType].nextVersion) {
            states[releaseLaneType] = { ...states.release };
        }
        states.release = deriveReleaseStateFromPrerelease(states.release);
    }
    const prereleaseBase = stripPrereleaseToStable(exports.PERSISTED_VERSION_TRACKS.filter((track) => track !== "release")
        .flatMap((track) => [states[track].nextVersion, states[track].lastVersion])
        .find((entry) => typeof entry === "string"));
    if (states.release.lastVersion &&
        states.release.nextVersion &&
        states.release.lastVersion === states.release.nextVersion &&
        prereleaseBase === states.release.nextVersion) {
        states.release = {
            lastVersion: decrementPatchVersion(states.release.nextVersion),
            nextVersion: states.release.nextVersion,
            updatedAt: states.release.updatedAt,
        };
    }
    return Object.fromEntries(exports.PERSISTED_VERSION_TRACKS.flatMap((track) => states[track].lastVersion || states[track].nextVersion ? [[track, states[track]]] : []));
}
function normalizeSingleTrackState(value) {
    if (!isRecord(value)) {
        return {};
    }
    return {
        lastVersion: typeof value.lastVersion === "string" ? value.lastVersion : undefined,
        nextVersion: typeof value.nextVersion === "string" ? value.nextVersion : undefined,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    };
}
function normalizeArtifactVersionRecord(record) {
    const tracks = normalizeTrackStates(record);
    const releaseState = tracks.release;
    return {
        artifactName: record.artifactName,
        packageName: record.packageName,
        lastVersion: releaseState?.lastVersion,
        nextVersion: releaseState?.nextVersion,
        tracks,
        updatedAt: record.updatedAt,
    };
}
function getTrackState(record, track) {
    return record?.tracks?.[track];
}
function toPersistedTrack(track) {
    return track === "exp" || track === "beta" ? track : "release";
}
function withTrackUpdates(record, track, updates) {
    const updatedAt = new Date().toISOString();
    const nextTracks = {
        ...(record.tracks ?? {}),
        [track]: {
            lastVersion: updates.lastVersion,
            nextVersion: updates.nextVersion,
            updatedAt,
        },
    };
    if (updates.lastVersion === undefined && updates.nextVersion === undefined) {
        delete nextTracks[track];
    }
    return normalizeArtifactVersionRecord({
        ...record,
        lastVersion: record.tracks?.release?.lastVersion,
        nextVersion: record.tracks?.release?.nextVersion,
        tracks: nextTracks,
        updatedAt,
    });
}
function derivePrereleaseFromReleaseBase(version, track) {
    const parsed = parseVersion(version);
    if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch}-${track}.0`;
    }
    return incrementPrereleaseVersion(version, track);
}
function detectLegacyTrack(version) {
    if (!version) {
        return "release";
    }
    return parseKnownPrereleaseVersion(version)?.track ?? "release";
}
function stripPrereleaseToStable(version) {
    if (!version) {
        return undefined;
    }
    const prerelease = parseKnownPrereleaseVersion(version);
    if (prerelease) {
        return `${prerelease.major}.${prerelease.minor}.${prerelease.patch}`;
    }
    return version;
}
function parseKnownPrereleaseVersion(value) {
    const labels = exports.PERSISTED_VERSION_TRACKS.filter((track) => track !== "release").join("|");
    const match = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)[.-](${labels})\\.(0|[1-9]\\d*)$`).exec(value.trim());
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        track: match[4],
        ordinal: Number(match[5]),
    };
}
function incrementPrereleaseVersion(version, track) {
    const prerelease = parseKnownPrereleaseVersion(version);
    if (prerelease && prerelease.track === track) {
        return `${prerelease.major}.${prerelease.minor}.${prerelease.patch}-${track}.${prerelease.ordinal + 1}`;
    }
    const parsed = parseVersion(version);
    if (parsed) {
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${track}.0`;
    }
    return `0.1.1-${track}.0`;
}
function deriveReleaseStateFromPrerelease(prereleaseState) {
    const nextStable = stripPrereleaseToStable(prereleaseState.nextVersion ?? prereleaseState.lastVersion);
    return {
        lastVersion: nextStable ? decrementPatchVersion(nextStable) : undefined,
        nextVersion: nextStable,
        updatedAt: prereleaseState.updatedAt,
    };
}
function withDisplayedTrack(record, track) {
    const trackState = getTrackState(record, track);
    return {
        ...record,
        lastVersion: trackState?.lastVersion,
        nextVersion: trackState?.nextVersion,
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
function isVersionTrack(value) {
    return value === "patch" || value === "minor" || value === "exp" || value === "beta";
}
function versionMatchesTrack(version, track) {
    switch (track) {
        case "exp":
            return parseExpVersion(version) !== null;
        case "beta":
            return parseBetaVersion(version) !== null;
        case "patch":
        case "minor":
            return parseExpVersion(version) === null && parseBetaVersion(version) === null && parseVersion(version) !== null;
        default:
            return false;
    }
}
function incrementVersionForTrack(version, track) {
    switch (track) {
        case "exp":
            return incrementExpVersion(version);
        case "beta":
            return incrementBetaVersion(version);
        case "minor":
            return incrementMinorVersion(version);
        case "patch":
        default:
            return incrementPatchVersion(version);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
