// ideate-cost-v1 (R-002, T-003) — the diversity meter, computed.
//
// The v0 run had the orchestrator read 70 markdown ideas and hand-cluster them;
// the recorded `near_dupes_merged: 38` was a number a human eyeballed while
// reading, and every downstream consumer treated it as measured. That is worse
// than no number. So ideator/panelist output becomes a validated object, and
// merging becomes deterministic code over those objects: same ideas in, same
// meter out, reproducible by anyone holding the record.
//
// RISK-002: `mechanism` is free text that survives the schema so nuance is not
// flattened — it is read by humans and NEVER enters the clustering feature set.

// One idea, as an ideator or panelist returns it.
import { parse as parseYaml } from "../vendorYaml.js";

export interface IdeaObject {
  id: string;
  claim: string;
  frame: string;
  lens: string;
  // frames-v1 (#697): the frame's move, SHOWN — an inversion's enumerated
  // failure ingredients, an analogy's named source domain + stolen mechanism.
  // The skill always demanded chain-of-thought; before this field the schema
  // discarded it, which guaranteed slogans. Empty on pre-frames-v1 records.
  reasoning: string;
  mechanism: string; // free text — read, never clustered on (RISK-002)
  assumption: string;
  novelty: string;
  claims_relied_on: string[];
}

export interface DiversityMeter {
  raw: number;
  distinct_clusters: number;
  near_dupes_merged: number;
  exhausted: boolean;
}

export interface DiversityComputation extends DiversityMeter {
  clusters: string[][]; // idea ids, grouped; order follows first appearance
}

// Which clusterer produced a meter. Stamped into the record next to the meter
// so a reader can tell a number computed by today's code from one computed by
// an older, weaker one — and so the provenance gate can say "recompute this"
// instead of "your arithmetic is wrong" when the algorithm moves under a record.
//
// v1 was set-Jaccard over unweighted tokens at 0.5. Bump this whenever a change
// would move the meter on the same pool.
//
// v3 (#693): v2 clustered on claim + assumption + relied-on facts, which reads
// TOPIC diversity — one move repeated across twenty spend categories scored as
// twenty clusters, because each category's rare nouns drove the vectors apart
// while the shared move lived in fields the clusterer never saw. v3 adds the
// frames-v1 `reasoning` field to the feature set: the reasoning carries the
// move (the failure ingredients enumerated, the source domain named), so two
// ideas making the same move now share the vocabulary that actually matters.
// On pre-frames-v1 pools reasoning is empty and v3 computes exactly what v2
// computed, so old measured records still reproduce.
export const CLUSTERER_ID = "idf-cosine-v3-moves";

// Two ideas are the same idea when their weighted feature vectors point this
// close to the same direction. Held here so the number is auditable rather than
// implicit, and calibrated against a real pool rather than picked by taste — see
// the note on `similarity` below for the measurement.
export const NEAR_DUPE_THRESHOLD = 0.25;

// A floor under every token's IDF weight. Pure IDF has a degenerate case that
// matters here: when EVERY idea in the pool rests on the same fact, that fact
// appears in every document, so IDF calls it uninformative and starves the very
// signal that makes the pool homogeneous — a pool that is 100% one move would
// read as maximally diverse, which is the #613 failure wearing a new hat. The
// floor keeps universally-shared content contributing. Measured across both
// cases: 0.4 is the smallest floor that collapses a fully convergent pool to one
// cluster while leaving unrelated ideas apart and holding precision at 0.98 on
// the real 47-idea pool.
const IDF_FLOOR = 0.4;

// How much harder a shared empirical dependency counts than a shared ordinary
// word. Two ideators who independently leaned on the same observed fact are
// usually making the same move; two who both said "harness" are not.
const RELIED_WEIGHT = 3;

