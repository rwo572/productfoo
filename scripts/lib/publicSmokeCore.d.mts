// Type surface for scripts/lib/publicSmokeCore.mjs — the pure rehearsal core.
// The runtime module is plain JavaScript outside the compiled dist tree; this
// declaration gives the smoke runner and test/publicSmoke.test.ts an honest,
// checked contract without pulling the script through tsc.

export declare class PublicSmokeError extends Error {}
export declare function releaseVersionFindings(expectedVersion: string, artifacts: Record<string, unknown>): string[];
export declare function tarballFilename(packageName: string, version: string): string;
export declare function cleanInstallEnv(home: string, parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export declare const NET_DENY_PRELOAD_SOURCE: string;
export declare const REPORTING_NET_DENY_PRELOAD_SOURCE: string;

export declare const SMOKE_WORKFLOW_IDS: readonly string[];

export interface ComputedPublicVersion {
  baseline: string;
  version: string;
}

export declare function computePublicVersion(baselineVersion: string): ComputedPublicVersion;

export declare function rootShapeFindings(exportDir: string, manifestPaths: readonly string[]): string[];

export interface RehearsalPhase {
  id: string;
  status: "pass" | "fail" | "skipped";
  detail?: string;
}

export interface RehearsalWorkflow {
  id: string;
  argv: string[];
  exit_code: number;
  pass: boolean;
  detail?: string;
}

/** #882: the toolchain that produced a receipt's digests. */
export interface Toolchain {
  node: string;
  npm: string;
  platform: string;
  arch: string;
}

/** #882: .tgz digest (compressor-dependent) and uncompressed tar digest (compressor-independent). */
export declare function tarballDigests(bytes: Uint8Array): { tarball_sha256: string; tarball_tar_sha256: string };
export declare function toolchainInfo(options?: { npmVersion?: string }): Toolchain;

export interface RehearsalReceipt {
  schema_version: "0.1";
  kind: "foo_public_rehearsal_receipt";
  runner: "scripts/smoke-public.mjs";
  mode: "full" | "surface";
  candidate: {
    source_commit: string | null;
    history_commit: string | null;
    baseline_version: string | null;
    computed_version: string | null;
  };
  network: { posture: string; preload: string; note?: string };
  toolchain: Toolchain;
  phases: RehearsalPhase[];
  workflows: RehearsalWorkflow[];
  digests: Record<string, string>;
  result: "pass" | "fail";
}

export interface BuildReceiptInput {
  mode: "full" | "surface";
  sourceCommit: string | null;
  historyCommit: string | null;
  baselineVersion: string | null;
  computedVersion: string | null;
  network: { posture: string; preload: string; note?: string };
  toolchain?: Toolchain;
  phases: RehearsalPhase[];
  workflows: RehearsalWorkflow[];
  digests: Record<string, string>;
}

export declare function buildReceipt(input: BuildReceiptInput): RehearsalReceipt;

export declare function validateAgainstSchema(document: unknown, schema: unknown, path?: string): string[];
