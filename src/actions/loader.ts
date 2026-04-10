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
  isLocalUser?: boolean;
  buttonColor?: string;
}

const ENV_DIR = ".envheaven";
const ACTIONS_SUBDIR = "actions";
const LOCAL_USER_SUBDIR = "local-user";
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
  const localUserDir = path.join(actionsDir, LOCAL_USER_SUBDIR);
  const actions: ActionDefinition[] = [];

  const baseActions = await loadActionsFromDir(actionsDir, false);
  actions.push(...baseActions);

  const localActions = await loadActionsFromDir(localUserDir, true);
  actions.push(...localActions);

  return actions;
}

async function loadActionsFromDir(dir: string, isLocalUser: boolean): Promise<ActionDefinition[]> {
  try {
    const files = await fs.readdir(dir);
    const actionFiles = files.filter((f) => f.endsWith(ACTION_SUFFIX));

    if (actionFiles.length === 0) {
      return [];
    }

    const actions: ActionDefinition[] = [];
    for (const file of actionFiles.sort()) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const action = normalizeAction(parsed, isLocalUser);
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
  const basePath = path.join(actionsDir, `${actionId}${ACTION_SUFFIX}`);
  const localPath = path.join(actionsDir, LOCAL_USER_SUBDIR, `${actionId}${ACTION_SUFFIX}`);

  try {
    await fs.unlink(localPath);
    return;
  } catch {
    // not in local-user, try base
  }

  await fs.unlink(basePath);
}

export async function saveAction(repoRoot: string, action: ActionDefinition): Promise<void> {
  const actionsDir = path.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
  const targetDir = action.isLocalUser
    ? path.join(actionsDir, LOCAL_USER_SUBDIR)
    : actionsDir;
  await fs.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${action.id}${ACTION_SUFFIX}`);
  const toWrite = { ...action };
  delete toWrite.isLocalUser;
  await fs.writeFile(filePath, JSON.stringify(toWrite, null, 2) + "\n", "utf8");
}

export async function moveAction(repoRoot: string, actionId: string, toLocalUser: boolean): Promise<void> {
  const actionsDir = path.join(repoRoot, ENV_DIR, ACTIONS_SUBDIR);
  const basePath = path.join(actionsDir, `${actionId}${ACTION_SUFFIX}`);
  const localDir = path.join(actionsDir, LOCAL_USER_SUBDIR);
  const localPath = path.join(localDir, `${actionId}${ACTION_SUFFIX}`);

  if (toLocalUser) {
    await fs.mkdir(localDir, { recursive: true });
    const raw = await fs.readFile(basePath, "utf8");
    await fs.writeFile(localPath, raw, "utf8");
    await fs.unlink(basePath);
  } else {
    const raw = await fs.readFile(localPath, "utf8");
    await fs.writeFile(basePath, raw, "utf8");
    await fs.unlink(localPath);
  }
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

function normalizeAction(parsed: Record<string, unknown>, isLocalUser = false): ActionDefinition | null {
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
