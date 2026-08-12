/** Symbol-matching patterns per language, keyed by module name.
 *  Dependency-free so the read_symbol tool can import this without pulling
 *  in web-tree-sitter (the security canary's self-contained model requires
 *  no node_modules in the import chain). `${name}` is a literal placeholder
 *  substituted by the caller. */
export const SYMBOL_PATTERNS: Record<string, string> = {
  rust: "\\bfn\\s+${name}\\b",
};

/** Returns the symbol pattern for the named language, or throws. */
export function getSymbolPattern(language: string): string {
  const pattern = SYMBOL_PATTERNS[language];
  if (!pattern) throw new Error(`unknown REVIEW_LANGUAGE: ${language}`);
  return pattern;
}
