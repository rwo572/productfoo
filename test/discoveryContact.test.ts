import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDiscoveryFixture } from "./discoveryFixtures.js";
import { stringify as stringifyYaml } from "../src/vendorYaml.js";

// discovery-insight-ties-v0 R-007/R-008: per-scope contact cards — the
// human-corrected identity layered over the call's attribution basis — plus
// local-context-only inference. No web is ever touched.

const FOO_BIN = path.resolve("bin/foo");

function fixture(): { root: string; inbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "foo-discovery-contact-"));
  seedDiscoveryFixture(root);
  const inbox = path.join(root, "discovery", "inbox");
  writeFileSync(path.join(inbox, "scope.yaml"), stringifyYaml({
    schema_version: "0.1",
    scopes: [
      {
        scope_id: "granola_morgan_example_2026_07",
        provider: "granola",
        connection_alias: "primary",
        time_window: { start: "2026-07-15T00:00:00-07:00", end: "2026-07-22T23:59:59-07:00" },
        participant_allowlist: ["Morgan Example"],
        domain_allowlist: [],
        title_tokens: [],
        state: "approved",
        approved_by: "taylor",
        approved_at: "2026-07-22T18:00:00.000Z",
      },
      {
        scope_id: "granola_avery_2026_07",
        provider: "granola",
        connection_alias: "primary",
        time_window: { start: "2026-07-15T00:00:00-07:00", end: "2026-07-22T23:59:59-07:00" },
        participant_allowlist: [],
        domain_allowlist: [],
        title_tokens: ["roundtable"],
        state: "approved",
        approved_by: "taylor",
        approved_at: "2026-07-22T18:00:00.000Z",
      },
    ],
  }));
  writeFileSync(path.join(inbox, "findings.yaml"), stringifyYaml({
    schema_version: "0.1",
    findings: [
      {
        finding_id: "F-024",
        lane: "unassigned_call_evidence",
        inbox_scope_id: "granola_morgan_example_2026_07",
        paraphrase: "Install friction: Morgan Example of Exampleco hit a permission wall on first run and gave up for the day.",
        review_state: "needs_review",
        attached_to: null,
      },
    ],
  }));
  return { root, inbox };
}

function run(root: string, args: string[]) {
  return spawnSync("node", [FOO_BIN, "--root", root, "discovery", "contact", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_NO_AUTOWIRE: "1", FOO_HANDOFF: "never", FOO_STATE_DIR: path.join(root, "state") },
  });
}

test("contact upsert: partial updates accumulate, human confirmation is stamped, ledger records each edit (V-006)", () => {
  const { root, inbox } = fixture();

  const first = run(root, ["granola_morgan_example_2026_07", "--name", "Morgan Example", "--by", "taylor", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstValue = JSON.parse(first.stdout);
  assert.equal(firstValue.status, "ok");
  assert.deepEqual(firstValue.coverage.fields_updated, ["full_name"]);

  const second = run(root, ["granola_morgan_example_2026_07", "--company", "Exampleco", "--linkedin", "https://www.linkedin.com/in/productfoo-fixture-morgan-example", "--by", "taylor", "--json"]);
  assert.equal(second.status, 0, second.stderr);

  const contacts = readFileSync(path.join(inbox, "contacts.yaml"), "utf8");
  assert.match(contacts, /scope_id: granola_morgan_example_2026_07/);
  assert.match(contacts, /full_name: Morgan Example/);
  assert.match(contacts, /company: Exampleco/);
  assert.match(contacts, /linkedin: https:\/\/www\.linkedin\.com\/in\/productfoo-fixture-morgan-example/);
  assert.match(contacts, /confirmed_by: taylor/);
  assert.match(contacts, /confirmed_at:/);

  const events = readFileSync(path.join(inbox, "events.jsonl"), "utf8").split("\n").filter((line) => line.includes("contact_updated")).map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  for (const event of events) assert.deepEqual(event.actor, { type: "human", id: "taylor" });
  assert.deepEqual(events[1].data.fields, ["linkedin", "company"]);

  // The updated file passes discovery validation.
  const validated = spawnSync("node", [FOO_BIN, "--root", root, "discovery", "validate", "--json"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_NO_AUTOWIRE: "1", FOO_HANDOFF: "never", FOO_STATE_DIR: path.join(root, "state") } });
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).status, "ok");
});

