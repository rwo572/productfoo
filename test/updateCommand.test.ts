// `foo update` — the other half of the notice. These lock what it installs, what
// it refuses to install over, and that it never claims to have updated anything
// it didn't.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchLatestVersion, updatePlan, updateCommand } from "../src/commands/update.js";

const behind = { running: "0.1.18", latest: "0.1.19", home: "/home/u/.foo" };

test("it pins the version the server named — bare `npm install -g productfoo` installs whatever npm resolves that second", () => {
  const plan = updatePlan({ ...behind, kind: "global" });
  assert.equal(plan.action, "install");
  assert.match(plan.command ?? "", /productfoo@0\.1\.19$/, "the user was told about 0.1.19; that is the build they must get");
});

// ── It must update the copy that actually RUNS. ──
//
// A machine can have two foos: the global npm one, and the channel one under
// ~/.foo/versions/dist that the PATH shim execs. `npm install -g` moves only the
// first. The owner hit exactly this: a global install of 0.1.20 reported success
// while `foo` — the shim, pointing at the channel — kept running 0.1.18. An
// update command that installs somewhere other than where you run from is worse
// than no update command, because it claims to have worked.

test("a CHANNEL install updates the channel, not the global prefix — `-g` would install past the foo you run", () => {
  const plan = updatePlan({ ...behind, kind: "channel" });
  assert.equal(plan.action, "install");
  assert.deepEqual(plan.argv, [
    "npm",
    "install",
    "--prefix",
    "/home/u/.foo/versions/dist",
    "productfoo@0.1.19",
  ]);
  assert.ok(!plan.argv?.includes("-g"), "-g here would update a copy the user never executes");
});

test("a GLOBAL install updates the global prefix — and never reaches into the channel dir", () => {
  const plan = updatePlan({ ...behind, kind: "global" });
  assert.deepEqual(plan.argv, ["npm", "install", "-g", "productfoo@0.1.19"]);
  assert.ok(!plan.argv?.includes("--prefix"));
});

test("the install target is argv, not a shell string — a home directory with a space is not a bug", () => {
  const plan = updatePlan({ ...behind, kind: "channel", home: "/Users/ada lovelace/.foo" });
  assert.equal(plan.argv?.[3], "/Users/ada lovelace/.foo/versions/dist");
});

test("it REFUSES to npm-install over a repo checkout — that would overwrite the source someone is editing", () => {
  const plan = updatePlan({ ...behind, kind: "repo" });
  assert.equal(plan.action, "repo");
  assert.equal(plan.command, null);
  assert.equal(plan.argv, null);
});

test("a current client installs nothing", () => {
  assert.equal(updatePlan({ running: "0.1.19", latest: "0.1.19", kind: "global" }).action, "current");
});

test("0.1.10 is newer than 0.1.6 — a string compare would 'update' a current client backwards", () => {
  assert.equal(updatePlan({ running: "0.1.10", latest: "0.1.6", kind: "global" }).action, "current");
});

test("offline is 'could not check', never 'you are current' — the reassuring lie is the one that strands people", () => {
  const plan = updatePlan({ running: "0.1.18", latest: null, kind: "global" });
  assert.equal(plan.action, "unreachable");
});

// ── The command around the decision. ──

test("it says exactly what it will run, then runs exactly that", async () => {
  let ran: string[] = [];
  const result = await updateCommand([], {
    running: "0.1.18",
    kind: "global",
    latest: async () => "0.1.19",
    install: (argv) => {
      ran = argv;
      return { status: 0 };
    },
    isTTY: false,
  });
  assert.deepEqual(ran, ["npm", "install", "-g", "productfoo@0.1.19"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /0\.1\.19 is installed/);
});

test("--check never mutates the machine — it is what a script or an agent runs", async () => {
  let installed = false;
  const result = await updateCommand(["--check"], {
    running: "0.1.18",
    kind: "global",
    latest: async () => "0.1.19",
    install: () => {
      installed = true;
      return { status: 0 };
    },
    isTTY: false,
  });
  assert.equal(installed, false, "--check must be safe to run anywhere, including unattended");
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /0\.1\.18 → 0\.1\.19/);
});

