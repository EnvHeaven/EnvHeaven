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

  if (Array.isArray(p["daemonUrls"])) {
    for (const u of p["daemonUrls"] as string[]) {
      lines.push(`[info] daemon:  ${u}`);
    }
  } else if (typeof p["daemonUrl"] === "string") {
    lines.push(`[info] daemon:  ${p["daemonUrl"]}`);
  }

  if (Array.isArray(p["uiUrls"])) {
    for (const u of p["uiUrls"] as string[]) {
      lines.push(`[info] ui:     ${u}`);
    }
  } else if (typeof p["uiUrl"] === "string") {
    lines.push(`[info] ui:     ${p["uiUrl"]}`);
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

  if (Array.isArray(p["applyResults"])) {
    lines.push("");
    lines.push("  Apply Version Results");
    lines.push("  " + "─".repeat(60));
    for (const r of p["applyResults"] as Array<Record<string, unknown>>) {
      const icon = r["applied"] ? "[ok]  " : "[fail]";
      lines.push(`  ${icon} ${String(r["artifactName"])} → ${String(r["version"])}  (${String(r["packageJsonPath"])})`);
    }
  }

  const deploySummary = p["deploySummary"];
  if (Array.isArray(deploySummary) && deploySummary.length > 0) {
    lines.push("");
    lines.push("  Deploy Summary");
    lines.push("  " + "─".repeat(72));
    lines.push("  " + padRight("Package", 38) + padRight("Before", 18) + "After");
    lines.push("  " + "─".repeat(72));
    for (const entry of deploySummary as Array<Record<string, unknown>>) {
      const pkg = String(entry["packageName"] ?? entry["artifactName"] ?? "?");
      const before = String(entry["lastVersion"] ?? "—");
      const after = String(entry["newVersion"] ?? "—");
      lines.push("  " + padRight(pkg, 38) + padRight(before, 18) + after);
    }
    lines.push("  " + "─".repeat(72));
    lines.push("");
    lines.push("  Verify:");
    for (const entry of deploySummary as Array<Record<string, unknown>>) {
      const pkg = String(entry["packageName"] ?? "");
      if (pkg) {
        lines.push(`    pnpm list -g ${pkg}`);
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

function padRight(str: string, len: number): string {
  return str.length >= len ? str + " " : str + " ".repeat(len - str.length);
}
