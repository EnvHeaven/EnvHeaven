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
    terminalMode?: "pty" | "pipe";
}
export interface ArtifactMeta {
    icon?: string;
    internalName?: string;
    labelName?: string;
    instanceLabelName?: string;
}
export declare function loadActions(repoRoot: string): Promise<ActionDefinition[]>;
export declare function deleteAction(repoRoot: string, actionId: string): Promise<void>;
export declare function saveAction(repoRoot: string, action: ActionDefinition): Promise<void>;
export declare function moveAction(repoRoot: string, actionId: string, toLocalUser: boolean): Promise<void>;
export declare function loadArtifactMeta(repoRoot: string): Promise<ArtifactMeta>;
export declare function saveArtifactMeta(repoRoot: string, meta: ArtifactMeta): Promise<void>;
export declare function normalizePageHeaderOptions(raw: unknown): PageHeaderOptions | undefined;
