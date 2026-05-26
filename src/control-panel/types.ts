export type TerminalSessionKind = "pty" | "pipe" | "log";

export type TerminalSessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "terminated"
  | "unknown";

export interface TerminalSessionSummary {
  id: string;
  runId: string;
  actionId?: string;
  actionLabel?: string;
  actionRunId?: string;
  actionGroupId?: string;
  artifactId?: string;
  repoRoot?: string;
  command?: string;
  kind: TerminalSessionKind;
  status: TerminalSessionStatus;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  hasReplay?: boolean;
  canAttach: boolean;
  canStop: boolean;
  title?: string;
  prelude?: string;
}

export type ActionGroupStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "terminated";

export interface ActionGroupSummary {
  id: string;
  rootRunId?: string;
  artifactId?: string;
  repoRoot?: string;
  label?: string;
  status: ActionGroupStatus;
  runIds: string[];
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface ActionGroupDispatchTerminalRequest {
  slotId?: string;
  actionId?: string;
  repoRoot?: string;
  runCommand?: string;
  title?: string;
}

export interface ActionGroupDispatchRequest {
  artifactId?: string;
  repoRoot?: string;
  label?: string;
  terminals: ActionGroupDispatchTerminalRequest[];
}

export interface ActionGroupDispatchResult {
  ok: true;
  group: ActionGroupSummary;
  runs: TerminalSessionSummary[];
  slotRunMap: Record<string, string>;
}

export type ControlBlockKind =
  | "terminal"
  | "status"
  | "externalLinks"
  | "placeholder"
  | "notes"
  | (string & {});

export interface ControlPanelPreset {
  id: string;
  artifactId?: string;
  repoRoot?: string;
  name: string;
  layout: ControlLayoutNode;
  blocks: ControlBlock[];
  createdAt: number;
  updatedAt: number;
}

export type ControlLayoutNode =
  | {
      type: "split";
      direction: "horizontal" | "vertical";
      sizes?: number[];
      children: ControlLayoutNode[];
    }
  | {
      type: "stack";
      activeBlockId?: string;
      blockIds: string[];
    }
  | {
      type: "block";
      blockId: string;
    };

export interface ControlBlock {
  id: string;
  kind: ControlBlockKind;
  title: string;
  terminal?: ControlTerminalBinding;
  status?: Record<string, unknown>;
  externalLinks?: ControlExternalLink[];
}

export interface ControlTerminalBinding {
  slotId: string;
  runId?: string;
  expectedActionId?: string;
  expectedRepoRoot?: string;
  expectedCommand?: string;
  match?: {
    actionId?: string;
    repoRoot?: string;
    actionGroupId?: string;
    labelIncludes?: string;
  };
}

export interface ControlExternalLink {
  id: string;
  label: string;
  url: string;
}
