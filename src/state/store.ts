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
  updatedAt: string;
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
    return repoRecord.artifacts[buildArtifactKey(artifactName, packageName)] ?? null;
  }

  async setArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    updates: Partial<Pick<ArtifactVersionRecord, "lastVersion" | "nextVersion">>,
  ): Promise<ArtifactVersionRecord> {
    // Force reload from disk on every write so that concurrent processes
    // (e.g. daemon and CLI running simultaneously) do not overwrite each
    // other's state with a stale in-memory cache.
    const state = await this.loadState(true);
    const repoRecord = await this.requireRepo(state, repoRoot);
    const recordKey = buildArtifactKey(artifactName, packageName);
    const existing = repoRecord.artifacts[recordKey];
    const nextRecord: ArtifactVersionRecord = {
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

  async incrementArtifactNextVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion?: string,
  ): Promise<ArtifactVersionRecord> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
    const nextVersion = incrementPatchVersion(baseVersion);
    return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
      lastVersion: existing?.lastVersion,
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

  async bootstrapArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    packageJsonVersion: string,
  ): Promise<{ record: ArtifactVersionRecord; bootstrapped: boolean }> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    if (existing?.nextVersion || existing?.lastVersion) {
      return { record: existing, bootstrapped: false };
    }

    const nextVersion = incrementPatchVersion(packageJsonVersion);
    const record = await this.setArtifactVersion(repoRoot, artifactName, packageName, { nextVersion });
    return { record, bootstrapped: true };
  }

  async incrementArtifactExpVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    fallbackVersion?: string,
  ): Promise<ArtifactVersionRecord> {
    const existing = await this.getVersionRecord(repoRoot, artifactName, packageName);
    const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
    const nextVersion = incrementExpVersion(baseVersion);
    return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
      lastVersion: existing?.lastVersion,
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
    const baseVersion = existing?.nextVersion ?? existing?.lastVersion ?? fallbackVersion ?? "0.1.0";
    const nextVersion = incrementMinorVersion(baseVersion);
    return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
      lastVersion: existing?.lastVersion,
      nextVersion,
    });
  }

  async advanceArtifactVersion(
    repoRoot: string,
    artifactName: string,
    packageName: string | undefined,
    deployedVersion: string,
    deployTarget?: string,
  ): Promise<ArtifactVersionRecord> {
    const isLocalTarget = deployTarget?.toLowerCase().includes("local") ?? false;
    const nextVersion = isLocalTarget
      ? incrementExpVersion(deployedVersion)
      : incrementPatchVersion(deployedVersion);
    return await this.setArtifactVersion(repoRoot, artifactName, packageName, {
      lastVersion: deployedVersion,
      nextVersion,
    });
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
  const parsed = parseVersion(version);
  if (parsed) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-exp.0`;
  }
  return "0.1.1-exp.0";
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

export function isValidVersionString(value: string): boolean {
  return parseVersion(value) !== null || parseExpVersion(value) !== null;
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
