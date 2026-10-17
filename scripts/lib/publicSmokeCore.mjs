//
// publicSmokeCore.mjs — pure core for the public-product rehearsal.
//
// foo-open-source-transition-v0 T-010 (R-001, R-006). The 08-17 plan's Task 11
// requires the rehearsal to produce a machine-readable receipt with each
// required workflow and its exit code, and to fail before `git init` if the
// exported tree carries anything the reviewed manifest does not name. This
// module holds the pure, testable half of that contract; the orchestration
// (subprocesses, npm, git) lives in scripts/smoke-public.mjs.
//
// Everything here is deterministic and side-effect free: version computation,
// the pre-init shape gate, the network-denial preload source, and the receipt
// builder + structural validator. test/publicSmoke.test.ts exercises these
// directly; the CLI is tested through real subprocess runs.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export class PublicSmokeError extends Error {}

// Compare observed artifacts, never infer their versions from a release plan.
export function releaseVersionFindings(expectedVersion, artifacts) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedVersion)) {
    return [`expected release version ${JSON.stringify(expectedVersion)} is not a stable semver`];
  }
  return Object.entries(artifacts).flatMap(([label, observed]) =>
    observed === expectedVersion ? [] : [`${label} version ${JSON.stringify(observed)} does not match expected ${expectedVersion}`]);
}

export function tarballFilename(packageName, version) {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

// The host environment is untrusted input to a clean-install test. Carry only
// process essentials; keep provider keys, harness markers, proxy/connector/DB
// settings, npm auth and caller Node preloads out, including future providers.
export function cleanInstallEnv(home, parent = process.env) {
  const env = {};
  const essentials = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ"];
  for (const key of essentials) if (parent[key] !== undefined) env[key] = parent[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_cache: path.join(home, ".npm"),
    DO_NOT_TRACK: "1", NODE_ENV: "production", TERM: "dumb",
  });
  return env;
}


// The network posture for the product-surface phase: any connect or resolve
// attempt throws, so a workflow that dials out fails loudly instead of hanging
// or silently degrading mid-assertion. Only loopback fixtures may pass, and
// none of the smoke workflows open one.
export const NET_DENY_PRELOAD_SOURCE = [
  'const net = require("node:net");',
  'const dns = require("node:dns");',
  'const deny = (where) => () => { throw new Error(`network access attempted (${where}) — this workflow must run offline`); };',
  'net.connect = deny("net.connect");',
  'net.Socket.prototype.connect = deny("net.Socket.connect");',
  'net.createConnection = deny("net.createConnection");',
  'dns.lookup = deny("dns.lookup");',
  'dns.promises.lookup = deny("dns.promises.lookup");',
].join("\n");

// Reporting may catch transport errors, so persist every denied attempt before
// throwing. A zero-length audit log is independent evidence of no connection.
export const REPORTING_NET_DENY_PRELOAD_SOURCE = NET_DENY_PRELOAD_SOURCE.replace(
  'throw new Error(',
  'require("node:fs").appendFileSync(process.env.FOO_REPORT_NETWORK_ATTEMPTS, `${where}\\n`); throw new Error(',
) + '\n' + [
  'require("node:tls").connect = deny("tls.connect");',
  'globalThis.fetch = deny("fetch");',
].join('\n');

// The complete local surface the cutover matrix demands: "Network-denied CLI,
// skill, swarm, research, and discovery smoke tests pass with no token and no
// hosted endpoint configured." Spec creation/validation and deterministic
// redaction complete the 08-17 Task 11 Step 5 list; the library entrypoint
// proves the emitted public closure imports as a module.
export const SMOKE_WORKFLOW_IDS = Object.freeze([
  "version",
  "doctor",
  "skill",
  "spec",
  "redact",
  "swarm",
  "research",
  "discovery",
  "library",
]);

// Provisioning-phase files that must never reach the export. The reviewed
// manifest already denies them; this gate re-proves the denial independently
// (08-17 Task 11 Step 2: rehearsal fails BEFORE git init on a stale lockfile
// or any unexpected root entry).
const STALE_EXPORT_ENTRIES = Object.freeze([
  "bun.lock",
  ".gitleaksignore",
  "render.yaml",
  "dist",
  "dist-public",
  "node_modules",
]);

/**
 * Historical target calculation only, never evidence of an artifact version.
 * The rehearsal uses releaseVersionFindings against observed metadata instead.
 * For a 0.1.x baseline the answer is 1.0.0 (0.1.37 -> 1.0.0, D-010). Any
 * other baseline is a stop for a version decision, never a silent bump.
 */
export function computePublicVersion(baselineVersion) {
  // The private line is 0.1.x; its first public release is 1.0.0 — the
  // complete standalone product, with a stable command, packet, and export
  // surface under semver (foo-open-source-transition-v0 D-010, replacing the
  // cutover plan's pinned 0.2.0 example). Any other baseline shape means the
  // public line has launched or the version scheme changed: stop for a human
  // version decision instead of choosing a release.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baselineVersion);
  if (!match || match[1] !== "0" || match[2] !== "1") {
    throw new PublicSmokeError(
      `baseline version ${baselineVersion} is not 0.1.x — stop for a version decision instead of choosing a release`,
    );
  }
  return { baseline: baselineVersion, version: "1.0.0" };
}

