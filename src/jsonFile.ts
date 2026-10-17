// Reading JSON off disk is one of productfoo's most repeated idioms — the same
// `JSON.parse(readFileSync(file, "utf8"))`, often wrapped in a try/catch that
// falls back to a default when the file is missing or corrupt. These two
// helpers name that idiom once so call sites read as intent, not plumbing.
import { readFileSync } from "node:fs";

// Read and parse a JSON file. Throws (ENOENT, or a SyntaxError on malformed
// content) exactly as the inlined `JSON.parse(readFileSync(...))` did — use
// this where the caller wants the failure to propagate.
export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// Read and parse a JSON file, returning `fallback` if it is missing or its
// contents cannot be parsed. The no-throw counterpart for reads that must never
// break over an absent or corrupt file.
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return readJson<T>(file);
  } catch {
    return fallback;
  }
}
