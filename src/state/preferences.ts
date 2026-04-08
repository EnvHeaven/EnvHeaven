import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface EnvHeavenPreferences {
  autoStartUi: boolean;
}

function getPreferencesPath(): string {
  return path.join(os.homedir(), ".envheaven", "preferences.json");
}

export async function loadPreferences(): Promise<EnvHeavenPreferences | null> {
  try {
    const raw = await fs.readFile(getPreferencesPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<EnvHeavenPreferences>;
    return {
      autoStartUi: typeof parsed.autoStartUi === "boolean" ? parsed.autoStartUi : false,
    };
  } catch {
    return null;
  }
}

export async function savePreferences(prefs: EnvHeavenPreferences): Promise<void> {
  const prefsPath = getPreferencesPath();
  await fs.mkdir(path.dirname(prefsPath), { recursive: true });
  await fs.writeFile(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf8");
}
