import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_SCHEMA_VERSION = 1;

export interface EnvHeavenPaths {
  cacheDirectory: string;
  configDirectory: string;
  stateDirectory: string;
  stateFilePath: string;
  toolsDirectory: string;
}

export interface ArtifactVersionRecord {
  artifactName: string;
  packageName?: string;
  lastVersion?: string;
  nextVersion?: string;
  tracks?: Partial<Record<PersistedVersionTrack, ArtifactVersionTrackState>>;
  updatedAt: string;
}

export interface ArtifactVersionTrackState {
  lastVersion?: string;
  nextVersion?: string;
  updatedAt?: string;
}

export interface RepoStateRecord {
  repoId: string;
  repoRoot: string;
  artifacts: Record<string, ArtifactVersionRecord>;
  updatedAt: string;
}

export interface EnvHeavenStateFile {
  schemaVersion: number;
  selectedRepoId?: string;
  recentRepoIds: string[];
  repos: Record<string, RepoStateRecord>;
}

export interface ResolvedArtifactVersion {
  value: string;
  source: "registry-next" | "registry-last" | "fallback";
  record?: ArtifactVersionRecord;
}

export type VersionTrack = "patch" | "minor" | "exp" | "beta";
export const PERSISTED_VERSION_TRACKS = ["exp", "canary", "alpha", "beta", "rc", "release"] as const;
export type PersistedVersionTrack = (typeof PERSISTED_VERSION_TRACKS)[number];

export class EnvHeavenStateStore {
  private cache: EnvHeavenStateFile | null = null;

  constructor(private readonly paths = resolveEnvHeavenPaths(process.platform, process.env)) {}

  getPaths(): EnvHeavenPaths {
    return this.paths;
  }

  async listRepos(): Promise<RepoStateRecord[]> {
    const state = await this.loadState();
    return state.recentRepoIds
      .map((repoId) => state.repos[repoId])
      .filter((entry): entry is RepoStateRecord => Boolean(entry));
  }

