// Local storage for direct provider credentials.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// The same machine-wide home `profile.ts` and `updateNotice.ts` already resolve
// — one home per machine, so keying once keys every project on it.
export function credentialsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOO_STATE_DIR?.trim() || env.FOO_HOME?.trim() || path.join(homedir(), ".foo");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(credentialsHome(env), "credentials.json");
}

type Credentials = Record<string, unknown> & { firecrawl_api_key?: string };

function readCredentials(env: NodeJS.ProcessEnv): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(env), "utf8")) as Credentials;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // No file, unreadable file, corrupt JSON — all mean the same thing to a
    // caller (nothing stored here) and none of them may crash a command.
    return {};
  }
}

// Merge-write: saving one credential must never discard another. A field set
// to undefined in the patch is removed.
function writeCredentials(patch: Credentials, env: NodeJS.ProcessEnv): string {
  const dir = credentialsHome(env);
  // The credentials home exists to hold secrets (audit F15): create it 0700
  // and re-tighten explicitly — the same re-chmod rule the file below follows,
  // so a directory made loose by an older productfoo does not survive a save.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = credentialsPath(env);
  const merged: Credentials = { ...readCredentials(env), ...patch };
  for (const key of Object.keys(merged) as (keyof Credentials)[]) {
    if (merged[key] === undefined) delete merged[key];
  }
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode is a no-op on a file that already exists, so set it
  // explicitly: a re-save must not silently inherit a loose mode from before.
  chmodSync(file, 0o600);
  return file;
}

export function readStoredFirecrawlKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = readCredentials(env).firecrawl_api_key;
  return typeof key === "string" ? key.trim() || null : null;
}

export function writeStoredFirecrawlKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return writeCredentials({ firecrawl_api_key: key.trim() }, env);
}

export function clearStoredFirecrawlKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsPath(env);
  if (!existsSync(file)) return false;
  const creds = readCredentials(env);
  if (!creds.firecrawl_api_key) return false;
  // Preserve unrelated settings, including inert credentials left by older versions.
  if (Object.keys(creds).some((key) => key !== "firecrawl_api_key")) {
    writeCredentials({ firecrawl_api_key: undefined }, env);
  } else {
    rmSync(file);
  }
  return true;
}

export type TokenSource = "env" | "stored" | "none";

// An explicit provider key in the shell wins over the saved one.
export function resolveFirecrawlKey(env: NodeJS.ProcessEnv = process.env): { key: string | null; source: TokenSource } {
  const fromEnv = (env.FIRECRAWL_API_KEY ?? "").trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const stored = readStoredFirecrawlKey(env);
  if (stored) return { key: stored, source: "stored" };
  return { key: null, source: "none" };
}
