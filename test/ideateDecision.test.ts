import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkRecordWithPack } from "../src/ideate.js";
import { renderFamilyPack } from "../src/conductor/pack.js";
import { ideateFamily } from "../src/conductor/families/ideate.js";
import { computeDiversity, meterLine } from "../src/conductor/diversity.js";

const FALSE_CLAIM = "The API exports full-resolution originals";
const UNKNOWN_CLAIM = "Users will choose ten photos in one sitting";
const pool = [
  { id: "i1", claim: "Import every original through the API", frame: "first-principles", lens: "engineering", reasoning: "bedrock: originals are needed; discarded-assumption: imports must be manual", mechanism: "Use the export endpoint", assumption: FALSE_CLAIM, novelty: "vs: manual uploads — less work", claims_relied_on: [FALSE_CLAIM] },
  { id: "i2", claim: "Make a ten-photo selection session", frame: "analogy", lens: "design", reasoning: "source-domain: museum curation; mechanism-stolen: a fixed exhibition size", mechanism: "Start with a bounded selection", assumption: UNKNOWN_CLAIM, novelty: "vs: bulk organization — a finished selection", claims_relied_on: [UNKNOWN_CLAIM] },
  { id: "i3", claim: "Keep the existing manual upload", frame: "inversion", lens: "product", reasoning: "guarantee-failure: migrate everything first; negated: use today's upload", mechanism: "Do nothing new until a user needs it", assumption: "Reversibility matters", novelty: "vs: new automation — no migration cost", claims_relied_on: [] },
];
const evidence = {
  claims: [
    { claim: FALSE_CLAIM, verdict: "refuted", evidence: [{ source: "fixtures/export-response.json", observation: "Only thumbnail URLs are present" }], consequence: "Drop automated original import" },
    { claim: UNKNOWN_CLAIM, verdict: "unknown", evidence: [], consequence: "Test completion with a prototype; do not assert demand" },
  ],
  excluded_ideas: ["i1"],
};
const decision = {
  recommendation: "Try a ten-photo selection session.",
  rationale: "A small finished selection gives the user something usable without an archive migration.",
  new_contribution: "Use a fixed-size selection as the finished deliverable instead of organizing the archive.",
  builds_on: [{ source: "ideas/prior-photo-plan.md", delta: "Keep its manual upload; replace full-archive organization with a ten-photo session." }],
  idea_ids: ["i2"],
  assumptions: [UNKNOWN_CLAIM],
  confidence: { level: "medium", reason: "The export limitation is observed; demand is untested." },
  alternatives: [{ direction: "Keep manual upload", choose_when: "The prototype does not improve completion", idea_ids: ["i3"] }],
  experiment: { action: "Ask three users to select ten photos with a paper prototype", effort: "One afternoon; no product build", pass: "At least two finish unaided in ten minutes", fail: "Fewer than two finish unaided" },
  dissent: "A cap of ten could exclude the photo that makes the story worthwhile.",
  not_doing: ["An archive migration or automatic original import"],
  next_action: "Choose whether to run the prototype test before specifying a build.",
};

function record(review: unknown = evidence, result: unknown = decision): string {
  return [
    "---", 'idea: "Make family photo selection useful"', "depth: fast", "decider: human",
    "ideate_contract: decisions-v2", `recommendation: ${JSON.stringify(decision.recommendation)}`,
    meterLine(computeDiversity(pool)), "diversity_method: measured", "diversity_clusterer: idf-cosine-v3-moves", "---",
    'pre_mortem: "Selection stalls at the tenth photo"', 'disconfirmation_vs_frontrunner: "Completion is untested"',
    'outcome_change: "Dropped automatic import after checking the API response"',
    'nearest_existing: "Manual upload"', 'cheapest_test: "One afternoon prototype"',
    'minority_report: "The cap may exclude a meaningful photo"', 'not_doing: ["Archive migration"]',
    'what_would_change_our_mind: "Fewer than two users complete the selection"',
    "```json grounding", JSON.stringify({ searched: ["ideas/", "research/"], sources: [{ source: "ideas/prior-photo-plan.md", takeaway: "Manual upload works; archive organization remains untested." }], gap: "No user completion measurements found." }), "```",
    "```json ideas", JSON.stringify(pool), "```",
    "```json falsification", JSON.stringify(review), "```",
    "```json decision", JSON.stringify(result), "```", "",
  ].join("\n");
}

const check = (text: string) => checkRecordWithPack(renderFamilyPack(ideateFamily, "fast", false), text);
function cli(text: string, command: string, ...flags: string[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "foo-decision-"));
  writeFileSync(path.join(cwd, "record.md"), text);
  return spawnSync("node", [path.resolve("bin/foo"), "--root", cwd, "ideate", command, "record.md", ...flags], { encoding: "utf8" });
}

test("a false shared premise cannot survive the early check by omitting exclusions", () => {
  const result = cli(record({ ...evidence, excluded_ideas: [] }), "check", "--before-build-on");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /i1.*refuted|refuted.*i1/);
});

test("early verification works before scoring or a decision exists", () => {
  const early = record().split('pre_mortem:')[0] + ["```json ideas", JSON.stringify(pool), "```", "```json falsification", JSON.stringify(evidence), "```"].join("\n");
  const result = cli(early, "check", "--before-build-on", "--json");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.notEqual(cli(early, "check").status, 0, "an early pass must not certify a finished result");
});