test("a failed install says you are STILL on the old build — never 'updated' when nothing was", async () => {
  const result = await updateCommand([], {
    running: "0.1.18",
    kind: "global",
    latest: async () => "0.1.19",
    install: () => ({ status: 1 }),
    isTTY: false,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /still on foo 0\.1\.18/);
});

test("unreachable exits nonzero and blames nothing — the install is unchanged", async () => {
  const result = await updateCommand([], {
    running: "0.1.18",
    kind: "global",
    latest: async () => null,
    install: () => ({ status: 0 }),
    isTTY: false,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /valid latest version from npm/);
  assert.match(result.output, /install is unchanged/);
});

test("--json carries the machine answer and no glyphs", async () => {
  const result = await updateCommand(["--json"], {
    running: "0.1.18",
    kind: "global",
    latest: async () => "0.1.19",
    isTTY: true,
  });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.state, "install");
  assert.equal(parsed.running, "0.1.18");
  assert.equal(parsed.latest, "0.1.19");
  assert.doesNotMatch(result.output, /[✅🚧]/, "glyphs are human-surface only — never in --json");
});

// ── The offer: one keystroke instead of one command. ──
//
// Same two rules as the error-report ask, pulling opposite ways: never interrupt
// the work (so it happens at the END of a run, not when the server mentions the
// build mid-fetch), and never hang (so it asks only when a human is on BOTH ends
// of the terminal). The answer defaults to no — silence is not consent to write
// to an npm prefix.

import { noteLatestVersion, resetPendingUpdate, pendingUpdate } from "../src/updateNotice.js";
import { offerUpdate } from "../src/commands/update.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

// A fake terminal made of REAL streams — readline needs to actually read and write,
// and a hand-rolled duck type passes the tests for the wrong reason (an unreadable
// stdin makes readline throw, which looks exactly like a declined prompt).
const fakeStderr = () => {
  const written: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb(); } }) as unknown as NodeJS.WriteStream;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  return { stream, text: () => written.join('') };
};
const answering = (reply: string) => {
  const stream = Readable.from([`${reply}\n`]) as unknown as NodeJS.ReadStream;
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  return stream;
};

const freshState = () => {
  process.env.FOO_STATE_DIR = mkdtempSync(path.join(tmpdir(), "foo-offer-"));
  process.env.FOO_UPDATE_NOTICE = "always"; // there is no real TTY in a test runner
  resetPendingUpdate();
};

test("y installs — the whole point: one keystroke, not a command to go type", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  assert.ok(pendingUpdate(), "the run learned about a new build");

  let ran: string[] | null = null;
  const err = fakeStderr();
  await offerUpdate({
    stdin: answering("y"),
    stderr: err.stream,
    kind: "global",
    install: (argv) => { ran = argv; return { status: 0 }; },
  });
  assert.deepEqual(ran, ["npm", "install", "-g", "productfoo@0.1.22"]);
  assert.match(err.text(), /Install it now\? \[y\/N\]/);
  assert.match(err.text(), /0\.1\.22 is installed/);
});

test("the ask says what the yes DOES — you must see the command before you authorize it", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  const err = fakeStderr();
  await offerUpdate({ stdin: answering("n"), stderr: err.stream, kind: "global", install: () => ({ status: 0 }) });
  assert.match(err.text(), /Installing runs: npm install -g productfoo@0\.1\.22/);
});

test("N is a real no — nothing is installed, and it does not ask again about this build today", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  let installed = false;
  const err = fakeStderr();
  await offerUpdate({
    stdin: answering("n"),
    stderr: err.stream,
    kind: "global",
    install: () => { installed = true; return { status: 0 }; },
  });
  assert.equal(installed, false);
  assert.match(err.text(), /Not installing/);

  // Same build, same day: the state file now says we spoke, so nothing is pending.
  resetPendingUpdate();
  noteLatestVersion("0.1.22", "0.1.21");
  assert.equal(pendingUpdate(), null, "a no must not become a nag on the very next command");
});

test("silence is not consent — a bare Enter declines", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  let installed = false;
  await offerUpdate({
    stdin: answering(""),
    stderr: fakeStderr().stream,
    kind: "global",
    install: () => { installed = true; return { status: 0 }; },
  });
  assert.equal(installed, false);
});

test("a pipeline is never blocked by a question nobody can answer — it prints the line and leaves", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  let installed = false;
  const written: string[] = [];
  await offerUpdate({
    // stdin is NOT a tty: an agent, a hook, a pipe. Asking here is a deadlock.
    stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
    stderr: { isTTY: true, write: (s: string) => { written.push(s); return true; } } as unknown as NodeJS.WriteStream,
    kind: "global",
    install: () => { installed = true; return { status: 0 }; },
  });
  assert.equal(installed, false, "productfoo must never install without a human saying yes");
  assert.match(written.join(""), /0\.1\.22 is available/);
  assert.doesNotMatch(written.join(""), /\[y\/N\]/, "a prompt with nobody there is a deadlock, not a question");
});

