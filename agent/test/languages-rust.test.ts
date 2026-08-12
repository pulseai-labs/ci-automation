import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rust } from "../src/stage1/languages";
import type { ContainerInfo, SymbolInfo } from "../src/types";

// ===========================================================================
// symbol extraction (moved from symbols.test.ts)
// ===========================================================================

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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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
  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);

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

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 0, removed: 1 }]);
  expect(symbols).toEqual([]);
  expect(containers).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
});

// --- Fix round 1 (review of S1) --------------------------------------------

// Review finding 1: the `${path}::${label}` dedup key collides when one file
// has two same-labelled `impl` blocks — idiomatic Rust (public API in one
// `impl`, helpers in another; or two `#[cfg]`-gated blocks). A first-writer-
// wins guard silently dropped the second block's signatures from the pack,
// landing exactly on the `open` / `open_with_embedder` peer-divergence case
// this feature exists to surface. Fixed by merging same-key containers
// (concatenating `items`, preserving source order) instead of first-wins.
const SPLIT_IMPL_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
}

impl PulseDB {
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("two same-labelled impl blocks in one file are merged into a single container, not first-writer-wins", async () => {
  const { repo, sh } = repoWith(SPLIT_IMPL_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    SPLIT_IMPL_SRC
      .replace("pub fn open(path: &Path)", "pub fn open(path: &Path) /* touched */")
      .replace("pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>)",
        "pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) /* touched */")
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [
    { path: "src/db.rs", added: 2, removed: 2 },
  ]);

  // both functions were extracted as symbols, from the same-labelled
  // container in each case
  expect(symbols.map(s => s.name).sort()).toEqual(["open", "open_with_embedder"]);
  expect(symbols.every(s => s.container === "impl PulseDB")).toBe(true);

  // merged into ONE container entry, not two
  expect(containers.length).toBe(1);
  expect(containers[0]!.container).toBe("impl PulseDB");

  // both blocks' signatures present, in source order (block 1's `open`
  // before block 2's `open_with_embedder`) — the reviewer's exact repro:
  // `open_with_embedder`'s own signature must resolve to `true`, not `false`
  const open = symbols.find(s => s.name === "open")!;
  const openWithEmbedder = symbols.find(s => s.name === "open_with_embedder")!;
  const container = containerFor(containers, open)!;
  expect(container).toBe(containerFor(containers, openWithEmbedder)!);
  expect(container.signatures).toEqual([
    "pub fn open(path: &Path) /* touched */ -> Result<Self>",
    "pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) /* touched */ -> Result<Self>",
  ]);
  rmSync(repo, { recursive: true, force: true });
});

// --- Fix round 2 (review of S1's merge fix) --------------------------------
//
// Round 1 fixed the case where BOTH same-labelled blocks have a touched
// item. It missed the case where only ONE does: `collect`'s caller skips any
// block whose own `touched` list is empty (`if (touched.length === 0)
// continue`), so a same-labelled block with nothing touched never made it
// into `containerByKey` — even when its sibling block, sharing the same
// key, WAS touched. That untouched peer is precisely the absence this
// feature exists to surface (the PulseDB motivating defect: `open` changed,
// `open_with_embedder` did not, and the reviewer needs to see both to
// notice). Fixed by deciding "does this key have any touched block" across
// ALL of a key's blocks before emitting any of them.

function repoWithFiles(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "sym-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
  }
  sh("git add -A && git commit -qm base && git branch base");
  return { repo, sh };
}

// The reviewer's exact repro: two same-labelled impl blocks, only the FIRST
// touched. Exhaustive `toEqual` on the whole signature array (not
// `toContain`) — the point is that `open_with_embedder`'s signature is
// present even though its block was never itself touched.
const SPLIT_IMPL_ONLY_FIRST_TOUCHED_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
}

impl PulseDB {
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("only the first of two same-labelled impl blocks is touched — the untouched peer's signature still merges in", async () => {
  const { repo, sh } = repoWith(SPLIT_IMPL_ONLY_FIRST_TOUCHED_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    SPLIT_IMPL_ONLY_FIRST_TOUCHED_SRC.replace("pub fn open(path: &Path)", "pub fn open(path: &Path) /* touched */"),
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);

  // only `open` was touched -> it is the only symbol
  expect(symbols.map(s => s.name)).toEqual(["open"]);
  expect(symbols[0]!.container).toBe("impl PulseDB");

  // still ONE merged container, and it carries BOTH blocks' signatures in
  // source order, even though the second block has nothing touched
  expect(containers.length).toBe(1);
  const container = containerFor(containers, symbols[0]!)!;
  expect(container.signatures).toEqual([
    "pub fn open(path: &Path) /* touched */ -> Result<Self>",
    "pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self>",
  ]);
  rmSync(repo, { recursive: true, force: true });
});

// Three same-labelled blocks, only the MIDDLE one touched — pins source
// order exactly (untouched-then-touched-then-untouched), which the naive
// "gather a touched block's siblings" framing could get wrong if the merge
// didn't walk blocks in their original document order.
const THREE_BLOCK_MIX_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
}

