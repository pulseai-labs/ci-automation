import type { ChangedFile, ContainerInfo, Finding, SymbolInfo } from "../../types";

export interface ToolOpts {
  cargoBin?: string;
  timeoutMs?: number;
}

export interface LinterResult {
  findings: Finding[];
  degraded: string[];
}

export interface ApiToolsResult {
  apiDelta?: string;
  semver?: Finding[];
  degraded: string[];
}

export interface SymbolResult {
  symbols: SymbolInfo[];
  containers: ContainerInfo[];
}

export interface LanguageModule {
  readonly name: string;
  detect(repo: string): boolean;
  readonly filePattern: string;
  extractSymbols(repo: string, base: string, files: ChangedFile[]): Promise<SymbolResult>;
  runLinters(repo: string, base: string, files: ChangedFile[], opts?: ToolOpts): LinterResult;
  runApiTools?(repo: string, base: string, opts?: ToolOpts): ApiToolsResult;
  readonly readSymbolPattern: string;
}
