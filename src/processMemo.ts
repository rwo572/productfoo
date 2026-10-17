// Per-process memoization for small config files (cli_performance-v0 R-002):
// within one invocation a config file is read and parsed at most once, keyed
// on (mtime, size) so an external write between reads in the same process —
// a test fixture, another tool — invalidates naturally. Absent files memoize
// under the "absent" key.
import { statSync } from "node:fs";

export type MemoEntry<V> = { key: string; value: V };

/** Cheap staleness key for a file's current content; "absent" when missing. */
export function fileStatKey(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

export function readMemoized<V>(store: Map<string, MemoEntry<V>>, file: string, statKey: string): V | undefined {
  const entry = store.get(file);
  return entry && entry.key === statKey ? entry.value : undefined;
}

export function writeMemoized<V>(store: Map<string, MemoEntry<V>>, file: string, statKey: string, value: V): void {
  store.set(file, { key: statKey, value });
}
