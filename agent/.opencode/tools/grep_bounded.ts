import { grepBoundedImpl } from "../../src/stage2/tools/grep_bounded";

export default {
  description:
    "Search the repository. Returns at most 40 matches, byte-capped. " +
    "Never returns whole files.",
  args: {
    pattern: { type: "string", description: "a fixed string or basic regex" },
    glob: { type: "string", description: "file filter, e.g. *.rs" },
  },
  async execute(args: { pattern: string; glob: string }, ctx: { directory: string }) {
    return grepBoundedImpl(ctx.directory, args.pattern, args.glob, 51_200);
  },
};
