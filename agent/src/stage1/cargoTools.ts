import type { Finding } from "../types";
import { have, spawnGuarded, type ToolOpts } from "./cargoProbe";

export type { ToolOpts };

export function runApiDelta(repo: string, base: string, opts: ToolOpts = {}) {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo, "public-api")) {
    degraded.push("cargo public-api unavailable: API-delta section omitted");
    return { apiDelta: undefined as string | undefined, degraded };
  }
  const p = spawnGuarded([cargo, "public-api", "diff", `${base}..HEAD`], { cwd: repo });
  // Important finding 3: guard the real invocation — see cargoProbe.ts.
  if (p.threw) {
    degraded.push(`cargo public-api failed to start: API-delta section omitted (${p.stderr || "unknown error"})`);
    return { apiDelta: undefined as string | undefined, degraded };
  }
  if (p.exitCode !== 0) {
    degraded.push("cargo public-api failed: API-delta section omitted");
    return { apiDelta: undefined as string | undefined, degraded };
  }
  return { apiDelta: p.stdout, degraded };
}

export function runSemverChecks(repo: string, opts: ToolOpts = {}) {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo, "semver-checks")) {
    degraded.push("cargo semver-checks unavailable: breaking-change section omitted");
    return { semver: undefined as Finding[] | undefined, degraded };
  }
  const p = spawnGuarded([cargo, "semver-checks", "check-release"], { cwd: repo });
  // Important finding 3: guard the real invocation — see cargoProbe.ts.
  if (p.threw) {
    degraded.push(
      `cargo semver-checks failed to start: breaking-change section omitted (${p.stderr || "unknown error"})`,
    );
    return { semver: undefined as Finding[] | undefined, degraded };
  }
  if (p.exitCode === 0) {
    return { semver: [] as Finding[], degraded };
  }
  const stdout = p.stdout.trim();
  if (!stdout) {
    // Important finding 2: a non-zero exit with nothing on stdout means the
    // tool never produced a report at all — no publishable baseline to
    // compare against, a network failure fetching one from crates.io, or a
    // build/config error. That is "could not run properly," not "found a
    // breaking change," and must degrade rather than fabricate a
    // merge-blocking Finding for a check that never validly ran. The real
    // error typically lands on stderr, which the old code never read.
    const detail = p.stderr.trim();
    degraded.push(`cargo semver-checks failed to run: ${detail || "no output on stdout or stderr"}`);
    return { semver: undefined as Finding[] | undefined, degraded };
  }
  const semver: Finding[] = [{
    severity: "major", category: "api-contract",
    path: "Cargo.toml", line: 1,
    title: "cargo semver-checks reported a breaking change",
    rationale: stdout.slice(0, 2000),
    failure_scenario: "downstream consumers fail to compile after upgrading",
    suggested_fix: "bump the major version, or restore the removed API",
    source: "semver", confidence: 1,
  }];
  return { semver, degraded };
}
