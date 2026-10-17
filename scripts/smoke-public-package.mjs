#!/usr/bin/env node
//
// smoke-public-package.mjs — install the REAL tarball and run it.
//
// #891: verify:public compared the packed file LIST with the reviewed manifest
// but never ran the package, so a tarball whose launcher and export map pointed
// at dist/ (which it does not ship) passed while every install failed to start.
// This packs the package, installs the tarball into a throwaway global prefix
// with a throwaway HOME, and proves the three things a user touches:
//
//   1. `foo --version` starts and prints the package version.
//   2. The package root imports by name through the export map.
//   3. `foo update --json` classifies the install as an npm install (global),
//      not a repo checkout (#892), against a local stand-in npm registry.
//
// Usage: node scripts/smoke-public-package.mjs
// Exit codes: 1 = a smoke check failed, 2 = environment problem.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { cleanInstallEnv, REPORTING_NET_DENY_PRELOAD_SOURCE } from "./lib/publicSmokeCore.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const work = mkdtempSync(path.join(tmpdir(), "foo-public-smoke-"));
const home = path.join(work, "home");
const prefix = path.join(work, "prefix");
const findings = [];
let tarballSha256;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
}

// A clean user: no foo credentials, config, or channel from this machine.
const env = cleanInstallEnv(home);