  async rememberRepo(repoRoot: string): Promise<RepoStateRecord> {
    // Always force-reload from disk before writing so that concurrent processes
    // (daemon + CLI) do not overwrite each other's state with a stale cache.
    const state = await this.loadState(true);
    const repoId = buildRepoId(repoRoot);
    const existing = state.repos[repoId];
    const repoRecord: RepoStateRecord = existing ?? {
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

  async setSelectedRepo(repoRoot: string): Promise<RepoStateRecord> {
    return await this.rememberRepo(repoRoot);
  }

  async getSelectedRepo(preferredRepoRoot?: string): Promise<RepoStateRecord | null> {
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

  invalidateCache(): void {
    this.cache = null;
  }

  async getVersionRecords(repoRoot: string): Promise<ArtifactVersionRecord[]> {
    const repoRecord = await this.ensureRepo(repoRoot);
    return Object.values(repoRecord.artifacts).sort((left, right) => left.artifactName.localeCompare(right.artifactName));
  }

  async getVersionRecord(
    repoRoot: string,
    artifactName: string,
    packageName?: string,
  ): Promise<ArtifactVersionRecord | null> {
    const repoRecord = await this.ensureRepo(repoRoot);
    const record = repoRecord.artifacts[buildArtifactKey(artifactName, packageName)] ?? null;
    return record ? normalizeArtifactVersionRecord(record) : null;
  }

  async setArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    updates: Partial<Pick<ArtifactVersionRecord, "lastVersion" | "nextVersion">>,
  ): Promise<ArtifactVersionRecord> {
    return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "release", updates);
  }

  async setArtifactTrackVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    track: PersistedVersionTrack,
    updates: Partial<Pick<ArtifactVersionTrackState, "lastVersion" | "nextVersion">>,
  ): Promise<ArtifactVersionRecord> {
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

  async incrementArtifactNextVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion?: string,
  ): Promise<ArtifactVersionRecord> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const releaseState = getTrackState(existing, "release");
    const baseVersion = releaseState?.nextVersion ?? releaseState?.lastVersion ?? fallbackVersion ?? "0.1.0";
    const nextVersion = incrementPatchVersion(baseVersion);
    return await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
      lastVersion: releaseState?.lastVersion,
      nextVersion,
    });
  }

  async resolveArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion: string,
  ): Promise<ResolvedArtifactVersion> {
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

  async bootstrapArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    packageJsonVersion: string,
    track: VersionTrack = "patch",
  ): Promise<{ record: ArtifactVersionRecord; bootstrapped: boolean }> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const persistedTrack = toPersistedTrack(track);
    const trackState = getTrackState(existing, persistedTrack);
    if (trackState?.nextVersion || trackState?.lastVersion) {
      return { record: existing!, bootstrapped: false };
    }

    let record = existing;
    const releaseState = getTrackState(existing, "release");
    const releaseNext =
      releaseState?.nextVersion ??
      releaseState?.lastVersion ??
      incrementPatchVersion(packageJsonVersion);

    if (!releaseState?.nextVersion && !releaseState?.lastVersion) {
      record = await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
        nextVersion: releaseNext,
      });
    }

    const nextVersion =
      persistedTrack === "release"
        ? incrementVersionForTrack(packageJsonVersion, track)
        : derivePrereleaseFromReleaseBase(releaseNext, persistedTrack);
    record = await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, persistedTrack, { nextVersion });
    return { record, bootstrapped: true };
  }

  async incrementArtifactExpVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion?: string,
  ): Promise<ArtifactVersionRecord> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const expState = getTrackState(existing, "exp");
    const releaseState = getTrackState(existing, "release");
    const baseVersion =
      expState?.nextVersion ??
      expState?.lastVersion ??
      releaseState?.nextVersion ??
      releaseState?.lastVersion ??
      fallbackVersion ??
      "0.1.0";
    const nextVersion =
      expState?.nextVersion || expState?.lastVersion
        ? incrementExpVersion(baseVersion)
        : derivePrereleaseFromReleaseBase(baseVersion, "exp");
    return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "exp", {
      lastVersion: expState?.lastVersion,
      nextVersion,
    });
  }

  async incrementArtifactMinorVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion?: string,
  ): Promise<ArtifactVersionRecord> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const releaseState = getTrackState(existing, "release");
    const baseVersion = releaseState?.nextVersion ?? releaseState?.lastVersion ?? fallbackVersion ?? "0.1.0";
    const nextVersion = incrementMinorVersion(baseVersion);
    return await this.setReleaseTrackVersion(repoRoot, artifactName, packageName, {
      lastVersion: releaseState?.lastVersion,
      nextVersion,
    });
  }

  async advanceArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    deployedVersion: string,
    track: VersionTrack = "patch",
  ): Promise<ArtifactVersionRecord> {
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
    for (const prereleaseTrack of PERSISTED_VERSION_TRACKS.filter((track) => track !== "release")) {
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

  private async setReleaseTrackVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    updates: Partial<Pick<ArtifactVersionTrackState, "lastVersion" | "nextVersion">>,
  ): Promise<ArtifactVersionRecord> {
    return await this.setArtifactTrackVersion(repoRoot, artifactName, packageName, "release", updates);
  }

  private async ensureRepo(repoRoot: string): Promise<RepoStateRecord> {
    await this.rememberRepo(repoRoot);
    const state = await this.loadState();
    return await this.requireRepo(state, repoRoot);
  }

  private async requireRepo(state: EnvHeavenStateFile, repoRoot: string): Promise<RepoStateRecord> {
    const repoId = buildRepoId(repoRoot);
    const repoRecord = state.repos[repoId];
    if (repoRecord) {
      return repoRecord;
    }

    await this.rememberRepo(repoRoot);
    const refreshed = await this.loadState(true);
    return refreshed.repos[repoId] as RepoStateRecord;
  }

  private async loadState(forceReload = false): Promise<EnvHeavenStateFile> {
    if (this.cache && !forceReload) {
      return this.cache;
    }

    await fs.mkdir(this.paths.stateDirectory, { recursive: true });

    try {
      const raw = await fs.readFile(this.paths.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<EnvHeavenStateFile>;
      const normalized = normalizeStateFile(parsed);
      this.cache = normalized;
      return normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const emptyState: EnvHeavenStateFile = {
      schemaVersion: STATE_SCHEMA_VERSION,
      recentRepoIds: [],
      repos: {},
    };
    this.cache = emptyState;
    await this.saveState(emptyState);
    return emptyState;
  }

  private async saveState(state: EnvHeavenStateFile): Promise<void> {
    this.cache = normalizeStateFile(state);
    await fs.mkdir(this.paths.stateDirectory, { recursive: true });
    await fs.writeFile(this.paths.stateFilePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
  }

  async writeInstalledCliVersion(version: string): Promise<void> {
    await fs.mkdir(this.paths.stateDirectory, { recursive: true });
    const versionFilePath = path.join(this.paths.stateDirectory, "cli-version");
    await fs.writeFile(versionFilePath, version, "utf8");
  }

  readInstalledCliVersionSync(): string | null {
    try {
      const versionFilePath = path.join(this.paths.stateDirectory, "cli-version");
      return readFileSync(versionFilePath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
}

export function resolveEnvHeavenPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homeDirectory = os.homedir(),
): EnvHeavenPaths {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA ?? env.APPDATA ?? path.join(homeDirectory, "AppData", "Local");
    const appRoot = path.join(localAppData, "EnvHeaven");
    return {
      cacheDirectory: path.join(appRoot, "cache"),
      configDirectory: path.join(appRoot, "config"),
      stateDirectory: path.join(appRoot, "state"),
      stateFilePath: path.join(appRoot, "state", "state.json"),
      toolsDirectory: path.join(appRoot, "cache", "tools"),
    };
  }

  const configHome = env.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config");
  const stateHome = env.XDG_STATE_HOME ?? path.join(homeDirectory, ".local", "state");
  const cacheHome = env.XDG_CACHE_HOME ?? path.join(homeDirectory, ".cache");
  return {
    cacheDirectory: path.join(cacheHome, "envheaven"),
    configDirectory: path.join(configHome, "envheaven"),
    stateDirectory: path.join(stateHome, "envheaven"),
    stateFilePath: path.join(stateHome, "envheaven", "state.json"),
    toolsDirectory: path.join(cacheHome, "envheaven", "tools"),
  };
}

export function buildRepoId(repoRoot: string): string {
  return createHash("sha1").update(path.resolve(repoRoot)).digest("hex");
}

export function buildArtifactKey(artifactName: string, packageName?: string): string {
  return packageName ? `${artifactName}::${packageName}` : artifactName;
}

export function incrementPatchVersion(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) {
    return "0.1.0";
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function decrementPatchVersion(version: string): string | undefined {
  const parsed = parseVersion(version);
  if (!parsed || parsed.patch === 0) {
    return undefined;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch - 1}`;
}

export function incrementMinorVersion(version: string): string {
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

export function incrementExpVersion(version: string): string {
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

export function incrementBetaVersion(version: string): string {
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

export function parseExpVersion(
  value: string,
): { major: number; minor: number; patch: number; exp: number } | null {
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

export function parseBetaVersion(
  value: string,
): { major: number; minor: number; patch: number; beta: number } | null {
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

export function isValidVersionString(value: string): boolean {
  return parseVersion(value) !== null || parseExpVersion(value) !== null || parseBetaVersion(value) !== null;
}

export function isValidExpVersionString(value: string): boolean {
  return parseExpVersion(value) !== null;
}

function normalizeStateFile(input: Partial<EnvHeavenStateFile>): EnvHeavenStateFile {
  const repos = isRecord(input.repos) ? input.repos : {};
  const normalizedRepos: Record<string, RepoStateRecord> = {};

  for (const [repoId, repoValue] of Object.entries(repos)) {
    if (!isRecord(repoValue) || typeof repoValue.repoRoot !== "string") {
      continue;
    }

    const artifacts = isRecord(repoValue.artifacts) ? repoValue.artifacts : {};
    const normalizedArtifacts: Record<string, ArtifactVersionRecord> = {};
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
        updatedAt:
          typeof artifactValue.updatedAt === "string" ? artifactValue.updatedAt : new Date(0).toISOString(),
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
    ? input.recentRepoIds.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    selectedRepoId: typeof input.selectedRepoId === "string" ? input.selectedRepoId : undefined,
    recentRepoIds: recentRepoIds.filter((repoId) => repoId in normalizedRepos),
    repos: normalizedRepos,
  };
}

function normalizeTrackStates(
  value: Record<string, any>,
): Partial<Record<PersistedVersionTrack, ArtifactVersionTrackState>> {
  const tracksValue = isRecord(value.tracks) ? (value.tracks as Record<string, unknown>) : {};
  const states = Object.fromEntries(
    PERSISTED_VERSION_TRACKS.map((track) => [track, normalizeSingleTrackState(tracksValue[track])]),
  ) as Record<PersistedVersionTrack, ArtifactVersionTrackState>;
  const legacyLastVersion = typeof value.lastVersion === "string" ? value.lastVersion : undefined;
  const legacyNextVersion = typeof value.nextVersion === "string" ? value.nextVersion : undefined;
  const legacyUpdatedAt = typeof value.updatedAt === "string" ? value.updatedAt : undefined;
  const legacyTrack = detectLegacyTrack(legacyNextVersion ?? legacyLastVersion);
  const fallbackRelease: ArtifactVersionTrackState = {
    nextVersion:
      legacyTrack === "release"
        ? legacyNextVersion
        : stripPrereleaseToStable(legacyNextVersion ?? legacyLastVersion),
    lastVersion: legacyTrack === "release" ? legacyLastVersion : undefined,
    updatedAt: legacyUpdatedAt,
  };
  const fallbackTrack: ArtifactVersionTrackState =
    legacyTrack !== "release"
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

  const prereleaseBase = stripPrereleaseToStable(
    PERSISTED_VERSION_TRACKS.filter((track) => track !== "release")
      .flatMap((track) => [states[track].nextVersion, states[track].lastVersion])
      .find((entry): entry is string => typeof entry === "string"),
  );
  if (
    states.release.lastVersion &&
    states.release.nextVersion &&
    states.release.lastVersion === states.release.nextVersion &&
    prereleaseBase === states.release.nextVersion
  ) {
    states.release = {
      lastVersion: decrementPatchVersion(states.release.nextVersion),
      nextVersion: states.release.nextVersion,
      updatedAt: states.release.updatedAt,
    };
  }

  return Object.fromEntries(
    PERSISTED_VERSION_TRACKS.flatMap((track) =>
      states[track].lastVersion || states[track].nextVersion ? [[track, states[track]]] : [],
    ),
  ) as Partial<Record<PersistedVersionTrack, ArtifactVersionTrackState>>;
}

function normalizeSingleTrackState(value: unknown): ArtifactVersionTrackState {
  if (!isRecord(value)) {
    return {};
  }

  return {
    lastVersion: typeof value.lastVersion === "string" ? value.lastVersion : undefined,
    nextVersion: typeof value.nextVersion === "string" ? value.nextVersion : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

export function normalizeArtifactVersionRecord(record: ArtifactVersionRecord): ArtifactVersionRecord {
  const tracks = normalizeTrackStates(record as unknown as Record<string, unknown>);
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

export function getTrackState(
  record: ArtifactVersionRecord | null | undefined,
  track: PersistedVersionTrack,
): ArtifactVersionTrackState | undefined {
  return record?.tracks?.[track];
}

export function toPersistedTrack(track: VersionTrack): PersistedVersionTrack {
  return track === "exp" || track === "beta" ? track : "release";
}

function withTrackUpdates(
  record: ArtifactVersionRecord,
  track: PersistedVersionTrack,
  updates: Partial<Pick<ArtifactVersionTrackState, "lastVersion" | "nextVersion">>,
): ArtifactVersionRecord {
  const updatedAt = new Date().toISOString();
  const nextTracks: Partial<Record<PersistedVersionTrack, ArtifactVersionTrackState>> = {
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

function derivePrereleaseFromReleaseBase(version: string, track: Exclude<PersistedVersionTrack, "release">): string {
  const parsed = parseVersion(version);
  if (parsed) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}-${track}.0`;
  }
  return incrementPrereleaseVersion(version, track);
}

function detectLegacyTrack(version: string | undefined): PersistedVersionTrack {
  if (!version) {
    return "release";
  }
  return parseKnownPrereleaseVersion(version)?.track ?? "release";
}

function stripPrereleaseToStable(version: string | undefined): string | undefined {
  if (!version) {
    return undefined;
  }
  const prerelease = parseKnownPrereleaseVersion(version);
  if (prerelease) {
    return `${prerelease.major}.${prerelease.minor}.${prerelease.patch}`;
  }
  return version;
}

function parseKnownPrereleaseVersion(
  value: string,
): { major: number; minor: number; patch: number; track: Exclude<PersistedVersionTrack, "release">; ordinal: number } | null {
  const labels = PERSISTED_VERSION_TRACKS.filter((track) => track !== "release").join("|");
  const match = new RegExp(
    `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)[.-](${labels})\\.(0|[1-9]\\d*)$`,
  ).exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    track: match[4] as Exclude<PersistedVersionTrack, "release">,
    ordinal: Number(match[5]),
  };
}

function incrementPrereleaseVersion(version: string, track: Exclude<PersistedVersionTrack, "release">): string {
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

function deriveReleaseStateFromPrerelease(prereleaseState: ArtifactVersionTrackState): ArtifactVersionTrackState {
  const nextStable = stripPrereleaseToStable(prereleaseState.nextVersion ?? prereleaseState.lastVersion);
  return {
    lastVersion: nextStable ? decrementPatchVersion(nextStable) : undefined,
    nextVersion: nextStable,
    updatedAt: prereleaseState.updatedAt,
  };
}

function withDisplayedTrack(record: ArtifactVersionRecord, track: PersistedVersionTrack): ArtifactVersionRecord {
  const trackState = getTrackState(record, track);
  return {
    ...record,
    lastVersion: trackState?.lastVersion,
    nextVersion: trackState?.nextVersion,
  };
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
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

export function isVersionTrack(value: string): value is VersionTrack {
  return value === "patch" || value === "minor" || value === "exp" || value === "beta";
}

export function versionMatchesTrack(version: string, track: VersionTrack): boolean {
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

export function incrementVersionForTrack(version: string, track: VersionTrack): string {
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
