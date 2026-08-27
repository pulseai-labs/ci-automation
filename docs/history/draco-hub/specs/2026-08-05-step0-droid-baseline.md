# Step 0 — droid's measured baseline on PulseDB PR #66

**Measured 2026-08-10.** This is the number the custom review agent will be judged
against in Task 13. It replaces §1.1's byte-proxy as the comparison basis for a
single `code-review` run — and, as it turns out, largely confirms it.

Spec: [`2026-08-05-custom-ci-review-agent-design.md`](2026-08-05-custom-ci-review-agent-design.md) §7 Step 0.

---

## The number

One `code-review` run over PulseDB PR #66 (`origin/main...sprint-4.3`, 7 changed
Rust files, 99,681 bytes of diff):

| metric | value |
|---|---:|
| `input_tokens` | 81,787 |
| `cache_read_input_tokens` | 664,256 |
| `cache_creation_input_tokens` | 0 |
| **input-side total** | **746,043** |
| `output_tokens` | 34,607 |
| **all tokens** | **780,650** |
| turns | 17 |
| wall clock | 595.6 s |
| verdict | FAIL (one P2, one P3) |
| `is_error` | false |

Raw artifacts (git-ignored, local only):
`ci-automation/.superpowers/sdd/step0-droid-baseline-pr66.json` and
`…-report.md`.

## What it confirms

**89% of the input side was cache reads.** 664,256 of 746,043 input-side tokens
were re-sent context, not new prompt. That is the design's central thesis
measured directly rather than argued: the lever is the transcript an agentic loop
re-sends every turn, not the size of the instructions.

**§1.1's byte-proxy was accurate, not inflated.** The proxy derived ~0.87 M input
tokens across 3 code-review runs averaging 7.3 turns — **39.7 K input tokens per
turn**. This run measured **43.9 K per turn**, within ~10%. §1.1 called itself an
upper bound because it ignored prompt caching; the measurement shows caching does
not reduce the token count, because cache reads are still tokens on the wire.
The proxy stands.

This run cost ~2.6× a typical code-review run only because it took 17 turns
against the 3-run average of 7.3 — consistent with §1.2's finding that
amplification scales roughly quadratically in turns.

**The golden finding is real and droid finds it.** droid's P2 is
`src/db.rs:310-313`: a read-only `PulseDB::open` of a pre-0.7.0 store now fails
where it previously succeeded. Its own reasoning names the sibling —

> `open_with_embedder` already behaved this way (and is tested at `db.rs:4284`),
> but for `open` this is a new regression

— which is exactly the divergence stage 1's sibling signatures exist to surface.
droid reached it by reading the whole file across 17 turns. The custom agent is
designed to reach it from the peer signature alone. **Task 13's test is therefore
well-posed: same finding, and now a priced baseline to beat.**

## How it was run

The spec pairs a golden diff on **PulseDB** with an automation whose curated skill
lives only in **pulsedb-internal** — PulseDB has `qa` and `qa-library` but no
`code-review` skill, and its workflows are `ci.yml` and `qa.yml` only, so
`code-review` has never run there. The hub's own guard fails closed on this
(`no curated skill at workspace/.factory/skills/code-review`).

**Operator decision:** reproduce the CI path faithfully against the golden diff,
borrowing pulsedb-internal's curated skill. Everything else matches
`.github/workflows/droid.yml` exactly.

```
workspace/
  .factory/skills/code-review/SKILL.md   # from pulsedb-internal (8,014 B)
  target/                                # PulseDB @ 6730c4d (sprint-4.3)
../.ci-automation/prompts/code-review.md # from ci-automation
```

```bash
cd workspace
unset GITHUB_TOKEN GH_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
droid exec --auto medium -m custom:glm-5.2-0 --disable-builtin-skills \
           -o json -f ../.ci-automation/prompts/code-review.md
```

`-o json` is the only deviation from CI, which uses the default text format and
tees to a report file. It is what exposes `usage`.

Run in a throwaway clone in scratch, since `--auto medium` permits file
creation and modification. The real PulseDB checkout was not touched.

## Caveats, stated so they are not forgotten

- **Tokens are not cost.** `cache_read_input_tokens` are typically billed at a
  discount, so 780,650 tokens is not 780,650 tokens' worth of spend. The spec's
  metric is tokens (§6 records them, does not gate on them), and Task 13 should
  compare like for like — but any monetary claim needs Z.AI's cache pricing
  applied first.
- **One run, not a distribution.** Turn count drives cost roughly quadratically,
  and this run took 17 turns against a 7.3 average. A second run would land
  somewhere else. Treat 43.9 K input-side tokens/turn as the stable figure and
  turn count as the variable.
- **The skill is borrowed.** pulsedb-internal's `code-review` SKILL.md, not one
  written for PulseDB. If PulseDB ever gets its own, this baseline should be
  re-measured.
