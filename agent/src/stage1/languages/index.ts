import type { LanguageModule } from "./types";
import { rust } from "./rust";

// Phase 1: only Rust. Phase 2+ adds more modules here.
const MODULES: LanguageModule[] = [rust];

export function detectLanguage(repo: string): LanguageModule | null {
  for (const mod of MODULES) {
    if (mod.detect(repo)) return mod;
  }
  return null;
}

export function getLanguage(name: string): LanguageModule | null {
  return MODULES.find(m => m.name === name) ?? null;
}

export { type LanguageModule, type ToolOpts, type LinterResult, type ApiToolsResult, type SymbolResult } from "./types";
export { rust };
