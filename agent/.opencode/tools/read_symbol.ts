import { readSymbolImpl } from "../../src/stage2/tools/read_symbol";

export default {
  description:
    "Return the body of ONE Rust function by name. Prefer this over reading a file. " +
    "Results are byte-capped; if you see a truncation marker, narrow the query.",
  args: {
    path: { type: "string", description: "repo-relative path, e.g. src/db.rs" },
    name: { type: "string", description: "function name, e.g. open_with_embedder" },
  },
  async execute(args: { path: string; name: string }, ctx: { directory: string }) {
    return readSymbolImpl(ctx.directory, args.path, args.name, 51_200);
  },
};
