// The public-product rehearsal's test suite — T-010 (R-001, R-006).
//
// The rehearsal's full pipeline (local clone -> npm ci -> tests -> pack
// -> clean-prefix install -> network-denied surface) runs once per candidate
// and writes a receipt; running it inside the unit suite would make
// every test run pay for an npm ci. What the suite proves here is the pure
// core the rehearsal's verdicts rest on:
//
//   - historical target calculation (advisory) and actual artifact version assertions,
//   - the pre-init shape gate (a tree the manifest does not name never reaches
//     git init),
//   - the network-denial preload (the tripwire text the clean room installs),
//   - the receipt builder's pass/fail logic, and receipt conformance to
//     config/rehearsal-receipt.schema.json shipped with the runner,
//   - the CLI guard: wrong modes refuse to run at all.
//
// The full-surface run itself is executed and recorded in the packet's event
// ledger (C-016/C-017 evidence), not re-run here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePaper, renderPaper, validateClaims } from "../src/research.js";

// scripts/ is plain JavaScript outside the compiled dist tree, so the runtime
// import resolves the module relative to THIS file's location — the same
// specifier works from the source tree and from dist/test.
const smokeCore = (await import(
  new URL("../../scripts/lib/publicSmokeCore.mjs", import.meta.url).href
)) as typeof import("../scripts/lib/publicSmokeCore.mjs");
const {
  NET_DENY_PRELOAD_SOURCE,
  PublicSmokeError,
  SMOKE_WORKFLOW_IDS,
  buildReceipt,
  cleanInstallEnv,
  releaseVersionFindings,
  tarballFilename,
  computePublicVersion,
  rootShapeFindings,
  tarballDigests,
  toolchainInfo,
  validateAgainstSchema,
} = smokeCore;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_PATH = path.join(ROOT, "config", "rehearsal-receipt.schema.json");
const CLI = path.join(ROOT, "scripts", "smoke-public.mjs");

