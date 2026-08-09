import type { Finding } from "../types";
import type { ToolOpts } from "./lint";

function have(bin: string, sub?: string): boolean {
  const cmd = sub ? `${bin} ${sub} --version` : `command -v ${bin}`;
  return Bun.spawnSync(["bash", "-lc", cmd]).exitCode === 0;
}

export function runApiDelta(repo: string, base: string, opts: ToolOpts = {}) {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo, "public-api")) {
    degraded.push("cargo public-api unavailable: API-delta section omitted");
    return { apiDelta: undefined as string | undefined, degraded };
  }
  const p = Bun.spawnSync([cargo, "public-api", "diff", `${base}..HEAD`], { cwd: repo });
  if (p.exitCode !== 0) {
    degraded.push("cargo public-api failed: API-delta section omitted");
    return { apiDelta: undefined, degraded };
  }
  return { apiDelta: p.stdout.toString(), degraded };
}

export function runSemverChecks(repo: string, opts: ToolOpts = {}) {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo, "semver-checks")) {
    degraded.push("cargo semver-checks unavailable: breaking-change section omitted");
    return { semver: undefined as Finding[] | undefined, degraded };
  }
  const p = Bun.spawnSync([cargo, "semver-checks", "check-release"], { cwd: repo });
  const semver: Finding[] = [];
  if (p.exitCode !== 0) {
    semver.push({
      severity: "major", category: "api-contract",
      path: "Cargo.toml", line: 1,
      title: "cargo semver-checks reported a breaking change",
      rationale: p.stdout.toString().slice(0, 2000),
      failure_scenario: "downstream consumers fail to compile after upgrading",
      suggested_fix: "bump the major version, or restore the removed API",
      source: "semver", confidence: 1,
    });
  }
  return { semver, degraded };
}