/**
 * Pre-init shape gate over the exported tree. manifestPaths is the reviewed
 * Git manifest's full path list; every root entry of the export must be named
 * by the manifest (and the manifest's root names must all be present), and
 * none of the stale provisioning entries may exist.
 */
export function rootShapeFindings(exportDir, manifestPaths) {
  const findings = [];
  const manifestRoots = new Set(manifestPaths.map((p) => (p.includes("/") ? p.split("/")[0] : p)));
  const present = new Set(readdirEntries(exportDir));

  for (const entry of [...present].sort()) {
    if (!manifestRoots.has(entry)) findings.push(`unexpected root entry in the export: ${entry}`);
  }
  for (const root of [...manifestRoots].sort()) {
    if (!present.has(root)) findings.push(`manifest root missing from the export: ${root}`);
  }
  for (const stale of STALE_EXPORT_ENTRIES) {
    if (present.has(stale)) findings.push(`stale provisioning entry in the export: ${stale}`);
  }
  return findings;
}

function readdirEntries(dir) {
  // No try/catch — a missing export directory is a caller bug and must throw.
  return readdirSync(dir);
}

/**
 * Build the rehearsal receipt. Timestamped (it is run evidence, not a
 * determinism proof — that property belongs to the export receipt).
 */
/**
 * #882: the two digests that freeze a packed tarball. tarball_sha256 hashes
 * the .tgz bytes, which depend on the gzip implementation in the Node that ran
 * `npm pack` (Node 26's zlib emits different bytes than 20/22/24 for the same
 * tar). tarball_tar_sha256 hashes the uncompressed tar payload, which npm
 * normalizes (entry order, mtimes), so it re-derives identically on any Node.
 * An unreadable gzip yields "" for the tar digest; the freeze gate refuses a
 * passing receipt without it.
 */
export function tarballDigests(bytes) {
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  let tar = "";
  try {
    tar = sha(gunzipSync(bytes));
  } catch {
    tar = "";
  }
  return { tarball_sha256: sha(bytes), tarball_tar_sha256: tar };
}

/** #882: the toolchain that produced a receipt's digests. */
export function toolchainInfo({ npmVersion = "" } = {}) {
  return { node: process.version, npm: npmVersion, platform: process.platform, arch: process.arch };
}

export function buildReceipt({
  mode,
  sourceCommit,
  historyCommit,
  baselineVersion,
  computedVersion,
  network,
  phases,
  workflows,
  digests,
  toolchain = toolchainInfo(),
}) {
  const pass = phases.every((p) => p.status === "pass" || p.status === "skipped") && workflows.every((w) => w.pass);
  return {
    schema_version: "0.1",
    kind: "foo_public_rehearsal_receipt",
    runner: "scripts/smoke-public.mjs",
    mode,
    candidate: {
      source_commit: sourceCommit,
      history_commit: historyCommit,
      baseline_version: baselineVersion,
      computed_version: computedVersion,
    },
    network,
    toolchain,
    phases,
    workflows,
    digests,
    result: pass ? "pass" : "fail",
  };
}

/**
 * Validate a receipt (or plan document) against a JSON Schema that uses the
 * draft-2020 subset this repo needs: type, required, properties,
 * additionalProperties, items, enum, pattern, minItems. Returns a list of
 * findings; empty means the document conforms.
 */
export function validateAgainstSchema(document, schema, path = "$") {
  if (schema.enum) {
    return schema.enum.includes(document) ? [] : [`${path}: ${JSON.stringify(document)} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`];
  }
  const typeOf = Array.isArray(document) ? "array" : document === null ? "null" : typeof document;
  // schema.type may be a single type or a union (e.g. ["string", "null"]).
  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expectedTypes.length > 0 && !expectedTypes.includes(typeOf)) {
    if (expectedTypes.includes("integer") && typeOf === "number" && Number.isInteger(document)) {
      // allowed below
    } else {
      return [`${path}: expected ${expectedTypes.join("|")}, got ${typeOf}`];
    }
  }
  const findings = [];
  if (schema.pattern && typeof document === "string" && !new RegExp(schema.pattern).test(document)) {
    findings.push(`${path}: ${JSON.stringify(document)} does not match ${schema.pattern}`);
  }
  if (Array.isArray(document)) {
    if (schema.minItems !== undefined && document.length < schema.minItems) {
      findings.push(`${path}: expected at least ${schema.minItems} item(s), got ${document.length}`);
    }
    if (schema.items) {
      document.forEach((item, index) => findings.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`)));
    }
    return findings;
  }
  if (typeOf === "object" && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!(key in document)) findings.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, value] of Object.entries(document)) {
      const sub = schema.properties[key];
      if (sub) findings.push(...validateAgainstSchema(value, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false) findings.push(`${path}: additional property "${key}" is not allowed`);
    }
  }
  return findings;
}