// v3: how much a shared reasoning token counts. The reasoning field carries the
// move itself, so it sits between ordinary prose (1) and a shared empirical
// dependency (3): strong evidence of the same move, weaker than the same fact.
const REASONING_WEIGHT = 2;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "for", "from", "has", "have", "in", "into",
  "is", "it", "its", "not", "of", "on", "or", "so", "that", "the", "their", "then", "there", "they", "this",
  "to", "was", "we", "were", "when", "which", "will", "with", "you", "your",
]);

// Light suffix folding so "pin"/"pinning", "invoke"/"invocation" and
// "dependency"/"dependencies" are one feature. Deliberately crude: a real
// stemmer is a dependency, and the failure mode we care about (the same
// mechanism described in two vocabularies) is mostly carried by rare nouns that
// survive this untouched.
const SUFFIXES = ["ing", "edly", "ed", "es", "s", "ly", "ment", "tion", "ance", "ence"];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

// The clustering feature set: what the idea says (claim), what it rests on
// (assumption), and which empirical claims it relies on — the last weighted
// `RELIED_WEIGHT` times heavier and, unlike v1, sharing one namespace with the
// prose. v1 namespaced relied-on tokens as `relied:<t>`, which meant the fact
// "interactive is Boolean(process.stdout.isTTY)" in one idea's `claims_relied_on`
// could never match the same fact stated in another idea's `claim`. That is
// precisely the match we need, so the namespace is gone; IDF now does the job
// namespacing was there for, by starving common words of weight.
//
// `mechanism`, `frame`, and `lens` remain deliberately absent: mechanism is the
// nuance we promised not to cluster on (RISK-002), and frame/lens are the cell
// the idea came from, so including them would make independence look like
// similarity. `reasoning` (v3) is the exception that proves the rule: it holds
// the MOVE, not the nuance, and the move is exactly what the meter must read.
export function featureSet(idea: IdeaObject): Map<string, number> {
  const feats = new Map<string, number>();
  const add = (t: string, weight: number) => feats.set(t, (feats.get(t) ?? 0) + weight);
  for (const t of tokens(idea.claim)) add(t, 1);
  for (const t of tokens(idea.assumption)) add(t, 1);
  // v3 (#693): the reasoning content joins the feature set — it is where the
  // move lives. The frames-v1 shape LABELS ("guarantee-failure:", "bedrock:")
  // are stripped first: every idea in the same frame carries the same labels,
  // so leaving them in would make sharing a frame look like sharing a move.
  for (const t of tokens((idea.reasoning ?? "").replace(/\b[a-z][a-z0-9-]*:/gi, " "))) add(t, REASONING_WEIGHT);
  for (const claim of idea.claims_relied_on) for (const t of tokens(claim)) add(t, RELIED_WEIGHT);
  return feats;
}

