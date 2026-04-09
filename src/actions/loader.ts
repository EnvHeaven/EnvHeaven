import { promises as fs } from "node:fs";
import path from "node:path";

export interface ActionHelper {
  kind: "open-url" | "copy-text";
  label: string;
  value: string;
}

export interface PageHeaderOptions {
  isFixedOnHeader: boolean;
  hasToReplaceActionText?: boolean;
  actionTextToReplace?: string;
}

export interface ActionDefinition {
  id: string;
  label: string;
  runCommand: string;
  stopCommand: string | null;
  icon: string;
  description: string;
  runLabel: string;
  stopLabel: string;
  successHelpers: ActionHelper[];
  failHelpers: ActionHelper[];
  pageHeaderOptions?: PageHeaderOptions;
}

const ENV_DIR = ".envheaven";
const ACTIONS_SUBDIR = "actions";
const ACTION_SUFFIX = ".envheaven.action.json";
const ARTIFACT_META_FILE = "artifact-meta.json";

export interface ArtifactMeta {
  icon?: string;
  internalName?: string;
  labelName?: string;
  instanceLabelName?: string;
}


export async function loadActions(repoRoot: string): Promise<ActionDefinition[]> {
  const actionsDir = path.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
  try {
    const files = await fs.readdir(actionsDir);
    const actionFiles = files.filter((f) => f.endsWith(ACTION_SUFFIX));

    if (actionFiles.length === 0) {
      return [];
    }

    const actions: ActionDefinition[] = [];
    for (const file of actionFiles.sort()) {
      try {
        const raw = await fs.readFile(path.join(actionsDir, file), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const action = normalizeAction(parsed);
        if (action) {
          actions.push(action);
        }
      } catch {
        // skip malformed files
      }
    }

    return actions;
  } catch {
    return [];
  }
}

export async function deleteAction(repoRoot: string, actionId: string): Promise<void> {
  const actionsDir = path.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
  const filePath = path.join(actionsDir, `${actionId}${ACTION_SUFFIX}`);
  await fs.unlink(filePath);
}

export async function saveAction(repoRoot: string, action: ActionDefinition): Promise<void> {
  const actionsDir = path.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
  await fs.mkdir(actionsDir, { recursive: true });
  const filePath = path.join(actionsDir, `${action.id}${ACTION_SUFFIX}`);
  await fs.writeFile(filePath, JSON.stringify(action, null, 2) + "\n", "utf8");
}

export async function loadArtifactMeta(repoRoot: string): Promise<ArtifactMeta> {
  const metaPath = path.join(repoRoot, ENV_DIR, ARTIFACT_META_FILE);
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return JSON.parse(raw) as ArtifactMeta;
  } catch {
    return {};
  }
}

export async function saveArtifactMeta(repoRoot: string, meta: ArtifactMeta): Promise<void> {
  const envDir = path.join(repoRoot, ENV_DIR);
  await fs.mkdir(envDir, { recursive: true });
  const metaPath = path.join(envDir, ARTIFACT_META_FILE);
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function normalizeAction(parsed: Record<string, unknown>): ActionDefinition | null {
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
  };
}

export function normalizePageHeaderOptions(raw: unknown): PageHeaderOptions | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["isFixedOnHeader"] !== true) return undefined;
  return {
    isFixedOnHeader: true,
    hasToReplaceActionText: r["hasToReplaceActionText"] === true,
    actionTextToReplace: typeof r["actionTextToReplace"] === "string" ? r["actionTextToReplace"] : "",
  };
}

function normalizeHelpers(raw: unknown): ActionHelper[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHelper);
}

function isHelper(h: unknown): h is ActionHelper {
  if (typeof h !== "object" || h === null) return false;
  const hh = h as Record<string, unknown>;
  return (
    (hh["kind"] === "open-url" || hh["kind"] === "copy-text") &&
    typeof hh["label"] === "string" &&
    typeof hh["value"] === "string"
  );
}
