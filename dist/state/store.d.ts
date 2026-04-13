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
export declare class EnvHeavenStateStore {
    private readonly paths;
    private cache;
    constructor(paths?: EnvHeavenPaths);
    getPaths(): EnvHeavenPaths;
    listRepos(): Promise<RepoStateRecord[]>;
    rememberRepo(repoRoot: string): Promise<RepoStateRecord>;
    setSelectedRepo(repoRoot: string): Promise<RepoStateRecord>;
    getSelectedRepo(preferredRepoRoot?: string): Promise<RepoStateRecord | null>;
    invalidateCache(): void;
    getVersionRecords(repoRoot: string): Promise<ArtifactVersionRecord[]>;
    getVersionRecord(repoRoot: string, artifactName: string, packageName?: string): Promise<ArtifactVersionRecord | null>;
    setArtifactVersion(repoRoot: string, artifactName: string, packageName: string | undefined, updates: Partial<Pick<ArtifactVersionRecord, "lastVersion" | "nextVersion">>): Promise<ArtifactVersionRecord>;
    incrementArtifactNextVersion(repoRoot: string, artifactName: string, packageName: string | undefined, fallbackVersion?: string): Promise<ArtifactVersionRecord>;
    resolveArtifactVersion(repoRoot: string, artifactName: string, packageName: string | undefined, fallbackVersion: string): Promise<ResolvedArtifactVersion>;
    bootstrapArtifactVersion(repoRoot: string, artifactName: string, packageName: string | undefined, packageJsonVersion: string): Promise<{
        record: ArtifactVersionRecord;
        bootstrapped: boolean;
    }>;
    incrementArtifactExpVersion(repoRoot: string, artifactName: string, packageName: string | undefined, fallbackVersion?: string): Promise<ArtifactVersionRecord>;
    incrementArtifactMinorVersion(repoRoot: string, artifactName: string, packageName: string | undefined, fallbackVersion?: string): Promise<ArtifactVersionRecord>;
    advanceArtifactVersion(repoRoot: string, artifactName: string, packageName: string | undefined, deployedVersion: string): Promise<ArtifactVersionRecord>;
    private ensureRepo;
    private requireRepo;
    private loadState;
    private saveState;
    writeInstalledCliVersion(version: string): Promise<void>;
    readInstalledCliVersionSync(): string | null;
}
export declare function resolveEnvHeavenPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDirectory?: string): EnvHeavenPaths;
export declare function buildRepoId(repoRoot: string): string;
export declare function buildArtifactKey(artifactName: string, packageName?: string): string;
export declare function incrementPatchVersion(version: string): string;
export declare function incrementMinorVersion(version: string): string;
export declare function incrementExpVersion(version: string): string;
export declare function parseExpVersion(value: string): {
    major: number;
    minor: number;
    patch: number;
    exp: number;
} | null;
export declare function isValidVersionString(value: string): boolean;
export declare function isValidExpVersionString(value: string): boolean;
