import { test, expect } from "bun:test";
import { runClippy } from "../src/stage1/lint";
import { runApiDelta, runSemverChecks } from "../src/stage1/cargoTools";

test("runClippy degrades cleanly when cargo is absent", () => {
  const r = runClippy("/nonexistent-repo", [], { cargoBin: "definitely-not-cargo" });
  expect(r.findings).toEqual([]);
  expect(r.degraded.join(" ")).toContain("clippy");
});

test("runApiDelta degrades cleanly when the tool is absent", () => {
  const r = runApiDelta("/nonexistent-repo", "main", { cargoBin: "definitely-not-cargo" });
  expect(r.apiDelta).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("public-api");
});

test("runSemverChecks degrades cleanly when the tool is absent", () => {
  const r = runSemverChecks("/nonexistent-repo", { cargoBin: "definitely-not-cargo" });
  expect(r.semver).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("semver");
});