// Inverse document frequency across the pool being measured. This is what makes
// the meter read ideas rather than wordcounts: in a pool about productfoo's CLI, every
// idea says "foo" and "command", so those carry almost no weight, while
// "isTTY" or "invocation" — said by only the ideators who found the same
// mechanism — carry a lot.
//
// Note the consequence, which is a property of the measure and not a bug: IDF is
// computed over the pool, so similarity is a fact about ideas *in this pool*,
// not an absolute. Adding ideas can move existing pair scores. The meter is a
// statement about a pool, and it is recomputed whole, so this stays coherent —
// but it is why a meter must be recomputed rather than incrementally patched.
function inverseDocumentFrequency(pool: Map<string, number>[]): Map<string, number> {
  const documentCount = new Map<string, number>();
  for (const feats of pool) {
    for (const t of feats.keys()) documentCount.set(t, (documentCount.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, df] of documentCount) idf.set(t, Math.log((pool.length + 1) / (df + 0.5)) + IDF_FLOOR);
  return idf;
}

function cosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [t, weight] of a) {
    const w = weight * (idf.get(t) ?? 0);
    normA += w * w;
    const other = b.get(t);
    if (other !== undefined) dot += w * other * (idf.get(t) ?? 0);
  }
  for (const [t, weight] of b) {
    const w = weight * (idf.get(t) ?? 0);
    normB += w * w;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Similarity of two ideas *within a pool*. The pool argument is required because
// the weighting is IDF — see above. `similarityIn` is the honest signature;
// `similarity` keeps the old two-argument shape for callers measuring a single
// pair, by treating the pair as its own pool.
//
// Calibration (2026-07-24, the 47-idea pool from the run that filed #613, whose
// four convergent clusters were identified by reading all 47): v1's Jaccard-at-
// 0.5 merged 0 of 78 same-idea pairs — and the same-pair and different-pair
// score distributions overlapped under that feature set, so *no* threshold could
// have separated them. This measure does: at 0.25 it recovers the clusters with
// precision 0.98 and recall 0.77, and it reads a fully convergent pool as one
// cluster rather than as maximum diversity.
export function similarityIn(a: IdeaObject, b: IdeaObject, pool: IdeaObject[]): number {
  const feats = pool.map(featureSet);
  return cosine(featureSet(a), featureSet(b), inverseDocumentFrequency(feats));
}

export function similarity(a: IdeaObject, b: IdeaObject): number {
  return similarityIn(a, b, [a, b]);
}

// Average-linkage agglomerative clustering: repeatedly merge the two closest
// clusters, where distance between clusters is the mean similarity across all
// their member pairs, until nothing is closer than NEAR_DUPE_THRESHOLD.
//
// v1 used single linkage, on the reasoning that near-dupe is transitive. Under a
// measure sensitive enough to actually find near-dupes, it isn't: single linkage
// chains, so one lucky link between two genuinely different ideas fuses their
// whole clusters. Measured on the #613 pool, single linkage at this threshold
// collapsed 47 ideas into 15 clusters and fused two distinct attractors into one
// blob of 14 (precision 0.40). Average linkage on the same pool and threshold
// gives 23 clusters at precision 0.98, and degrades gracefully as the threshold
// moves rather than falling off a cliff.
//
// That asymmetry is deliberate: over-merging invents convergence that is not
// there, which is the failure this meter exists to prevent. When the clusterer
// is unsure, it should leave two ideas apart and let a reader find the overlap.
//
// The result does not depend on the order the ideators happened to report in — a
// meter that moves when you shuffle the input is not a measurement — so ties are
// broken on idea id, not on position.
export function computeDiversity(ideas: IdeaObject[], exhausted = false): DiversityComputation {
  // Feature vectors and the pool's IDF are computed once, not per pair: the
  // comparison is O(n²) and rebuilding the weighting inside it would be O(n³).
  const feats = ideas.map(featureSet);
  const idf = inverseDocumentFrequency(feats);
  const n = ideas.length;
  const pair: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      pair[i][j] = pair[j][i] = cosine(feats[i], feats[j], idf);
    }
  }

  // Clusters as index lists, in first-appearance order. `members` is kept sorted
  // by original index so cluster contents render in pool order.
  let groups = ideas.map((_, i) => [i]);
  const meanSimilarity = (a: number[], b: number[]): number => {
    let total = 0;
    for (const i of a) for (const j of b) total += pair[i][j];
    return total / (a.length * b.length);
  };

  for (;;) {
    let best = -1;
    let bestX = -1;
    let bestY = -1;
    for (let x = 0; x < groups.length; x += 1) {
      for (let y = x + 1; y < groups.length; y += 1) {
        const value = meanSimilarity(groups[x], groups[y]);
        if (value < NEAR_DUPE_THRESHOLD) continue;
        // Strictly-greater keeps the first pair on a tie, and because groups are
        // held in first-appearance order that first pair is a function of the
        // ideas, not of the order they arrived in.
        if (value > best) {
          best = value;
          bestX = x;
          bestY = y;
        }
      }
    }
    if (bestX === -1) break;
    const merged = [...groups[bestX], ...groups[bestY]].sort((a, b) => a - b);
    groups = groups.filter((_, i) => i !== bestX && i !== bestY);
    groups.push(merged);
    groups.sort((a, b) => a[0] - b[0]);
  }

  const clusters = groups.map((group) => group.map((i) => ideas[i].id));
  return {
    raw: ideas.length,
    distinct_clusters: clusters.length,
    // The whole definition, stated once: a merge is an idea that did not earn
    // its own cluster. Nothing here is a judgment call.
    near_dupes_merged: ideas.length - clusters.length,
    exhausted,
    clusters,
  };
}