test("contact refusals: bad LinkedIn URL, unknown scope, and no fields each name the resume command (V-006)", () => {
  const { root } = fixture();

  const badUrl = run(root, ["granola_morgan_example_2026_07", "--linkedin", "http://linkedin.com/in/marc", "--by", "taylor", "--json"]);
  assert.equal(badUrl.status, 1);
  assert.match(JSON.parse(badUrl.stdout).handoff, /https URL on a linkedin\.com host/);

  const wrongHost = run(root, ["granola_morgan_example_2026_07", "--linkedin", "https://evil.example/marc", "--by", "taylor", "--json"]);
  assert.equal(wrongHost.status, 1);

  const unknown = run(root, ["no_such_scope", "--name", "Nobody", "--by", "taylor", "--json"]);
  assert.equal(unknown.status, 1);
  assert.match(JSON.parse(unknown.stdout).handoff, /Scope no_such_scope was not found/);

  const empty = run(root, ["granola_morgan_example_2026_07", "--by", "taylor", "--json"]);
  assert.equal(empty.status, 1);
  assert.match(JSON.parse(empty.stdout).handoff, /Nothing to update/);
});

test("discovery validate rejects a malformed contacts.yaml (unknown scope, bad linkedin)", () => {
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "contacts.yaml"), stringifyYaml({
    schema_version: "0.1",
    contacts: [
      { scope_id: "not_a_real_scope", full_name: "X", linkedin: "http://linkedin.com/x", company: null, confirmed_by: "taylor", confirmed_at: "2026-07-23T00:00:00.000Z" },
    ],
  }));
  const validated = spawnSync("node", [FOO_BIN, "--root", root, "discovery", "validate", "--json"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_NO_AUTOWIRE: "1", FOO_HANDOFF: "never", FOO_STATE_DIR: path.join(root, "state") } });
  assert.equal(validated.status, 1);
  const value = JSON.parse(validated.stdout);
  assert.equal(value.status, "invalid");
  const messages = value.errors.map((error: { message: string }) => error.message).join("\n");
  assert.match(messages, /scope_id must name a known inbox scope/);
  assert.match(messages, /linkedin must be an https linkedin\.com URL/);
});

test("inference from attribution text: name and company with sources; linkedin honestly missing without web (V-007)", () => {
  const { root } = fixture();
  const inferred = run(root, ["granola_morgan_example_2026_07", "--infer", "--json"]);
  assert.equal(inferred.status, 0, inferred.stderr);
  const value = JSON.parse(inferred.stdout);
  assert.equal(value.status, "ok");
  const candidates = value.coverage.candidates as Array<{ field: string; value: string; inferred: boolean; source: string }>;
  const name = candidates.find((candidate) => candidate.field === "full_name");
  assert.equal(name?.value, "Morgan Example");
  assert.equal(name?.inferred, true);
  assert.match(name!.source, /finding:F-024 paraphrase|scope:participant_allowlist/);
  const company = candidates.find((candidate) => candidate.field === "company");
  assert.equal(company?.value, "Exampleco");
  assert.match(company!.source, /finding:F-024 paraphrase/);
  const missing = value.coverage.missing as Array<{ field: string; reason: string }>;
  assert.ok(missing.some((entry) => entry.field === "linkedin" && /never looks it up on the web/.test(entry.reason)));
  assert.equal(value.coverage.written, false);
  assert.equal(value.coverage.sources, "local_call_context_only");
});

// --- discovery-contact-capture-v0 ------------------------------------------

function runDiscovery(root: string, args: string[], input?: string) {
  return spawnSync("node", [FOO_BIN, "--root", root, "discovery", ...args], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", DO_NOT_TRACK: "1", FOO_NO_AUTOWIRE: "1", FOO_HANDOFF: "never", FOO_STATE_DIR: path.join(root, "state") },
  });
}

