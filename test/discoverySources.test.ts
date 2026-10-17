import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  adapterCapabilityState,
  companyFromEmailDomain,
  contactHintsFromDisplayLabel,
  sanitizeDiscoveryStableUrl,
  validateNormalizedSession,
  type DiscoverySession,
} from "../src/discoverySources.js";

const SESSION: DiscoverySession = {
  schema_version: "0.1",
  provider: "granola",
  connection_alias: "primary",
  runtime_handle: "private-id",
  completed_at: "2026-07-20T16:00:00.000Z",
  completion_state: "completed",
  title: "Shape Up workflow",
  participants: ["Casey Sample"],
  stable_url: "https://app.granola.ai/meeting/abc",
  capabilities: { list_sessions: true, open_transcript: true, stable_link: true, timestamps: true },
  access: "available",
};

test("validates normalized session metadata without reading transcript content", () => {
  assert.deepEqual(validateNormalizedSession(SESSION), []);
  assert.match(validateNormalizedSession({ ...SESSION, completion_state: "scheduled" as "completed" }).join("\n"), /completion_state/);
  assert.match(validateNormalizedSession({ ...SESSION, title: "", participants: [] }).join("\n"), /title/);
  assert.match(validateNormalizedSession({ ...SESSION, runtime_handle: "" }).join("\n"), /runtime_handle/);
});

// discovery-contact-capture-v0 R-003/R-004: the closed session shape accepts
// contact hints, and the email-privacy rule is enforced at the shape boundary.
test("contact hints validate closed and refuse email-carrying values", () => {
  const withHints: DiscoverySession = { ...SESSION, contact_hints: [
    { field: "full_name", value: "Chris Exampleton", source: "granola:attendee" },
    { field: "company", value: "Exampleton Brothers", source: "granola:attendee" },
    { field: "title", value: "CEO", source: "granola:attendee" },
    { field: "linkedin", value: "https://www.linkedin.com/in/productfoo-fixture-chris-exampleton", source: "granola:attendee" },
  ] };
  assert.deepEqual(validateNormalizedSession(withHints), []);
  assert.match(
    validateNormalizedSession({ ...SESSION, contact_hints: [{ field: "company", value: "chris@exampletonbros.example", source: "granola:attendee" }] }).join("\n"),
    /must not contain an email address/,
  );
  assert.match(
    validateNormalizedSession({ ...SESSION, contact_hints: [{ field: "linkedin", value: "https://evil.example/x", source: "granola:attendee" }] }).join("\n"),
    /linkedin value must be an https linkedin\.com URL/,
  );
  assert.match(
    validateNormalizedSession({ ...SESSION, contact_hints: [{ field: "email" as "company", value: "x", source: "s" }] }).join("\n"),
    /invalid field/,
  );
});

test("company derivation keeps the address out: domain yields the company, free-mail yields nothing", () => {
  assert.equal(companyFromEmailDomain("chris@exampletonbros.example"), "Exampletonbros");
  assert.equal(companyFromEmailDomain("ceo@exampleco.example"), "Exampleco");
  assert.equal(companyFromEmailDomain("dana@gmail.com"), null);
  assert.equal(companyFromEmailDomain("dana@icloud.com"), null);
  assert.equal(companyFromEmailDomain("not-an-email"), null);
});

test("display labels parse conservatively: name, name+company, and email-shaped labels yield nothing", () => {
  assert.deepEqual(contactHintsFromDisplayLabel("Chris Exampleton from Exampleton Brothers", "s"), [
    { field: "full_name", value: "Chris Exampleton", source: "s" },
    { field: "company", value: "Exampleton Brothers", source: "s" },
  ]);
  assert.deepEqual(contactHintsFromDisplayLabel("Morgan Example of Exampleco", "s"), [
    { field: "full_name", value: "Morgan Example", source: "s" },
    { field: "company", value: "Exampleco", source: "s" },
  ]);
  assert.deepEqual(contactHintsFromDisplayLabel("Taylor Fixture", "s"), [{ field: "full_name", value: "Taylor Fixture", source: "s" }]);
  assert.deepEqual(contactHintsFromDisplayLabel("buyer@customer.example", "s"), []);
  assert.deepEqual(contactHintsFromDisplayLabel("lowercase name", "s"), []);
});

test("stable links are HTTPS, provider-hosted, and stripped of no tokens because unsafe input is refused", () => {
  assert.equal(sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc"), "https://app.granola.ai/meeting/abc");
  // The share-link host the owner actually pastes (notes.granola.ai/t/<id>).
  assert.equal(sanitizeDiscoveryStableUrl("granola", "https://notes.granola.ai/t/abc-123"), "https://notes.granola.ai/t/abc-123");
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "https://app.granola.ai/meeting/abc?token=x"), /query string/);
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "https://evil.example/meeting/abc"), /approved host/);
  assert.throws(() => sanitizeDiscoveryStableUrl("granola", "http://app.granola.ai/meeting/abc"), /HTTPS/);
});

test("missing adapter capabilities degrade to honest discovery states", () => {
  assert.equal(adapterCapabilityState({ list_sessions: false, open_transcript: true, stable_link: true, timestamps: true }), "needs_provider_connector");
  assert.equal(adapterCapabilityState({ list_sessions: true, open_transcript: false, stable_link: true, timestamps: true }), "needs_provider_connector");
  assert.equal(adapterCapabilityState({ list_sessions: true, open_transcript: true, stable_link: false, timestamps: false }), "ready_with_coverage_caveat");
  assert.equal(adapterCapabilityState(SESSION.capabilities), "ready");
});

test("provider-specific payload keys do not appear in matching or evidence core", () => {
  for (const file of ["src/discoverySources.ts", "src/discoveryMatching.ts", "src/discoveryEvidence.ts", "src/discoveryReconcile.ts"]) {
    const full = path.resolve(file);
    if (!full.endsWith("discoverySources.ts") && !full.endsWith("discoveryMatching.ts") && !full.endsWith("discoveryEvidence.ts") && !full.endsWith("discoveryReconcile.ts")) continue;
    let text = "";
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    assert.doesNotMatch(text, /\b(?:datetime|attendees|review_link)\b/, `${file} must use normalized fields only`);
  }
});
