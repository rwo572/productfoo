#!/usr/bin/env node
// Rehearse a public source commit or an exact supplied npm tarball.
//
// Full: --source-commit=<sha> [--work=<parent>] [--keep] [--receipt=<path>]
// Surface: --repo=<dir> --tarball=<file> --network deny [--prefix=<new-dir>]
//          [--work=<parent>] [--keep] [--receipt=<path>] [--expected-version=1.0.0]
//
// Full mode clones this public repository locally and checks out the requested
// commit without changing its history. Provisioning may use npm's registry;
// installed product workflows run with network denied and isolated credentials.
// Receipts bind the reviewed public inventories and exact tarball digests.
// No publishing, tags, commits, or remote mutations are performed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readInventory, inventoryFindings, sourceFindings, packageFindings, trackedFiles } from "./lib/publicManifest.mjs";
import {
  REPORTING_NET_DENY_PRELOAD_SOURCE,
  PublicSmokeError,
  SMOKE_WORKFLOW_IDS,
  buildReceipt,
  tarballDigests,
  toolchainInfo,
  cleanInstallEnv,
  releaseVersionFindings,
  tarballFilename,
  validateAgainstSchema,
} from "./lib/publicSmokeCore.mjs";

const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(message, code = 2) {
  console.error(`smoke-public: ${message}`);
  process.exit(code);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv) {
  const args = { sourceCommit: null, work: null, receipt: null, keep: false, repo: null, tarball: null, prefix: null, network: "deny", expectedVersion: "1.0.0" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network") {
      args.network = argv[++i];
      continue;
    }
    if (arg === "--keep") {
      args.keep = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) return null;
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in args)) return null;
    args[key] = match[2];
  }
  const full = Boolean(args.sourceCommit);
  const surface = Boolean(args.repo || args.tarball);
  if (full === surface) return null; // exactly one mode
  if (surface && (!args.repo || !args.tarball)) return null;
  if (args.network !== "deny") return null;
  if (releaseVersionFindings(args.expectedVersion, {}).length) return null;
  return args;
}

function metadataVersionFindings(repo, expected) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    const findings = releaseVersionFindings(expected, {
      "package.json": pkg.version,
      "package-lock.json": lock.version,
      "package-lock.json packages[root]": lock.packages?.[""]?.version,
    });
    if (typeof pkg.name !== "string" || !pkg.name) findings.push("package.json has no package name");
    return { version: typeof pkg.version === "string" ? pkg.version : null, name: pkg.name, findings };
  } catch (error) { return { version: null, name: null, findings: [`cannot read release metadata: ${error.message}`] }; }
}

function packedVersionFindings(tarball, expected, packageName) {
  const findings = [];
  const expectedName = tarballFilename(packageName, expected);
  if (path.basename(tarball) !== expectedName) findings.push(`tarball filename ${path.basename(tarball)} does not match expected ${expectedName}`);
  const packed = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8", maxBuffer: 1 << 20 });
  try {
    if (packed.status !== 0) throw new Error("tar cannot read package/package.json");
    const pkg = JSON.parse(packed.stdout);
    findings.push(...releaseVersionFindings(expected, { "packed package.json": pkg.version }));
    if (pkg.name !== packageName) findings.push(`packed package name ${pkg.name} does not match ${packageName}`);
  } catch (error) { findings.push(`cannot read packed metadata: ${error.message}`); }
  return findings;
}