impl PulseDB {
    pub fn middle(path: &Path) -> Result<Self> { Ok(Self {}) }
}

impl PulseDB {
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("three same-labelled impl blocks, only the middle one touched — all three merge in exact source order", async () => {
  const { repo, sh } = repoWith(THREE_BLOCK_MIX_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    THREE_BLOCK_MIX_SRC.replace("pub fn middle(path: &Path)", "pub fn middle(path: &Path) /* touched */"),
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);

  expect(symbols.map(s => s.name)).toEqual(["middle"]);
  expect(containers.length).toBe(1);
  const container = containerFor(containers, symbols[0]!)!;
  expect(container.signatures).toEqual([
    "pub fn open(path: &Path) -> Result<Self>",
    "pub fn middle(path: &Path) /* touched */ -> Result<Self>",
    "pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self>",
  ]);
  rmSync(repo, { recursive: true, force: true });
});

// Negative 1: a same-labelled block living in a DIFFERENT file must never
// merge with it, even when both files' blocks are independently touched.
// The dedup key must keep carrying `path`.
const CROSS_FILE_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
}
`;

test("a same-labelled impl block in a different file never merges, even when both are touched", async () => {
  const { repo, sh } = repoWithFiles({ "src/a.rs": CROSS_FILE_SRC, "src/b.rs": CROSS_FILE_SRC });
  writeFileSync(join(repo, "src/a.rs"), CROSS_FILE_SRC.replace("Result<Self>", "Result<Self> /* a touched */"));
  writeFileSync(join(repo, "src/b.rs"), CROSS_FILE_SRC.replace("Result<Self>", "Result<Self> /* b touched */"));
  sh("git add -A && git commit -qm change");

  const { containers } = await rust.extractSymbols(repo, "base", [
    { path: "src/a.rs", added: 1, removed: 1 },
    { path: "src/b.rs", added: 1, removed: 1 },
  ]);

  expect(containers.length).toBe(2);
  const a = containers.find(c => c.path === "src/a.rs");
  const b = containers.find(c => c.path === "src/b.rs");
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect(a!.signatures).toEqual(["pub fn open(path: &Path) -> Result<Self> /* a touched */"]);
  expect(b!.signatures).toEqual(["pub fn open(path: &Path) -> Result<Self> /* b touched */"]);
  rmSync(repo, { recursive: true, force: true });
});

// Negative 2: two same-labelled blocks where NEITHER has a touched item
// (only the inter-block comment is edited) must still emit no container at
// all — the fix merges in untouched peers of a touched key, it does not
// start emitting containers for wholly-untouched keys.
const SPLIT_IMPL_NEITHER_TOUCHED_SRC = `
impl PulseDB {
    pub fn open(path: &Path) -> Result<Self> { Ok(Self {}) }
}

