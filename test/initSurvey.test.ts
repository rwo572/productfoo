import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  loadProfile,
  machineProfilePath,
  parseHarness,
  parseHarnesses,
  profileHarnesses,
  parseRoles,
  parseTeam,
  profilePath,
  profileReportEvent,
  PROFILE_NONE,
  renderProfileReadback,
  renderProfileStatus,
  reportProfile,
  runFirstRunSurvey,
  runProfileRedo,
  runProfileSet,
  PROFILE_SET_EMPTY,
  saveProfile,
  SURVEY_CLOSE_PRODUCT,
  SURVEY_CLOSE_SAVED,
  SURVEY_CLOSE_SKIPPED,
  SURVEY_CORPUS,
  SURVEY_INTRO,
  type FooProfile,
} from "../src/profile.js";
import { PM_SURFACE_FORBIDDEN, runInitInteractive, surveyApplies } from "../src/initCommand.js";
import { agentLogPath } from "../src/commands/agent.js";

// --- helpers -----------------------------------------------------------------

// machine-wide-profile-v0: the profile home is FOO_STATE_DIR (mirrors the
// tester id). Every test that touches profiles points it at a fresh temp dir so
// the real ~/.foo is never read or written, and each test starts profile-free.
function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "foo-home-"));
  process.env.FOO_STATE_DIR = home;
  return home;
}

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "foo-survey-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

const REPO_FILES = {
  "src/app.ts": "export const app = () => {}; // TODO: validate input\n",
  "README.md": "# app\n",
};

// A fake terminal: each answer is written only when its prompt appears, the
// way a human answers — pre-buffering all lines makes readline drop the ones
// that arrive while no question is pending.
function fakeTerminal(answers: string[]): { input: PassThrough; output: PassThrough; screen: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = [...answers];
  let screen = "";
  output.on("data", (chunk) => {
    screen += String(chunk);
    if (String(chunk).includes("> ") && pending.length) input.write(`${pending.shift()}\n`);
  });
  return { input, output, screen: () => screen };
}

async function drive(answers: string[]): Promise<{ profile: FooProfile; screen: string }> {
  const io = fakeTerminal(answers);
  const profile = await runFirstRunSurvey({ input: io.input, output: io.output }, () => "2026-07-11T00:00:00.000Z");
  return { profile, screen: io.screen() };
}

// --- lenient parsing (T-004: the "1, 3" drop can never happen again) -----------

test("role answers parse leniently: digit lists, words, and mixes all land", () => {
  assert.deepEqual(parseRoles("1, 3"), ["product", "designer"]);
  assert.deepEqual(parseRoles("1 and 4"), ["product", "founder"]);
  assert.deepEqual(parseRoles("2"), ["engineer"]);
  assert.deepEqual(parseRoles("pm"), ["product"]);
  assert.deepEqual(parseRoles("product + design"), ["product", "designer"]);
  assert.deepEqual(parseRoles("founder, exec"), ["founder", "executive"]);
  assert.deepEqual(parseRoles("541"), ["executive", "founder", "product"]);
  assert.deepEqual(parseRoles(""), []);
  assert.deepEqual(parseRoles("plumber"), []);
});

test("team and harness answers parse leniently too", () => {
  assert.equal(parseTeam("2"), "small-team");
  assert.equal(parseTeam("just me"), "just-me");
  assert.equal(parseTeam("a big company"), "larger-org");
  assert.equal(parseTeam("seventeen"), undefined);
  assert.equal(parseHarness("1"), "claude-code");
  assert.equal(parseHarness("Claude Code"), "claude-code");
  assert.equal(parseHarness("custom-agent"), "custom-agent");
  assert.equal(parseHarness(""), undefined);
  // The owner's real redo answer (dogfood 2026-07-11): people lead with their
  // main tool, so the first recognized mention — digit or name — wins.
  assert.equal(parseHarness("1, sometimes 3"), "claude-code");
  assert.equal(parseHarness("2 mostly, codex rarely"), "cursor", "the leading mention is the 'most' pick");
  assert.equal(parseHarness("mostly 2"), "cursor");
  assert.equal(parseHarness("codex, occasionally 1"), "codex");
});

// --- the survey itself (R-002, T-004) ------------------------------------------

