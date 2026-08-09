import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols } from "../src/stage1/symbols";

const SRC = `
impl PulseDB {
    pub fn open(path: &Path, config: Config) -> Result<Self> {
        let x = 1;
        Ok(Self {})
    }

    pub fn open_with_embedder(path: &Path, config: Config, e: Arc<dyn Embedder>) -> Result<Self> {
        Ok(Self {})
    }

    fn helper(&self) -> u32 { 7 }
}
`;

function repoWith(content: string) {
  const repo = mkdtempSync(join(tmpdir(), "sym-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/db.rs"), content);
  sh("git add -A && git commit -qm base && git branch base");
  return { repo, sh };
}

test("a change inside open surfaces open_with_embedder as a sibling SIGNATURE", () => {
  const { repo, sh } = repoWith(SRC);
  writeFileSync(join(repo, "src/db.rs"), SRC.replace("let x = 1;", "let x = 2; // migration"));
  sh("git add -A && git commit -qm change");

  const syms = extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const open = syms.find(s => s.name === "open");
  expect(open).toBeDefined();
  expect(open!.container).toBe("impl PulseDB");
  expect(open!.siblings.some(s => s.includes("open_with_embedder"))).toBe(true);

  // signatures only — no bodies
  expect(open!.siblings.join("\n")).not.toContain("Ok(Self {})");
  rmSync(repo, { recursive: true, force: true });
});

test("siblings exclude the changed symbol itself", () => {
  const { repo, sh } = repoWith(SRC);
  writeFileSync(join(repo, "src/db.rs"), SRC.replace("let x = 1;", "let x = 2;"));
  sh("git add -A && git commit -qm change");
  const syms = extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const open = syms.find(s => s.name === "open")!;
  expect(open.siblings.some(s => /\bfn open\s*\(/.test(s))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
});