// comment between the two same-labelled impl blocks
impl PulseDB {
    pub fn open_with_embedder(path: &Path, e: Arc<dyn Embedder>) -> Result<Self> { Ok(Self {}) }
}
`;

test("two same-labelled impl blocks, neither touched, emit no container at all", async () => {
  const { repo, sh } = repoWith(SPLIT_IMPL_NEITHER_TOUCHED_SRC);
  writeFileSync(
    join(repo, "src/db.rs"),
    SPLIT_IMPL_NEITHER_TOUCHED_SRC.replace(
      "// comment between the two same-labelled impl blocks",
      "// an updated comment between the two same-labelled impl blocks",
    ),
  );
  sh("git add -A && git commit -qm change");

  const { symbols, containers } = await rust.extractSymbols(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }]);
  expect(symbols).toEqual([]);
  expect(containers).toEqual([]);
  rmSync(repo, { recursive: true, force: true });
});

// ===========================================================================
// clippy + cargo tools (moved from lint.test.ts)
// ===========================================================================

// --- test helpers ------------------------------------------------------

/** Writes an executable stand-in "cargo" and returns its absolute path.
 *  `body` receives $1, $2, ... exactly as the real cargo invocations pass
 *  them (`<sub> --version` for a `have()` probe, `<sub> <flags...>` for the
 *  real call), so a script can branch on `$1`/`$2` to fake both. */
function fakeCargo(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-cargo-"));
  const path = join(dir, "cargo");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A git repo with `content` committed on branch "base", then a second
 *  commit on the current branch applying `mutate`. */
function repoWithMutation(content: string, mutate: (c: string) => string): string {
  const repo = mkdtempSync(join(tmpdir(), "lint-repo-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/db.rs"), content);
  sh("git add -A && git commit -qm base && git branch base");
  writeFileSync(join(repo, "src/db.rs"), mutate(content));
  sh("git add -A && git commit -qm change");
  return repo;
}

// --- pre-existing tests (brief step 1), updated for the Rust module ---

test("runLinters degrades cleanly when cargo is absent", () => {
  const r = rust.runLinters("/nonexistent-repo", "main", [], { cargoBin: "definitely-not-cargo" });
  expect(r.findings).toEqual([]);
  expect(r.degraded.join(" ")).toContain("clippy");
});

test("runApiTools degrades cleanly when both tools are absent", () => {
  const r = rust.runApiTools!("/nonexistent-repo", "main", { cargoBin: "definitely-not-cargo" });
  expect(r.apiDelta).toBeUndefined();
  expect(r.semver).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("public-api");
  expect(r.degraded.join(" ")).toContain("semver");
});

// --- Important finding 1: clippy scoped to changed LINES, not changed files ---

const TEN_LINES = ["fn a() {}", "fn b() {}", "fn c() {}", "fn d() {}", "fn e() {}",
  "fn f() {}", "fn g() {}", "fn h() {}", "fn i() {}", "fn j() {}", ""].join("\n");

test("runLinters keeps only diagnostics whose span overlaps a changed line, not merely a changed file", () => {
  const repo = repoWithMutation(TEN_LINES, s => s.replace("fn c() {}", "fn c2() {}")); // changes line 3
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then
  exit 0
fi
cat <<'JSON'
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"on-changed-line","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":3,"line_end":3}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"far-from-change","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":9,"line_end":9}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"overlapping-span","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":2,"line_end":4}],"children":[]}}
JSON
exit 0
`);

  const r = rust.runLinters(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }], { cargoBin: cargo });
  const titles = r.findings.map(f => f.title);

  // exact match on the changed line: kept
  expect(titles).toContain("on-changed-line");
  // span [2,4] never equals the changed row (3) exactly, but overlaps it: kept
  // — this is the documented policy (hunks.ts rangeTouched): overlap, not exact match.
  expect(titles).toContain("overlapping-span");
  // same file, but its span (line 9) touches nothing the diff changed: dropped
  expect(titles).not.toContain("far-from-change");
  expect(r.findings.length).toBe(2);

  rmSync(repo, { recursive: true, force: true });
});

// --- Important finding 2: a broken semver invocation must degrade, not fabricate a Finding ---

test("runApiTools degrades (does not fabricate a Finding) when semver-checks ran but produced no report", () => {
  const cargo = fakeCargo(`
if [[ "$1" == "semver-checks" && "$2" == "--version" ]]; then
  exit 0
fi
if [[ "$1" == "semver-checks" && "$2" == "check-release" ]]; then
  echo "error: no crates.io baseline found for this crate" 1>&2
  exit 1
fi
exit 1
`);
  const r = rust.runApiTools!("/tmp", "main", { cargoBin: cargo });
  // "ran, failed" must land in degraded as undefined -- never as a synthesized
  // major/api-contract Finding for a check that never validly compared anything.
  expect(r.semver).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("semver-checks");
  // the real failure reason (stderr) must actually be surfaced, not dropped
  expect(r.degraded.join(" ")).toContain("no crates.io baseline");
});

test("runApiTools still reports a real breaking change when semver-checks produces a report", () => {
  const cargo = fakeCargo(`
if [[ "$1" == "semver-checks" && "$2" == "--version" ]]; then
  exit 0
fi
if [[ "$1" == "semver-checks" && "$2" == "check-release" ]]; then
  echo "--- failure major: removed function 'pub_fn' ---"
  exit 1
fi
exit 1
`);
  const r = rust.runApiTools!("/tmp", "main", { cargoBin: cargo });
  expect(r.semver?.length).toBe(1);
  // the finding must carry a non-empty rationale drawn from the report
  expect(r.semver?.[0]?.rationale).toContain("removed function");
});

// --- Important finding 3: guard real invocations against a spawn-level throw ---
// Bun.spawnSync throws synchronously (not a non-zero result) when the process
// cannot be started at all -- empirically reproduced here with a nonexistent
// cwd, the reviewer's own repro. `have()` cannot catch this: it never spawns
// with `cwd: repo`, so a bad *repo* cwd only ever surfaces at the real call.

const BAD_CWD = "/definitely/does/not/exist/nope";