test("a multi-role answer lands, is read back, and gets the product close", async () => {
  const { profile, screen } = await drive(["1, 4", "1", "a tiny crm", "2"]);
  assert.deepEqual(profile.roles, ["product", "founder"]);
  assert.equal(profile.harness, "claude-code");
  assert.equal(profile.building, "a tiny crm");
  assert.equal(profile.team, "small-team");
  assert.ok(!screen.toLowerCase().includes("share"), "the share question is gone (onboarding-trust-boundary-v0 D-001)");
  assert.ok(screen.includes(SURVEY_INTRO));
  assert.ok(screen.includes("Read: product + founder · Claude Code · building a tiny crm · a small team."), `read-back missing from:\n${screen}`);
  assert.ok(screen.includes(SURVEY_CLOSE_PRODUCT));
});

test("an answer productfoo can't place is named out loud, never silently dropped", async () => {
  const { profile, screen } = await drive(["plumber", "", "", ""]);
  assert.equal(profile.roles, undefined);
  assert.ok(screen.includes('(didn\'t catch "plumber" — skipped)'));
  assert.ok(screen.includes(SURVEY_CLOSE_SKIPPED));
});

test("Enter skips every question, the close says nothing saved", async () => {
  const { profile, screen } = await drive(["", "", "", ""]);
  assert.equal(profile.roles, undefined);
  assert.equal(profile.harness, undefined);
  assert.equal(profile.building, undefined);
  assert.equal(profile.team, undefined);
  assert.ok(screen.includes(SURVEY_CLOSE_SKIPPED));
  assert.ok(!screen.includes("Read:"), "nothing answered, nothing read back");
});

test("a non-product answer saves with the honest non-product close", async () => {
  const { profile, screen } = await drive(["engineer", "custom-agent", "", "1"]);
  assert.deepEqual(profile.roles, ["engineer"]);
  assert.equal(profile.harness, "custom-agent");
  assert.equal(profile.team, "just-me");
  assert.ok(screen.includes(SURVEY_CLOSE_SAVED));
  assert.ok(!screen.includes(SURVEY_CLOSE_PRODUCT));
});

// --- the language eval (R-002): survey strings join the first-run corpus ------

test("the survey corpus passes the language eval — no machinery words", () => {
  const corpus = SURVEY_CORPUS.join("\n").toLowerCase();
  for (const word of [...PM_SURFACE_FORBIDDEN, "thin client", "skill server", "scaffold", "telemetry", "survey"]) {
    assert.ok(!corpus.includes(word.toLowerCase()), `survey corpus must not say "${word}"`);
  }
});

// --- the report (R-004, amended: picks ride the alpha telemetry agreement) -----

test("the report is picks-only with roles plural; an all-skipped profile reports nothing", () => {
  const base: FooProfile = { roles: ["product", "executive"], harness: "claude-code", building: "top secret diary app", team: "just-me", answered_at: "2026-07-11T00:00:00.000Z" };
  const event = profileReportEvent(base, "0.1.0");
  assert.ok(event);
  assert.deepEqual(event.roles, ["product", "executive"]);
  assert.equal(event.harness, "claude-code");
  assert.equal(event.team, "just-me");
  assert.ok(!("building" in event), "free text must be structurally absent from the payload");
  assert.ok(!JSON.stringify(event).includes("top secret"), "free text must not ride along anywhere");

  assert.equal(profileReportEvent({ answered_at: "2026-07-11T00:00:00.000Z" }, "0.1.0"), null, "nothing answered, nothing to report");
});

test("a free-typed coding agent reports as 'other', never as the typed text", () => {
  const profile: FooProfile = { harness: "my-bespoke-agent", answered_at: "2026-07-11T00:00:00.000Z" };
  const event = profileReportEvent(profile, "0.1.0");
  assert.ok(event);
  assert.equal(event.harness, "other");
});

test("reportProfile rides the telemetry agreement: both opt-outs win, otherwise picks flow", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const profile: FooProfile = { roles: ["product"], building: "top secret diary app", answered_at: "2026-07-11T00:00:00.000Z" };

  reportProfile(root, profile, "0.1.0", { DO_NOT_TRACK: "1" });
  assert.ok(!existsSync(agentLogPath(root)), "DO_NOT_TRACK writes nothing");

  mkdirSync(path.join(root, ".foo"), { recursive: true });
  writeFileSync(path.join(root, ".foo", "telemetry.json"), `${JSON.stringify({ enabled: false })}\n`);
  reportProfile(root, profile, "0.1.0", {});
  assert.ok(!existsSync(agentLogPath(root)), "foo agent telemetry disable writes nothing");

  writeFileSync(path.join(root, ".foo", "telemetry.json"), `${JSON.stringify({ enabled: true })}\n`);
  reportProfile(root, profile, "0.1.0", {});
  const log = readFileSync(agentLogPath(root), "utf8");
  assert.match(log, /"event_type":"profile"/);
  assert.match(log, /"roles":\["product"\]/);
  assert.ok(!log.includes("building"), "free text never reaches the log");
  assert.ok(!log.includes("top secret"), "free text never reaches the log, part two");
});