test("--json is machine output — a machine cannot answer a prompt", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  const err = fakeStderr();
  await offerUpdate({ stdin: answering("y"), stderr: err.stream, args: ["--json"], kind: "global", install: () => ({ status: 0 }) });
  assert.doesNotMatch(err.text(), /\[y\/N\]/);
});

test("a repo checkout is never offered an install over itself", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  let installed = false;
  const err = fakeStderr();
  await offerUpdate({
    stdin: answering("y"),
    stderr: err.stream,
    kind: "repo",
    install: () => { installed = true; return { status: 0 }; },
  });
  assert.equal(installed, false);
  assert.doesNotMatch(err.text(), /\[y\/N\]/);
});

test("a failed install never claims success — you are still on the old build", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  const err = fakeStderr();
  await offerUpdate({ stdin: answering("y"), stderr: err.stream, kind: "global", install: () => ({ status: 1 }) });
  assert.match(err.text(), /still on foo 0\.1\.21/);
});

// ── The agent relay: an agent-invoked run tells its human, through the agent. ──

const freshAgentState = () => {
  process.env.FOO_STATE_DIR = mkdtempSync(path.join(tmpdir(), "foo-relay-"));
  delete process.env.FOO_UPDATE_NOTICE; // not "always" — we want the real agent path, not the forced-human one
  delete process.env.FOO_HANDOFF;
  process.env.CLAUDECODE = "1"; // a harness marker — productfoo can positively see an agent (no TTY in the runner)
  process.env.FOO_SESSION_ID = "sess-A";
  resetPendingUpdate();
};

test("an agent-invoked run relays the offer — the subprocess case that used to tell nobody", async () => {
  freshAgentState();
  noteLatestVersion("0.1.24", "0.1.23");
  assert.ok(pendingUpdate(), "an agent run learns about the new build too");
  const err = fakeStderr();
  await offerUpdate({ stderr: err.stream, args: [], kind: "global" });
  assert.match(err.text(), /A newer productfoo is available/);
  assert.match(err.text(), /foo update/);
});

test("the relay never lands under --json — and a suppressed --json run does not spend the session's relay", async () => {
  freshAgentState();
  noteLatestVersion("0.1.24", "0.1.23");
  const err = fakeStderr();
  await offerUpdate({ stderr: err.stream, args: ["--json"], kind: "global" });
  assert.equal(err.text(), "", "no relay line under --json");
  // Suppressed, so NOT recorded: a later non-json run this session still gets to relay.
  resetPendingUpdate();
  noteLatestVersion("0.1.24", "0.1.23");
  assert.ok(pendingUpdate(), "a --json run must not spend the session's one relay");
});

test("an agent relay must NOT spend the human's day ration — a person who also runs foo by hand still gets their offer", async () => {
  // One machine, one state file, one day: an agent run relays first, then the
  // same person opens a terminal and runs foo by hand. The relay is
  // session-rationed; the interactive offer is day-rationed; they share nothing,
  // so the terminal offer must still fire (R-001: the human path is unchanged).
  const stateDir = mkdtempSync(path.join(tmpdir(), "foo-mixed-"));

  // The agent run: harness marker, no TTY, no force.
  process.env.FOO_STATE_DIR = stateDir;
  delete process.env.FOO_UPDATE_NOTICE;
  delete process.env.FOO_HANDOFF;
  process.env.CLAUDECODE = "1";
  process.env.FOO_SESSION_ID = "sess-A";
  resetPendingUpdate();
  noteLatestVersion("0.1.24", "0.1.23");
  assert.ok(pendingUpdate(), "the agent run learned about the build");
  await offerUpdate({ stderr: fakeStderr().stream, args: [], kind: "global" });

  // The human run, same machine, same day, same build: forced-human audience.
  delete process.env.CLAUDECODE;
  delete process.env.FOO_SESSION_ID;
  process.env.FOO_UPDATE_NOTICE = "always";
  resetPendingUpdate();
  noteLatestVersion("0.1.24", "0.1.23");
  assert.ok(pendingUpdate(), "the agent relay must not have consumed the human's interactive offer");
});