try {
  // `npm pack` runs prepack (build:public), exactly as a release does.
  const packed = run("npm", ["pack", "--pack-destination", work, "--json"], { cwd: ROOT, env });
  if (packed.status !== 0) {
    console.error(`smoke-public-package: npm pack failed:\n${packed.stderr}`);
    process.exit(2);
  }
  const packResult = JSON.parse(packed.stdout)[0];
  for (const file of packResult.files) {
    if (/(?:^|\/)(?:bugTransportHttp|bugTransport|cliOperator|operatorCommands|shellProfile|skillResourceManifest|packServer)\./.test(file.path)) findings.push(`private reporting adapter shipped in tarball: ${file.path}`);
  }
  const tarball = path.join(work, packResult.filename);
  tarballSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");

  const installed = run("npm", ["install", "-g", "--prefix", prefix, tarball, "--no-audit", "--no-fund", "--prefer-offline"], { env });
  if (installed.status !== 0) {
    console.error(`smoke-public-package: npm install of the tarball failed:\n${installed.stderr}`);
    process.exit(2);
  }
  const bin = path.join(prefix, "bin", "foo");
  const libDir = path.join(prefix, "lib");

  // 1. The launcher starts the shipped build.
  const version = run(bin, ["--version"], { env, cwd: work });
  if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
    findings.push(`foo --version did not print ${pkg.version} (exit ${version.status}):\n${version.stdout}${version.stderr}`);
  }

  // 2. The package root resolves by NAME through the export map.
  const imported = run(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pkg.name)}); if (typeof m.main !== "function") { console.error("main is not exported"); process.exit(1); } console.log("ok");`], { env, cwd: libDir });
  if (imported.status !== 0) {
    findings.push(`importing ${pkg.name} by name failed:\n${imported.stdout}${imported.stderr}`);
  }

  // Core product installation must not pull in the removed database subsystem.
  const installedRoot = path.join(prefix, "lib", "node_modules", pkg.name);
  for (const file of packResult.files) {
    if (/^(?:dist-public\/src\/sdr\/|dist-public\/src\/commands\/sdr\.|commands\/sdr\.md$|config\/sdr-policy\.yaml$)/.test(file.path)) {
      findings.push(`removed sales subsystem artifact shipped: ${file.path}`);
    }
  }
  const driver = run(process.execPath, ["--input-type=module", "-e", `
    const { createRequire } = await import("node:module");
    const require = createRequire(${JSON.stringify(path.join(installedRoot, "package.json"))});
    let found = false;
    try { require.resolve("pg"); found = true; }
    catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
    if (found) throw new Error("removed database driver is still installed");
  `], { env, cwd: libDir });
  if (driver.status !== 0) findings.push(`database-free installation check failed:\n${driver.stdout}${driver.stderr}`);
  const retired = run(bin, ["sdr", "status", "synthetic-account"], { env, cwd: work });
  if (retired.status === 0 || !/unknown domain: sdr/.test(retired.stderr)) findings.push("removed sales command still dispatches");

  // Moving bundled data out of the root must also work in a real installation.
  const config = run(process.execPath, ["--input-type=module", "-e", `
    const { pathToFileURL } = await import("node:url");
    const root = ${JSON.stringify(installedRoot)};
    for (const [module, loader] of [
      ["loopBudget", "loadPricing"], ["activeModel", "loadModelRoster"],
      ["routingPolicy", "loadRoutingPolicy"],
    ]) {
      const api = await import(pathToFileURL(root + "/dist-public/src/" + module + ".js"));
      if (api[loader](root).available !== true) throw new Error(loader + " cannot load bundled config");
    }
  `], { env, cwd: work });
  if (config.status !== 0) findings.push(`installed configuration is unavailable:\n${config.stdout}${config.stderr}`);
  for (const relative of ["docs/CHANGELOG.md", "docs/THIRD_PARTY_NOTICES.md", "LICENSE"]) {
    if (!existsSync(path.join(installedRoot, relative))) findings.push(`installed documentation missing: ${relative}`);
  }

  // Reporting acceptance runs against the installed package export, with the
  // harness outside the tarball. Prove the guard fires before trusting it.
  const guard = path.join(work, "deny-network.cjs");
  writeFileSync(guard, REPORTING_NET_DENY_PRELOAD_SOURCE);
  const attempts = path.join(work, "network-attempts.log");
  const offlineEnv = { ...env, NODE_OPTIONS: `--require=${guard}`, FOO_REPORT_NETWORK_ATTEMPTS: attempts };
  for (const expression of ['require("node:net").connect(443, "example.test")', 'require("node:tls").connect(443, "example.test")', 'require("node:dns").lookup("example.test", () => {})', 'fetch("https://example.test")']) {
    writeFileSync(attempts, "");
    const control = run(process.execPath, ["-e", expression], { env: offlineEnv, cwd: libDir });
    if (control.status === 0 || !readFileSync(attempts, "utf8").trim()) findings.push(`reporting network guard positive control did not fire: ${expression}`);
  }
  writeFileSync(attempts, "");
  // The exported source tree builds src/ only, so compile the external test
  // harness here rather than relying on private dist/ or emitted test files.
  const helperPath = path.join(work, "reporting-acceptance.mjs");
  writeFileSync(helperPath, transformSync(readFileSync(path.join(ROOT, "test/helpers/reportingAcceptance.ts"), "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code);
  const helper = pathToFileURL(helperPath).href;
  const reporting = run(process.execPath, ["--input-type=module", "-e", `
    const { reportingAcceptance } = await import(${JSON.stringify(helper)});
    const api = await import(${JSON.stringify(pkg.name)});
    const cases = await reportingAcceptance(api);
    if (cases.length !== 9 || cases.some(c => c.status !== "pass")) throw new Error("incomplete reporting acceptance");
    console.log(JSON.stringify(cases));
  `], { env: offlineEnv, cwd: libDir });
  if (reporting.status !== 0 || readFileSync(attempts, "utf8").trim()) {
    findings.push(`installed reporting acceptance failed:\n${reporting.stdout}${reporting.stderr}`);
  }

  // Synthetic stored/ambient alpha settings and current-schema capsules with
  // alpha version labels must not turn the public CLI into a reporting client.
  for (const mode of ["clean", "stored", "ambient", "combined"]) {
    const caseHome = path.join(work, `report-home-${mode}`);
    const project = path.join(caseHome, "project");
    mkdirSync(project, { recursive: true });
    const caseEnv = { ...cleanInstallEnv(caseHome), NODE_OPTIONS: `--require=${guard}`, FOO_REPORT_NETWORK_ATTEMPTS: attempts };
    const boundary = run(process.execPath, ["--input-type=module", "-e", `
      const api = await import(${JSON.stringify(pkg.name)});
      const { localReportingAcceptance } = await import(${JSON.stringify(helper)});
      const cases = await localReportingAcceptance(api, ${JSON.stringify(mode)});
      if (cases.length !== 4) throw new Error("incomplete local boundary checks");
      console.log(JSON.stringify(cases));
    `], { env: caseEnv, cwd: libDir });
    if (boundary.status !== 0 || readFileSync(attempts, "utf8").trim()) {
      findings.push(`${mode} installed local reporting boundary failed: ${boundary.stdout}${boundary.stderr}`);
      continue;
    }
    if (mode === "ambient" || mode === "combined") Object.assign(caseEnv, { FOO_SKILL_TOKEN: "synthetic_alpha_report_token", FOO_SKILL_SERVER: "http://127.0.0.1:4020" });
    // Usage logging remains on here: stale alpha configuration must not upload
    // usage or profile picks, even though those writes are best-effort.
    const trackingEnv = { ...caseEnv, FOO_SKIP_UPDATE_CHECK: "1" };
    delete trackingEnv.DO_NOT_TRACK;
    for (const args of [["classify", "Update local docs"], ["profile", "set", "--role", "engineer", "--json"]]) {
      const tracked = run(bin, ["--root", project, ...args], { env: trackingEnv, cwd: project });
      if (tracked.status !== 0 || readFileSync(attempts, "utf8").trim()) findings.push(`${mode} installed usage/profile logging attempted network access: ${tracked.stderr}`);
    }
    const seed = run(process.execPath, ["--input-type=module", "-e", `
      const api = await import(${JSON.stringify(pkg.name)});
      const added = await api.runReportCommand(${JSON.stringify(project)}, ["add", "--expected", "Expected alpha behavior", "--actual", "Synthetic alpha failure", "--json"], process.env, { version: "0.1.25" });
      if (added.status !== "ready") throw new Error(added.output);
      console.log(added.output);
    `], { env: caseEnv, cwd: libDir });
    if (seed.status !== 0) { findings.push(`${mode} alpha capsule seed failed: ${seed.stderr}`); continue; }
    const saved = JSON.parse(seed.stdout);
    const pending = path.join(project, ".foo/reports/pending", `${saved.capsule_id}.json`);
    const pendingBytes = readFileSync(pending, "utf8");
    const shown = run(bin, ["--root", project, "report", "show", saved.capsule_id, "--json"], { env: caseEnv, cwd: project });
    const sent = run(bin, ["--root", project, "report", "send", saved.capsule_id, "--approve", saved.payload_digest, "--json"], { env: caseEnv, cwd: project });
    const retained = readFileSync(pending, "utf8") === pendingBytes;
    const deleted = run(bin, ["--root", project, "report", "delete", saved.capsule_id, "--approve", saved.payload_digest, "--json"], { env: caseEnv, cwd: project });
    try {
      const preview = JSON.parse(shown.stdout);
      const result = JSON.parse(sent.stdout);
      if (shown.status !== 0 || preview.payload.product.version !== "0.1.25" || preview.next_actions.some(a => a.startsWith("foo report send"))) findings.push(`${mode} alpha preview was not local`);
      if (sent.status !== 1 || result.status !== "refused" || result.error?.code !== "E_REPORT_SEND_REMOVED" || result.destination !== null) findings.push(`${mode} installed CLI did not keep approved send local`);
      if (deleted.status !== 0 || JSON.parse(deleted.stdout).status !== "deleted" || existsSync(pending)) findings.push(`${mode} installed local deletion failed`);
      // The library boundary separately proves retained rich bytes unchanged;
      // deletion here must have been the only operation that removed them.
      if (!retained || readFileSync(attempts, "utf8").trim()) findings.push(`${mode} installed CLI attempted reporting network access`);
    } catch (error) { findings.push(`${mode} installed CLI reporting output was invalid: ${error.message}`); }
  }

  // 3. The installed copy updates as an npm install, never as a repo build.
  const latest = "999.0.0";
  const registryPath = `/${pkg.name.replace("/", "%2f")}/latest`;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== registryPath || req.headers["x-foo-client-version"] || req.headers.authorization) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: latest }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // Async spawn: the stand-in npm registry runs in THIS process, so a
  // blocking spawnSync would starve it and the CLI would see no answer.
  const update = await new Promise((resolve) => {
    const child = spawn(bin, ["update", "--json"], { env: { ...env, npm_config_registry: `http://127.0.0.1:${port}` }, cwd: work });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  await new Promise((resolve) => server.close(resolve));
  if (requests.length !== 1 || requests[0] !== registryPath) findings.push("updater did not request the named npm package metadata exactly once");
  let plan;
  try {
    plan = JSON.parse(update.stdout.slice(update.stdout.indexOf("{"), update.stdout.lastIndexOf("}") + 1));
  } catch {
    plan = null;
  }
  if (!plan || plan.state === "repo" || plan.latest !== latest) {
    findings.push(`foo update classified the npm install as ${plan ? `"${plan.state}"` : "unparseable output"} — an installed package must be able to update:\n${update.stdout}${update.stderr}`);
  } else if (typeof plan.command === "string" && !plan.command.includes(pkg.name)) {
    findings.push(`foo update would install a different package than this one (${pkg.name}): ${plan.command}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (findings.length > 0) {
  console.error(`smoke-public-package: ${findings.length} finding(s):\n- ${findings.join("\n- ")}`);
  process.exit(1);
}
console.log(`smoke-public-package: OK — ${pkg.name}@${pkg.version} installs from its tarball, starts, imports by name, passes 9 reporting controls plus 16 alpha-boundary API and 12 installed CLI controls, and updates as an npm install.`);
console.log(`smoke-public-package: tested tarball sha256 ${tarballSha256}`);