// --- Record I/O ---------------------------------------------------------------

// The structured pool lives in the record inside a fenced block so the record
// stays one human-readable file and still carries its own show-your-work.
export const IDEAS_FENCE_OPEN = "```json ideas";
const IDEAS_BLOCK = /```json ideas\s*\n([\s\S]*?)```/;

export interface IdeaParseResult {
  ideas: IdeaObject[];
  errors: string[];
  present: boolean; // the block exists at all (missing ≠ empty)
}

const REQUIRED_TEXT: (keyof IdeaObject)[] = ["id", "claim", "frame", "lens", "mechanism", "assumption", "novelty"];

// Validation is presence-and-shape only. It refuses prose where an object
// belongs; it does not grade the idea — that is what the panel is for.
export function parseIdeaObjects(recordText: string): IdeaParseResult {
  const block = recordText.match(IDEAS_BLOCK);
  if (!block) return { ideas: [], errors: [], present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1].trim() || "[]");
  } catch (err) {
    return { ideas: [], errors: [`ideas block is not valid JSON: ${(err as Error).message}`], present: true };
  }
  if (!Array.isArray(parsed)) return { ideas: [], errors: ["ideas block must be a JSON array"], present: true };

  const errors: string[] = [];
  const ideas: IdeaObject[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, i) => {
    const at = `idea[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${at}: not an object`);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const missing = REQUIRED_TEXT.filter((f) => typeof obj[f] !== "string" || (obj[f] as string).trim() === "");
    if (missing.length) errors.push(`${at}: missing or empty ${missing.join(", ")}`);
    const relied = obj.claims_relied_on;
    if (!Array.isArray(relied) || relied.some((c) => typeof c !== "string")) {
      errors.push(`${at}: claims_relied_on must be an array of strings (use [] when the idea rests on none)`);
      return;
    }
    if (missing.length) return;
    const id = String(obj.id);
    if (seen.has(id)) errors.push(`${at}: duplicate id ${id}`);
    seen.add(id);
    ideas.push({
      id,
      claim: String(obj.claim),
      frame: String(obj.frame),
      lens: String(obj.lens),
      // Lenient on purpose: pre-frames-v1 records have no reasoning field, and
      // the provenance gate must keep reproducing their meters. Presence is
      // enforced by the frame-reasoning gate, only on frames-v1 records.
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
      mechanism: String(obj.mechanism),
      assumption: String(obj.assumption),
      novelty: String(obj.novelty),
      claims_relied_on: relied as string[],
    });
  });
  return { ideas, errors, present: true };
}

export const DIVERSITY_METER_LINE =
  /^diversity:\s*\{\s*raw:\s*(\d+),\s*distinct_clusters:\s*(\d+),\s*near_dupes_merged:\s*(\d+),\s*exhausted:\s*(true|false)\s*\}/m;

export function readDeclaredMeter(recordText: string): DiversityMeter | null {
  const m = recordText.match(DIVERSITY_METER_LINE);
  if (!m) return null;
  return {
    raw: Number(m[1]),
    distinct_clusters: Number(m[2]),
    near_dupes_merged: Number(m[3]),
    exhausted: m[4] === "true",
  };
}

export type DiversityMethod = "measured" | "estimated";

// Absent reads as `estimated`: an older record never claimed to have computed
// anything, and the gate's job is to refuse a FALSE `measured`, not to
// retroactively fail records that were honest about being eyeballed.
export function readDiversityMethod(recordText: string): { value: DiversityMethod; declared: boolean } | null {
  const m = recordText.match(/^diversity_method:\s*(\S+)/m);
  if (!m) return { value: "estimated", declared: false };
  const value = m[1].trim();
  if (value !== "measured" && value !== "estimated") return null;
  return { value, declared: true };
}

