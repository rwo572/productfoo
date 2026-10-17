import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deriveCountTokensUrl, describeActiveModel, loadModelRoster, resolveActiveModel } from "../src/activeModel.js";
import { estimateLoopBudget, loadPricing, measureSourcesCounted } from "../src/loopBudget.js";

const FOO_BIN = path.resolve("bin/foo");

// Pre-measured sources so the estimator does no file I/O — isolates the pricing path.
const MEASURED = { total: 100_000, measured: [{ source: "x", found: true, tokens: 100_000 }], method: "structural" as const };

// --- resolveActiveModel: the single source (R-001 / D-003) -----------------

test("native Claude Code resolves to confirmed Anthropic defaults", () => {
  const m = resolveActiveModel({ CLAUDECODE: "1" });
  assert.equal(m.provider, "anthropic");
  assert.equal(m.family, "claude");
  assert.equal(m.worker, "claude-opus-4-8");
  assert.equal(m.verifier, "claude-haiku-4-5");
  assert.equal(m.confidence, "confirmed");
  assert.equal(m.routed, false);
  assert.equal(m.countTokensUrl, "https://api.anthropic.com/v1/messages/count_tokens");
});

test("an explicit native Anthropic base URL is still native, not routed", () => {
  const m = resolveActiveModel({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  assert.equal(m.routed, false);
  assert.equal(m.family, "claude");
});

test("Claude Code routed to z.ai resolves to GLM, priced as glm-5.2, confidence assumed", () => {
  const m = resolveActiveModel({
    CLAUDECODE: "1",
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "redacted",
  });
  assert.equal(m.provider, "z.ai");
  assert.equal(m.family, "glm");
  assert.equal(m.worker, "glm-5.2");
  assert.equal(m.verifier, "glm-5.2");
  assert.equal(m.confidence, "assumed"); // inferred from base URL — never claimed as confirmed
  assert.equal(m.routed, true);
  // R-003: count_tokens follows the active base URL, not api.anthropic.com.
  assert.equal(m.countTokensUrl, "https://api.z.ai/api/anthropic/v1/messages/count_tokens");
});

test("an OpenAI-compatible Fireworks route with a GLM model id resolves to glm", () => {
  const m = resolveActiveModel({ OPENAI_BASE_URL: "https://api.fireworks.ai/inference/v1", OPENAI_MODEL: "accounts/fireworks/models/glm-5p2" });
  assert.equal(m.provider, "fireworks");
  assert.equal(m.family, "glm");
  assert.equal(m.worker, "glm-5.2");
  assert.equal(m.confidence, "assumed");
});

test("an explicit FOO_MODEL wins over inference and is confirmed (R-001 precedence)", () => {
  const m = resolveActiveModel({
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    FOO_MODEL: "glm-5.2",
  });
  assert.equal(m.confidence, "confirmed"); // explicit declaration beats base-URL inference
  assert.equal(m.worker, "glm-5.2");
  assert.equal(m.source, "FOO_MODEL");
});

test("a routed but unrecognized provider is family unknown, still resolves (never blocks)", () => {
  const m = resolveActiveModel({ ANTHROPIC_BASE_URL: "https://proxy.example.com/v1" });
  assert.equal(m.routed, true);
  assert.equal(m.provider, "proxy.example.com");
  assert.equal(m.family, "unknown");
  assert.equal(m.confidence, "assumed");
});

test("deriveCountTokensUrl mirrors the Anthropic path under any base", () => {
  assert.equal(deriveCountTokensUrl("https://api.z.ai/api/anthropic"), "https://api.z.ai/api/anthropic/v1/messages/count_tokens");
  assert.equal(deriveCountTokensUrl("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages/count_tokens");
});

// --- describeActiveModel: human provenance line ----------------------------

test("describeActiveModel returns null for the native default (no signal)", () => {
  assert.equal(describeActiveModel(resolveActiveModel({ CLAUDECODE: "1" })), null);
});

test("describeActiveModel flags an unconfirmed routed model", () => {
  const note = describeActiveModel(resolveActiveModel({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }));
  assert.match(note ?? "", /z\.ai/);
  assert.match(note ?? "", /unconfirmed/);
});

// --- R-002: an unpinned estimate prices the resolved active model -----------

test("a GLM-backed loop (no pinned mix) is priced at glm-5.2 rates, not Opus", () => {
  const pricing = loadPricing(".");
  const native = estimateLoopBudget({ packetDir: ".", sources: [], pricing, measured: MEASURED, active: resolveActiveModel({}) });
  const glm = estimateLoopBudget({
    packetDir: ".",
    sources: [],
    pricing,
    measured: MEASURED,
    active: resolveActiveModel({ ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" }),
  });

  assert.equal(native.model_mix.worker, "claude-opus-4-8");
  assert.equal(glm.model_mix.worker, "glm-5.2");
  // GLM input is $1.40/MTok vs Opus $5.00 — the GLM estimate must be cheaper, not equal.
  assert.ok(glm.usd.expected < native.usd.expected, `glm ${glm.usd.expected} should be < native ${native.usd.expected}`);
  // Provenance is carried and honest: assumed (inferred from the base URL).
  assert.equal(glm.model_provenance.confidence, "assumed");
  assert.equal(glm.model_provenance.family, "glm");
  assert.equal(native.model_provenance.confidence, "confirmed");
});

// --- D-010 egress gate: count_tokens is withheld on a routed endpoint -------

test("a routed (non-native) endpoint withholds count_tokens — no egress, structural_egress_gated", async () => {
  // An API key + preferApi would normally hit the count_tokens API; routedNonNative must
  // gate it to the structural tier instead, so no source text leaves the machine.
  const measured = await measureSourcesCounted(".", [], {
    model: "glm-5.2",
    apiKey: "would-be-used",
    preferApi: true,
    countTokensUrl: "https://api.z.ai/api/anthropic/v1/messages/count_tokens",
    routedNonNative: true,
  });
  assert.equal(measured.method, "structural_egress_gated");
});

test("a native endpoint with a key still prefers the count_tokens API (gate is routing-only)", async () => {
  // No sources → no actual fetch, but the method must NOT be downgraded to gated when native.
  const measured = await measureSourcesCounted(".", [], { model: "claude-opus-4-8", apiKey: "k", preferApi: true, routedNonNative: false });
  assert.notEqual(measured.method, "structural_egress_gated");
});

// --- model-roster-data-v0: the roster is data, not constants -----------------

test("R-001: the roster (roles, markers, native defaults) loads from pricing.yaml", () => {
  const roster = loadModelRoster(".");
  assert.equal(roster.available, true);
  assert.equal(roster.nativeProvider, "anthropic");
  assert.equal(roster.nativeFamily, "claude");
  const worker = roster.entries.find((entry) => entry.roles.includes("worker"));
  const verifier = roster.entries.find((entry) => entry.roles.includes("verifier"));
  assert.ok(worker, "a worker role is declared in the data file");
  assert.ok(verifier, "a verifier role is declared in the data file");
  assert.ok(roster.nativeHosts.includes("api.anthropic.com"));
  assert.ok(roster.multiModelHosts.some((entry) => entry.marker === "fireworks"));
});

// The spec's validation check (model-roster-data-v0): a fictional model added via a
// DATA-ONLY change — id + rates + family + roles + markers in the yaml, zero src/
// edits — resolves, prices, and detects.
test("validation: a fictional model added by data-only change resolves, prices, and detects", () => {
  const root = mkdtempSync(path.join(tmpdir(), "foo-fictional-model-"));
  writeFileSync(
    path.join(root, "pricing.yaml"),
    [
      'schema_version: "0.1"',
      'date: "2099-01-01"',
      "currency: usd",
      "stale_after_days: 30",
      "roster:",
      "  native_provider: acme",
      "  native_family: acme",
      "  native_base_url: https://api.acme.example",
      "providers:",
      "  native_hosts: [api.acme.example]",
      "  multi_model_hosts: []",
      "models:",
      "  # Fictional model, source: this test, 2099-01-01.",
      "  acme-turbo-9:",
      "    input_per_mtok: 2.00",
      "    output_per_mtok: 8.00",
      "    family: acme",
      "    roles: [worker, verifier]",
      "    detect:",
      "      model_markers: [acme]",
      "      host_markers: [acme-cloud]",
      "      provider: acme",
      "",
    ].join("\n"),
  );

  const roster = loadModelRoster(root);
  assert.equal(roster.available, true);

  // Detects: a routed host carrying the data-declared marker resolves the family.
  const byHost = resolveActiveModel({ ANTHROPIC_BASE_URL: "https://api.acme-cloud.example/v1" }, roster);
  assert.equal(byHost.family, "acme");
  assert.equal(byHost.provider, "acme");
  assert.equal(byHost.worker, "acme-turbo-9");
  assert.equal(byHost.verifier, "acme-turbo-9");
  assert.equal(byHost.confidence, "assumed");
  assert.deepEqual(byHost.findings, []);

  // Resolves: the native default comes from the data file too.
  const native = resolveActiveModel({}, roster);
  assert.equal(native.provider, "acme");
  assert.equal(native.worker, "acme-turbo-9");
  assert.equal(native.confidence, "confirmed");
  assert.equal(native.baseUrl, "https://api.acme.example");

  // Prices: the same data file prices it — no src/ edit anywhere in this test.
  const pricing = loadPricing(root);
  const est = estimateLoopBudget({ packetDir: root, sources: [], pricing, measured: MEASURED, active: byHost, now: new Date("2099-01-02T00:00:00Z") });
  assert.equal(est.priced, true);
  assert.equal(est.model_mix.worker, "acme-turbo-9");
  assert.ok(est.usd.expected > 0, "the fictional model prices at its own data-declared rates");
  assert.deepEqual(est.findings, []);
});

// R-003 unknown-model honesty: absent from the data file => labeled finding and
// token-only handling, never a silent fallback to another model's rates.
test("R-003: an unknown declared model keeps its id, gets a labeled finding, and never prices", () => {
  const m = resolveActiveModel({ FOO_MODEL: "not-in-the-table-9" });
  assert.equal(m.worker, "not-in-the-table-9"); // honored as-is, not canonicalized onto another key
  assert.equal(m.confidence, "confirmed"); // the declaration is explicit; only the pricing is unknown
  assert.ok(m.findings.some((f) => f.startsWith("unknown model:")), `labeled finding, got: ${JSON.stringify(m.findings)}`);

  const est = estimateLoopBudget({ packetDir: ".", sources: [], pricing: loadPricing("."), measured: MEASURED, active: m });
  assert.equal(est.priced, false); // token-only, no default-model rates
  assert.equal(est.usd.expected, 0);
  assert.ok(est.tokens.expected > 0, "token estimate still works");
  assert.ok(est.findings.some((f) => f.includes("not-in-the-table-9")), "the finding names the model");
  assert.match(est.priced_with, /unpriced/);
});

test("R-002 degraded: a missing data file degrades resolution honestly and never throws", () => {
  const emptyRoot = mkdtempSync(path.join(tmpdir(), "foo-no-pricing-"));
  const roster = loadModelRoster(emptyRoot);
  assert.equal(roster.available, false);
  assert.ok(roster.findings.some((f) => f.includes("pricing.yaml missing")));

  const m = resolveActiveModel({ CLAUDECODE: "1" }, roster);
  assert.equal(m.worker, "unknown"); // honest: no data, no model claim
  assert.equal(m.confidence, "assumed"); // never "confirmed" without data to vouch for it
  assert.ok(m.findings.some((f) => f.includes("model roster unavailable")));
  assert.ok(describeActiveModel(m), "the degraded state is a visible signal, not silence");
});

// --- the real CLI: `foo runtime --json` is machine-readable, never glyphed --

test("`foo runtime --json` reports runtime + active model, no glyphs (R-004 gating)", () => {
  const result = spawnSync("node", [FOO_BIN, "runtime", "--json"], {
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", CLAUDECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.active.family, "glm");
  assert.equal(payload.active.provider, "z.ai");
  assert.equal(payload.active.confidence, "assumed");
  assert.ok(!/⚠️|🏷️/.test(result.stdout), "no glyph in --json output");
});
