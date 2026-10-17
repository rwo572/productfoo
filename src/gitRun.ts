// One shared wrapper for productfoo's git invocations. It reports outcome; the caller
// owns what a failure means — some sites fail open (null/[] and continue),
// others fail closed. Implemented over execFileSync so each site's existing
// stdio/maxBuffer/stderr-echo semantics survive: execFileSync's default echoes
// the child's stderr to the parent process, and a site that historically
// silenced git must keep doing so by passing `stdio` explicitly.
import { execFileSync } from "node:child_process";

type GitStdio = Array<"ignore" | "pipe" | "inherit">;

export type GitRunOptions = {
  cwd?: string;
  maxBuffer?: number;
  stdio?: GitStdio;
  // Bound a git call that can touch the network (`ls-remote`). Without this a
  // doctor run on a flaky link hangs instead of reporting "could not check".
  timeout?: number;
  // Needed alongside `timeout` for the same reason: a private remote makes git
  // prompt for credentials on a TTY, and a prompt outlives any timeout. Callers
  // that go to the network pass GIT_TERMINAL_PROMPT=0.
  env?: NodeJS.ProcessEnv;
};

export type GitRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  // The thrown error's message when ok is false (execFileSync wording — one
  // caller prints it verbatim in user-facing output).
  message: string;
};

// Only forward options a caller actually set, so execFileSync's defaults
// (cwd = process.cwd(), maxBuffer = 1 MiB, stderr echoed to the parent) hold
// exactly where they held before.
function execOptions(opts: GitRunOptions): {
  cwd?: string;
  maxBuffer?: number;
  stdio?: GitStdio;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
} {
  return {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}),
    ...(opts.stdio !== undefined ? { stdio: opts.stdio } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
}

export function gitRun(args: string[], opts: GitRunOptions = {}): GitRunResult {
  try {
    const stdout = execFileSync("git", args, { encoding: "utf8" as const, ...execOptions(opts) });
    return { ok: true, stdout: stdout ?? "", stderr: "", message: "" };
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// Convenience for the common fail-open sites: stdout on success, null on any
// git failure (including git not being installed).
export function gitRunOrNull(args: string[], opts: GitRunOptions = {}): string | null {
  const result = gitRun(args, opts);
  return result.ok ? result.stdout : null;
}

// Raw-bytes variant for reading blobs (e.g. staged file content) where the
// binary guard must inspect real bytes, not a utf8 re-encoding.
export function gitRunBuffer(args: string[], opts: GitRunOptions = {}): { ok: boolean; stdout: Buffer } {
  try {
    return { ok: true, stdout: execFileSync("git", args, execOptions(opts)) };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}