// Which clusterer computed the meter in this record, if it said. Absent means
// "older than the stamp" — which, for a `measured` record, is the same practical
// state as stale: the number was computed, but not by this code.
export function readClustererId(recordText: string): string | null {
  const m = recordText.match(/^diversity_clusterer:\s*(\S+)/m);
  return m ? m[1].trim() : null;
}

export function clustererLine(): string {
  return `diversity_clusterer: ${CLUSTERER_ID}`;
}

export function meterLine(meter: DiversityMeter): string {
  return `diversity: { raw: ${meter.raw}, distinct_clusters: ${meter.distinct_clusters}, near_dupes_merged: ${meter.near_dupes_merged}, exhausted: ${meter.exhausted} }`;
}

// --- frames-v1: executable frames (#697) --------------------------------------

// The contract version a record was scaffolded under. Gates that this version
// introduces (frame-reasoning, stress evidence, novelty anchor, cheapest test)
// apply only to records that carry the line — a record honest about being older
// is never retroactively failed.
export const IDEATE_CONTRACT_VERSION = "frames-v1";

export function ideateFrontmatter(record: string): Record<string, unknown> | null {
  const frontmatter = record.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return {};
  try {
    const value: unknown = parseYaml(frontmatter);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function ideateContractVersion(record: string): string | null {
  const value = ideateFrontmatter(record);
  if (value === null) return "invalid";
  if (!Object.hasOwn(value, "ideate_contract")) return null;
  return typeof value.ideate_contract === "string" ? value.ideate_contract : "invalid";
}

export function hasExecutableFramesContract(recordText: string): boolean {
  const version = ideateContractVersion(recordText);
  return version === IDEATE_CONTRACT_VERSION || version === "decisions-v2";
}

// The checkable SHAPE of each frame's move. Shape, never quality: an inversion
// that cannot show the failure it negated did not run inversion, whatever its
// label says — but how good the negation is stays with blind judging.
const FRAME_SHAPES: Record<string, { tags: RegExp[]; hint: string }> = {
  analogy: {
    tags: [/source-domain:/i, /mechanism-stolen:/i],
    hint: "reasoning must contain `source-domain:` and `mechanism-stolen:`",
  },
  inversion: {
    tags: [/guarantee-failure:/i, /negated:/i],
    hint: "reasoning must contain `guarantee-failure: <ingredient>; <ingredient>` then `negated:`",
  },
  "how-might-we": {
    tags: [/tension:/i, /answer:/i],
    hint: "reasoning must contain `tension:` and `answer:`",
  },
  "first-principles": {
    tags: [/bedrock:/i, /discarded-assumption:/i],
    hint: "reasoning must contain `bedrock:` and `discarded-assumption:`",
  },
  "second-order": {
    tags: [/then-1:/i, /then-2:/i],
    hint: "reasoning must contain `then-1:` and `then-2:`",
  },
};

// Free-text frames (panel lenses, build-on, custom) still owe a shown move,
// just not a tagged one.
const MIN_FREE_REASONING = 20;

export function frameReasoningOffenders(ideas: IdeaObject[]): string[] {
  const offenders: string[] = [];
  for (const idea of ideas) {
    const shape = FRAME_SHAPES[idea.frame.trim().toLowerCase()];
    const reasoning = (idea.reasoning ?? "").trim();
    if (shape) {
      const missing = shape.tags.filter((t) => !t.test(reasoning));
      if (missing.length) offenders.push(`${idea.id} (${idea.frame}): ${shape.hint}`);
    } else if (reasoning.length < MIN_FREE_REASONING) {
      offenders.push(`${idea.id} (${idea.frame}): reasoning must state the move (free text, not empty)`);
    }
  }
  return offenders;
}