// --- machine-wide home: the profile is about the person (machine-wide-profile-v0) ---

test("saveProfile lands machine-wide by default; scope:repo writes the override", () => {
  const home = freshHome();
  const root = gitRepo(REPO_FILES);

  saveProfile({ roles: ["product"], answered_at: "2026-07-11T00:00:00.000Z" });
  assert.ok(existsSync(machineProfilePath()), "default save is machine-wide");
  assert.ok(machineProfilePath().startsWith(home), "machine profile lives under FOO_STATE_DIR");
  assert.ok(!existsSync(profilePath(root)), "no per-repo file is written by default");

  saveProfile({ roles: ["engineer"], answered_at: "2026-07-11T00:00:00.000Z" }, { scope: "repo", root });
  assert.ok(existsSync(profilePath(root)), "scope:repo writes the per-repo override");
});

test("the profile follows the person: answer once, every other project already knows you", async () => {
  freshHome();
  const repoA = gitRepo(REPO_FILES);
  const repoB = gitRepo(REPO_FILES);

  // Answer in repo A.
  const io = fakeTerminal(["1", "1", "a crm", "1"]);
  const readA = await runInitInteractive(repoA, [], { input: io.input, output: io.output, inputTTY: true, outputTTY: true });
  assert.ok(io.screen().includes(SURVEY_INTRO), "repo A asks the questions");
  assert.match(readA, /first read of your project/, "and personalizes immediately");

  // Repo B has never been touched — but the person is already known.
  assert.equal(surveyApplies(repoB, [], { inputTTY: true, outputTTY: true }), false, "no re-ask in a fresh project");
  const readB = await runInitInteractive(repoB, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: true, outputTTY: true });
  assert.ok(!readB.includes(SURVEY_INTRO), "repo B does not re-ask");
  assert.match(readB, /first read of your project/, "repo B leads with the product view — personalization followed the person");
  assert.deepEqual(loadProfile(repoB)?.roles, ["product"], "repo B reads the machine-wide profile");
});

test("a repo override wins over the machine-wide profile", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  saveProfile({ roles: ["product"], answered_at: "2026-07-11T00:00:00.000Z" }); // machine
  saveProfile({ roles: ["engineer"], answered_at: "2026-07-11T00:00:00.000Z" }, { scope: "repo", root }); // override
  assert.deepEqual(loadProfile(root)?.roles, ["engineer"], "the repo's own lens wins here");
});

// --- placement in the first-run moment (R-001/R-005) ----------------------------

test("surveyApplies only on a bare TTY read, first time, in a repo, with no profile yet", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const tty = { inputTTY: true, outputTTY: true };
  assert.equal(surveyApplies(root, [], tty), true);
  assert.equal(surveyApplies(root, ["--pm"], tty), true, "--pm is still a bare first read");
  assert.equal(surveyApplies(root, ["--json"], tty), false);
  assert.equal(surveyApplies(root, ["--pick", "1"], tty), false);
  assert.equal(surveyApplies(root, ["--intent", "x"], tty), false);
  assert.equal(surveyApplies(root, ["--attach-proof", "x"], tty), false);
  assert.equal(surveyApplies(root, [], { inputTTY: false, outputTTY: true }), false);
  assert.equal(surveyApplies(root, [], { inputTTY: true, outputTTY: false }), false);
  const notARepo = mkdtempSync(path.join(tmpdir(), "foo-survey-norepo-"));
  assert.equal(surveyApplies(notARepo, [], tty), false);

  saveProfile({ roles: ["engineer"], answered_at: "2026-07-11T00:00:00.000Z" });
  assert.equal(surveyApplies(root, [], tty), false, "a machine profile suppresses the survey everywhere");
});

test("the whole moment: opener, questions, read-back, read — once, then quiet forever", async () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const io = fakeTerminal(["1, 3", "", "", "", ""]);

  const read = await runInitInteractive(root, [], { input: io.input, output: io.output, inputTTY: true, outputTTY: true });
  const screen = io.screen();
  assert.ok(screen.includes("productfoo helps you agree on work"), "opener opens the moment");
  assert.ok(screen.includes(SURVEY_INTRO));
  assert.ok(screen.includes("Read: product + designer."), "the read-back names what landed");
  assert.ok(!read.includes("productfoo helps you agree on work"), "the read must not repeat the opener");
  assert.match(read, /first read of your project/, "a product answer lands on the PM surface immediately");

  const profile = loadProfile(root);
  assert.ok(profile);
  assert.deepEqual(profile.roles, ["product", "designer"]);

  // Second bare read: no questions, and the PM surface is now the default.
  const again = await runInitInteractive(root, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: true, outputTTY: true });
  assert.ok(!again.includes(SURVEY_INTRO), "productfoo never asks again");
  assert.match(again, /first read of your project/);
  assert.match(again, /agreed spec/);
});

