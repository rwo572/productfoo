// Canonical skills resolve from this installed package, with release or development trust.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markFailure, type FailureMark } from "./errorTaxonomy.js";
import { BUNDLED_SKILL_TREE, BUNDLED_SKILL_TREE_DOMAIN, type BundledSkillTreeAnchor } from "./skillClientPolicy.js";
import { skillTreeSnapshot, topLevelSkillFolderCount } from "./skillTreeDigest.js";
import { canonicalJson } from "./trustEnvelope.js";

// Classify missing or unapproved local skills as expected command failures.
export function markSkillFailure(kind: SkillFailureKind, message: string): void {
  const mark: FailureMark =
    kind === "not-found"
      ? { errorClass: "not_found", errorCode: "E_SKILL_NOT_FOUND", message }
      : kind === "unapproved-source"
        ? { errorClass: "gate_block", errorCode: "E_SKILL_SOURCE_UNAPPROVED", message }
        : { errorClass: "io_error", errorCode: "E_IO", message };
  markFailure(mark);
}

export type SkillFailureKind =
  | "not-found"
  // The skill text on disk is not covered by an approval this machine has made.
  // A real refusal with a real fix — not an outage, and never reported as one.
  | "unapproved-source";

// productfoo's own package root (this file compiles to dist/src/skillLocal.js), so
// a FULL install's bundled skills/ resolves from any working directory — root
// (the caller's project) only covers dogfood/dev where cwd is the foo repo.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class SkillDeliveryError extends Error {
  readonly kind: SkillFailureKind;
  constructor(kind: SkillFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

/**
 * productfoo executes only skill text it can tie to an approval made on this machine:
 * the bundled release digest, or a development tree the operator approved by
 * exact digest. That refusal is the control that stops a caller repository
 * shadowing a canonical skill with its own instructions.
 *
 * It is a refusal, not an outage. The old wording called it a trust boundary
 * being "rebuilt" and told the reader to "use package-root skills" — which is
 * what they were already doing, so the one command that clears it never
 * appeared. Each condition now names itself and the command that fixes it.
 */
export function refuseUnapprovedSkillSource(reason: "missing" | "refused"): never {
  throw new SkillDeliveryError(
    "unapproved-source",
    reason === "missing"
      ? "This skill tree has not been approved on this machine. Review it, then approve that exact tree: `foo skill trust`."
      : "This machine's skill approval no longer matches the skill tree — it was edited, it expired, or it was issued for another package root. Re-approve: `foo skill trust`.",
  );
}

/** A missing bundled resource is a local installation error. */
export function skillNotBundledMessage(name: string): string {
  return `"${name}" is not bundled with this productfoo install.`;
}

// A deliverable name is either a skill id ("pitch" → skills/pitch/SKILL.md) or
// a markdown reference under a skill ("pitch/references/prfaq-template.md" →
// that literal file). Every path segment must start alphanumeric, so ".." can
// never form — this validator IS the traversal guard, used for every local read.
export function skillRelPath(name: string): string | null {
  if (/^[a-z0-9][a-z0-9-]*$/.test(name)) return path.join(name, "SKILL.md");
  if (/^[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(name) && name.endsWith(".md")) return name;
  return null;
}

const DEV_TRUST_SCHEMA = "1";
const DEV_TRUST_KIND = "foo.development-skill-source";
const DEV_TREE_HASH_DOMAIN = "foo.development-skill-tree.v1";
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface DevelopmentSkillTrustRecord {
  schema_version: "1";
  record_kind: "foo.development-skill-source";
  root: string;
  skills_sha256: string;
  issued_at: string;
  expires_at: string;
}

export interface DevelopmentSkillTrustProposal extends DevelopmentSkillTrustRecord {
  record_path: string;
}

export interface DevelopmentSkillTrustProposalOptions {
  record_path?: string;
  issued_at?: string;
  days?: number;
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function boundedApprovalDays(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
    throw new TypeError("development trust validity must be a whole number of days from 1 through 365");
  }
  return value;
}

export function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function approvalInterval(options: DevelopmentSkillTrustProposalOptions): { issued_at: string; expires_at: string } {
  const issued_at = options.issued_at ?? new Date().toISOString();
  const issuedAt = canonicalTimestamp(issued_at);
  const days = boundedApprovalDays(options.days ?? 30);
  if (issuedAt === null) throw new TypeError("development trust approval requires a canonical issue time");
  return {
    issued_at,
    expires_at: new Date(issuedAt + days * 86_400_000).toISOString(),
  };
}

function canonicalSkillTreeSnapshot(rootValue: string, targetRelative?: string): { hash: string; targetBytes: Buffer | null } {
  // The walk is shared with the bundled-install anchor (skillTreeDigest.ts) so
  // a development record and the release anchor can never disagree about what
  // "this exact tree" hashes to. The domain keeps the two digest namespaces
  // distinct; existing development records verify exactly as before.
  return skillTreeSnapshot(rootValue, DEV_TREE_HASH_DOMAIN, targetRelative);
}

export function createDevelopmentSkillTrustRecord(
  rootValue: string,
  validity: { issued_at: string; expires_at: string },
): DevelopmentSkillTrustRecord {
  const root = realpathSync(rootValue);
  const issuedAt = canonicalTimestamp(validity.issued_at);
  const expiresAt = canonicalTimestamp(validity.expires_at);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) {
    throw new TypeError("development trust record requires a valid canonical time interval");
  }
  return Object.freeze({
    schema_version: DEV_TRUST_SCHEMA,
    record_kind: DEV_TRUST_KIND,
    root,
    skills_sha256: canonicalSkillTreeSnapshot(root).hash,
    issued_at: validity.issued_at,
    expires_at: validity.expires_at,
  });
}

export function developmentSkillTrustProposal(
  rootValue: string,
  options: DevelopmentSkillTrustProposalOptions = {},
): DevelopmentSkillTrustProposal {
  const record = createDevelopmentSkillTrustRecord(rootValue, approvalInterval(options));
  return Object.freeze({
    ...record,
    record_path: path.resolve(options.record_path ?? defaultDevelopmentTrustRecord()),
  });
}

function assertExternalTrustRecordPath(rootValue: string, recordPathValue: string): string {
  const root = realpathSync(rootValue);
  const recordPath = path.resolve(recordPathValue);
  if (recordPath === root || recordPath.startsWith(`${root}${path.sep}`)) {
    throw new TypeError("development trust record must stay outside the productfoo checkout");
  }
  const parent = path.dirname(recordPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentReal = realpathSync(parent);
  if ((lstatSync(parentReal).mode & 0o022) !== 0) {
    throw new TypeError("development trust record directory must not be writable by other users");
  }
  const resolved = path.join(parentReal, path.basename(recordPath));
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new TypeError("development trust record must stay outside the productfoo checkout");
  }
  if (existsSync(recordPath)) {
    const existing = lstatSync(recordPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new TypeError("development trust record target must be a regular file, not a link");
    }
  }
  return recordPath;
}

function writePrivateTrustRecord(recordPathValue: string, record: DevelopmentSkillTrustRecord): void {
  const recordPath = assertExternalTrustRecordPath(record.root, recordPathValue);
  const parent = path.dirname(recordPath);
  const temp = path.join(parent, `.${path.basename(recordPath)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      const bytes = Buffer.from(`${canonicalJson(record as unknown as never)}\n`, "utf8");
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, recordPath);
    chmodSync(recordPath, 0o600);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
  const parentFd = openSync(parent, "r");
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
}

export function approveDevelopmentSkillTrust(
  rootValue: string,
  expectedSkillsSha256: string,
  options: DevelopmentSkillTrustProposalOptions = {},
): DevelopmentSkillTrustProposal {
  if (!SHA256_HEX.test(expectedSkillsSha256)) {
    throw new TypeError("development trust approval requires the exact reviewed skill-tree SHA-256");
  }
  const proposal = developmentSkillTrustProposal(rootValue, options);
  if (proposal.skills_sha256 !== expectedSkillsSha256) {
    throw new TypeError("development skill tree changed after review; review the new digest before approval");
  }
  const { record_path, ...record } = proposal;
  writePrivateTrustRecord(record_path, record);
  return proposal;
}

export type DevelopmentSkillTrustStatus =
  | { status: "missing" }
  | { status: "refused" }
  | {
      status: "ready";
      root: string;
      skills_sha256: string;
      issued_at: string;
      expires_at: string;
      record_path: string;
    };

type DevelopmentSkillTrustRead = DevelopmentSkillTrustStatus & { target_bytes?: Buffer | null };

export function readDevelopmentSkillTrust(
  rootValue: string,
  recordPath: string,
  targetRelative?: string,
  nowValue = new Date().toISOString(),
): DevelopmentSkillTrustRead {
  try {
    let recordLink: ReturnType<typeof lstatSync>;
    try {
      recordLink = lstatSync(recordPath);
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { status: "missing" }
        : { status: "refused" };
    }
    if (!recordLink.isFile() || recordLink.isSymbolicLink() || (recordLink.mode & 0o022) !== 0) return { status: "refused" };
    const recordReal = realpathSync(recordPath);
    const packageReal = realpathSync(rootValue);
    if (recordReal === packageReal || recordReal.startsWith(`${packageReal}${path.sep}`)) return { status: "refused" };
    const parsed = JSON.parse(readFileSync(recordReal, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "refused" };
    const record = parsed as Record<string, unknown>;
    if (!exactKeys(record, ["schema_version", "record_kind", "root", "skills_sha256", "issued_at", "expires_at"])) return { status: "refused" };
    if (record.schema_version !== DEV_TRUST_SCHEMA || record.record_kind !== DEV_TRUST_KIND) return { status: "refused" };
    if (typeof record.root !== "string" || realpathSync(record.root) !== packageReal) return { status: "refused" };
    if (typeof record.skills_sha256 !== "string" || !SHA256_HEX.test(record.skills_sha256)) return { status: "refused" };
    const issuedAt = canonicalTimestamp(record.issued_at);
    const expiresAt = canonicalTimestamp(record.expires_at);
    const now = canonicalTimestamp(nowValue);
    if (issuedAt === null || expiresAt === null || now === null || issuedAt > now || now >= expiresAt) return { status: "refused" };
    const snapshot = canonicalSkillTreeSnapshot(packageReal, targetRelative);
    if (record.skills_sha256 !== snapshot.hash) return { status: "refused" };
    return {
      status: "ready",
      root: packageReal,
      skills_sha256: record.skills_sha256,
      issued_at: record.issued_at as string,
      expires_at: record.expires_at as string,
      record_path: recordReal,
      target_bytes: targetRelative === undefined ? undefined : snapshot.targetBytes,
    };
  } catch {
    return { status: "refused" };
  }
}

export function inspectDevelopmentSkillTrust(
  rootValue: string,
  recordPath: string = defaultDevelopmentTrustRecord(),
  nowValue = new Date().toISOString(),
): DevelopmentSkillTrustStatus {
  const { target_bytes: _, ...status } = readDevelopmentSkillTrust(rootValue, recordPath, undefined, nowValue);
  return status;
}

export interface CanonicalSkillTrustOptions {
  development_trust_record?: string;
  /**
   * Test-only anchor override: pins which tree a resolve must match, so the
   * mismatch-refusal path stays reachable without mutating the package on
   * disk. Production callers omit it and get the committed release anchor.
   */
  bundled_skill_tree?: BundledSkillTreeAnchor;
  now?: string;
}

function defaultDevelopmentTrustRecord(): string {
  return path.join(userInfo().homedir, ".foo", "trust", "development-skill-source.json");
}

/**
 * The install-anchored half of canonical-skill trust (foo-open-source-transition-v0
 * T-003). When this package's skills tree is exactly the tree the release
 * anchored, the bytes are the reviewed ones — npm's tarball integrity binds the
 * install and BUNDLED_SKILL_TREE binds every read — so a clean install runs a
 * bundled skill with no hosted call, no token, and no per-machine approval.
 * Returns null whenever the anchor cannot prove the tree (absent tree, walk
 * error, digest or count drift); the caller then falls back to the development
 * record, which refuses when absent. The fallback is fail-closed either way.
 */
function readBundledCanonicalSkill(rel: string, trust: CanonicalSkillTrustOptions): string | null {
  try {
    const anchor = trust.bundled_skill_tree ?? BUNDLED_SKILL_TREE;
    const snapshot = skillTreeSnapshot(PACKAGE_ROOT, BUNDLED_SKILL_TREE_DOMAIN, rel);
    if (snapshot.hash !== anchor.tree_sha256) return null;
    if (topLevelSkillFolderCount(PACKAGE_ROOT) !== anchor.skill_count) return null;
    const bytes = snapshot.targetBytes;
    if (bytes === null) return null;
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return null;
    return text;
  } catch {
    // An incomplete install has no tree to walk and an unreadable tree cannot be
    // proven; neither is an anchor case, and the dev-record fallback below
    // still refuses honestly.
    return null;
  }
}

/**
 * #897: doctor's view of the install-anchored path. True when this package's
 * skills tree is exactly the release-anchored tree, so every bundled skill
 * loads with no approval (readBundledCanonicalSkill). False when the tree is
 * absent, unreadable, or edited; then `foo skill trust` is genuinely needed.
 */
export function bundledSkillTreeVerified(root: string = PACKAGE_ROOT, anchor: BundledSkillTreeAnchor = BUNDLED_SKILL_TREE): boolean {
  try {
    return skillTreeSnapshot(root, BUNDLED_SKILL_TREE_DOMAIN).hash === anchor.tree_sha256
      && topLevelSkillFolderCount(root) === anchor.skill_count;
  } catch {
    return false;
  }
}

function readTrustedCanonicalSkill(name: string, trust: CanonicalSkillTrustOptions): string {
  const rel = skillRelPath(name);
  if (rel === null) throw new SkillDeliveryError("not-found", `skill "${name}" is not valid`);
  const bundled = readBundledCanonicalSkill(rel, trust);
  if (bundled !== null) return bundled;
  const recordPath = trust.development_trust_record ?? defaultDevelopmentTrustRecord();
  // The read already tells missing (never approved) apart from refused (edited,
  // expired, wrong root). Carry that distinction out to the reader instead of
  // collapsing both into one "unavailable".
  const read = readDevelopmentSkillTrust(PACKAGE_ROOT, recordPath, rel, trust.now);
  if (read.status !== "ready") return refuseUnapprovedSkillSource(read.status);
  const bytes = read.target_bytes ?? null;
  if (bytes === null) return refuseUnapprovedSkillSource("refused");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return refuseUnapprovedSkillSource("refused");
  return text;
}

// Resolve a skill from productfoo's own installed package and nowhere else.
//
// Skills ship on disk; a missing resource cannot fall back to a service.
export function resolveLocalSkill(
  name: string,
  trust: CanonicalSkillTrustOptions = {},
): { text: string; source: "local" } | null {
  const rel = skillRelPath(name);
  if (rel === null) {
    throw new SkillDeliveryError(
      "not-found",
      `"${name}" is not a valid skill name (a skill id like "pitch", or a reference like "pitch/references/prfaq-template.md").`,
    );
  }
  if (!existsSync(path.join(PACKAGE_ROOT, "skills", rel))) return null;
  return { text: readTrustedCanonicalSkill(name, trust), source: "local" };
}

export { PACKAGE_ROOT, readTrustedCanonicalSkill, SHA256_HEX };

// Resolve a skill only from productfoo's own installed package, never the caller repo.
export async function resolveSkill(
  root: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  trust: CanonicalSkillTrustOptions = {},
): Promise<{ text: string; source: "local" }> {
  const rel = skillRelPath(name);
  if (rel === null) {
    throw new SkillDeliveryError("not-found", `"${name}" is not a valid skill name (a skill id like "pitch", or a reference like "pitch/references/prfaq-template.md").`);
  }
  const local = path.join(PACKAGE_ROOT, "skills", rel);
  if (existsSync(local)) return { text: readTrustedCanonicalSkill(name, trust), source: "local" };
  void root;
  void env; // Legacy configuration cannot change the canonical skill source.
  throw new SkillDeliveryError("not-found", skillNotBundledMessage(name));
}

async function runDevelopmentSkillTrustCommand(args: string[]): Promise<{ output: string; exitCode: number }> {
  const json = args.includes("--json");
  const knownFlags = new Set(["--json", "--approve", "--days", "--out"]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (!knownFlags.has(flag)) {
      markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: `unknown skill trust option ${flag}` });
      return {
        output: json
          ? `${JSON.stringify({ schema_version: "0.1", status: "refused", reason: "invalid_option" })}\n`
          : "usage: foo skill trust [--json] [--approve <sha256>] [--days 1..365] [--out <external-file>]\n",
        exitCode: 1,
      };
    }
    if (flag === "--json") continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(flag)) {
      markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: `${flag} requires one value` });
      return {
        output: json
          ? `${JSON.stringify({ schema_version: "0.1", status: "refused", reason: "invalid_option" })}\n`
          : "usage: foo skill trust [--json] [--approve <sha256>] [--days 1..365] [--out <external-file>]\n",
        exitCode: 1,
      };
    }
    values.set(flag, value);
    index += 1;
  }
  const daysText = values.get("--days");
  const days = daysText === undefined
    ? 30
    : /^[1-9][0-9]{0,2}$/.test(daysText)
      ? Number(daysText)
      : Number.NaN;
  const options: DevelopmentSkillTrustProposalOptions = {
    record_path: values.get("--out"),
    days,
  };
  try {
    const approvedDigest = values.get("--approve");
    const proposal = approvedDigest
      ? approveDevelopmentSkillTrust(PACKAGE_ROOT, approvedDigest, options)
      : developmentSkillTrustProposal(PACKAGE_ROOT, options);
    if (json) {
      return {
        output: `${JSON.stringify({
          schema_version: "0.1",
          status: approvedDigest ? "approved" : "review_required",
          root: proposal.root,
          skills_sha256: proposal.skills_sha256,
          issued_at: proposal.issued_at,
          expires_at: proposal.expires_at,
          record_path: proposal.record_path,
        })}\n`,
        exitCode: 0,
      };
    }
    if (approvedDigest) {
      return {
        output: `Development skills approved for ${proposal.root}\nDigest: ${proposal.skills_sha256}\nExpires: ${proposal.expires_at}\nRecord: ${proposal.record_path}\n`,
        exitCode: 0,
      };
    }
    const approveCommand = [
      "foo skill trust --approve",
      proposal.skills_sha256,
      "--days",
      String(days),
      "--out",
      shellWord(proposal.record_path),
    ].join(" ");
    return {
      output: `Review productfoo's canonical skill tree before approval.\nRoot: ${proposal.root}\nDigest: ${proposal.skills_sha256}\nProposed expiry: ${proposal.expires_at}\nExternal record: ${proposal.record_path}\nApprove only this exact digest with: ${approveCommand}\n`,
      exitCode: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "development trust approval refused";
    markFailure({ errorClass: "gate_block", errorCode: "E_GATE_BLOCKED", message });
    return {
      output: json
        ? `${JSON.stringify({ schema_version: "0.1", status: "refused", reason: message })}\n`
        : `✋ needs your input — ${message}\n`,
      exitCode: 1,
    };
  }
}

// CLI adapter: `foo skill <name>` prints the resolved leaf text — this is the
// handoff surface harnesses use when no skills/ directory exists.
export async function runSkillCommand(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  trust: CanonicalSkillTrustOptions = {},
): Promise<{ output: string; exitCode: number }> {
  if (args[0] === "trust") return runDevelopmentSkillTrustCommand(args);
  const trustFlagIndex = args.indexOf("--dev-trust-record");
  const trustRecord = trustFlagIndex === -1 ? trust.development_trust_record : args[trustFlagIndex + 1];
  if (trustFlagIndex !== -1 && (!trustRecord || trustRecord.startsWith("--"))) {
    markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: "development trust record path missing" });
    return { output: "usage: foo skill <name> [--dev-trust-record <external-record.json>]\n", exitCode: 1 };
  }
  const name = args.find((arg, index) => !arg.startsWith("--")
    && (trustFlagIndex === -1 || index !== trustFlagIndex + 1));
  if (!name) {
    markFailure({ errorClass: "usage_error", errorCode: "E_BAD_FLAG", message: "skill name missing" });
    return { output: "usage: foo skill <name>\n", exitCode: 1 };
  }
  try {
    const { text } = await resolveSkill(root, name, env, { ...trust, development_trust_record: trustRecord });
    return { output: text.endsWith("\n") ? text : `${text}\n`, exitCode: 0 };
  } catch (err) {
    if (err instanceof SkillDeliveryError) {
      markSkillFailure(err.kind, err.message);
      return { output: `${err.message}\n`, exitCode: 1 };
    }
    throw err;
  }
}