test("title is the fourth contact field: round-trips through upsert, validate, and the ledger (V-001)", () => {
  const { root, inbox } = fixture();
  const set = run(root, ["granola_morgan_example_2026_07", "--title", "Technical Co-founder", "--by", "taylor", "--json"]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout).coverage.fields_updated, ["title"]);
  const contacts = readFileSync(path.join(inbox, "contacts.yaml"), "utf8");
  assert.match(contacts, /title: Technical Co-founder/);
  const events = readFileSync(path.join(inbox, "events.jsonl"), "utf8").split("\n").filter((line) => line.includes("contact_updated")).map((line) => JSON.parse(line));
  assert.deepEqual(events[0].data.fields, ["title"]);
  const validated = runDiscovery(root, ["validate", "--json"]);
  assert.equal(validated.status, 0, validated.stderr);

  // Bad shape refused by validation.
  writeFileSync(path.join(inbox, "contacts.yaml"), stringifyYaml({
    schema_version: "0.1",
    contacts: [{ scope_id: "granola_morgan_example_2026_07", full_name: null, linkedin: null, company: null, title: 7, confirmed_by: "taylor", confirmed_at: "2026-07-23T00:00:00.000Z" }],
  }));
  const invalid = runDiscovery(root, ["validate", "--json"]);
  assert.equal(invalid.status, 1);
  assert.match(JSON.stringify(JSON.parse(invalid.stdout).errors), /title must be a string or null/);
});

