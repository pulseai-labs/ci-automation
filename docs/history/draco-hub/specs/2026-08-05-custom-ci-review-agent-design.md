# Custom CI review agent — design

- **Status:** design approved (all five sections), implementation not started
- **Date:** 2026-08-05
- **Supersedes:** droid as the agent behind `pulseai-labs/ci-automation`
- **Does not change:** the CI platform itself. ADR-0001 stands. Validation, checkout,
  commenting, commit-status gating and workspace cleanup are untouched.

> **Provenance.** Every number below is marked `[M]` measured on this host today,
> `[D]` documented, or `[E]` estimated. Resolve live facts with `./scripts/context.sh`;
> nothing volatile is recorded here. Measurements are reproducible via the appendix.

---

## 1. Why

**Economics, not capability.** droid produced genuinely good output — it returned
INCONCLUSIVE on a CI-only diff rather than inventing findings, and found two real defects
on PulseDB PR #66. Quality was never the problem. Consumption was: the Z.AI coding-plan
session quota was exhausted within a day of enabling two automations.

That claim is now measured rather than reasoned.

### 1.1 What the runs actually cost `[M]`

Twelve droid CI sessions, correlated to workflow runs by timestamp (12/12 matched
within 3 minutes):

| automation | runs | avg turns | cumulative context | ~input tokens | share |
|---|---:|---:|---:|---:|---:|
| qa | 9 | 15.1 | 21,792 KB | 5.58 M | 87% |
| code-review | 3 | 7.3 | 3,382 KB | 0.87 M | 13% |
| **total** | **12** | | **25,174 KB** | **~6.44 M** | |

Cumulative context = the sum, over turns, of transcript-bytes-so-far — the quantity an
agentic loop actually re-sends. It is an **upper bound**: it ignores prompt caching
(droid reports `cache_read_input_tokens`, so caching is active) and compaction.

### 1.2 Where the tokens go `[M]`

Amplification scales linearly with turn count (7 turns → 2.3×; 16 → 9.6×; 32 → 20.0×),
so cumulative context grows roughly **quadratically in turns**.

Composition of the 356 KB transcript of run `30843117622` (code-review, 15 turns):

| | KB | share |
|---|---:|---:|
| tool results | ~250 | **~70%** |
| thinking blocks | 85 | 24% |
| skill + prompt | 9 | **2.5%** |

And the growth curve is dominated by a single event:

```
turn  1:  14 KB        turn  7: 208 KB   ← +137 KB in one tool result
turn  6:  71 KB        turn 15: 356 KB
```

**Turns 7–15 carry 2,708 KB of the 2,936 KB total — 92% of the run's cost.** One
oversized tool result set the price of every turn after it.

### 1.3 Consequences that shaped this design

1. **The skill is not the lever.** At 2.5% of transcript (code-review) it is noise.
   Deleting `qa-library` entirely would save less than the single tool call at turn 7.
2. **Unbounded tool output is the lever.** `src/storage/redb.rs` is 337 KB; reading it
   costs ~84k tokens, **4× the entire diff-with-context**, and is then re-sent every turn.
3. **Turn count is the second lever**, and it is quadratic.
4. **A stale SHA pin cost 17% of all measured spend** `[M]`: run `30885775050` ran 23
   turns / 504 s / ~1.07 M input tokens and produced **no report**, because
   `pulsedb-internal` was pinned to hub `c3bf4f9`, predating the autonomy fix in `4163346`.

### 1.4 Scope

MVP is **code-review only**. It is read-only (no sandbox problem), cheapest to iterate on,
and uniquely has a **regression baseline**: PR #66 / run `30843117622` produced two
genuine findings. `security-audit` has no skill written yet; `qa` needs the sandbox
conversation and is 87% of spend — both follow once the shape is proven.

---

## 2. Measured baseline `[M]`

Same model (`glm-5.2` via the Z.AI coding plan), same prompt (`"Reply with exactly: OK"`),
input tokens for one turn:

| harness | input tokens |
|---|---:|
| opencode, default `build` agent | 14,333 |
| droid, default | 11,957 |
| droid `--disable-builtin-skills` (hub config today) | 4,941 – 6,413 |
| **opencode, stripped + 1 tool** | **623** |
| opencode, stripped + zero tools | **227** |

droid's floor varied ~20% run to run, so treat single-config comparisons under ~10%
as noise. The 227-vs-6,413 gap is far outside that.