test("non-TTY first run keeps today's behavior exactly: opener in the read, no questions", async () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const read = await runInitInteractive(root, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: false, outputTTY: false });
  assert.ok(read.includes("productfoo helps you agree on work"), "opener still renders once for piped first runs");
  assert.ok(!read.includes(SURVEY_INTRO));
  assert.equal(loadProfile(root), null);
});

test("a corrupt profile never breaks the read and explicit flags still win", async () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  mkdirSync(path.dirname(profilePath(root)), { recursive: true });
  writeFileSync(profilePath(root), "not json{{{\n");
  const read = await runInitInteractive(root, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: false, outputTTY: false });
  assert.match(read, /first read of your repo/, "corrupt profile falls back to the plain surface");

  saveProfile({ roles: ["engineer"], answered_at: "2026-07-11T00:00:00.000Z" });
  const pm = await runInitInteractive(root, ["--pm"], { input: new PassThrough(), output: new PassThrough(), inputTTY: false, outputTTY: false });
  assert.match(pm, /first read of your project/, "--pm wins regardless of the profile");
});

// --- schema migration and founder/executive personalization ---------------------

test("a v1 single-role repo profile still counts, and founder/executive get the product view", async () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  // A legacy per-repo profile from before the machine-wide move.
  mkdirSync(path.dirname(profilePath(root)), { recursive: true });
  writeFileSync(profilePath(root), `${JSON.stringify({ role: "product", answered_at: "2026-07-11T00:00:00.000Z" })}\n`);
  assert.deepEqual(loadProfile(root)?.roles, ["product"], "v1 role folds into roles");
  const read = await runInitInteractive(root, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: true, outputTTY: true });
  assert.match(read, /first read of your project/, "v1 profile still personalizes");

  saveProfile({ roles: ["founder"], answered_at: "2026-07-11T00:00:00.000Z" }, { scope: "repo", root });
  const founder = await runInitInteractive(root, [], { input: new PassThrough(), output: new PassThrough(), inputTTY: true, outputTTY: true });
  assert.match(founder, /first read of your project/, "a founder leads with the product view");
});

// --- foo profile (see it, redo it) ----------------------------------------------

test("foo profile shows the read-back, the machine-wide home, and the redo path", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  assert.equal(renderProfileStatus(root), `${PROFILE_NONE}\n`);

  saveProfile({ roles: ["product", "executive"], harness: "cursor", building: "a marketplace", team: "small-team", answered_at: "2026-07-11T00:00:00.000Z" });
  const status = renderProfileStatus(root);
  assert.ok(status.includes("Read: product + executive · Cursor · building a marketplace · a small team."));
  assert.ok(status.includes("follows you across projects"), "the machine-wide home is named");
  assert.ok(status.includes("foo profile redo"));
  for (const word of PM_SURFACE_FORBIDDEN) {
    assert.ok(!status.toLowerCase().includes(word.toLowerCase()), `profile status leaked raw term: ${word}`);
  }
});

test("foo profile names a repo override when one is present", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  saveProfile({ roles: ["designer"], answered_at: "2026-07-11T00:00:00.000Z" }, { scope: "repo", root });
  const status = renderProfileStatus(root);
  assert.ok(status.includes("This repo has its own profile"), "a repo override is called out");
});

test("foo profile redo re-runs the questions and overwrites the machine profile", async () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  saveProfile({ roles: ["engineer"], answered_at: "2026-07-11T00:00:00.000Z" });

  const refused = await runProfileRedo(root, "0.1.0", { input: new PassThrough(), output: new PassThrough(), inputTTY: false, outputTTY: true });
  assert.match(refused, /live terminal/);
  assert.deepEqual(loadProfile(root)?.roles, ["engineer"], "non-TTY redo changes nothing");

  const io = fakeTerminal(["4", "2", "", "1", "n"]);
  await runProfileRedo(root, "0.1.0", { input: io.input, output: io.output, inputTTY: true, outputTTY: true });
  const profile = loadProfile(root);
  assert.deepEqual(profile?.roles, ["founder"]);
  assert.equal(profile?.harness, "cursor");
  assert.equal(profile?.team, "just-me");
  assert.ok(existsSync(machineProfilePath()), "redo writes machine-wide");
});