test("sweep backfills inferred candidates from data already on disk and reruns as a clean no-op (V-005)", () => {
  const { root, inbox } = fixture();
  // A human-confirmed value exists before the sweep; it must survive untouched.
  const confirmed = run(root, ["granola_morgan_example_2026_07", "--name", "Morgan Example", "--by", "taylor", "--json"]);
  assert.equal(confirmed.status, 0, confirmed.stderr);

  const first = runDiscovery(root, ["contact", "--sweep", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstValue = JSON.parse(first.stdout);
  assert.equal(firstValue.status, "ok");
  assert.equal(firstValue.coverage.provider_calls, 0);
  assert.equal(firstValue.coverage.confirmed_fields_touched, 0);
  assert.ok(firstValue.coverage.candidates_added > 0);

  const contacts = readFileSync(path.join(inbox, "contacts.yaml"), "utf8");
  assert.match(contacts, /full_name: Morgan Example/, "confirmed field untouched");
  assert.match(contacts, /confirmed_by: taylor/);
  assert.match(contacts, /candidates:/);
  assert.match(contacts, /value: Exampleco/);
  assert.match(contacts, /inferred: true/);
  assert.match(contacts, /source: finding:F-024 paraphrase/);
  // The scope with only scope-id context also gained its name candidate.
  assert.match(contacts, /scope_id: granola_avery_2026_07/);
  assert.match(contacts, /value: Avery/);

  const validated = runDiscovery(root, ["validate", "--json"]);
  assert.equal(validated.status, 0, validated.stderr);

  // Idempotent: the second sweep adds nothing and writes nothing.
  const second = runDiscovery(root, ["contact", "--sweep", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const secondValue = JSON.parse(second.stdout);
  assert.equal(secondValue.status, "clean_no_op");
  assert.equal(secondValue.coverage.candidates_added, 0);
  assert.deepEqual(secondValue.writes, []);
  assert.equal(readFileSync(path.join(inbox, "contacts.yaml"), "utf8"), contacts);
});

test("inbox match seeds contact-card candidates from provider attendee metadata without persisting any email (V-002/V-003)", () => {
  const { root, inbox } = fixture();
  const session = {
    schema_version: "0.1",
    provider: "granola",
    connection_alias: "primary",
    runtime_handle: "private-meeting-id",
    completed_at: "2026-07-20T16:00:00.000Z",
    completion_state: "completed",
    title: "Morgan Example intro call",
    participants: ["Morgan Example"],
    capabilities: { list_sessions: true, open_transcript: true, stable_link: false, timestamps: true },
    access: "available",
    contact_hints: [
      { field: "company", value: "Exampleco", source: "granola:attendee_email_domain" },
      { field: "title", value: "CEO", source: "granola:attendee" },
    ],
  };
  // Fix the scope window around the session (fixture window covers it already).
  const matched = runDiscovery(root, ["match", "inbox:granola_morgan_example_2026_07", "--sessions-stdin", "--json"], JSON.stringify([session]));
  // No source approval was seeded: the transcript prerequisite blocks (exit 1),
  // but the metadata matched the approved scope, so capture already happened —
  // scope approval is the consent boundary the metadata passed (D-004).
  const value = JSON.parse(matched.stdout);
  assert.equal(value.status, "needs_source_approval");
  assert.equal(value.coverage.contact_candidates_recorded, 3);
  const contacts = readFileSync(path.join(inbox, "contacts.yaml"), "utf8");
  assert.match(contacts, /value: Morgan Example/);
  assert.match(contacts, /value: Exampleco/);
  assert.match(contacts, /value: CEO/);
  assert.match(contacts, /source: granola:attendee_email_domain/);
  assert.doesNotMatch(contacts, /@/, "no email address may persist in the committed card");
  assert.match(contacts, /confirmed_by: null/, "nothing was auto-confirmed");

  // The same match again is candidate-idempotent.
  const again = runDiscovery(root, ["match", "inbox:granola_morgan_example_2026_07", "--sessions-stdin", "--json"], JSON.stringify([session]));
  assert.equal(JSON.parse(again.stdout).coverage.contact_candidates_recorded, 0);

  // Stored candidates surface through --infer beside fresh ones.
  const inferred = run(root, ["granola_morgan_example_2026_07", "--infer", "--json"]);
  const candidates = JSON.parse(inferred.stdout).coverage.candidates as Array<{ field: string; value: string }>;
  assert.ok(candidates.some((candidate) => candidate.field === "title" && candidate.value === "CEO"));

  const validated = runDiscovery(root, ["validate", "--json"]);
  assert.equal(validated.status, 0, validated.stderr);
});

test("discovery validate rejects a candidate carrying an email and a candidate claiming to be confirmed (V-006)", () => {
  const { root, inbox } = fixture();
  writeFileSync(path.join(inbox, "contacts.yaml"), stringifyYaml({
    schema_version: "0.1",
    contacts: [{
      scope_id: "granola_morgan_example_2026_07",
      full_name: null, linkedin: null, company: null, title: null,
      confirmed_by: null, confirmed_at: null,
      candidates: [
        { field: "company", value: "fixture-morgan@exampleco.example", inferred: true, source: "granola:attendee" },
        { field: "full_name", value: "Morgan Example", inferred: false, source: "granola:attendee" },
        { field: "nickname", value: "x", inferred: true, source: "s" },
      ],
    }],
  }));
  const validated = runDiscovery(root, ["validate", "--json"]);
  assert.equal(validated.status, 1);
  const messages = JSON.parse(validated.stdout).errors.map((error: { message: string }) => error.message).join("\n");
  assert.match(messages, /value must not contain an email address or phone number/);
  assert.match(messages, /candidates are always inferred: true/);
  assert.match(messages, /field must be full_name, company, title, or linkedin/);
});

test("inference falls back to scope-id tokens and is honest when context is empty (V-007)", () => {
  const { root } = fixture();
  const inferred = run(root, ["granola_avery_2026_07", "--infer", "--json"]);
  assert.equal(inferred.status, 0, inferred.stderr);
  const value = JSON.parse(inferred.stdout);
  const candidates = value.coverage.candidates as Array<{ field: string; value: string; source: string }>;
  const name = candidates.find((candidate) => candidate.field === "full_name");
  assert.equal(name?.value, "Avery");
  assert.equal(name?.source, "scope:scope_id");
  const missing = value.coverage.missing as Array<{ field: string; reason: string }>;
  assert.ok(missing.some((entry) => entry.field === "linkedin"));
  // Candidates are never written.
  assert.equal(value.coverage.written, false);
});