test("runLinters guards a spawn-level throw (bad cwd) and degrades instead of throwing", () => {
  const r = rust.runLinters(BAD_CWD, "main", [], { cargoBin: "true" });
  expect(r.findings).toEqual([]);
  expect(r.degraded.length).toBeGreaterThan(0);
  // I1: the previous version of this test asserted only `.length > 0`,
  // which the OTHER degrade branch in runClippy ("clippy skipped: build
  // failed", lint.ts:40) also satisfies — deleting the `if (p.threw)`
  // branch entirely (lint.ts:35) left this test green because that later
  // branch's non-zero-exit check still degrades on a spawn-level throw's
  // default `exitCode: -1`. Assert the distinguishing string that only the
  // `p.threw` branch itself produces.
  expect(r.degraded.join(" ")).toContain("failed to start");
});

test("runApiTools guards a spawn-level throw (bad cwd) and degrades instead of throwing", () => {
  const r = rust.runApiTools!(BAD_CWD, "main", { cargoBin: "true" });
  expect(r.apiDelta).toBeUndefined();
  expect(r.semver).toBeUndefined();
  expect(r.degraded.length).toBeGreaterThan(0);
});

// --- Important finding 4: consolidated have() gives runClippy an accurate ---
// --- degrade message for "component missing" vs. "build failed"          ---

test("runLinters distinguishes a missing clippy component from a real build failure", () => {
  const missingComponent = fakeCargo(`
if [[ "$2" == "--version" ]]; then
  exit 1
fi
exit 1
`);
  const componentResult = rust.runLinters("/tmp", "main", [], { cargoBin: missingComponent });
  expect(componentResult.degraded.join(" ")).toContain("component");
  expect(componentResult.degraded.join(" ")).not.toContain("build failed");

  const buildFailure = fakeCargo(`
if [[ "$2" == "--version" ]]; then
  exit 0
fi
echo "error: could not compile probe due to 1 previous error" 1>&2
exit 101
`);
  const buildResult = rust.runLinters("/tmp", "main", [], { cargoBin: buildFailure });
  expect(buildResult.degraded.join(" ")).toContain("build failed");
});

// --- category mapping based on lint level ---

test("runLinters maps error-level diagnostics to correctness and warning-level to maintainability", () => {
  const repo = repoWithMutation(TEN_LINES, s => s.replace("fn a() {}", "fn a2() {}"));
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then
  exit 0
fi
cat <<'JSON'
{"reason":"compiler-message","message":{"level":"error","code":{"code":"clippy::eq_op"},"message":"correctness-lint","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":1,"line_end":1}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::needless_return"},"message":"style-lint","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":1,"line_end":1}],"children":[]}}
JSON
exit 0
`);

  const r = rust.runLinters(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }], { cargoBin: cargo });
  expect(r.findings.length).toBe(2);

  const correctness = r.findings.find(f => f.title === "correctness-lint");
  expect(correctness?.category).toBe("correctness");
  // I1: this test previously asserted only `.category` — a mutation
  // hardcoding `severity: "minor"` regardless of `msg.level` (lint.ts:71)
  // left the full suite green, because nothing anywhere checked
  // `.severity` on a clippy finding. verdict.ts's DEFAULT_GATE only gates
  // on "blocker"/"major", so this mapping is the entire clippy merge gate.
  expect(correctness?.severity).toBe("major");

  const maintainability = r.findings.find(f => f.title === "style-lint");
  expect(maintainability?.category).toBe("maintainability");
  expect(maintainability?.severity).toBe("minor");

  rmSync(repo, { recursive: true, force: true });
});

// --- I1: attribute to the PRIMARY span, not merely the first span ---

test("runLinters attributes a diagnostic to its primary span, not merely the first span in the array", () => {
  const repo = repoWithMutation(TEN_LINES, s => s.replace("fn c() {}", "fn c2() {}")); // changes line 3
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then
  exit 0
fi
cat <<'JSON'
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"primary-not-first","spans":[{"is_primary":false,"file_name":"src/other.rs","line_start":9,"line_end":9},{"is_primary":true,"file_name":"src/db.rs","line_start":3,"line_end":3}],"children":[]}}
JSON
exit 0
`);

  const r = rust.runLinters(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }], { cargoBin: cargo });
  // `spans.find(s => s.is_primary) ?? spans[0]` (lint.ts:52) mutated to
  // `spans[0]` picks the non-primary "src/other.rs" span instead — which
  // is not in `changedFilePaths` (only "src/db.rs" was passed as changed),
  // so the finding is dropped entirely under the mutation. Correct
  // behavior keeps it, attributed to the primary span's file and line.
  const finding = r.findings.find(f => f.title === "primary-not-first");
  expect(finding).toBeDefined();
  expect(finding?.path).toBe("src/db.rs");
  expect(finding?.line).toBe(3);

  rmSync(repo, { recursive: true, force: true });
});
