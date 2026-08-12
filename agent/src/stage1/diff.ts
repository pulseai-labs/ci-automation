import type { ChangedFile } from "../types";

export const TRUNCATION_MARKER = "\n[truncated: returned {kept} of {total} bytes — narrow your query]\n";

function git(repo: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
  return p.stdout.toString();
}

/**
 * Truncate `text` to at most `limit` UTF-8 bytes, appending a marker that
 * reports how much was kept vs. the original size.
 *
 * The cut point is walked back to the nearest whole-character boundary so a
 * multi-byte UTF-8 character straddling `limit` is never split (which would
 * otherwise decode to a U+FFFD replacement character). `rawBytes` always
 * reports the pre-truncation byte length, regardless of where the cut lands.
 */
export function cap(text: string, limit: number): { text: string; capped: boolean; rawBytes: number } {
  const buf = Buffer.from(text, "utf8");
  const raw = buf.length;
  if (raw <= limit) return { text, capped: false, rawBytes: raw };
  let end = limit;
  // Back off while the next byte is a UTF-8 continuation byte (10xxxxxx),
  // i.e. while cutting here would split a multi-byte character in half.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  const kept = buf.subarray(0, end).toString("utf8");
  const marker = TRUNCATION_MARKER
    .replace("{kept}", String(limit))
    .replace("{total}", String(raw));
  return { text: kept + marker, capped: true, rawBytes: raw };
}

export function getChangedFiles(repo: string, base: string, filePattern: string): ChangedFile[] {
  const out = git(repo, ["diff", "--numstat", `${base}...HEAD`, "--", filePattern]);
  return out.trim().split("\n").filter(Boolean).map(line => {
    const [added, removed, path] = line.split("\t");
    return { path, added: Number(added) || 0, removed: Number(removed) || 0 };
  });
}

export function getDiff(repo: string, base: string, filePattern: string, limit: number) {
  const raw = git(repo, ["diff", "-U5", `${base}...HEAD`, "--", filePattern]);
  const { text, capped, rawBytes } = cap(raw, limit);
  return { diff: text, capped, rawBytes };
}