test("public history retains allowlisted ignored fixtures in a clean clone", async () => {
  const { stagePublicHistory } = await import(new URL("../../scripts/lib/publicHistory.mjs", import.meta.url).href) as typeof import("../scripts/lib/publicHistory.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "foo-public-history-"));
  const repo = path.join(dir, "repo");
  const clone = path.join(dir, "clone");
  mkdirSync(repo);
  const files = { ".gitignore": "integration-events.jsonl\n", "integration-events.jsonl": "{\"fixture\":true}\n" };
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(repo, name), bytes);
    git(repo, ["init", "-b", "main"]);
    stagePublicHistory(repo, Object.keys(files));
    git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
    git(dir, ["clone", "--no-local", repo, clone]);
    for (const [name, bytes] of Object.entries(files)) assert.equal(readFileSync(path.join(clone, name), "utf8"), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withTree(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-smoke-tree-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    if (content !== "") writeFileSync(full, content);
    else mkdirSync(full, { recursive: true });
  }
  return dir;
}

test("computePublicVersion: a 0.1.x baseline yields the first public release, 1.0.0 (D-010)", () => {
  assert.deepEqual(computePublicVersion("0.1.36"), { baseline: "0.1.36", version: "1.0.0" });
  assert.deepEqual(computePublicVersion("0.1.37"), { baseline: "0.1.37", version: "1.0.0" });
});

test("computePublicVersion: any other baseline stops for a version decision", () => {
  // Past 0.1.x the public line has launched; the rehearsal must not silently
  // choose the next number.
  for (const baseline of ["0.2.0", "1.0.0", "0.1", "0.1.37-beta.1", ""]) {
    assert.throws(() => computePublicVersion(baseline), PublicSmokeError, `expected a stop for ${JSON.stringify(baseline)}`);
  }
});

test("rootShapeFindings: a manifest-shaped tree with no stale entries passes", () => {
  const tree = withTree({ "package.json": "{}", src: "", test: "", docs: "" });
  try {
    const manifest = ["package.json", "src/cli.ts", "test/publicBoundary.test.ts", "docs/README.md"];
    assert.deepEqual(rootShapeFindings(tree, manifest), []);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("rootShapeFindings: an unexpected root entry, a missing manifest root, and stale provisioning entries all fail before git init", () => {
  const manifest = ["package.json", "src/cli.ts", "test/publicBoundary.test.ts"];
  const tree = withTree({ "package.json": "{}", src: "", test: "", notes: "", "bun.lock": "{}", dist: "", node_modules: "" });
  try {
    const findings = rootShapeFindings(tree, manifest);
    assert.ok(findings.some((f) => f.includes("unexpected root entry") && f.includes("notes")), findings.join("\n"));
    // The tree carries no docs/ here; the manifest only names roots it has.
    assert.ok(findings.some((f) => f.startsWith("stale provisioning entry") && f.includes("bun.lock")), findings.join("\n"));
    assert.ok(findings.some((f) => f.startsWith("stale provisioning entry") && f.includes("node_modules")), findings.join("\n"));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("the network-denial preload denies net and dns so an offline workflow fails loudly, not silently", () => {
  for (const marker of ["net.connect", "net.Socket.prototype.connect", "net.createConnection", "dns.lookup", "dns.promises.lookup"]) {
    assert.ok(NET_DENY_PRELOAD_SOURCE.includes(marker), `preload does not deny ${marker}`);
  }
});

test("buildReceipt: the result passes only when every phase and workflow passed", () => {
  const base = {
    mode: "full" as const,
    sourceCommit: "a".repeat(40),
    historyCommit: "b".repeat(40),
    baselineVersion: "1.0.0",
    computedVersion: "1.0.0",
    network: { posture: "deny", preload: "net/dns deny" },
    digests: {},
  };
  const passing = buildReceipt({
    ...base,
    phases: [{ id: "export", status: "pass" }, { id: "gitleaks", status: "skipped", detail: "absent" }],
    workflows: [{ id: "version", argv: [], exit_code: 0, pass: true }],
  });
  assert.equal(passing.result, "pass");

  const failedPhase = buildReceipt({
    ...base,
    phases: [{ id: "export", status: "fail" }],
    workflows: [{ id: "version", argv: [], exit_code: 0, pass: true }],
  });
  assert.equal(failedPhase.result, "fail");

  const failedWorkflow = buildReceipt({
    ...base,
    phases: [{ id: "export", status: "pass" }],
    workflows: [{ id: "redact", argv: [], exit_code: 1, pass: false }],
  });
  assert.equal(failedWorkflow.result, "fail");
});

test("SMOKE_WORKFLOW_IDS covers the cutover matrix's offline surfaces", () => {
  // "Network-denied CLI, skill, swarm, research, and discovery smoke tests pass
  // with no token and no hosted endpoint configured" — plus the 08-17 Task 11
  // Step 5 list: version/doctor, spec creation/validation, redaction dry-run,
  // and the library entrypoint.
  for (const surface of ["version", "doctor", "skill", "spec", "redact", "swarm", "research", "discovery", "library"]) {
    assert.ok(SMOKE_WORKFLOW_IDS.includes(surface), `the smoke surface list omits ${surface}`);
  }
});

test("a receipt built by the runner's own builder conforms to the reviewed schema", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const receipt = buildReceipt({
    mode: "full",
    sourceCommit: "a".repeat(40),
    historyCommit: "b".repeat(40),
    baselineVersion: "1.0.0",
    computedVersion: "1.0.0",
    network: { posture: "deny", preload: "net/dns deny" },
    phases: [{ id: "export", status: "pass" }],
    workflows: [{ id: "version", argv: ["foo", "--version"], exit_code: 0, pass: true }],
    digests: {
      source_tree_sha256: "c".repeat(64),
      git_manifest_sha256: "d".repeat(64),
      npm_manifest_sha256: "e".repeat(64),
      tarball_name: "productfoo-1.0.0.tgz",
      tarball_sha256: "1".repeat(64),
      tarball_tar_sha256: "2".repeat(64),
    },
    toolchain: { node: "v26.5.0", npm: "11.17.0", platform: "darwin", arch: "arm64" },
  });
  assert.deepEqual(validateAgainstSchema(receipt, schema), []);
  // #882: a receipt must say which toolchain produced its digests.
  const { toolchain: _dropped, ...withoutToolchain } = receipt;
  assert.ok(validateAgainstSchema(withoutToolchain, schema).length > 0, "a receipt without its toolchain is refused");

  // Digests that only exist after their phase (source tree, tarball) are
  // optional — a failing run's receipt legitimately records only the digests
  // computed before the failure. Every supplied digest pattern still binds.
  // The runner refuses any passing receipt lacking the complete digest set.
  const failingRunReceipt = structuredClone(receipt) as unknown as Record<string, unknown>;
  delete ((failingRunReceipt.digests as Record<string, unknown>).tarball_name);
  delete ((failingRunReceipt.digests as Record<string, unknown>).tarball_sha256);
  delete ((failingRunReceipt.digests as Record<string, unknown>).source_tree_sha256);
  (failingRunReceipt as Record<string, unknown>).result = "fail";
  assert.deepEqual(validateAgainstSchema(failingRunReceipt, schema), []);

  for (const mutation of [
    (r: Record<string, unknown>) => { r.result = "maybe"; },
    (r: Record<string, unknown>) => { (r.digests as Record<string, unknown>).git_manifest_sha256 = "invalid"; },
    (r: Record<string, unknown>) => { (r.digests as Record<string, unknown>).tarball_sha256 = "nothex"; },
    (r: Record<string, unknown>) => { (r.candidate as Record<string, unknown>).extra = true; },
    (r: Record<string, unknown>) => { (r as Record<string, unknown>).mode = "sideways"; },
  ]) {
    const broken = structuredClone(receipt) as unknown as Record<string, unknown>;
    mutation(broken);
    assert.ok(validateAgainstSchema(broken, schema).length > 0, `expected schema findings after mutation ${mutation.toString()}`);
  }
});

test("the CLI refuses to run without exactly one mode", () => {
  const noMode = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(noMode.status, 2);
  assert.match(noMode.stderr, /usage:/);

  const bothModes = spawnSync(process.execPath, [CLI, "--source-commit=HEAD", "--repo=/tmp/x", "--tarball=/tmp/y.tgz"], { encoding: "utf8" });
  assert.equal(bothModes.status, 2);

  const badNetwork = spawnSync(process.execPath, [CLI, "--repo=/tmp/x", "--tarball=/tmp/y.tgz", "--network=unlimited"], { encoding: "utf8" });
  assert.equal(badNetwork.status, 2);
});

// #882: the .tgz digest depends on the compressor; the tar digest does not.
test("tarballDigests: the same tar compressed two ways differs as .tgz but matches as tar", async () => {
  const { gzipSync } = await import("node:zlib");
  const tar = Buffer.from("package/package.json\0".padEnd(4096, "x"));
  const fast = tarballDigests(gzipSync(tar, { level: 1 }));
  const best = tarballDigests(gzipSync(tar, { level: 9 }));
  assert.notEqual(fast.tarball_sha256, best.tarball_sha256, "different gzip output, different .tgz digest");
  assert.equal(fast.tarball_tar_sha256, best.tarball_tar_sha256, "the uncompressed payload digest is compressor-independent");
  assert.match(fast.tarball_tar_sha256, /^[0-9a-f]{64}$/);
});

test("tarballDigests: an unreadable gzip yields an empty tar digest, never a guess", () => {
  const digests = tarballDigests(Buffer.from("not a gzip stream"));
  assert.match(digests.tarball_sha256, /^[0-9a-f]{64}$/);
  assert.equal(digests.tarball_tar_sha256, "");
});

test("toolchainInfo records node, npm, platform, and arch", () => {
  const info = toolchainInfo({ npmVersion: "11.17.0" });
  assert.equal(info.node, process.version);
  assert.equal(info.npm, "11.17.0");
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
});


test("version assertions require each observed artifact and stable expected semver", () => {
  assert.deepEqual(releaseVersionFindings("1.0.0", { package: "1.0.0", lock: "1.0.0", cli: "1.0.0" }), []);
  assert.equal(releaseVersionFindings("1.0.0", { package: "0.1.37", lock: undefined, cli: "1.0.0 extra" }).length, 3);
  for (const expected of ["1.0.0-beta.1", "01.0.0", "1.0", ""]) assert.equal(releaseVersionFindings(expected, { package: expected }).length, 1);
  assert.equal(tarballFilename("productfoo", "1.0.0"), "productfoo-1.0.0.tgz");
  assert.equal(tarballFilename("@scope/foo", "1.0.0"), "scope-foo-1.0.0.tgz");
});

test("clean install environment keeps process essentials and redirects all config homes", () => {
  const env = cleanInstallEnv("/fresh/home", {
    PATH: "/fixture/bin", LANG: "en_US.UTF-8", SystemRoot: "C:/Windows",
    FIRECRAWL_API_KEY: "synthetic-fixture", ANTHROPIC_API_KEY: "synthetic-fixture",
    OPENAI_API_KEY: "synthetic-fixture", FUTURE_PROVIDER_SECRET: "synthetic-fixture",
    FOO_SKILL_SERVER: "https://private.invalid", FOO_TOKEN: "synthetic-fixture",
    DATABASE_URL: "synthetic-fixture", MCP_SERVER_URL: "https://private.invalid",
    NODE_OPTIONS: "--require /host/preload.cjs", npm_config_userconfig: "/host/.npmrc",
    NPM_TOKEN: "synthetic-fixture", HTTP_PROXY: "https://private.invalid",
    HOME: "/host", USERPROFILE: "/host", XDG_CONFIG_HOME: "/host/.config", CODEX_THREAD_ID: "host-thread",
  });
  assert.equal(env.PATH, "/fixture/bin");
  assert.equal(env.SystemRoot, "C:/Windows");
  assert.equal(env.HOME, "/fresh/home");
  assert.equal(env.USERPROFILE, "/fresh/home");
  assert.equal(env.XDG_CONFIG_HOME, "/fresh/home/.config");
  assert.equal(env.npm_config_userconfig, "/fresh/home/.npmrc");
  assert.equal(env.npm_config_globalconfig, "/fresh/home/global.npmrc");
  assert.equal(env.npm_config_cache, "/fresh/home/.npm");
  for (const key of ["FIRECRAWL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FUTURE_PROVIDER_SECRET", "FOO_SKILL_SERVER", "FOO_TOKEN", "DATABASE_URL", "MCP_SERVER_URL", "NODE_OPTIONS", "NPM_TOKEN", "HTTP_PROXY", "CODEX_THREAD_ID"]) assert.equal(env[key], undefined, key);
});


test("the documented space-separated network flag reaches surface validation (#928)", () => {
  const tree = withTree({});
  try {
    const result = spawnSync(process.execPath, [CLI, `--repo=${tree}`, `--tarball=${tree}/absent.tgz`,
      "--network", "deny", `--work=${tree}/work`], { encoding: "utf8" });
    assert.doesNotMatch(result.stderr, /usage:/);
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /fail/i);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});


test("the public rehearsal has no private exporter or ownership-manifest dependency", () => {
  const script = readFileSync(CLI, "utf8");
  assert.doesNotMatch(script, /export-public\.mjs|module-ownership\.json|open-source[\/"']/);
  assert.match(script, /public-source-files\.json/);
  assert.match(script, /public-package-files\.json/);
  assert.match(script, /"clone", "--no-hardlinks", "--no-checkout"/);
  assert.match(script, /"checkout", "--detach", sourceCommit/);
  assert.doesNotMatch(script, /stagePublicHistory|"commit", "-m"/);
  assert.ok(existsSync(SCHEMA_PATH), "the receipt schema must ship");
});

test("rehearsal failure preserves the caller's work parent and emits a schema-valid public receipt", () => {
  const tree = withTree({ "keep.txt": "user-owned work parent" });
  const receipt = path.join(tree, "receipt.json");
  try {
    const result = spawnSync(process.execPath, [CLI, `--repo=${tree}`, `--tarball=${tree}/absent.tgz`,
      "--network", "deny", `--work=${tree}`, `--receipt=${receipt}`], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /public-source-files\.json/);
    assert.doesNotMatch(result.stderr, /open-source manifest|without schema validation/);
    assert.equal(readFileSync(path.join(tree, "keep.txt"), "utf8"), "user-owned work parent");
    const evidence = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(evidence.result, "fail");
    assert.equal(evidence.phases[0].id, "source-inventory");
    assert.deepEqual(validateAgainstSchema(evidence, JSON.parse(readFileSync(SCHEMA_PATH, "utf8"))), []);
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

test("surface rehearsal checks the exact supplied tarball against public inventories before installation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-smoke-artifact-"));
  const repo = path.join(dir, "repo");
  const archive = path.join(dir, "archive");
  const receipt = path.join(dir, "receipt.json");
  const prefix = path.join(dir, "prefix");
  const pkg = JSON.stringify({ name: "productfoo", version: "1.0.0" });
  const sourcePaths = ["package.json", "package-lock.json", "README.md", "config/public-source-files.json", "config/public-package-files.json"];
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    mkdirSync(path.join(repo, "config"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), pkg);
    writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
    writeFileSync(path.join(repo, "README.md"), "Synthetic public package fixture.\n");
    writeFileSync(path.join(repo, "config/public-source-files.json"), JSON.stringify({ schema_version: 1, files: sourcePaths }));
    writeFileSync(path.join(repo, "config/public-package-files.json"), JSON.stringify({ schema_version: 1, files: ["package.json", "README.md"] }));
    git(["init", "-b", "main"]);
    git(["add", "--", ...sourcePaths]);
    mkdirSync(path.join(archive, "package"), { recursive: true });
    writeFileSync(path.join(archive, "package/package.json"), pkg);
    writeFileSync(path.join(archive, "package/README.md"), "Synthetic public package fixture.\n");
    writeFileSync(path.join(archive, "package/unreviewed.txt"), "Unreviewed artifact content.\n");
    const tarball = path.join(dir, "productfoo-1.0.0.tgz");
    const tar = spawnSync("tar", ["-czf", tarball, "-C", archive, "package"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    const result = spawnSync(process.execPath, [CLI, `--repo=${repo}`, `--tarball=${tarball}`, "--network", "deny",
      `--work=${dir}`, `--prefix=${prefix}`, `--receipt=${receipt}`], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unreviewed.*unreviewed\.txt/);
    const evidence = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(evidence.phases.find((phase: { id: string }) => phase.id === "source-inventory").status, "pass");
    assert.equal(evidence.phases.find((phase: { id: string }) => phase.id === "pack").status, "fail");
    assert.equal(evidence.phases.some((phase: { id: string }) => phase.id === "install"), false);
    assert.equal(existsSync(prefix), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline research fixture keeps signed topic identity and uses valid claim labels", async () => {
  const runner = await import(pathToFileURL(CLI).href) as {
    OFFLINE_RESEARCH_TOPIC: string;
    renderOfflineResearchFixture: (renderer: typeof renderPaper, runId: string) => string;
  };
  const text = runner.renderOfflineResearchFixture(renderPaper, "r-fixture-001");
  const paper = parsePaper(text);
  assert.equal(paper.topic, runner.OFFLINE_RESEARCH_TOPIC);
  assert.match(text, /research_run: r-fixture-001/);
  assert.equal(paper.sources.web_firecrawl, "excluded");
  assert.equal(paper.sources.web_free, "excluded");
  assert.equal(validateClaims([...paper.claims, ...(paper.self_application ? [paper.self_application] : [])]).ok, true);
  assert.match(paper.claims[0].text, /synthetic fixture/);
  assert.doesNotMatch(text, /gathered public web only|hn:49713894/);
});

test("offline smoke configures npm offline without disarming or hiding denied connections", async () => {
  const runner = await import(pathToFileURL(CLI).href) as {
    offlineSmokeEnv: (home: string, guard: string, attempts: string) => Record<string, string>;
  };
  const dir = mkdtempSync(path.join(tmpdir(), "foo-smoke-offline-"));
  try {
    const guard = path.join(dir, "deny.cjs");
    const attempts = path.join(dir, "attempts.log");
    const { REPORTING_NET_DENY_PRELOAD_SOURCE } = smokeCore;
    writeFileSync(guard, REPORTING_NET_DENY_PRELOAD_SOURCE);
    writeFileSync(attempts, "");
    const env = runner.offlineSmokeEnv(dir, guard, attempts);
    assert.equal(env.npm_config_offline, "true");
    assert.equal(env.npm_config_update_notifier, "false");
    const npm = spawnSync("npm", ["view", "productfoo", "version", "--json"], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(npm.status, 0, "fresh offline npm cache cannot claim a known current version");
    assert.match(npm.stderr + npm.stdout, /ENOTCACHED|only-if-cached/);
    assert.equal(readFileSync(attempts, "utf8"), "", "offline npm must not attempt registry access");
    const denied = spawnSync(process.execPath, ["-e", 'require("node:tls").connect(443, "example.test")'], { env, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(readFileSync(attempts, "utf8"), /tls.connect/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
