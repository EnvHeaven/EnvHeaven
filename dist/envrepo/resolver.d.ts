import type { RepoModel, ResolvedPlan, SupportedTarget } from "../types";
export declare function resolvePlan(repoModel: RepoModel, target: SupportedTarget, kind?: "run" | "deploy"): ResolvedPlan;
