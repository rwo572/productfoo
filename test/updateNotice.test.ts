// The server tells the client it is out of date, because nothing else can.
// These lock the decision: when we speak, when we stay quiet, and that we never
// lie about being current.
import test from "node:test";
import assert from "node:assert/strict";
import { updateNoticePlan, noticeAudienceIsHuman, noticeAudience, currentSession, UPDATE_COMMAND, CHANGELOG_URL, localDay } from "../src/updateNotice.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── The bug: the notice spent its one line on a run nobody was reading. ──
//
// It was rationed to one line per build per day, and the ration was claimed by
// whichever process ran `foo` first — a hook, an agent, a pipe. That run wrote
// "told them" to the state file, and the human's next real command read it and
// said nothing. The owner sat a day behind with the state file insisting she
// had been informed. These tests exist so that can never be true again.

test("a piped/agent/hook run says NOTHING — a line printed where no one is reading is a line thrown away", () => {
  const plan = updateNoticePlan({
    running: "0.1.18",
    latest: "0.1.19",
    lastNotifiedDay: null,
    lastNotifiedVersion: null,
    today: "2026-07-14",
    audience: "none", session: "s1",
  });
  assert.equal(plan.notify, false, "no human is at stderr; speaking here reaches nobody");
  assert.equal(plan.line, null);
});

test("and it must not SPEND the day's line either — this is the whole defect", () => {
  // The caller only records having spoken when it actually speaks. So a
  // non-interactive run that returns notify:false leaves the state untouched,
  // and the human's next real command is still owed its notice. Prove the
  // sequence: an agent runs, then the person types `foo` — they get told.
  const agentRun = updateNoticePlan({
    running: "0.1.18",
    latest: "0.1.19",
    lastNotifiedDay: null,
    lastNotifiedVersion: null,
    today: "2026-07-14",
    audience: "none", session: "s1",
  });
  assert.equal(agentRun.notify, false);

  // State is unchanged, because nothing was said. The human arrives:
  const humanRun = updateNoticePlan({
    running: "0.1.18",
    latest: "0.1.19",
    lastNotifiedDay: null,
    lastNotifiedVersion: null,
    today: "2026-07-14",
    audience: "human", session: "s1",
  });
  assert.equal(humanRun.notify, true, "the agent run must not have consumed the human's notice");
  assert.match(humanRun.line ?? "", /0\.1\.19 is available/);
});

test("stderr decides, not stdout — `foo doctor --json | jq` still has a human sitting right there", () => {
  assert.equal(noticeAudienceIsHuman({}, true), true);
  assert.equal(noticeAudienceIsHuman({}, false), false);
});

test("the audience can be forced either way — 'is anyone watching' is the one thing a program cannot know", () => {
  assert.equal(noticeAudienceIsHuman({ FOO_UPDATE_NOTICE: "always" }, false), true);
  assert.equal(noticeAudienceIsHuman({ FOO_UPDATE_NOTICE: "never" }, true), false);
});

test("the notice hands over a command, not homework — one word, not an npm string to paste", () => {
  const plan = updateNoticePlan({
    running: "0.1.18",
    latest: "0.1.19",
    lastNotifiedDay: null,
    today: "2026-07-14",
    audience: "human", session: "s1",
  });
  assert.equal(UPDATE_COMMAND, "foo update");
  assert.match(plan.line ?? "", /foo update/);
  assert.doesNotMatch(plan.line ?? "", /npm install/, "being told you are behind and handed a paste is most of the way to being told nothing");
});

// ── Every new build speaks; every new day speaks again until they update. ──

