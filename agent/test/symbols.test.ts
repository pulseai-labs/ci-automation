import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols } from "../src/stage1/symbols";
import type { ContainerInfo, SymbolInfo } from "../src/types";

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

/** Find the `ContainerInfo` a given symbol's `(path, container)` key points to. */
function containerFor(containers: ContainerInfo[], sym: SymbolInfo): ContainerInfo | undefined {
  return containers.find(c => c.path === sym.path && c.container === sym.container);
}

// --- original tests (kept) -------------------------------------------------

test("a change inside open surfaces open_with_embedder as a sibling SIGNATURE", async () => {
  const { repo, sh } = repoWith(SRC);
  writeFileSync(join(repo, "src/db.rs"), SRC.replace("let x = 1;", "let x = 2; // migration"));
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const open = symbols.find(s => s.name === "open");
  expect(open).toBeDefined();
  expect(open!.container).toBe("impl PulseDB");
  const container = containerFor(containers, open!);
  expect(container).toBeDefined();
  expect(container!.signatures.some(s => s.includes("open_with_embedder"))).toBe(true);

  // signatures only — no bodies
  expect(container!.signatures.join("\n")).not.toContain("Ok(Self {})");
  rmSync(repo, { recursive: true, force: true });
});

// Re-keying task (S1): the old `siblings` field excluded the changed symbol
// itself (`c.items.filter(s => s !== item)`). `ContainerInfo.signatures` is
// stored ONCE per container and includes every item, the changed one
// included — that is the only way to store the list once instead of once
// per symbol. This test asserts the new, deliberately inclusive behaviour;
// see the doc comment on `ContainerInfo` in types.ts.
test("a container's signatures include every item, including the one that changed", async () => {
  const { repo, sh } = repoWith(SRC);
  writeFileSync(join(repo, "src/db.rs"), SRC.replace("let x = 1;", "let x = 2;"));
  sh("git add -A && git commit -qm change");
  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const open = symbols.find(s => s.name === "open")!;
  const container = containerFor(containers, open)!;
  expect(container.signatures.some(s => /\bfn open\s*\(/.test(s))).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});

// --- hazard tests (Important 6) --------------------------------------------
// Each of these reproduces one of the review's Critical/Important findings and
// would have failed against the old brace-matching implementation.

// Critical 2: multi-line signatures were truncated to their first line,
// dropping every parameter — including the very `Arc<dyn EmbeddingService>`
// the motivating PulseDB defect concerns. Assert the FULL collapsed
// signature, not a substring match.
const MULTILINE_SIG_SRC = `
impl PulseDB {
    pub fn open_with_embedder(
        path: impl AsRef<Path>,
        config: Config,
        embedder: Arc<dyn EmbeddingService>,
    ) -> Result<Self> {
        Ok(Self {})
    }

    fn helper(&self) -> u32 { 7 }
}
`;

test("multi-line signatures are captured in full, not truncated to the first line", async () => {
  const { repo, sh } = repoWith(MULTILINE_SIG_SRC);
  writeFileSync(join(repo, "src/db.rs"), MULTILINE_SIG_SRC.replace("u32 { 7 }", "u32 { 8 }"));
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const helper = symbols.find(s => s.name === "helper");
  expect(helper).toBeDefined();
  const container = containerFor(containers, helper!);
  expect(container).toBeDefined();

  const full =
    "pub fn open_with_embedder( path: impl AsRef<Path>, config: Config, " +
    "embedder: Arc<dyn EmbeddingService>, ) -> Result<Self>";
  // exact full signature — parameters AND return type both present, not a
  // substring of the truncated first line ("pub fn open_with_embedder(")
  expect(container!.signatures).toContain(full);
  rmSync(repo, { recursive: true, force: true });
});

// Critical 3: brace counting desynced on braces inside strings and comments
// (`format!("{{")`, or a doc comment containing `{`), permanently overshooting
// `depth` and silently swallowing every later sibling.
const BRACE_HAZARD_SRC = `
impl PulseDB {
    /// note: a literal brace shows up in prose here: {
    pub fn tricky() -> String {
        let s = format!("{{");
        s
    }

    pub fn sibling_after_braces() -> u32 { 42 }
}
`;

test("braces inside format! strings and doc comments do not desync container parsing", async () => {
  const { repo, sh } = repoWith(BRACE_HAZARD_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    BRACE_HAZARD_SRC.replace('format!("{{")', 'format!("{{}}")')
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const tricky = symbols.find(s => s.name === "tricky");
  expect(tricky).toBeDefined();
  expect(tricky!.container).toBe("impl PulseDB");
  const container = containerFor(containers, tricky!);
  expect(container).toBeDefined();
  // the sibling declared AFTER the brace-bearing doc comment and format! call
  // must still be visible — a desynced depth counter would have swallowed it
  expect(container!.signatures.some(s => s.includes("sibling_after_braces"))).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});

// Important 4 (+ const fn coverage): a multi-line `impl<T> ... where` header
// with the brace on its own line used to never match, making every method in
// it invisible.
const WHERE_CLAUSE_SRC = `
impl<T> Other<T> where T: Send,
{
    pub const fn c() -> u8 { 1 }

    pub fn d() -> u16 { 2 }
}
`;

test("a multi-line where-clause container header is recognized, including const fn items", async () => {
  const { repo, sh } = repoWith(WHERE_CLAUSE_SRC);
  writeFileSync(join(repo, "src/db.rs"), WHERE_CLAUSE_SRC.replace("u8 { 1 }", "u8 { 2 }"));
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  const c = symbols.find(s => s.name === "c");
  expect(c).toBeDefined();
  expect(c!.container).toBe("impl<T> Other<T> where T: Send,");
  expect(c!.kind).toBe("fn");
  const container = containerFor(containers, c!);
  expect(container).toBeDefined();
  expect(container!.signatures.some(s => s.includes("pub fn d() -> u16"))).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});

// Critical 1: a pure-deletion hunk (`@@ -l,s +n,0 @@`) has count === 0 on the
// new side, so the old walker never added anything to the touched set — the
// deleted migration call was structurally unreachable.
const DELETION_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> {
        let x = 1;
        run_migration();
        Ok(Self {})
    }

    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> {
        Ok(Self {})
    }
}
`;

test("a pure-deletion hunk still surfaces the enclosing (now-shorter) function as changed", async () => {
  const { repo, sh } = repoWith(DELETION_SRC);
  writeFileSync(join(repo, "src/db.rs"), DELETION_SRC.replace("        run_migration();\n", ""));
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
  const open = symbols.find(s => s.name === "open");
  expect(open).toBeDefined();
  expect(open!.container).toBe("impl PulseDB");
  const container = containerFor(containers, open!);
  expect(container).toBeDefined();
  expect(container!.signatures.some(s => s.includes("open_with_embedder"))).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});

// Important 5: `end`-line tracking used to bleed past a function's closing
// brace, so editing a comment BETWEEN two functions falsely reported the
// preceding one as changed. Node ranges are exact and exclude leading
// comments (they are siblings in the tree, not children of the function).
const COMMENT_BETWEEN_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
    // a comment sitting between two functions
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("editing only a comment between two functions reports neither as changed", async () => {
  const { repo, sh } = repoWith(COMMENT_BETWEEN_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    COMMENT_BETWEEN_SRC.replace(
      "// a comment sitting between two functions",
      "// an updated comment sitting between two functions"
    )
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  expect(symbols).toEqual([]);
  // no symbol was touched, so no container's signature list is emitted either
  expect(containers).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
});

// --- second review round: 2 Important findings -----------------------------

// Important (round 2, finding 1): the `count === 0` branch added to fix
// Critical 1 registered BOTH gap anchors as independently touched. When the
// deleted content sits BETWEEN two functions (not inside one), those anchors
// land on the preceding function's last row and the following function's
// first row respectively — falsely marking both changed although neither's
// own content changed. This is the pure-deletion analogue of the
// "comment between two functions" case above (a same-line edit, handled by
// the ordinary count>0 path, was already safe).
test("deleting (not editing) a comment between two functions reports neither as changed", async () => {
  const { repo, sh } = repoWith(COMMENT_BETWEEN_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    COMMENT_BETWEEN_SRC.replace("    // a comment sitting between two functions\n", "")
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
  expect(symbols).toEqual([]);
  expect(containers).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
});

// Important (round 2, finding 2): only container nodes pushed a stack frame,
// so a local helper `fn` declared inside another function's body was
// attributed to the enclosing container and appeared in its enclosing
// method's `siblings` as if it were a peer method. It is not a peer of
// anything (nothing outside its host function can even call it), so it is
// excluded from the symbol list entirely (see the design-choice comment on
// `collect` in symbols.ts).
const NESTED_FN_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> {
        fn local_helper(x: u32) -> u32 { x + 1 }
        let y = local_helper(1);
        Ok(Self {})
    }

    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> {
        Ok(Self {})
    }
}
`;

test("a fn nested inside another fn's body is excluded from the symbol list and from its host's container signatures", async () => {
  const { repo, sh } = repoWith(NESTED_FN_SRC);
  writeFileSync(join(repo, "src/db.rs"), NESTED_FN_SRC.replace("x + 1", "x + 2"));
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);

  // the nested helper never appears as its own symbol
  expect(symbols.find(s => s.name === "local_helper")).toBeUndefined();

  // editing the helper's body still shows its host, `open`, as changed
  const open = symbols.find(s => s.name === "open");
  expect(open).toBeDefined();
  expect(open!.container).toBe("impl PulseDB");
  const container = containerFor(containers, open!);
  expect(container).toBeDefined();
  // exact signature list — local_helper must not be smuggled in as a peer,
  // and (S1's deliberate semantic change) `open`'s own signature IS present
  // alongside `open_with_embedder`'s, in source order.
  expect(container!.signatures).toEqual([
    "pub fn open(path: &Path) -> Result<Self>",
    "pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self>",
  ]);
  rmSync(repo, { recursive: true, force: true });
});

// Minor: a pure-deletion hunk at the very start of a file has no preceding
// line (git reports `+0,0`); `changedLines` must not synthesize a negative
// row for it. Regression guard, not a pre-fix failure: an unguarded -1 also
// never matched any item's (>= 0) startRow, so behaviour is unchanged — this
// just pins down that the boundary case stays inert rather than crashing or
// (if the guard were ever removed carelessly) coincidentally matching.
const LEADING_LINE_SRC = `// leading file comment, not inside any container
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("deleting the very first line of a file does not mark any function changed", async () => {
  const { repo, sh } = repoWith(LEADING_LINE_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    LEADING_LINE_SRC.replace("// leading file comment, not inside any container\n", "")
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
  expect(symbols).toEqual([]);
  expect(containers).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
});
