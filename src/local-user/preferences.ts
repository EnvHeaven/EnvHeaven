import { promises as fs } from "node:fs";
import path from "node:path";

const ENV_DIR = ".envheaven";
const LOCAL_USER_SUBDIR = "local-user";
const PINNED_ARTIFACTS_FILE = "pinned-artifacts.json";

export async function loadPinnedArtifactIds(repoRoot: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(pinnedArtifactsPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Array.isArray(parsed["artifactIds"])
      ? parsed["artifactIds"].filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export async function savePinnedArtifactIds(repoRoot: string, artifactIds: string[]): Promise<void> {
  const filePath = pinnedArtifactsPath(repoRoot);
  await ensureLocalUserGitIgnore(repoRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const uniqueIds = [...new Set(artifactIds.filter((id) => typeof id === "string" && id.length > 0))];
  await fs.writeFile(filePath, JSON.stringify({ artifactIds: uniqueIds }, null, 2) + "\n", "utf8");
}

function pinnedArtifactsPath(repoRoot: string): string {
  return path.join(repoRoot, ENV_DIR, LOCAL_USER_SUBDIR, PINNED_ARTIFACTS_FILE);
}

async function ensureLocalUserGitIgnore(repoRoot: string): Promise<void> {
  const gitIgnorePath = path.join(repoRoot, ENV_DIR, ".gitignore");
  const localUserIgnoreBlock = [
    "",
    "# local-user data (user-specific, not committed to repo)",
    "**/local-user/**/*",
    "!**/.keep",
    "",
  ].join("\n");

  try {
    const existing = await fs.readFile(gitIgnorePath, "utf8");
    if (existing.includes("**/local-user/**/*")) return;
    await fs.writeFile(gitIgnorePath, `${existing.replace(/\s*$/, "")}\n${localUserIgnoreBlock}`, "utf8");
  } catch {
    await fs.mkdir(path.dirname(gitIgnorePath), { recursive: true });
    await fs.writeFile(gitIgnorePath, localUserIgnoreBlock.trimStart(), "utf8");
  }
}