// ── C-009: an old client's update notice names the published package, never the dist repo. ──
//
// The 0.1.18 alpha installs are the proof audience: they cannot read the source, only
// their own stderr. Whatever they see must name the npm package and must not name the
// retired channel. The name is read through the one contract (distributionPackageName()),
// not hardcoded — so these assertions hold through the successor-package rename too.
import { distributionPackageName } from "../src/channelFreshness.js";

test("the update notice names the published package and never the retired dist repo (C-009)", async () => {
  freshState();
  noteLatestVersion("0.1.22", "0.1.21");
  const err = fakeStderr();
  await offerUpdate({ stdin: answering("n"), stderr: err.stream, kind: "global", install: () => ({ status: 0 }) });
  const text = err.text();
  assert.ok(text.length > 0, "an old client must see a notice at all");
  assert.ok(
    text.includes(distributionPackageName()),
    "the notice must name the published package the old client can install",
  );
  assert.ok(!text.includes("github:rwo572/foo-dist"), "the retired dist repository must never appear in a notice");
});

test("the notice's install spec is package@version — Git's #v syntax is gone from the surface (C-009)", () => {
  const plan = updatePlan({ ...behind, kind: "channel" });
  const spec = plan.argv?.[4] ?? "";
  assert.ok(spec.startsWith(`${distributionPackageName()}@`), `install spec must be <package>@<version>, got: ${spec}`);
  assert.ok(!spec.includes("#"), "the #v pin syntax belonged to the retired Git channel");
  assert.ok(!spec.includes("github:"), "no git spec may survive in the install surface");
});

test("a bare pipe with no harness marker stays silent — productfoo cannot see an agent there", () => {
  process.env.FOO_STATE_DIR = mkdtempSync(path.join(tmpdir(), "foo-relay-"));
  delete process.env.FOO_UPDATE_NOTICE;
  delete process.env.FOO_HANDOFF;
  delete process.env.CLAUDECODE;
  resetPendingUpdate();
  noteLatestVersion("0.1.24", "0.1.23");
  assert.equal(pendingUpdate(), null, "a headless pipe parks nothing");
});


test("latest lookup uses npm package metadata, without productfoo client headers", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 });
  };
  try {
    assert.equal(await fetchLatestVersion("https://registry.example"), "1.0.0");
    assert.equal(calls[0].url, "https://registry.example/productfoo/latest");
    assert.equal(new Headers(calls[0].init?.headers).has("x-foo-client-version"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("npm lookup refuses failed, malformed and prerelease metadata", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, version] of [[404, "1.0.0"], [200, "1.0.0-beta.1"], [200, "01.0.0"], [200, "staging"], [200, "1.0.0 --registry=elsewhere"], [200, null]] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ version }), { status });
      assert.equal(await fetchLatestVersion("https://registry.example"), null);
    }
    globalThis.fetch = async () => { throw new Error("offline fixture"); };
    assert.equal(await fetchLatestVersion("https://registry.example"), null);
  } finally { globalThis.fetch = originalFetch; }
});

test("an invalid latest version never reaches an npm install plan", () => {
  for (const latest of ["1.0.0-beta.1", "1.0.0 --registry=elsewhere", "staging", "01.0.0"]) {
    const plan = updatePlan({ running: "0.1.37", latest, kind: "global" });
    assert.equal(plan.action, "unreachable");
    assert.equal(plan.argv, null);
  }
});


test("update lookup uses the same npmrc registry as installation", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "foo-npm-registry-"));
  const originalFetch = globalThis.fetch;
  const config = path.join(home, "user.npmrc");
  writeFileSync(path.join(home, ".npmrc"), "registry=https://project.fixture.invalid/\n");
  const priorCwd = process.cwd();
  writeFileSync(config, "registry=https://registry.fixture.invalid/\n");
  let requested = "";
  globalThis.fetch = async (input) => { requested = String(input); return new Response(JSON.stringify({ version: "1.0.0" })); };
  try {
    process.chdir(home);
    const env = { ...process.env, npm_config_userconfig: config, npm_config_globalconfig: path.join(home, "global.npmrc"), npm_config_registry: undefined, NPM_CONFIG_REGISTRY: undefined };
    const result = await updateCommand(["--check", "--json"], { running: "0.1.37", kind: "global", env });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(JSON.parse(result.output).latest, "1.0.0");
    assert.equal(requested, "https://registry.fixture.invalid/productfoo/latest");
  } finally { process.chdir(priorCwd); globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); }
});