test("the read-back grammar mirrors the repo read", () => {
  assert.equal(
    renderProfileReadback({ roles: ["designer"], harness: "codex", team: "larger-org", answered_at: "x" }),
    "Read: designer · Codex · a bigger org.",
  );
  assert.equal(renderProfileReadback({ answered_at: "x" }), "");
});

// --- foo profile set: the non-interactive writer for conversational onboarding ---

test("foo profile set records agent-gathered answers machine-wide, lenient parsing, read-back", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const out = runProfileSet(root, "0.1.0", { roles: "1,4", harness: "claude", team: "just me", building: "a pm tool" }, () => "2026-07-12T00:00:00.000Z");
  assert.match(out, /Read: product \+ founder · Claude Code · building a pm tool · just you\./);
  const profile = loadProfile(root);
  assert.ok(existsSync(machineProfilePath()), "set writes machine-wide");
  assert.deepEqual(profile?.roles, ["product", "founder"]);
  assert.equal(profile?.harness, "claude-code");
  assert.equal(profile?.team, "just-me");
  assert.equal(profile?.building, "a pm tool");
});

test("foo profile set --json returns picks only; the free text is never echoed back out", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  const out = runProfileSet(root, "0.1.0", { roles: "product and founder", harness: "cursor", team: "a small team", building: "top secret", json: true }, () => "x");
  const parsed = JSON.parse(out);
  // #622: the plural list rides alongside the legacy single field.
  assert.deepEqual(parsed, { roles: ["product", "founder"], harnesses: ["cursor"], harness: "cursor", team: "small-team" });
  assert.ok(!out.includes("top secret"), "free text stays out of the machine-readable echo");
});

test("foo profile set with nothing to set is a clear error", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  assert.throws(() => runProfileSet(root, "0.1.0", {}), new RegExp(PROFILE_SET_EMPTY.slice(0, 20)));
});

test("foo profile set: free text is written locally but never reported", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  runProfileSet(root, "0.1.0", { roles: "engineer", building: "my secret startup idea" }, () => "x");
  assert.equal(loadProfile(root)?.building, "my secret startup idea", "kept in the local profile");
  if (existsSync(agentLogPath(root))) {
    assert.ok(!readFileSync(agentLogPath(root), "utf8").includes("secret startup"), "free text never reaches the reported event");
  }
});

test("foo profile set (CLI): repeatable --role and lenient values parse end to end", () => {
  freshHome();
  const root = gitRepo(REPO_FILES);
  // bin/foo is the launcher that actually invokes main(); running dist/src/cli.js
  // directly only loads the module. From dist/test/ that is ../../bin/foo.
  const foo = fileURLToPath(new URL("../../bin/foo", import.meta.url));
  const out = execFileSync("node", [foo, "--root", root, "profile", "set", "--role", "1", "--role", "4", "--harness", "claude", "--team", "just me", "--building", "a pm tool"], {
    env: { ...process.env, FOO_STATE_DIR: process.env.FOO_STATE_DIR, DO_NOT_TRACK: "1" },
    encoding: "utf8",
  });
  assert.match(out, /Read: product \+ founder/);
  const profile = loadProfile(root);
  assert.deepEqual(profile?.roles, ["product", "founder"]);
  assert.equal(profile?.harness, "claude-code");
  assert.equal(profile?.team, "just-me");
});

// #622: the harness question is plural, like roles, and the answer is kept whole.
test("parseHarnesses keeps every named agent in order, deduplicated; free text stays one value", () => {
  assert.deepEqual(parseHarnesses("1, 3"), ["claude-code", "codex"]);
  assert.deepEqual(parseHarnesses("cursor + claude, and cursor again"), ["cursor", "claude-code"]);
  assert.deepEqual(parseHarnesses("2 and codex"), ["cursor", "codex"]);
  assert.deepEqual(parseHarnesses("custom-agent"), ["custom-agent"]);
  assert.deepEqual(parseHarnesses("   "), []);
  assert.equal(parseHarness("3, 1"), "codex", "the single form is still the first named");
});

test("profileHarnesses reads the plural field and an older single-harness profile alike", () => {
  assert.deepEqual(profileHarnesses({ harnesses: ["cursor", "claude-code"], harness: "cursor" }), ["cursor", "claude-code"]);
  assert.deepEqual(profileHarnesses({ harness: "claude-code" }), ["claude-code"]);
  assert.deepEqual(profileHarnesses(null), []);
});
