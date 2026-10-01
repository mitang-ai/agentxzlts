export type SavedConfig = {
  version: 1;
  installationId: string;
  mode: "embedded" | "external";
  env: Record<string, string>;
  createdAt: string;
};
export type RuntimeConfig = {
  root: string;
  env: Record<string, string>;
  saved: SavedConfig | null;
  mode: "embedded" | "external";
};
export const keys: string[];
export function repositoryRoot(cwd?: string): string;
export function configPath(root?: string): string;
export function readSavedConfig(root?: string): SavedConfig | null;
export function fileEnvironment(root?: string): Record<string, string>;
export function loadRuntimeConfig(root?: string): RuntimeConfig;
export function applyRuntimeConfig(root?: string): RuntimeConfig;
