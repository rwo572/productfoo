import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const skill = readFileSync("skills/customer-discovery/SKILL.md", "utf8");

test("customer-discovery teaches the proof-gated provider-neutral runtime sequence", () => {
  assert.match(skill, /description:\s*["']?Use when/i);
  for (const required of [
    "foo discovery plan",
    "foo discovery match",
    "foo source approve",
    "ready_to_synthesize",
    "open transcript",
    "in memory",
    "foo discovery apply",
    "needs_review",
  ]) assert.ok(skill.toLowerCase().includes(required.toLowerCase()), `missing runtime contract: ${required}`);
  assert.ok(skill.indexOf("foo discovery match") < skill.indexOf("ready_to_synthesize"));
  const proofSection = skill.slice(skill.indexOf("### 3."));
  assert.ok(proofSection.indexOf("ready_to_synthesize") < proofSection.toLowerCase().indexOf("open transcript"));
  assert.ok(skill.toLowerCase().lastIndexOf("open transcript") < skill.indexOf("foo discovery apply"));
});

test("customer-discovery keeps private transcripts out of CLI, files, logs, and fallbacks", () => {
  assert.match(skill, /never (?:put|pass|write|send)[^\n]*(?:raw |full )?transcript[^\n]*(?:argv|stdin|file|Git)/i);
  assert.match(skill, /stable[^\n]*(?:non-tokenized|sanitized)[^\n]*(?:link|URL)/i);
  assert.match(skill, /request access to the full transcript/i);
  assert.match(skill, /do not (?:use|fall back to)[^\n]*(?:browser|file ingress|redact-transcripts|study-digest)/i);
  assert.match(skill, /prompt injection|untrusted evidence/i);
});

test("customer-discovery distinguishes planned studies from approved unassigned calls", () => {
  assert.match(skill, /study-linked/i);
  assert.match(skill, /unassigned_call_evidence/);
  assert.match(skill, /never[^\n]*retrospective hypothes/i);
  assert.match(skill, /provider[^\n]*connection[^\n]*time window[^\n]*customer selector/i);
  assert.match(skill, /human[^\n]*(?:promot|complet|attach|dismiss|select)/i);
});

test("Granola is one adapter, not a hard-coded core or a claim of unsupported breadth", () => {
  assert.match(skill, /Granola[^\n]*first provider-adapter contract/i);
  assert.match(skill, /does not establish or own[^\n]*provider connection/i);
  assert.match(skill, /Nango-backed connection[^\n]*separate requirement/i);
  assert.match(skill, /Marvin[^\n]*Dovetail[^\n]*no adapter/i);
  assert.match(skill, /Zoom[^\n]*Gmail[^\n]*Outlook[^\n]*Slack[^\n]*Notion[^\n]*contract-only/i);
  assert.match(skill, /provider-specific[^\n]*adapter/i);
});