// Run a provisioning command; on failure, record the phase and stop — later
// phases cannot meaningfully run (unlike smoke workflows, which all run so the
// receipt records the complete surface).
function runPhase(name, argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd ?? RUNNER_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: options.timeoutMs ?? 20 * 60_000,
    input: options.input,
    env: options.env,
  });
  if (result.error) {
    return { id: name, status: "fail", detail: `spawn failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-12).join("\n");
    return { id: name, status: "fail", detail: `exit ${result.status}\n${tail}` };
  }
  return { id: name, status: "pass", ...(options.passDetail !== undefined ? { detail: options.passDetail } : {}) };
}

function npmArgs(rest) {
  return [process.execPath.endsWith("node") ? "npm" : "npm", ...rest, "--no-audit", "--no-fund", "--loglevel=error"];
}

// One smoke workflow: run the installed foo, record argv + exit code, keep
// going so the receipt records the complete surface.
function recordWorkflow(workflows, id, fooBin, env, cwd, args, options = {}) {
  const result = spawnSync(fooBin, args, { cwd, env, encoding: "utf8", timeout: options.timeoutMs ?? 120_000, input: options.input ?? "" });
  const exit = result.status ?? -1;
  const entry = { id, argv: [fooBin, ...args], exit_code: exit, pass: exit === 0 };
  if (options.detail !== undefined) entry.detail = options.detail;
  if (result.error) {
    entry.pass = false;
    entry.detail = `spawn failed: ${result.error.message}`;
  }
  if (!entry.pass && !result.error) {
    const failure = `${result.stderr || result.stdout}`.trim().split("\n").slice(-12).join("\n");
    entry.detail = [entry.detail, failure].filter(Boolean).join("\n");
  }
  workflows.push(entry);
  return { exit, stdout: result.stdout ?? "", stderr: result.stderr ?? "", pass: entry.pass };
}

// The governed research paper is rendered by the INSTALLED product's own
// renderer — importing the emitted public closure is itself part of the proof
// (the library surface), and hand-writing markdown would rehearse the smoke
// script's idea of a paper instead of productfoo's.
async function loadInstalledRenderer(pkgRoot) {
  const module = await import(pathToFileURL(path.join(pkgRoot, "dist-public", "src", "research.js")).href);
  return module.renderPaper;
}

export const OFFLINE_RESEARCH_TOPIC = "Offline synthetic research fixture";

// npm's normal offline switch keeps doctor's optional npm-version probe local.
// The independent network tripwire remains armed for every installed process.
export function offlineSmokeEnv(home, guard, attempts) {
  return { ...cleanInstallEnv(home), npm_config_offline: "true", npm_config_update_notifier: "false",
    NODE_OPTIONS: `--require=${JSON.stringify(guard)}`, FOO_REPORT_NETWORK_ATTEMPTS: attempts };
}

export function renderOfflineResearchFixture(renderPaper, runId) {
  const paper = renderPaper({
        schema_version: "0.1",
        topic: OFFLINE_RESEARCH_TOPIC,
        date: "2026-09-25",
        depth: "standard",
        sources: [
          { class: "repo", status: "available", reason: "synthetic smoke fixture in local workspace", skill: null },
          { class: "web_free", status: "excluded", reason: "network denied; no web retrieval attempted", skill: null },
          { class: "web_firecrawl", status: "excluded", reason: "no key; network denied", skill: null },
          { class: "connected", status: "excluded", reason: "none configured", skill: null },
        ],
        claims: [{ text: "This synthetic fixture exercises local paper rendering only.", source_class: "primary", confidence: "high", dissent: null, source: "local smoke fixture" }],
        panel_findings: [{ lens: "safety", finding: "No private data routed to external services.", dissent: false }],
        open_questions: ["External research remains unperformed in this offline smoke."],
        self_application: { text: "Planned with foo research; no external evidence gathered. This is a synthetic smoke fixture.", source_class: "primary", confidence: "high", dissent: "none surfaced" },
      });
  return paper.replace(/^---\n/, `---\nresearch_run: ${runId}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    die(
      "usage:\n" +
        "  node scripts/smoke-public.mjs --source-commit=<sha> [--work=<dir>] [--receipt=<path>] [--expected-version=1.0.0] [--keep]\n" +
        "  node scripts/smoke-public.mjs --repo=<dir> --tarball=<file> --network deny [--prefix=<dir>] [--receipt=<path>] [--expected-version=1.0.0]",
    );
  }

  const fullMode = Boolean(args.sourceCommit);
  const phases = [];
  const workflows = [];
  const digests = {};

  // --work is a parent, never a directory the runner is allowed to erase.
  const workParent = path.resolve(args.work ?? process.env.TMPDIR ?? "/tmp");
  mkdirSync(workParent, { recursive: true });
  const work = mkdtempSync(path.join(workParent, "foo-rehearsal-"));
  const receiptPath = args.receipt ? path.resolve(args.receipt) : `${work}-receipt.json`;
  if (!args.keep && !path.relative(work, receiptPath).startsWith("..") && !path.isAbsolute(path.relative(work, receiptPath))) {
    die("--receipt must live outside the temporary work directory, or use --keep");
  }
  const provisionEnv = { ...cleanInstallEnv(mkdtempSync(path.join(work, "provision-home-"))), NODE_ENV: "development" };
  delete provisionEnv.DO_NOT_TRACK;
  let sourceDir = fullMode ? path.join(work, "repo") : path.resolve(args.repo);
  let tarballPath = fullMode ? null : path.resolve(args.tarball);
  let baselineVersion = null;
  let packageName = null;
  const computedVersion = args.expectedVersion;
  let sourceCommit = null;
  let historyCommit = null;
  const done = () => finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);

  if (fullMode) {
    const resolved = spawnSync("git", ["rev-parse", "--verify", `${args.sourceCommit}^{commit}`], { cwd: RUNNER_ROOT, encoding: "utf8" });
    sourceCommit = resolved.status === 0 ? resolved.stdout.trim() : null;
    if (!sourceCommit) die(`cannot resolve public source commit ${args.sourceCommit}`);
    const clone = runPhase("clone", ["git", "-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "--no-checkout", RUNNER_ROOT, sourceDir], { env: provisionEnv });
    phases.push(clone);
    if (clone.status !== "pass") return done();
    const checkout = runPhase("checkout", ["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", sourceCommit], { cwd: sourceDir, env: provisionEnv });
    phases.push(checkout);
    if (checkout.status !== "pass") return done();
    historyCommit = sourceCommit;
  } else {
    const current = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" });
    sourceCommit = current.status === 0 ? current.stdout.trim() : null;
  }

  let gitManifest;
  let npmManifest;
  try {
    gitManifest = readInventory(sourceDir, "public-source-files.json");
    npmManifest = readInventory(sourceDir, "public-package-files.json");
    const actual = trackedFiles(sourceDir);
    const findings = [...sourceFindings(actual), ...inventoryFindings(actual, gitManifest)];
    const missing = gitManifest.filter(file => !existsSync(path.join(sourceDir, file)));
    findings.push(...missing.map(file => `source file missing: ${file}`));
    if (findings.length) throw new Error(findings.join("; "));
    digests.git_manifest_sha256 = sha256Hex(readFileSync(path.join(sourceDir, "config/public-source-files.json")));
    digests.npm_manifest_sha256 = sha256Hex(readFileSync(path.join(sourceDir, "config/public-package-files.json")));
    const tree = createHash("sha256");
    for (const file of [...gitManifest].sort()) tree.update(file).update("\0").update(sha256Hex(readFileSync(path.join(sourceDir, file)))).update("\0");
    digests.source_tree_sha256 = tree.digest("hex");
    phases.push({ id: "source-inventory", status: "pass", detail: `${actual.length} source paths match the public inventory; working-tree bytes hashed separately from the commit` });
  } catch (error) {
    phases.push({ id: "source-inventory", status: "fail", detail: error.message });
    return done();
  }
  const metadata = metadataVersionFindings(sourceDir, computedVersion);
  baselineVersion = metadata.version;
  packageName = metadata.name;
  phases.push({ id: "version", status: metadata.findings.length ? "fail" : "pass", detail: metadata.findings.join("; ") || `source metadata agrees with expected ${computedVersion}` });
  if (metadata.findings.length) return done();

  if (fullMode) {
    for (const [name, argv] of [
      ["npm-ci", npmArgs(["ci", "--include=dev"])],
      ["npm-test", npmArgs(["test"])],
      ["build-public", npmArgs(["run", "build:public"])],
      ["self-check", [process.execPath, path.join(sourceDir, "bin/foo"), "self", "check"]],
      ["commands-validate", [process.execPath, path.join(sourceDir, "bin/foo"), "commands", "validate"]],
    ]) {
      const phase = runPhase(name, argv, { cwd: sourceDir, env: provisionEnv, timeoutMs: 25 * 60_000 });
      phases.push(phase);
      if (phase.status !== "pass") return done();
    }
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: sourceDir, env: provisionEnv, encoding: "utf8", maxBuffer: 1 << 26 });
    if (packed.status !== 0) {
      phases.push({ id: "pack", status: "fail", detail: packed.stderr || "npm pack failed" });
      return done();
    }
    tarballPath = path.join(work, JSON.parse(packed.stdout)[0].filename);
  }

  const packVersionFindings = packedVersionFindings(tarballPath, computedVersion, packageName);
  phases.push({ id: "pack-version", status: packVersionFindings.length ? "fail" : "pass", detail: packVersionFindings.join("; ") || `supplied artifact agrees with expected ${computedVersion}` });
  if (packVersionFindings.length) return done();
  const entries = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8", maxBuffer: 1 << 26 });
  const files = (entries.stdout ?? "").split("\n").filter(file => file && !file.endsWith("/"));
  const invalid = files.filter(file => !file.startsWith("package/"));
  const packedFiles = files.map(file => file.replace(/^package\//, ""));
  const packFindings = [...invalid.map(file => `tar entry outside package/: ${file}`), ...packageFindings(packedFiles, gitManifest), ...inventoryFindings(packedFiles, npmManifest)];
  if (entries.status !== 0) packFindings.push("cannot list the supplied tarball");
  phases.push({ id: "pack", status: packFindings.length ? "fail" : "pass", detail: packFindings.join("; ") || `${packedFiles.length} artifact paths match the public package inventory` });
  if (packFindings.length) return done();
  digests.tarball_name = path.basename(tarballPath);
  Object.assign(digests, tarballDigests(readFileSync(tarballPath)));

  // Always install the exact checked artifact. Never trust an unrelated or
  // same-version installation that happens to occupy the requested prefix.
  const prefix = args.prefix ? path.resolve(args.prefix) : path.join(work, "prefix");
  if (existsSync(prefix)) {
    phases.push({ id: "install", status: "fail", detail: `prefix already exists: ${prefix}; choose a new directory` });
    return done();
  }
  const install = runPhase("install", npmArgs(["install", "-g", "--ignore-scripts", `--prefix=${prefix}`, tarballPath]), { cwd: work, env: provisionEnv });
  phases.push(install);
  if (install.status !== "pass") return done();

  // --- Phase: smoke — the network-denied local surface ----------------------
  const fooBin = path.join(prefix, "bin", "foo");
  if (!existsSync(fooBin)) {
    phases.push({ id: "smoke", status: "fail", detail: `no foo launcher at ${fooBin} — install the tarball with --prefix first` });
    return finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);
  }
  const pkgRoot = path.dirname(path.dirname(realpathSync(fooBin)));
  if (!existsSync(path.join(pkgRoot, "dist-public", "src", "cli.js"))) {
    phases.push({ id: "smoke", status: "fail", detail: `the installed package carries no dist-public/src/cli.js (${pkgRoot}) — the tarball cannot run` });
    return finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);
  }

  let installedFindings;
  try {
    const installed = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    installedFindings = releaseVersionFindings(computedVersion, { "installed package.json": installed.version });
    if (installed.name !== packageName) installedFindings.push(`installed package name ${installed.name} does not match ${packageName}`);
  } catch (error) { installedFindings = [`cannot read installed metadata: ${error.message}`]; }
  phases.push({ id: "installed-version", status: installedFindings.length ? "fail" : "pass", detail: installedFindings.join("; ") || `installed metadata agrees with expected ${computedVersion}` });
  if (installedFindings.length) return finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);

  // Clean room: allow only process essentials, use a fresh home/config, and
  // deny product networking. Host provider credentials never participate.
  const home = mkdtempSync(path.join(work, "home-"));
  writeFileSync(path.join(home, "net-deny.cjs"), REPORTING_NET_DENY_PRELOAD_SOURCE);
  const attempts = path.join(home, "network-attempts.log");
  const smokeEnv = offlineSmokeEnv(home, path.join(home, "net-deny.cjs"), attempts);
  writeFileSync(attempts, "");
  const control = spawnSync(process.execPath, ["-e", 'require("node:net").connect(443, "example.test")'], { env: smokeEnv, encoding: "utf8" });
  if (control.status === 0 || !readFileSync(attempts, "utf8").trim()) {
    phases.push({ id: "network-guard", status: "fail", detail: "network denial positive control did not fire" });
    return done();
  }
  writeFileSync(attempts, "");
  phases.push({ id: "network-guard", status: "pass", detail: "denial positive control fired; subsequent attempts are audited" });
  const projectDir = path.join(work, "project");
  mkdirSync(projectDir, { recursive: true });

  const cliVersion = recordWorkflow(workflows, "version", fooBin, smokeEnv, projectDir, ["--version"]);
  const cliFindings = releaseVersionFindings(computedVersion, { "foo --version": cliVersion.stdout.trim() });
  workflows[workflows.length - 1].pass = cliVersion.pass && cliFindings.length === 0;
  workflows[workflows.length - 1].detail = cliFindings.join("; ") || `installed CLI reports expected ${computedVersion}`;
  if (!workflows[workflows.length - 1].pass) return finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);
  recordWorkflow(workflows, "doctor", fooBin, smokeEnv, projectDir, ["doctor", "--json"], { detail: "doctor reports a clean local install" });

  const skill = recordWorkflow(workflows, "skill", fooBin, smokeEnv, projectDir, ["skill", "create-prd"], { detail: "a canonical product-management skill resolves locally" });
  if (skill.pass) {
    const skillBody = recordWorkflow(workflows, "skill-content", fooBin, smokeEnv, projectDir, ["skill", "create-prd"], { detail: "skill body non-empty" });
    workflows[workflows.length - 1].pass = skillBody.stdout.trim().length > 0;
  }

  // Spec creation and validation (packet contract) in the clean project.
  const specStart = recordWorkflow(workflows, "spec-start", fooBin, smokeEnv, projectDir,
    ["spec", "start", "Smoke the public install", "--request", "Prove a clean public install can run the productfoo Spec workflow.", "--packet", "smoke-v0"]);
  if (specStart.pass) {
    recordWorkflow(workflows, "spec-validate", fooBin, smokeEnv, projectDir, ["asp", "validate", "specs/smoke-v0"]);
  }

  // Deterministic redaction, offline (R-006). The transcript carries the
  // canonical AWS docs example key — a redaction fixture, same as the tests.
  const transcript = path.join(projectDir, "transcript.txt");
  writeFileSync(transcript, "contact ops@acme.com about key AKIAIOSFODNN7EXAMPLE\n"); // foo-redact: allow — canonical AWS docs example key, redaction fixture
  const redact = recordWorkflow(workflows, "redact", fooBin, smokeEnv, projectDir, ["redact", "transcript.txt", "--json"]);
  if (redact.pass) {
    const redactions = JSON.parse(redact.stdout)?.receipt?.redactions ?? 0;
    workflows[workflows.length - 1].pass = redactions === 1;
    workflows[workflows.length - 1].detail = `${redactions} redaction(s) applied locally`;
  }

  // One product-management swarm: prepare the record, fill the decision
  // fields the family gates read (the swarm's own fill step — a fresh record
  // is prepared with them EMPTY and the completion gates refuse empty), then
  // verify it against the family pack's contract gates.
  const swarm = recordWorkflow(workflows, "swarm", fooBin, smokeEnv, projectDir, ["swarm", "Improve onboarding activation", "--json"]);
  if (swarm.pass) {
    const recordPath = JSON.parse(swarm.stdout)?.record_path;
    if (recordPath) {
      const recordFile = path.join(projectDir, recordPath);
      const record = readFileSync(recordFile, "utf8");
      const filled = record
        .replace('minority_report: ""', 'minority_report: "none — the dissent is carried in the ledger"')
        .replace("not_doing: []", 'not_doing: ["no paid-placement experiments — outside the activation scope"]')
        .replace('what_would_change_our_mind: ""', 'what_would_change_our_mind: "activation rate rises without onboarding changes"');
      if (filled === record) {
        workflows[workflows.length - 1].pass = false;
        workflows[workflows.length - 1].detail = "swarm record carried none of the expected decision fields";
      } else {
        writeFileSync(recordFile, filled);
        recordWorkflow(workflows, "swarm-check", fooBin, smokeEnv, projectDir, ["swarm", "check", recordPath, "--json"]);
      }
    } else {
      workflows[workflows.length - 1].pass = false;
      workflows[workflows.length - 1].detail = "swarm prepared no record path";
    }
  }

  // Research: plan -> governed paper (rendered by the installed product) ->
  // seal -> validate. No key, no hosted endpoint, no network (R-006).
  const plan = recordWorkflow(workflows, "research-plan", fooBin, smokeEnv, projectDir, ["research", OFFLINE_RESEARCH_TOPIC, "--json"]);
  if (plan.pass) {
    const runId = JSON.parse(plan.stdout)?.run_id;
    const renderPaper = await loadInstalledRenderer(pkgRoot).catch(() => null);
    if (!runId || !renderPaper) {
      if (workflows[workflows.length - 1].pass) {
        workflows[workflows.length - 1].pass = false;
        workflows[workflows.length - 1].detail = runId ? "the installed package does not export its paper renderer" : "research planned no run id";
      }
    } else {
      const paperPath = path.join(projectDir, "paper.md");
      writeFileSync(paperPath, renderOfflineResearchFixture(renderPaper, runId));
      recordWorkflow(workflows, "research-seal", fooBin, smokeEnv, projectDir, ["research", "seal", "paper.md"]);
      const validate = recordWorkflow(workflows, "research-validate", fooBin, smokeEnv, projectDir, ["research", "validate", "paper.md", "--json"]);
      if (validate.pass) {
        workflows[workflows.length - 1].pass = JSON.parse(validate.stdout)?.stage === "realized";
      }
    }
  }

  // Discovery: scope approval -> plan -> match -> transcript-open attestation
  // -> apply -> validate, all offline against a synthetic session (R-006).
  mkdirSync(path.join(projectDir, "discovery", "inbox"), { recursive: true });
  writeFileSync(
    path.join(projectDir, "discovery", "inbox", "scope.yaml"),
    [
      'schema_version: "0.1"',
      "scopes:",
      "  - scope_id: dev_calls",
      "    provider: granola",
      "    connection_alias: main",
      "    state: approved",
      "    approved_by: Smoke Fixture",
      "    approved_at: 2026-09-24T00:00:00.000Z",
      "    time_window:",
      "      start: 2026-09-01T00:00:00Z",
      "      end: 2026-09-30T23:59:59Z",
      "    participant_allowlist:",
      "      - Dana Field",
      "",
    ].join("\n"),
  );
  recordWorkflow(workflows, "discovery-approve", fooBin, smokeEnv, projectDir,
    ["source", "approve", "discovery/inbox", "--provider", "granola", "--connection", "main", "--scope", "scope:dev_calls", "--by", "Smoke Fixture", "--json"]);
  const dPlan = recordWorkflow(workflows, "discovery-plan", fooBin, smokeEnv, projectDir, ["discovery", "plan", "--inbox", "--json"]);
  if (dPlan.pass) {
    const session = {
      schema_version: "0.1",
      provider: "granola",
      connection_alias: "main",
      runtime_handle: "granola-call-123",
      completed_at: "2026-09-15T15:00:00Z",
      completion_state: "completed",
      title: "Onboarding call",
      participants: ["Dana Field"],
      capabilities: { list_sessions: true, open_transcript: true, stable_link: false, timestamps: false },
      access: "available",
    };
    const match = recordWorkflow(workflows, "discovery-match", fooBin, smokeEnv, projectDir,
      ["discovery", "match", "inbox:dev_calls", "--sessions-stdin", "--json"], { input: JSON.stringify([session]) });
    if (match.pass) {
      const { readFileSync: rf } = await import("node:fs");
      const matchRecord = JSON.parse(rf(path.join(projectDir, ".foo", "discovery", "inbox_dev_calls", "match.json"), "utf8"));
      const fingerprint = matchRecord.candidates?.[0]?.source_fingerprint;
      const opened = recordWorkflow(workflows, "discovery-proof-opened", fooBin, smokeEnv, projectDir,
        ["discovery", "proof-opened", "inbox:dev_calls", "--fingerprint", fingerprint, "--json"]);
      if (opened.pass) {
        const envelope = {
          schema_version: "0.1",
          kind: "discovery_evidence",
          study_id: "inbox:dev_calls",
          lane: "unassigned_call_evidence",
          source: { provider: "granola", source_fingerprint: fingerprint, completed_at: session.completed_at, locator_capability: "none" },
          findings: [{
            finding_id: "F-001",
            headline: "Onboarding friction is manual",
            paraphrase: "The customer said setup takes days because it is manual.",
            evidence_type: "stated",
            confidence: "medium",
            dissent: "none surfaced",
          }],
          coverage: { transcript_complete: true, caveats: ["source capabilities lack stable_link and timestamps; locators are unavailable"] },
          privacy_attestation: { pii_redacted: true, direct_quotes: false },
          raw_content_present: false,
        };
        recordWorkflow(workflows, "discovery-apply", fooBin, smokeEnv, projectDir,
          ["discovery", "apply", "inbox:dev_calls", "--evidence-stdin", "--json"], { input: JSON.stringify(envelope) });
        recordWorkflow(workflows, "discovery-validate", fooBin, smokeEnv, projectDir, ["discovery", "validate", "--json"]);
      }
    }
  }

  // Library surface: the emitted public closure imports as a module.
  const library = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(path.join(pkgRoot, "dist-public", "src", "index.js")).href)}); if (!m || typeof m !== "object") process.exit(1);`],
    { cwd: projectDir, env: smokeEnv, encoding: "utf8", timeout: 60_000 });
  workflows.push({
    id: "library",
    argv: [process.execPath, "--input-type=module", "-e", "import <pkg>/dist-public/src/index.js"],
    exit_code: library.status ?? -1,
    pass: library.status === 0,
    detail: "the emitted public closure imports standalone",
  });

  // Coverage: every logical surface group must appear in the receipt.
  const covered = new Set(workflows.map((w) => w.id));
  for (const group of SMOKE_WORKFLOW_IDS) {
    if (![...covered].some((id) => id === group || id.startsWith(`${group}-`))) {
      phases.push({ id: "smoke", status: "fail", detail: `the receipt covers no workflow for surface "${group}"` });
    }
  }
  if (readFileSync(attempts, "utf8").trim()) phases.push({ id: "smoke", status: "fail", detail: "installed workflows attempted denied network access" });
  const smokeOk = workflows.every((w) => w.pass) && !phases.some((p) => p.id === "smoke" && p.status === "fail");
  phases.push({ id: "smoke", status: smokeOk ? "pass" : "fail", detail: `${workflows.length} workflows over the installed product, network denied` });

  return finish(args, work, receiptPath, fullMode ? "full" : "surface", sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests);
}

function finish(args, work, receiptPath, mode, sourceCommit, historyCommit, baselineVersion, computedVersion, phases, workflows, digests) {
  const network = {
    posture: args.network,
    preload: "net/dns deny (scripts/lib/publicSmokeCore.mjs NET_DENY_PRELOAD_SOURCE)",
    note: "provisioning phases (npm ci, install) may reach the registry; the product surface never does",
  };
  // #882: record which toolchain produced the digests, so a re-derivation on
  // another machine can tell a compressor difference from a content change.
  const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const toolchain = toolchainInfo({ npmVersion });
  const receipt = buildReceipt({ mode, sourceCommit, historyCommit, baselineVersion, computedVersion, network, phases, workflows, digests, toolchain });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const schemaPath = path.join(RUNNER_ROOT, "config", "rehearsal-receipt.schema.json");
  if (existsSync(schemaPath)) {
    const findings = validateAgainstSchema(receipt, JSON.parse(readFileSync(schemaPath, "utf8")));
    if (findings.length) {
      console.error(`smoke-public: the receipt does not satisfy its schema:\n  ${findings.join("\n  ")}`);
      process.exit(1);
    }
  } else {
    console.error("smoke-public: config/rehearsal-receipt.schema.json missing — refusing unvalidated evidence");
    process.exit(1);
  }

  const failedPhases = phases.filter((p) => p.status === "fail");
  const failedWorkflows = workflows.filter((w) => !w.pass);
  // A passing receipt binds the source bytes, reviewed inventories and exact
  // installed artifact. Failed runs legitimately have only partial digests.
  if (receipt.result === "pass" &&
      (!digests.source_tree_sha256 || !digests.git_manifest_sha256 || !digests.npm_manifest_sha256 || !digests.tarball_name || !digests.tarball_sha256 || !digests.tarball_tar_sha256)) {
    console.error("smoke-public: runner bug — a passing rehearsal must record the public source, inventories, tarball, and uncompressed tar digests");
    process.exit(1);
  }
  for (const phase of phases) console.error(`smoke-public: [${phase.status}] ${phase.id}${phase.detail ? ` — ${phase.detail.split("\n")[0]}` : ""}`);
  for (const workflow of workflows) console.error(`smoke-public: [${workflow.pass ? "pass" : "FAIL"}] ${workflow.id} (exit ${workflow.exit_code})`);
  console.error(`smoke-public: ${receipt.result.toUpperCase()} — receipt at ${receiptPath}`);
  if (receipt.result !== "pass" || failedPhases.length || failedWorkflows.length) process.exit(1);
  if (!args.keep) rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
  .then((code) => process.exitCode = code ?? 0)
  .catch((error) => {
    console.error(`smoke-public: ${error instanceof PublicSmokeError ? error.message : (error?.stack ?? String(error))}`);
    process.exit(1);
  });
