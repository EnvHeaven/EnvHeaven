import type { Diagnostic, GlobalOptions } from "./types";

export function verboseLog(message: string, options: GlobalOptions): void {
  if (options.verbose) {
    const ts = new Date().toISOString();
    process.stderr.write(`[verbose ${ts}] ${message}\n`);
  }
}

export function writeOutput(payload: unknown, exitCode: number, options: GlobalOptions): void {
  if (options.jsonResponse) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHumanOutput(payload)}\n`);
  }
  process.exitCode = exitCode;
}

function renderHumanOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return String(payload);
  }

  const p = payload as Record<string, unknown>;
  const lines: string[] = [];

  if (typeof p["mode"] === "string") {
    lines.push(`[info] mode: ${p["mode"]}`);
  }

  if (typeof p["port"] === "number") {
    lines.push(`[info] port: ${String(p["port"])}`);
  }

  if (typeof p["daemonUrl"] === "string") {
    lines.push(`[info] daemon: ${p["daemonUrl"]}`);
  }

  if (typeof p["uiUrl"] === "string") {
    lines.push(`[info] ui: ${p["uiUrl"]}`);
  }

  if (p["intent"] && typeof p["intent"] === "object") {
    const intent = p["intent"] as Record<string, unknown>;
    const target = intent["target"] ? ` ${String(intent["target"])}` : "";
    lines.push(`[info] command: ${String(intent["kind"] ?? "")}${target}`);
  }

  const deploy = p["deploy"];
  if (deploy && typeof deploy === "object") {
    const d = deploy as Record<string, unknown>;
    for (const execList of [d["repoExecutions"], d["artifactExecutions"]]) {
      if (Array.isArray(execList)) {
        for (const item of execList as unknown[]) {
          if (item && typeof item === "object") {
            const entry = item as Record<string, unknown>;
            const result = entry["result"] as Record<string, unknown> | undefined;
            const code = result?.["exitCode"] ?? entry["exitCode"] ?? 0;
            const passed = code === 0;
            const label = String(entry["name"] ?? entry["artifactName"] ?? entry["runnerName"] ?? "?");
            lines.push(`${passed ? "[ok]  " : "[fail]"} ${label} (exit ${String(code)})`);
          }
        }
      }
    }
  }

  if (Array.isArray(p["diagnostics"])) {
    for (const d of p["diagnostics"] as Diagnostic[]) {
      lines.push(`[${d.severity}] ${d.message}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no output)";
}