test("missing claim coverage and unsupported verdicts fail; unknown is an honest outcome", () => {
  assert.equal(check(record()).ok, true);
  for (const review of [
    { ...evidence, claims: evidence.claims.slice(0, 1) },
    { ...evidence, claims: [{ ...evidence.claims[0], evidence: [] }, evidence.claims[1]] },
    { ...evidence, claims: [{ ...evidence.claims[0], verdict: "probably" }, evidence.claims[1]] },
    { ...evidence, claims: [{ ...evidence.claims[0], verdict: ["refuted"] }, evidence.claims[1]], excluded_ideas: [] },
    { ...evidence, claims: [...evidence.claims, evidence.claims[0]] },
  ]) assert.equal(check(record(review)).ok, false, JSON.stringify(review));
});

test("a newly introduced build-on claim must be reviewed before final handoff", () => {
  const updated = record().replace(JSON.stringify(pool), JSON.stringify([...pool, { ...pool[2], id: "i4", frame: "build-on", claims_relied_on: ["Storage is free forever"] }]));
  const result = check(updated);
  assert.ok(result.findings.some((f) => !f.ok && /Storage is free forever/.test(f.detail)));
});

test("a final recommendation cannot revive excluded ideas or conceal an unknown premise", () => {
  for (const change of [
    { idea_ids: ["i1"] }, { idea_ids: ["invented"] }, { assumptions: [] },
    { alternatives: [{ ...decision.alternatives[0], idea_ids: ["i1"] }] },
    { experiment: { ...decision.experiment, fail: "" } },
    { alternatives: Array(3).fill(decision.alternatives[0]) },
    { new_contribution: "" }, { builds_on: [] },
    { confidence: { level: ["high"], reason: "This is not a string enum" } },
    { builds_on: [{ source: "invented.md", delta: "Use a nonexistent prior insight" }] },
  ]) assert.equal(check(record(evidence, { ...decision, ...change })).ok, false, JSON.stringify(change));
});

test("result renders an actionable page with the refuted claim derived from evidence", () => {
  const result = cli(record(), "result");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Try a ten-photo selection session/);
  assert.match(result.stdout, /choose when.*prototype does not improve completion/i);
  assert.match(result.stdout, /At least two finish unaided/);
  assert.match(result.stdout, /Fewer than two finish/);
  assert.match(result.stdout, /One afternoon/);
  assert.match(result.stdout, /Only thumbnail URLs are present/);
  assert.match(result.stdout, /ideas\/prior-photo-plan.md/);
  assert.match(result.stdout, /fixed-size selection/);
  assert.doesNotMatch(result.stdout, /"idea_ids"|"claims_relied_on"|NUF|Explorer|i[123]\b/);
  const json = cli(record(), "result", "--json");
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), ["recommendation", "alternatives", "falsified", "dissent", "what_would_change_our_mind", "next_action"].sort());
});

test("result refuses malformed or duplicate decision blocks instead of printing a partial answer", () => {
  for (const text of [record(evidence, {}), record() + '\n```json decision\n{}\n```', record().replace('"verdict":"refuted"', '"verdict":null')]) {
    const result = cli(text, "result");
    assert.notEqual(result.status, 0);
  }
});

test("older records remain readable but cannot claim an early falsification pass", () => {
  const legacy = record().replace("decisions-v2", "frames-v1").replace(/```json (falsification|decision)\n[\s\S]*?```/g, "");
  assert.equal(check(legacy).ok, true);
  assert.notEqual(cli(legacy, "check", "--before-build-on").status, 0);
  assert.notEqual(cli(legacy, "result").status, 0);
});

test("quoted contract versions keep their checks; unknown and duplicate versions fail closed", () => {
  for (const version of ['"decisions-v2"', 'decisions-v2 # current']) {
    assert.equal(check(record().replace('ideate_contract: decisions-v2', `ideate_contract: ${version}`)).ok, true);
    assert.equal(check(record({}, {}).replace('ideate_contract: decisions-v2', `ideate_contract: ${version}`)).ok, false);
  }
  for (const version of ['decisions-v3', 'decisions-v2\nideate_contract: frames-v1']) {
    assert.equal(check(record({}, {}).replace('ideate_contract: decisions-v2', `ideate_contract: ${version}`)).ok, false);
  }
  const quotedKey = record().replace("ideate_contract:", '"ideate_contract":');
  assert.equal(check(quotedKey).ok, true);
  assert.equal(check(quotedKey.replace(/^pre_mortem:.*$/m, "")).ok, false);
});

test("the record's leading recommendation cannot contradict its verified decision", () => {
  const contradictory = record().replace(/^recommendation:.*$/m, 'recommendation: "Import every original through the API."');
  assert.equal(check(contradictory).ok, false);
});

test("duplicate idea pools cannot hide an unreviewed premise from the early check", () => {
  const extra = '\n```json ideas\n' + JSON.stringify([{ ...pool[0], id: "hidden", claims_relied_on: ["Unreviewed fact"] }]) + '\n```';
  assert.notEqual(cli(record() + extra, "check", "--before-build-on").status, 0);
});

test("full observations stay in the backing record while the human result stays bounded", () => {
  const review = { ...evidence, claims: [{ ...evidence.claims[0], evidence: [{ source: "fixtures/export-response.json", observation: "Only thumbnails. " + "Additional detail. ".repeat(350) }] }, evidence.claims[1]] };
  const result = cli(record(review), "result");
  assert.equal(result.status, 0, result.stdout);
  assert.ok(result.stdout.trim().split(/\s+/).length <= 600);
  assert.match(result.stdout, /fixtures\/export-response.json/);
});
