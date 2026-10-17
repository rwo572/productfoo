import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseAllowlist } from "./redactEngine.js";

// Repo-level redaction allowlist (OQ2): a human-curated `.foo-redact-allow` at
// the repo root, one literal value per line. Pairs with the inline
// `foo-redact: allow` pragma. R-007: human-authored only, never auto-populated.
export const REDACT_ALLOW_FILE = ".foo-redact-allow";

export function loadRepoAllowlist(root: string): string[] {
  const file = path.join(root, REDACT_ALLOW_FILE);
  return existsSync(file) ? parseAllowlist(readFileSync(file, "utf8")) : [];
}