### 2.1 Per-tool cost `[M]`

Deterministic, from the server's assembled tool schemas (zero model calls):

| tool | bytes | ~tokens | keep for review? |
|---|---:|---:|---|
| `bash` | 5,756 | 1,439 | **no** — 25% of the surface, and the injection blast radius |
| `task` | 3,823 | 955 | **no** — see §4.4 |
| `todowrite` | 2,653 | 663 | no |
| `edit` | 1,925 | 481 | no |
| `read` | 1,701 | 425 | no — replaced by `read_symbol` |
| `question` | 1,481 | 370 | no — non-interactive |
| `webfetch` | 1,260 | 315 | no |
| `grep` | 1,150 | 287 | no — replaced by `grep_bounded` |
| `glob` | 1,081 | 270 | no |
| `write` | 993 | 248 | no |
| `skill` | 643 | 160 | no — also removes the `<available_skills>` block |
| `invalid` | 225 | 56 | (synthetic) |
| **total** | **22,691** | **5,672** | |

Live validation against the byte model:

| config | live tokens | Δ | byte-predicted Δ |
|---|---:|---:|---:|
| 0 tools | 227 | — | — |
| +`grep` | 621 | 394 | 287 |
| +`grep` +`read` | 1,066 | 839 | 712 |
| +`task` | 1,177 | **950** | **955** |
| all 14 | 5,468 | 5,241 | 5,672 |

Byte-derived figures under-predict by 0–40%; treat them as a lower bound. `task` matched
within 0.5%.

Two caveats on that last row. The "all 14" config names 14 tools, but the server returns
**12** for this provider/model — `patch`, `todoread` and `list` do not exist here, so the
live figure covers 12. And `[M]` throughout this section means measured on this host today
with `--pure` and `OPENCODE_DISABLE_MODELS_FETCH=1`; the 227 baseline was independently
reproduced twice (227 and 226) by different methods.

---

## 3. Architecture

**Location:** `pulseai-labs/ci-automation`, under `agent/`. The hub already checks itself
out at `github.job_workflow_sha`, so this is one repo, one SHA pin, no second pin to drift
(§1.3, item 4).

**Runtime:** Bun 1.3.6 `[M]` — already on the runner. node 20.20.0 available as fallback.

**Process model:** the orchestrator spawns its own `opencode serve` per job, on
`127.0.0.1` with an explicitly assigned port and `OPENCODE_SERVER_PASSWORD`, and tears it
down in a `finally`. Not a shared long-lived server: that would leave `POST /pty` and
`PUT /auth/{providerID}` reachable on the runner between jobs.

```
GitHub Actions step (hub droid.yml — plumbing unchanged)
  └── bun run .ci-automation/agent/review.ts
        ├── stage 1  gather facts      — deterministic, no model
        ├── stage 2  drive the agent   — SDK, structured output
        └── stage 3  validate + render — deterministic, no model
              emits: report.md · VERDICT · commit status · token accounting
                    │ @opencode-ai/sdk over 127.0.0.1 (password, explicit port)
              opencode serve --pure
                ├── agent: code-review   (own prompt, 2 tools, steps cap)
                └── tools: diff_facts · read_symbol · grep_bounded ·
                           api_surface_delta · semver_check   (all byte-capped)
```

**Trust boundary.** The review agent gets **no `bash`, no network, no GitHub token, and no
whole-file read** — only the capped tools. This is a tool *allowlist*, structurally
stronger than droid's `--auto` command *classifier*: there is no shell string that escapes
a tool which was never registered. It also closes the loopback hole, since an injected
prompt has no way to `curl 127.0.0.1`.

`security-audit` inherits this unchanged. Only `qa` — which must compile and execute code —
needs the sandbox conversation.

---

## 4. Stages and contracts

### 4.1 Contract

