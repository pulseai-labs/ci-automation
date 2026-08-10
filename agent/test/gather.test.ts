import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gather, CAPS } from "../src/stage1";

const REPO = "/Volumes/master_ssd/projects/PulseDB";
const maybe = existsSync(REPO) ? test : test.skip;

maybe("gather is deterministic: same SHA in, byte-identical pack out", async () => {
  const a = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  const b = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

maybe("gather stays inside its declared budget", async () => {
  const p = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  const total = CAPS.diff + CAPS.siblings + CAPS.clippy + CAPS.apiDelta;
  expect(p.budget.bytes).toBeLessThanOrEqual(total);
  expect(p.head).toMatch(/^[0-9a-f]{40}$/);
});

maybe("gather records what it truncated and what it degraded", async () => {
  const p = await gather({ repo: REPO, base: "origin/main", diffCap: 1000, skipCargo: true });
  expect(p.budget.capped).toContain("diff");
  expect(Array.isArray(p.degraded)).toBe(true);
});

/** A self-contained git repo with a base branch and a >1000-byte Rust diff. */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn one() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  // 5 functions, each with a long doc line: enough bytes that a 1000-byte diff
  // cap must truncate, few enough symbols that the 8 KB sibling cap does not.
  const body = Array.from({ length: 5 }, (_, i) =>
    `    /// ${"documentation ".repeat(12)}\n` +
    `    fn f${i}(input: &str, count: usize) -> Result<String, Error> { Ok(format!("{input}{count}")) }`
  ).join("\n");
  writeFileSync(join(repo, "src/a.rs"), `impl T {\n${body}\n}\n`);
  sh("git add -A && git commit -qm change");
  return repo;
}

test("fixture: gather is deterministic — same SHA in, byte-identical pack out", async () => {
  const repo = fixtureRepo();
  try {
    const a = await gather({ repo, base: "base", skipCargo: true });
    const b = await gather({ repo, base: "base", skipCargo: true });
    // Guard first: determinism over an empty pack proves nothing.
    // Numbers verified against `git diff --numstat base...HEAD -- '*.rs'` on
    // the fixture (10 lines added, 1 removed) — the brief's amendment said
    // 11/1; corrected here to match reality per the brief's own instruction.
    expect(a.changed).toEqual([{ path: "src/a.rs", added: 10, removed: 1 }]);
    expect(a.diff.length).toBeGreaterThan(1000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fixture: gather stays inside its declared budget and reports the real head SHA", async () => {
  const repo = fixtureRepo();
  try {
    const p = await gather({ repo, base: "base", skipCargo: true });
    const total = CAPS.diff + CAPS.siblings + CAPS.clippy + CAPS.apiDelta;
    expect(p.budget.bytes).toBeLessThanOrEqual(total);
    expect(p.budget.bytes).toBe(Buffer.byteLength(JSON.stringify(p), "utf8"));
    const realHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
      .stdout.toString().trim();
    expect(p.head).toBe(realHead);
    expect(p.head).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fixture: gather records what it truncated and what it degraded", async () => {
  const repo = fixtureRepo();
  try {
    const capped = await gather({ repo, base: "base", diffCap: 1000, skipCargo: true });
    expect(capped.budget.capped).toContain("diff");
    expect(capped.diff).toContain("[truncated:");
    expect(capped.degraded).toEqual(["cargo sections skipped by caller"]);

    const uncapped = await gather({ repo, base: "base", skipCargo: true });
    expect(uncapped.budget.capped).not.toContain("diff");
    expect(uncapped.diff).not.toContain("[truncated:");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
