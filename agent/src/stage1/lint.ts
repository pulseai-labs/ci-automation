import type { ChangedFile, Finding } from "../types";

export interface ToolOpts { cargoBin?: string; timeoutMs?: number }

function have(bin: string): boolean {
  return Bun.spawnSync(["bash", "-lc", `command -v ${bin}`]).exitCode === 0;
}

export function runClippy(repo: string, files: ChangedFile[], opts: ToolOpts = {}) {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo)) {
    degraded.push(`clippy skipped: ${cargo} not found`);
    return { findings: [] as Finding[], degraded };
  }
  const p = Bun.spawnSync(
    [cargo, "clippy", "--message-format=json", "--quiet"],
    { cwd: repo, env: { ...process.env } },
  );
  if (p.exitCode !== 0 && !p.stdout.toString().trim()) {
    degraded.push("clippy skipped: build failed");
    return { findings: [] as Finding[], degraded };
  }
  const changed = new Set(files.map(f => f.path));
  const findings: Finding[] = [];
  for (const line of p.stdout.toString().split("\n")) {
    if (!line.startsWith("{")) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    const msg = m?.message;
    if (!msg?.spans?.length) continue;
    const span = msg.spans.find((s: any) => s.is_primary) ?? msg.spans[0];
    if (!changed.has(span.file_name)) continue;   // changed lines only (§16 noise policy)
    findings.push({
      severity: msg.level === "error" ? "major" : "minor",
      category: "maintainability",
      path: span.file_name,
      line: span.line_start,
      title: msg.message,
      rationale: msg.message,
      failure_scenario: "reported by cargo clippy",
      suggested_fix: msg.children?.[0]?.message ?? "see clippy output",
      source: "clippy",
      confidence: 1,
    });
  }
  return { findings, degraded };
}