```ts
type EvidencePack = {              // stage 1 → stage 2 (deterministic)
  head: string                     // 40-hex SHA, echoed into every finding
  diff: string                     // git diff -U5, byte-capped
  changed: { path: string; added: number; removed: number }[]
  symbols: {                       // per changed function/method
    path: string; name: string; kind: string
    container: string              // e.g. "impl PulseDB"
    siblings: string[]             // SIGNATURES ONLY of items in the same container
  }[]
  clippy: Finding[]                // deterministic findings, changed lines only
  apiDelta?: string                // cargo public-api diff, if toolchain present
  semver?: Finding[]               // cargo semver-checks
  budget: { bytes: number; capped: string[] }
}

type Finding = {                   // stage 2 → stage 3 (json_schema-constrained)
  severity: 'blocker' | 'major' | 'minor' | 'nit'
  category: 'correctness' | 'security' | 'data-loss' | 'api-contract' | 'maintainability'
  path: string; line: number
  title: string
  rationale: string
  failure_scenario: string
  suggested_fix: string
  source: 'agent' | 'clippy' | 'semver'
  confidence: number
}
```

`Finding` is the `json_schema` passed to the server. The model cannot return prose where a
verdict belongs — which is the entire reason for the SDK path over the CLI.

### 4.2 Stage 1 — gather (no model)

Budgets measured on PulseDB `sprint-4.3` @ `6730c4d` `[M]`:

| item | measured | cap |
|---|---:|---:|
| `git diff -U5 -- '*.rs'` | 80,836 B (~20.2k tok), 7 files | 150 KB |
| sibling signatures | ~2–4 KB | 8 KB |
| clippy, changed lines | small | 16 KB |
| `cargo public-api diff` | tens of lines | 8 KB |
| **evidence pack** | **~100 KB (~25k tok) observed** | **182 KB (~46k tok) worst case** |

The caps are a *ceiling*, not a target: the observed pack on a real PR is ~100 KB. What
matters is that the ceiling exists and cannot be exceeded mid-run.

For contrast, whole bodies of those 7 files total **680,379 B / ~170k tokens** `[M]`.

**Sibling signatures are load-bearing.** PR #66's P2 — *"the `main_graph` migration exists
in `open` but is missing from `open_with_embedder`"* — is about code **not in the diff**.
A diff-only reviewer cannot find it at any model quality. Emitting the signatures of every
sibling item in the same `impl` block costs a few KB and makes the absence visible; the
agent then pulls exactly one body to confirm. Two tool calls, not fifteen turns.

### 4.3 Stage 2 — reason (bounded)

System prompt = the existing `code-review/SKILL.md` (8,014 B) ported near-verbatim. It is
PulseDB-specific domain knowledge — redb transaction boundaries, HNSW lock discipline,
provider-identity guards — and it is the thing that produced real findings. It is portable
to any harness.

Tools, exactly two:

- `read_symbol(path, name)` → one item's body, byte-capped, truncated with an explicit marker
- `grep_bounded(pattern, glob)` → `--max-count 40`, byte-capped

No `bash`, no file read, no network. `steps` capped. Output constrained to `Finding[]`.

The cap on `read_symbol` is the single load-bearing line of code in the system: it makes
the 137 KB turn-7 event unreachable rather than unlikely.

### 4.4 No LLM orchestrator at MVP `[M]`

The `task` tool costs **950 tokens on every parent turn** — ~14,250 over a 15-turn review —
purely to make subagent routing available. And the routing decision is already made
deterministically: `automations: code-review` is a **workflow input**, known before any
model runs.

