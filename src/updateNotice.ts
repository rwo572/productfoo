// "Your productfoo is out of date" — told by the server, because nothing else can tell you.
//
// The client never auto-updates and never learns the newest release from a
// Git remote. (It once pointed at the private dist repository, whose tags a
// client could not read without git credentials — the historical reference
// survives only in tests and the cutover plan.) The one thing every install
// DOES talk to on every run is the skill server. So the server stamps each
// response with the version it considers current, and the client says so —
// once a day, on stderr.
//
// This exists because a tester sat on a broken 0.1.0 for days and neither he nor
// the owner had any surface that would have said so. Silence was the bug.
//
// Three hard rules, all learned in this codebase:
//   - stderr only. stdout carries --json and piped output; a chatty notice there
//     corrupts a contract someone is parsing.
//   - never fatal. A missing header, an unreadable state file, a read-only home
//     directory — none of it may change what the command was asked to do.
//   - speak only where a human is listening, and spend the day's one line only
//     there. See `interactive` below — this rule is why the notice reached nobody.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readJsonSafe } from "./jsonFile.js";
import { compareVersions, distributionPackageName } from "./channelFreshness.js";
import { harnessMarkerPresent } from "./commandContract.js";

// productfoo's own package root (this file compiles to dist/src/updateNotice.js), so the
// version reported is the one actually RUNNING, whatever directory it runs from.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function clientVersion(): string {
  try {
    const pkg = readJson<{ version?: string }>(path.join(PACKAGE_ROOT, "package.json"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The client tells the server what it is running; the server tells the client
// what is current. Both are metadata — no content, no identity beyond the token
// the request already carries.
export const CLIENT_VERSION_HEADER = "x-foo-client-version";
export const LATEST_VERSION_HEADER = "x-foo-latest-version";

// What a human types. It used to be the raw `npm install -g github:…` string —
// which told them the truth and then made them go do the work: select a long
// line out of a terminal, trust it, paste it. Telling someone they are behind
// and handing them homework is most of the way to telling them nothing. `foo
// update` is one word, and it is the same install underneath (see
// commands/update.ts, which installs the published package pinned to the
// version the server named).
export const UPDATE_COMMAND = "foo update";

// Telling someone they are behind, without telling them what they would get, is
// a nag. The changelog lives on npm's page for the published package — the
// distribution-target contract resolves the name — so this URL resolves for
// exactly the people who can already install it, and it never names the
// retired dist repository.
export const CHANGELOG_URL = `https://www.npmjs.com/package/${distributionPackageName()}`;

// Two regimes, two separate rations, and therefore two separate records. The
// human offer is day-rationed (`last_notified_*`); the agent relay is
// session-rationed (`last_relayed_*`). They MUST NOT share a field: an agent
// relay that wrote the human's version/day would silence the human's own
// interactive offer for the rest of the day, even though nobody at the terminal
// was ever told. (`last_notified_session` is legacy from when the agent regime
// borrowed the human record; kept only so old state files parse.)
type UpdateState = {
  last_notified_day?: string;
  last_notified_version?: string;
  last_notified_session?: string;
  last_relayed_version?: string;
  last_relayed_session?: string;
};

// Who the notice is for. `human` gets the interactive terminal offer; `agent` gets
// a line addressed to the coding agent that ran foo, to relay to its person; `none`
// is a headless pipe productfoo cannot reach, and stays silent.
export type NoticeAudience = "human" | "agent" | "none";

export type UpdateNoticePlan = { notify: boolean; line: string | null; audience?: NoticeAudience };

// Pure decision: given what is running, what is current, what we last said, and
// whether anyone is listening, should we say anything now? Every state is
// unit-testable without a server, a clock, a terminal, or a home directory.
//
// FIRST, is a human even there? This is the bug that made the whole notice
// useless, and it is worth being precise about, because every other rule below
// was already right.
//
// The notice is rationed: one line per build, plus one per day. That ration was
// being spent by whichever process happened to run `foo` first — and in real
// use that is almost never a person. It is a hook, an agent, a pipe, a script:
// runs whose stderr goes into a transcript nobody reads. That run printed the
// line into the void, wrote "told them" to the state file, and every later run
// — including the one where the owner was actually sitting at the terminal —
// read that state and stayed quiet. productfoo was telling the truth, once a day, to
// nobody. The owner sat on 0.1.18 for a day with 0.1.19 published and never saw
// a word, and the state file said she had been told.
//
// So the ration is spent only where it can land: an attended terminal. A
// non-interactive run neither speaks NOR records — it must not consume a line
// on the human's behalf. Not speaking here costs nothing: an agent cannot
// choose to update, and the human it is working for will be told on their next
// real command.
//
// Then two things wake the notice up, and staying quiet requires BOTH to be false:
//
//   1. A NEW BUILD. If the version we last spoke about is not the one that is
//      now current, foo speaks — even if it already spoke today. Being told
//      about 0.1.17 this morning is not being told about 0.1.18 this afternoon,
//      and the old rule ("once a day, whatever changed") silently swallowed the
//      second release of the day. Releases have shipped four-in-an-evening here.
//
//   2. A NEW DAY. If they were told and still have not updated, foo tells them
//      again tomorrow, and every day after, until they do. A tester sat on a
//      broken build for days because nothing ever spoke twice.
//
// It stays quiet only when it has already spoken about THIS build TODAY — so
// the ceiling is one line per new build, plus one per day. Noisier than before,
// deliberately, and still never more than once per run.
export function updateNoticePlan(input: {
  running: string;
  latest: string | null;
  lastNotifiedDay: string | null;
  lastNotifiedVersion?: string | null;
  lastNotifiedSession?: string | null;
  today: string;
  session: string;
  audience: NoticeAudience;
}): UpdateNoticePlan {
  const { running, latest, lastNotifiedDay, lastNotifiedVersion, lastNotifiedSession, today, session, audience } = input;
  // A pipe productfoo cannot reach: stay silent and record nothing, exactly as before.
  if (audience === "none") return { notify: false, line: null };
  if (!latest) return { notify: false, line: null };
  // Numeric compare, not lexical: "0.1.10" sorts BELOW "0.1.6" as a string, and
  // a stale client would be told it was current — the exact bug this prevents.
  // Up to date is the ONE state that is always silent: a nag someone cannot act
  // on is the fastest way to teach them to ignore the channel entirely.
  if (compareVersions(running, latest) >= 0) return { notify: false, line: null };

  const spokeAboutThisBuild = (lastNotifiedVersion ?? null) === latest;

  if (audience === "agent") {
    // The agent case is rationed by SESSION, not day: an agent-only user has no
    // stderr backstop, so a decline must come back the next session (D-002). A
    // new build always speaks; otherwise it speaks once per session.
    const sameSession = (lastNotifiedSession ?? null) === session;
    if (spokeAboutThisBuild && sameSession) return { notify: false, line: null };
    // Addressed to the agent, phrased as an offer it surfaces to its human — not
    // a bare "you're behind" line, which would just move the homework onto the
    // person `foo update` was created to spare (R-003).
    const line =
      `[foo → the human you're working for] A newer productfoo is available (${running} → ${latest}). ` +
      `Ask them whether to run \`foo update\`, and run it only on their yes — never silently. ` +
      `What's new: ${CHANGELOG_URL}`;
    return { notify: true, line, audience: "agent" };
  }

  // audience === "human": the interactive terminal offer, rationed per build per day.
  const spokeToday = lastNotifiedDay === today;
  if (spokeAboutThisBuild && spokeToday) return { notify: false, line: null };
  // Say plainly that they are still behind when this is not the first time —
  // the repeat is the point, and a line that reads identically to yesterday's
  // is a line that gets skimmed.
  const again = spokeAboutThisBuild && !spokeToday;
  const head = again
    ? `foo ${running} → ${latest} is available. You're still on an old build.`
    : `foo ${running} → ${latest} is available.`;
  return {
    notify: true,
    line: `${head} Update: ${UPDATE_COMMAND}\nWhat's new: ${CHANGELOG_URL}`,
    audience: "human",
  };
}

function stateDir(): string {
  return process.env.FOO_STATE_DIR?.trim() || path.join(homedir(), ".foo");
}

function statePath(): string {
  return path.join(stateDir(), "update-check.json");
}

function readState(): UpdateState {
  return readJsonSafe<UpdateState>(statePath(), {});
}

function writeState(state: UpdateState): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(statePath(), `${JSON.stringify(state)}\n`);
  } catch {
    // A home dir we cannot write is not a reason to fail a command. Worst case
    // the notice repeats — annoying, never broken.
  }
}

// The LOCAL calendar day, not the UTC one. "They still have not updated by the
// morning, so tell them again" is a statement about the user's morning. With
// toISOString() the day rolled over at 4-5pm in California — so the "next day"
// reminder fired the same evening, and a real morning could pass in silence.
export function localDay(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Is a person going to see this line? stderr is the surface the notice writes
// to, so stderr is the surface that decides — not stdout, which is routinely
// piped (`foo doctor --json | jq`) by a human who is still sitting right there.
//
// The env override exists because "is anyone watching" is the one thing a
// program cannot be certain of: FOO_UPDATE_NOTICE=always to force the line
// (how this fix was verified — a TTY is hard to fake from a test harness),
// never to silence it for good.
export function noticeAudienceIsHuman(env: NodeJS.ProcessEnv = process.env, stderrIsTty = process.stderr.isTTY): boolean {
  const forced = (env.FOO_UPDATE_NOTICE ?? "").trim().toLowerCase();
  if (forced === "always") return true;
  if (forced === "never") return false;
  return Boolean(stderrIsTty);
}

// Three-way audience for the notice. Human at a TTY → the interactive offer. Not
// a TTY but a harness marker is set (or FOO_HANDOFF=always) → the agent that ran
// productfoo is reading, so relay to it. Not a TTY and no marker → a bare pipe foo
// cannot reach; stay silent (D-003). Reuses the same marker list and the same
// FOO_HANDOFF / FOO_UPDATE_NOTICE overrides as the rest of foo — not a new
// detector, and the strict "positively an agent" check, not handoffEnabled's
// broader "anything that is not a TTY".
export function noticeAudience(env: NodeJS.ProcessEnv = process.env, stderrIsTty = process.stderr.isTTY): NoticeAudience {
  const forced = (env.FOO_UPDATE_NOTICE ?? "").trim().toLowerCase();
  if (forced === "never") return "none";
  if (forced === "always") return "human";
  if (stderrIsTty) return "human";
  if (env.FOO_HANDOFF === "never") return "none";
  if (env.FOO_HANDOFF === "always") return "agent";
  return harnessMarkerPresent(env) ? "agent" : "none";
}

// The unit the agent-relay ration re-arms on. There is no portable "agent session
// id" env across harnesses (OQ-1), so productfoo uses the process that spawned it —
// stable for the life of one agent session, different in the next — with an
// explicit FOO_SESSION_ID override for a harness that can name its session (and
// for tests). Named here, not guessed, per T-002.
export function currentSession(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.FOO_SESSION_ID ?? "").trim();
  return explicit || `ppid:${process.ppid}`;
}

export type PendingUpdate = { running: string; latest: string; line: string; audience: NoticeAudience };

// What the server told us, held until the run is over.
//
// It is not printed the moment we learn it, and that is deliberate. We learn it
// from a response to a request the command was already making — which can land
// anywhere, including halfway through a skill fetch, in the middle of someone's
// work. A LINE there is merely untidy. A QUESTION there ("install it now?") is
// an interruption, and productfoo does not stop mid-task to ask a favour. So the news
// is parked here, and `offerUpdate()` (commands/update.ts) settles it as the
// last thing the run does — the same posture as the error-report ask, for the
// same reason.
let pending: PendingUpdate | null = null;

// Test seam: module state outlives a single in-process main(), and the suite
// calls main() many times.
export function resetPendingUpdate(): void {
  pending = null;
}

export function pendingUpdate(): PendingUpdate | null {
  return pending;
}

// Called with whatever the server said (or didn't) on any response the client
// already makes. Decides, records nothing, prints nothing, and swallows
// everything.
export function noteLatestVersion(latest: string | null | undefined, running: string): void {
  try {
    if (!latest || !running || running === "unknown") return;
    const current = latest.trim() || null;
    const state = readState();
    const audience = noticeAudience();
    // Feed each regime its OWN recorded version so one never rations the other:
    // the agent branch reads `last_relayed_version`, the human branch reads
    // `last_notified_version`.
    const plan = updateNoticePlan({
      running,
      latest: current,
      lastNotifiedDay: state.last_notified_day ?? null,
      lastNotifiedVersion:
        audience === "agent" ? (state.last_relayed_version ?? null) : (state.last_notified_version ?? null),
      lastNotifiedSession: state.last_relayed_session ?? null,
      today: localDay(),
      session: currentSession(),
      audience,
    });
    if (!plan.notify || !plan.line || !current) return;
    pending = { running, latest: current, line: plan.line, audience: plan.audience ?? "human" };
  } catch {
    // Never let the update notice change what the CLI was asked to do.
  }
}

// We spoke about this build today — whether we printed a line or asked a
// question, and whether the answer was yes or no. Recorded WITH the version, not
// just the day: a release that lands an hour after we spoke must still get its
// own line, and this repo has shipped four releases in one evening.
export function recordUpdateSpoken(latest: string): void {
  writeState({ ...readState(), last_notified_day: localDay(), last_notified_version: latest });
}

// The agent relay's own record. Session-rationed, and kept in fields the human
// day-ration never reads, so relaying through an agent never spends the line the
// person at the terminal is owed.
export function recordRelaySpoken(latest: string, session: string = currentSession()): void {
  writeState({ ...readState(), last_relayed_version: latest, last_relayed_session: session });
}

// `headers.get()` on a fetch Response, tolerant of a server that predates this.
export function latestFromResponse(res: { headers: { get(name: string): string | null } }): string | null {
  try {
    return res.headers.get(LATEST_VERSION_HEADER);
  } catch {
    return null;
  }
}