test("a NEW build speaks the same day — being told about 0.1.17 is not being told about 0.1.18", () => {
  // Already spoke today, about 0.1.17. Then 0.1.18 ships an hour later.
  const plan = updateNoticePlan({
    running: "0.1.10",
    latest: "0.1.18",
    lastNotifiedDay: "2026-07-13",
    lastNotifiedVersion: "0.1.17",
    today: "2026-07-13",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, true, "a release that lands after we spoke must not wait until tomorrow");
  assert.match(plan.line ?? "", /0\.1\.18 is available/);
});

test("the SAME build, the same day, stays quiet — the ceiling is one line per build per day", () => {
  const plan = updateNoticePlan({
    running: "0.1.10",
    latest: "0.1.18",
    lastNotifiedDay: "2026-07-13",
    lastNotifiedVersion: "0.1.18",
    today: "2026-07-13",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, false);
});

test("still not updated in the morning: it speaks again, and says they are STILL behind", () => {
  const plan = updateNoticePlan({
    running: "0.1.10",
    latest: "0.1.18",
    lastNotifiedDay: "2026-07-13",
    lastNotifiedVersion: "0.1.18",
    today: "2026-07-14",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, true);
  assert.match(plan.line ?? "", /still on an old build/, "a repeat that reads identically to yesterday gets skimmed");
});

test("it keeps speaking every day until they actually update — silence is what stranded a tester", () => {
  for (const day of ["2026-07-14", "2026-07-15", "2026-07-16", "2026-07-20"]) {
    const plan = updateNoticePlan({
      running: "0.1.10",
      latest: "0.1.18",
      lastNotifiedDay: "2026-07-13",
      lastNotifiedVersion: "0.1.18",
      today: day,
    audience: "human", session: "s1",
  });
    assert.equal(plan.notify, true, `still behind on ${day} — productfoo must still say so`);
  }
});

test("once they update, it goes silent forever — a nag you cannot act on teaches you to ignore the channel", () => {
  const plan = updateNoticePlan({
    running: "0.1.18",
    latest: "0.1.18",
    lastNotifiedDay: "2026-07-13",
    lastNotifiedVersion: "0.1.18",
    today: "2026-07-20",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, false);
  assert.equal(plan.line, null);
});

test("the day boundary is the user's LOCAL midnight, not UTC — 'in the morning' is a local claim", () => {
  // 11pm Pacific on 2026-07-13 is already 2026-07-14 in UTC. The user has not
  // reached their morning yet, so the day must still read as the 13th.
  const latePacificEvening = new Date(2026, 6, 13, 23, 30, 0);
  assert.equal(localDay(latePacificEvening), "2026-07-13");
  // And a genuine local morning is a new day.
  assert.equal(localDay(new Date(2026, 6, 14, 8, 0, 0)), "2026-07-14");
});

test("a client that never heard of the version field is told once, not silently skipped", () => {
  // State written by an older client: a day, but no version. It must not read as
  // "already spoke about this build".
  const plan = updateNoticePlan({
    running: "0.1.10",
    latest: "0.1.18",
    lastNotifiedDay: "2026-07-13",
    lastNotifiedVersion: null,
    today: "2026-07-13",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, true);
});

test("a stale client is told, once, with the command it should run", () => {
  const plan = updateNoticePlan({ running: "0.1.0", latest: "0.1.11", lastNotifiedDay: null, today: "2026-07-12", audience: "human", session: "s1" });
  assert.equal(plan.notify, true);
  assert.match(plan.line ?? "", /0\.1\.0/);
  assert.match(plan.line ?? "", /0\.1\.11 is available/);
  assert.match(plan.line ?? "", new RegExp(escape(UPDATE_COMMAND)));
});

test("being told you are behind, without being told what you'd get, is a nag — point at the changelog", () => {
  const plan = updateNoticePlan({ running: "0.1.0", latest: "0.1.11", lastNotifiedDay: null, today: "2026-07-12", audience: "human", session: "s1" });
  assert.match(plan.line ?? "", new RegExp(escape(CHANGELOG_URL)));
  assert.match(plan.line ?? "", /What's new:/);
});

test("a current client is pointed nowhere — no notice means no changelog nag either", () => {
  const plan = updateNoticePlan({ running: "0.1.11", latest: "0.1.11", lastNotifiedDay: null, today: "2026-07-12", audience: "human", session: "s1" });
  assert.equal(plan.notify, false);
  assert.equal(plan.line, null);
});

test("having spoken today about THIS build, it stays quiet — the notice must not ride every command", () => {
  // Quiet now requires both: same build AND same day. Naming the build is what
  // lets a release that lands later today still speak (see the new-build test).
  const plan = updateNoticePlan({
    running: "0.1.0",
    latest: "0.1.11",
    lastNotifiedDay: "2026-07-12",
    lastNotifiedVersion: "0.1.11",
    today: "2026-07-12",
    audience: "human", session: "s1",
  });
  assert.equal(plan.notify, false);
});

test("a new day earns one more line — days of staleness must be impossible to miss", () => {
  const plan = updateNoticePlan({ running: "0.1.0", latest: "0.1.11", lastNotifiedDay: "2026-07-11", today: "2026-07-12", audience: "human", session: "s1" });
  assert.equal(plan.notify, true);
});

test("a current client is never nagged", () => {
  assert.equal(updateNoticePlan({ running: "0.1.11", latest: "0.1.11", lastNotifiedDay: null, today: "d", audience: "human", session: "s1" }).notify, false);
});

test("a dev build ahead of the release is not 'stale'", () => {
  assert.equal(updateNoticePlan({ running: "0.1.12", latest: "0.1.11", lastNotifiedDay: null, today: "d", audience: "human", session: "s1" }).notify, false);
});

test("0.1.10 is NEWER than 0.1.6 — a string compare would nag every current client forever", () => {
  // The trap: "0.1.10" < "0.1.6" lexically. Get this wrong and the notice fires
  // on an up-to-date install, every day, and everyone learns to ignore it.
  assert.equal(updateNoticePlan({ running: "0.1.10", latest: "0.1.6", lastNotifiedDay: null, today: "d", audience: "human", session: "s1" }).notify, false);
  assert.equal(updateNoticePlan({ running: "0.1.6", latest: "0.1.10", lastNotifiedDay: null, today: "d", audience: "human", session: "s1" }).notify, true);
});

test("a server that says nothing changes nothing — old servers stay silent, not wrong", () => {
  assert.equal(updateNoticePlan({ running: "0.1.0", latest: null, lastNotifiedDay: null, today: "d", audience: "human", session: "s1" }).notify, false);
});

// ── The agent-relay case: a human who only ever drives foo through an agent. ──
//
// The offer used to fire only at a TTY, so a subprocess `foo research` — no TTY —
// told nobody, however much foo the agent triggered. The relay is a third audience:
// addressed to the agent, so it can surface the offer to its person.

test("audience is agent only when productfoo can POSITIVELY see one — a bare pipe stays silent", () => {
  assert.equal(noticeAudience({}, true), "human");                       // a real terminal
  assert.equal(noticeAudience({ CLAUDECODE: "1" }, false), "agent");     // harness marker, no TTY
  assert.equal(noticeAudience({ CURSOR_AGENT: "1" }, false), "agent");
  assert.equal(noticeAudience({ FOO_HANDOFF: "always" }, false), "agent"); // forced
  assert.equal(noticeAudience({}, false), "none");                       // bare pipe — the D-003 fallback
  assert.equal(noticeAudience({ CLAUDECODE: "1", FOO_UPDATE_NOTICE: "never" }, false), "none"); // never wins
});

test("the agent relay re-arms next SESSION, not next day — a decline comes back (D-002)", () => {
  const base = { running: "0.1.23", latest: "0.1.24", lastNotifiedDay: "d", today: "d", audience: "agent" as const };
  // First time on this build+session: relay.
  assert.equal(updateNoticePlan({ ...base, lastNotifiedVersion: null, lastNotifiedSession: null, session: "s1" }).notify, true);
  // Same build, same session, already spoke: silent.
  assert.equal(updateNoticePlan({ ...base, lastNotifiedVersion: "0.1.24", lastNotifiedSession: "s1", session: "s1" }).notify, false);
  // Same build, NEW session: relay again — this is the decline coming back.
  assert.equal(updateNoticePlan({ ...base, lastNotifiedVersion: "0.1.24", lastNotifiedSession: "s1", session: "s2" }).notify, true);
  // A NEW build always relays, whatever the session.
  assert.equal(updateNoticePlan({ ...base, latest: "0.1.25", lastNotifiedVersion: "0.1.24", lastNotifiedSession: "s2", session: "s2" }).notify, true);
});

test("the relay is an offer the agent surfaces, not a 'you're behind' line — it names foo update", () => {
  const plan = updateNoticePlan({ running: "0.1.23", latest: "0.1.24", lastNotifiedDay: null, lastNotifiedVersion: null, lastNotifiedSession: null, today: "d", session: "s1", audience: "agent" });
  assert.equal(plan.audience, "agent");
  assert.match(plan.line ?? "", /foo update/);
  assert.match(plan.line ?? "", /human|ask them/i);
  assert.match(plan.line ?? "", /0\.1\.23 → 0\.1\.24/);
});

test("a headless run neither speaks nor spends the ration — audience 'none' is silent", () => {
  assert.equal(updateNoticePlan({ running: "0.1.23", latest: "0.1.24", lastNotifiedDay: null, lastNotifiedVersion: null, lastNotifiedSession: null, today: "d", session: "s1", audience: "none" }).notify, false);
});

test("the session unit is named: an explicit FOO_SESSION_ID wins, else the spawning process", () => {
  assert.equal(currentSession({ FOO_SESSION_ID: "abc" }), "abc");
  assert.match(currentSession({}), /^ppid:\d+$/);
});