**The orchestrator is the TypeScript program, not an agent.** Specialists stay exactly as
specialists; what is removed is a model call whose only job is to read a field we already
have. Revisit when a specialist should *escalate* ("this diff touches auth — also run
security-audit"), or when three automations need to share findings. Neither is MVP.

### 4.5 Stage 3 — validate (no model)

Every finding must survive:

1. `path` exists at `head` — else **drop** (kills hallucinated files)
2. `line` within that file's length — else **drop**
3. not in the diff → **relabel `adjacent`**, exclude from gating (droid did this by hand on
   PR #66; here it is mechanical)
4. dedupe against clippy/semver by `path:line:category`

Verdict is then **derived, not parsed**:

```
any surviving in-diff finding, severity=blocker   → FAIL
else any major                                     → FAIL   (configurable)
else findings exist                                → PASS with comments
else no changed .rs files                          → INCONCLUSIVE
stage 1/2 threw, server unreachable, provider error → ERROR  (never PASS)
```

Stage 3 also renders the report and writes per-message `cost` and
`tokens{input,output,reasoning,cache}` into the comment footer — the accounting droid never
provided.

---

## 5. Error handling

**Governing rule: the gate always reaches a terminal state.** The orchestrator writes
`result.json` **before doing anything else**, pre-populated with
`{verdict:"ERROR", reason:"orchestrator did not complete"}`, and overwrites it on every
transition. The hub step reads it with `if: always()`. Missing or malformed → `error`.
There is no path that leaves the status `pending`.

| failure | detected by | verdict | gate |
|---|---|---|---|
| provider quota / rate limit | SDK error code, not prose | ERROR | blocks |
| provider auth failure | `/config/providers` at startup | ERROR | blocks |
| server won't start | spawn timeout | ERROR | blocks |
| server dies mid-run | SSE closes | ERROR | blocks, partial findings kept |
| SDK/server version skew | asserted at startup | ERROR | blocks |
| `StructuredOutputError` after retries | `error.name` | ERROR | blocks |
| self-deadline exceeded | own timer | ERROR | blocks, partial findings kept |
| `cargo` absent | stage 1 probe | **degrade** | — |
| nightly absent (`public-api`) | stage 1 probe | **degrade** | — |
| no changed `.rs` files | stage 1 | INCONCLUSIVE | passes |

Detection is **by error type, not string matching on output** — which makes the current
hub's `db.rs:429` bug (§9) structurally impossible rather than merely fixed.

**Degrade vs fail is deliberate.** A missing nightly toolchain produces a thinner review
that says so. A dead provider blocks, because the review did not happen.

**Self-deadline: 20 minutes**, under the hub's `timeout-minutes: 25`. This is not
belt-and-braces — a silent, output-less hang was reproduced repeatedly today (§8.1). The
design must not depend on how Actions handles `if: always()` under a job timeout; if the
orchestrator always finishes first, that question never arises.

**Truncation is recorded, not silent.** The agent sees
`[truncated: returned 51,200 of 337,891 bytes — narrow your query]`; stage 1 records it in
`budget.capped[]`; stage 3 surfaces it in the footer. If truncation correlates with missed
findings, the caps are visibly too tight.

**Prompt injection**, in order of what actually does the work:

1. The agent has no `bash`, no network, no GitHub token. A fully successful injection finds
   nothing to exfiltrate and no way to act.
2. Output is `json_schema`-constrained — no channel for free-form instructions.
3. Stage 3 validates every `path`/`line` against the real repo.
4. Stage 3 renders the report, so injected content never controls the comment's structure.
   (droid emitted markdown that the hub pasted, which is why the hub must strip
   `</details>`.)
5. `OPENCODE_DISABLE_PROJECT_CONFIG=1` + `OPENCODE_CONFIG_CONTENT` — see §8.2, which is a
   **real** injection vector, not a hypothetical one.

**Retryable:** transient provider network, `StructuredOutputError` (server-native via
`retryCount`), server connection-refused at startup.
**Not retryable:** quota exhaustion, auth failure, version skew, self-deadline. Retrying a
dead quota burns 25 minutes to reach the same answer — which is what run `30885775050` did.

---

## 6. Testing

Stage 1 is a pure function of a git SHA; stage 3 is a pure function of `Finding[]` plus a
repo. Together they are most of the code, and neither needs a model.

| layer | what | model? | CI |
|---|---|---|---|
| 0 | evidence-pack determinism (snapshot) | no | every commit |
| 1 | stage 1 units, against the real checkout | no | every commit |
| 2 | stage 3 units, incl. known-bad inputs | no | every commit |
| 3 | stage 2 replay from recorded SSE | no | every commit |
| 4 | golden review — PR #66 | **yes** | manual/nightly |
| 5 | eval set | **yes** | manual |

**Layer 0 first.** Without byte-identical packs you cannot attribute a quality change to
your code rather than noise, and every later tuning decision is blind.

**The highest-value single test:** given `PulseDB::open` changed, sibling extraction must
return `open_with_embedder`'s signature. If it fails, the reviewer is structurally
incapable of finding the P2. Write it before anything else.

**Layer 2 encodes the meta-lesson** — *run every new check against a known-bad input once*.
The four cases that broke the current classifier become permanent regressions: a finding
whose rationale says "rate limit", or cites `db.rs:429`, or mentions a disk quota, or
quotes an injection containing "Exec failed", must all still yield **PASS**.

**Layer 3** — capture one real SSE stream to a fixture and replay it. Covers event
handling, tool dispatch, truncation marking, partial-result preservation and
`StructuredOutputError` with no quota. Truncate a recorded stream to simulate a crash;
swap a `step_finish` for a quota error to simulate exhaustion.

**Layer 4 — the golden review.** PR #66, run `30843117622`; both artifacts archived.
Pass = re-finds the **P2** (`main_graph` migration missing from `open_with_embedder`) and
the **P3** (dead `migrate_legacy_main_graph_stamp` + stale comment), zero fabrications.
Scored mechanically: a finding matches if `path` matches and `line` is within ±25.
Tokens are **recorded, not gated** — v1 is quality-first.

**Layer 5 sources:** the six archived QA reports and one code-review report (already
labelled, free); planted bugs (revert one hunk of a historical fix); and live accumulation.

---

## 7. Build sequence

**Step 0 — while the quota is alive.** Capture droid's real baseline on PR #66 with
`droid exec -o json`. §1.1's figures are a byte-proxy; this yields billed
`input_tokens`/`output_tokens`/`cache_read_input_tokens` for the exact diff the golden test
uses. One review's cost, and it is the number the project will be judged on.

**Step 1 — stage 1.** Ships when packs are byte-identical and the sibling test passes.

**Step 2 — stage 3.** Ships when the known-bad harness is green.

> **Milestone:** stages 1 + 3 with stage 2 *stubbed* to fixture findings = a complete
> pipeline producing a real report and a real commit status, **with no model anywhere**.
> All plumbing de-risked before a provider is involved, and reachable regardless of quota.

**Step 3 — stage 2.** Ships when the golden review passes.

**Step 4 — swap into the hub.** Five changes; nothing else moves:

| hub element | change |
|---|---|
| `Run droid` step | → `bun run .ci-automation/agent/review.ts` |
| `Resolve prompt and autonomy` | **deleted** — allowlist replaces autonomy tiers |
| `Verify curated skill is present` | path → the checklist's new home |
| INFRA string detection | **deleted** — replaced by `result.json` |
| `model` input | `custom:glm-5.2-0` → `zai-coding-plan/glm-5.2` |

**Step 5 — `security-audit`** (needs its checklist written), then **`qa`** (needs the
sandbox conversation; 87% of spend).

---

## 8. The opencode hardening contract

opencode is a general coding agent. Everything it ships for interactive coding is per-turn
rent and attack surface here. This section is the teardown.

### 8.1 Required environment `[M]`

```bash
OPENCODE_DISABLE_MODELS_FETCH=1     # REQUIRED — see below
OPENCODE_DISABLE_AUTOUPDATE=1       # a merge gate must not self-update
OPENCODE_DISABLE_PROJECT_CONFIG=1   # ignore any opencode.json in the checkout
OPENCODE_CONFIG_CONTENT='{...}'     # entire config via env; no on-disk file
OPENCODE_DISABLE_SHARE=1            # no phone-home
OPENCODE_DISABLE_LSP_DOWNLOAD=1     # no toolchain downloads mid-review
OPENCODE_SERVER_PASSWORD=<per-job>  # env-var only; there is no --password flag
OPENCODE_DB=<per-job path>          # isolate the session store
# plus: --pure   (kills external plugins)
```

**`OPENCODE_DISABLE_MODELS_FETCH=1` is not optional.** Without it, `opencode` intermittently
blocks **forever** during `init` on a models.dev registry fetch — holding an ESTABLISHED
connection at 0% CPU, with **zero stdout, zero stderr, no timeout**, and nothing in the log
after `init`. Reproduced repeatedly today across fresh directories, with `--pure`, with a
healthy provider (curl to the same host over the same IPv6 address: 290 ms), a healthy
database, and a warm 3.5 MB cache on disk. Setting the flag fixed it immediately and
dropped the floor to 623 tokens.

For a merge gate this is the most consequential opencode behaviour we found. It is also
why §5's self-deadline exists.

`--pure` matters more than it looks: a globally-installed plugin was injecting **867
tokens** into every turn `[M]`. That fully explains 1,497 (no `--pure`) vs 623 (`--pure`).

### 8.2 A real prompt-injection vector, closed

opencode walks up from cwd and injects `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` **raw into
the system message**, under a bare `Instructions from: <path>` header — no fencing, no
untrusted marker, unbounded size.

**A PR that adds an `AGENTS.md` rewrites the reviewer's system prompt.** On an
attacker-influenceable checkout that is a live vector, not a hypothetical. It also costs
~4,759 tokens `[M]`.

Closed by `instructions: []` + `OPENCODE_DISABLE_PROJECT_CONFIG=1` +
`OPENCODE_CONFIG_CONTENT` — configuration a malicious PR cannot reach.

### 8.3 What can and cannot be owned

**The system prompt is fully replaceable** `[M]`. In the binary it is a ternary, not a
concatenation: `agent.<name>.prompt ? [prompt] : SystemPrompt.provider(model)`. Setting it
deletes opencode's 8,532-char coding prompt outright. Confirmed on the wire: no prompt →
9,090-char system message; `prompt: "R"` → 563 chars beginning literally `R\n`.

**The tail cannot be owned.** An environment block (~95–140 tokens) is always appended
after your prompt, and is not suppressible by any config key. Note `Platform: darwin` in it
is a **hardcoded string literal**, not `process.platform` — on a Linux runner opencode
would tell the model it is on macOS. Irrelevant while we run on the mini; a trap if the
runner ever changes.

**Structured output costs +265 tokens** `[M]` — a fixed instruction paragraph plus the
synthetic `StructuredOutput` tool schema, plus `toolChoice: "required"`. Not suppressible
while using `json_schema`, and worth it.

### 8.4 Server operation `[M]`

- `opencode serve` is **unauthenticated by default** and prints
  `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` The 150-path surface
  includes `POST /pty`, `POST /session/{id}/shell`, `PATCH /config` and
  `PUT /auth/{providerID}` — i.e. the model credential is readable and writable over
  loopback. The served OpenAPI declares `security: []`, so a generated client will not know
  auth exists.
- `--port 0` binds **4096** if free, otherwise an ephemeral port. Two concurrent servers do
  not collide (observed: 4096 and 62255). Assign explicitly anyway.
- SDK version must be pinned with the server: SDK latest is 1.18.12, the installed server
  is 1.17.8. Assert at startup.
- `@opencode-ai/sdk` is MIT; `anomalyco/opencode` is MIT.

---

## 9. Prerequisite fix to the current hub

Independent of this project, and worth landing first because the quota is live again:

The hub's verdict classifier (`6faf0f3`) regex-scrapes prose and uses unanchored globs
`*402*` / `*429*`. Tested against real inputs: **2/2 real infrastructure failures caught,
4/4 false-positive probes wrong** `[M]`. The real PR #66 code-review report needs only one
line number to move from `db.rs:520` to `db.rs:429` to be reclassified as "model quota
exhausted" and posted as commit status `error` — blocking the merge and sending the
reviewer to debug infrastructure instead of reading a genuine P2.

Fix validated 12/12: gate the classifier on `rc != 0` (the hub already captures `rc` and
plumbs `STEP_RC` into the status step, then never reads it), match droid's
`Error during droid execution:` envelope rather than the whole body, and delete the bare
numeric globs.

`droid/qa` is currently off required checks and `QA Trigger` is disabled, so nothing is
gated today. **Land this before re-enabling anything.**

---

## 10. Deferred and open

- **`qa` and `security-audit`** — after code-review proves the shape.
- **Warm-server reuse** (`serve` + `--attach`) — worth it once three automations can
  amortise one process; not for one.
- **LLM orchestrator / subagents** — revisit on escalation or cross-automation findings
  (§4.4).
- **A code graph** — explicitly rejected for now. The entire review context is ~20k tokens;
  this is an unbounded-output problem, not an exploration problem. Every tree-sitter-based
  candidate is **`#[cfg]`-blind**, and PulseDB has five feature configurations — a reviewer
  confidently wrong about which implementation is live is worse than one that reads the
  whole file. If an index is ever needed, `rust-analyzer`'s SCIP output is the only
  cfg-correct option. It is **not currently installed**: `~/.cargo/bin/rust-analyzer` is a
  symlink to `rustup` and the component is absent `[M]`.
- **`cargo-public-api` / `cargo-semver-checks`** — not installed yet `[M]`; needed for
  §4.2's `apiDelta`/`semver` sections, which degrade gracefully without them.
- **Ephemeral runner registration** — unchanged from ADR-0001; only `qa` needs it.
- **Provider flexibility** — opencode's ChatGPT and GitHub Copilot subscription paths are
  compiled into the binary `[M]`; Z.AI Coding Plan is already authenticated. Credentials
  live in plain `~/.local/share/opencode/auth.json` (0600, no OS keychain), so droid's
  `FACTORY_DISABLE_KEYRING`-at-login-time trap has no analogue here.

---

## Appendix — reproducing the measurements

```bash
# per-tool schema sizes, zero model calls
OPENCODE_DISABLE_MODELS_FETCH=1 opencode serve --pure --hostname 127.0.0.1 --port 39411 &
curl -sS 'http://127.0.0.1:39411/experimental/tool?provider=zai-coding-plan&model=glm-5.2'

# a single-turn floor for a given agent config
OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
  opencode run --pure --agent <name> --format json -m zai-coding-plan/glm-5.2 \
  "Reply with exactly: OK"      # read tokens.input from the step_finish event

# droid comparison
droid exec -o json -m custom:glm-5.2-0 --disable-builtin-skills "Reply with exactly: OK"

# the diff-size ground truth
cd <pulsedb> && git diff -U5 origin/main...HEAD -- '*.rs' | wc -c

# droid session cost model — §1.1/§1.2
# needs root: /Users/github-runner is drwxr-x--- github-runner:ghrunner.
# Prints counts and byte totals only; never message content.
sudo bash scripts/measure/droid-session-cost.sh

# the verdict-classifier regression suite — §9
./scripts/measure/test-verdict-classifier.sh --fetch     # populate fixtures (gitignored)
./scripts/measure/test-verdict-classifier.sh             # 12 passed, 0 failed, 0 skipped
STRICT=1 ./scripts/measure/test-verdict-classifier.sh    # non-zero if any check is skipped
```

`--strict` exists because a green exit while checks silently did not run is the exact
failure mode §6 is designed around. Use it in CI. Note the fixtures are GitHub Actions
artifacts, which **expire after 14 days** — once gone, those three checks cannot be
re-populated and the suite degrades to 7 synthetic cases.

Every opencode floor above assumes `--pure` and `OPENCODE_DISABLE_MODELS_FETCH=1`. Without
the latter the command may hang forever with no output.

---

## Amendment A1 — tree-sitter for signature extraction (2026-08-05)

**Status:** approved by the operator in session, in response to an explicit
question during execution of Task 3. Recorded here because a decision that
only lives in an agent's scratch file is not auditable.

**What changed.** §10 rejects a code graph and notes that every tree-sitter-based
candidate is `#[cfg]`-blind. That reasoning stands **for code graphs**, which
answer "who calls this" by resolving symbols across files — where being
confidently wrong about which `#[cfg]` branch is live is worse than reading the
whole file.

It does **not** apply to Task 3's sibling-signature extraction, which performs no
resolution: it reads syntax and emits signature text verbatim from source, with
both `#[cfg]` branches included. The constraint was over-applied.

**What triggered it.** The hand-rolled brace-matching parser the plan mandated
shipped with three Critical defects, found in review and each reproduced against
real code:

1. Pure-deletion hunks (`@@ -5 +4,0 @@`) made the changed symbol invisible —
   `changedLines()` walked only the `+` side. *(Not a parser bug; fixed separately.)*
2. Multi-line signatures were truncated to their first line. The real
   `PulseDB::open_with_embedder` spans five lines; the parser stored
   `"pub fn open_with_embedder("`, dropping every parameter — including the
   `Arc<dyn EmbeddingService>` that PR #66's P2 finding is about.
3. `format!("{{")` and brace-bearing doc comments desynced the brace counter,
   silently absorbing every later sibling so `siblings` became `[]`.

Defect 2 also revealed that the plan's own acceptance gate was too weak: it
asserted `.includes("open_with_embedder")`, which the truncated fragment
satisfied. **The gate passed on the defect it existed to catch.**

**Resolution.** `agent/src/stage1/symbols.ts` uses `web-tree-sitter` +
`tree-sitter-rust` (both prebuilt WASM, no native build, verified under Bun
1.3.6). Signatures are sliced from a `function_item`'s start to its body node's
start, so a body leak is structurally impossible rather than merely tested for.

The gate now asserts the **full** signature — parameter list and return type —
not a substring. Verified against PulseDB `sprint-4.3` vs `origin/main`:

```
pub fn open_with_embedder( path: impl AsRef<Path>, config: Config,
    embedder: Arc<dyn EmbeddingService>, ) -> Result<Self>
```

**Carried forward:** §10's rejection of a code graph is unchanged. This
amendment narrows the constraint to what the research actually supports; it does
not license tree-sitter for cross-file resolution.
