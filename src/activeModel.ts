// The single authoritative active-model resolver (glm-model-awareness-v0 / T-001,
// R-001, D-003; data-driven since model-roster-data-v0 R-001).
//
// foo silently assumed Anthropic/Opus everywhere a model fact was needed: pricing,
// loop-budget estimation, and the count_tokens endpoint were all hardcoded to Claude
// models and api.anthropic.com. But a coding harness (Claude Code first) can be pointed
// at a different model via a compatible endpoint — concretely GLM served by z.ai
// (Anthropic-compatible) or Fireworks (OpenAI-compatible). Because of server-side model
// mapping the harness still reports "Claude", so the active model is invisible and foo
// emits a confident, Opus-priced, wrong number with no signal it is guessing.
//
// D-003 is the load-bearing rule: there is exactly ONE place that resolves the active
// provider/model, and every model-aware subsystem (pricing, budget key, count_tokens
// routing, provenance) reads only from it. No second source that can drift from the base
// URL the harness actually calls. This module is that source.
//
// model-roster-data-v0 R-001 moves the *constants* out: the worker/verifier roster,
// provider host markers, and detection hints live in the committed, dated pricing.yaml
// (loaded by loadModelRoster), so a model rename or a new provider is a data-only
// change. The resolver contract — one source, explicit precedence, honest confidence —
// is unchanged; this module holds zero model-name literals.
//
// Precedence (R-001): an explicit declaration wins; inference from the base URL is the
// fallback; native default (from the data file) is the default.
//   1. FOO_MODEL / FOO_ACTOR_MODEL (+ FOO_ACTOR_PROVIDER) -> confirmed
//   2. ANTHROPIC_BASE_URL / OPENAI_BASE_URL off a native host -> inferred, "assumed"
//   3. nothing routed -> native default, confirmed
//
// Confidence is honest by construction: only an explicit foo-level declaration (or the
// genuinely-native default) is "confirmed". Anything inferred from an endpoint override
// is "assumed" — because the harness's own model env may not match the provider's
// server-side mapping — and that drives the ⚠️ provenance tag (R-004 / T-004).
//
// Unknown-model honesty (model-roster-data-v0 R-003): a model id absent from the data
// file resolves as itself with a labeled "unknown model" finding and token-only
// handling downstream — never a silent fallback to another model's rates (the exact
// bug class this module was built to kill). A missing/unreadable data file degrades
// the same way: the resolver never blocks, it gets honest.

import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./configPath.js";
import { parse as parseYaml } from "./vendorYaml.js";

// Family keys come from the data file ("claude", "glm", ...); UNKNOWN_FAMILY is the
// only in-code sentinel. A family is a data value, not a code enum, so a new family
// is a data-only change.
export type ModelFamily = string;
export type ModelConfidence = "confirmed" | "assumed";

export const UNKNOWN_FAMILY = "unknown";
export const UNKNOWN_MODEL = "unknown";

/**
 * Model families foo default-denies for autonomous work (glm-model-awareness-v0
 * R-005): weaker self-correction makes them a degraded verifier of their own
 * loop, and the inference-egress boundary is not yet in place.
 *
 * This is the ONE source of truth. It used to be an inline `family === "glm"`
 * check in the loop command, which meant `foo estimate` — knowing nothing about
 * it — would cheerfully recommend a cheaper GLM build that `foo loop estimate
 * --agree` then refuses. Any surface that offers a model as an option must be
 * able to ask this question.
 */
export const AUTONOMY_DENIED_FAMILIES: ReadonlySet<string> = new Set(["glm"]);

export function autonomyDenied(family: string | undefined | null): boolean {
  return typeof family === "string" && AUTONOMY_DENIED_FAMILIES.has(family);
}

// Provider label (not a model name) and default base for the case where nothing is
// routed and the roster itself is unavailable — the harness's native endpoint.
const NATIVE_PROVIDER_FALLBACK = "anthropic";
export const ANTHROPIC_BASE_DEFAULT = "https://api.anthropic.com";

export type ActiveModel = {
  /** Friendly provider name: e.g. "anthropic" (native), "z.ai", "fireworks", or the host. */
  provider: string;
  /** Coarse model family (data-driven), used for pricing-key canonicalization and family signals. */
  family: ModelFamily;
  /** Resolved worker model id — the pricing/budget key for the acting model. */
  worker: string;
  /** Resolved verifier model id. */
  verifier: string;
  /** confirmed = explicit declaration or genuinely-native; assumed = inferred from a base URL. */
  confidence: ModelConfidence;
  /** Is the harness pointed off its native provider? */
  routed: boolean;
  /** Active API base for the harness's provider (drives count_tokens routing). */
  baseUrl: string;
  /** count_tokens endpoint derived from baseUrl — never a hardcoded provider literal. */
  countTokensUrl: string;
  /** Provenance of the resolution (which signal won). */
  source: string;
  /**
   * Worded, human-readable findings: roster-data degradation and labeled
   * "unknown model" honesty (R-003). Empty when everything resolved cleanly.
   * Plain text only — the caller owns glyph gating.
   */
  findings: string[];
};

// --- Roster data (model-roster-data-v0 R-001) --------------------------------

export type RosterEntry = {
  id: string;
  family: string;
  roles: readonly string[];
  modelMarkers: readonly string[];
  hostMarkers: readonly string[];
  provider: string | null;
  /** Wire format for direct panel calls (multi-model-research-panel-v0 R-005): "anthropic" | "openai" | null. */
  wire: string | null;
  /**
   * Routing tier this model serves (model-orchestrator-v0 R-001). Null when the
   * roster does not place it — the routing policy then resolves it to the
   * conservative tier with a worded finding rather than guessing (R-013).
   */
  routingTier?: string | null;
  /** Optional per-model task-type override; empty means "whatever the tier says". */
  routingTaskTypes?: readonly string[];
};

export type ModelRoster = {
  /** Basename of the data file, e.g. "pricing.yaml". */
  source: string;
  /** False when the data file is missing/unreadable — resolution degrades, never blocks. */
  available: boolean;
  nativeProvider: string;
  nativeFamily: string;
  nativeBaseUrl: string;
  nativeHosts: readonly string[];
  multiModelHosts: readonly { marker: string; provider: string }[];
  entries: readonly RosterEntry[];
  /** Worded degradation findings carried into every resolution. */
  findings: readonly string[];
};

const ROSTER_SOURCE = "pricing.yaml";

function isObj(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function degradedRoster(finding: string): ModelRoster {
  return {
    source: ROSTER_SOURCE,
    available: false,
    nativeProvider: NATIVE_PROVIDER_FALLBACK,
    nativeFamily: UNKNOWN_FAMILY,
    nativeBaseUrl: ANTHROPIC_BASE_DEFAULT,
    nativeHosts: [],
    multiModelHosts: [],
    entries: [],
    findings: [finding],
  };
}

// Load the model roster (identity, roles, detection) from the committed data file.
// Missing or unreadable data degrades to an honest "unknown" roster with a worded
// finding — it never throws, because model *resolution* must never block (D-006:
// detection is a signal, not a boundary).
export function loadModelRoster(root: string = process.cwd()): ModelRoster {
  const file = configPath(root, ROSTER_SOURCE);
  if (!existsSync(file)) {
    return degradedRoster(
      `model roster unavailable: ${ROSTER_SOURCE} missing at repo root or in config/ — active model resolves as unknown; token-only handling`,
    );
  }
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    return degradedRoster(
      `model roster unavailable: ${ROSTER_SOURCE} unreadable (${error instanceof Error ? error.message : String(error)}) — active model resolves as unknown; token-only handling`,
    );
  }
  if (!isObj(doc)) return degradedRoster(`model roster unavailable: ${ROSTER_SOURCE} is not a mapping — active model resolves as unknown; token-only handling`);

  const roster = isObj(doc.roster) ? doc.roster : {};
  const providers = isObj(doc.providers) ? doc.providers : {};
  const models = isObj(doc.models) ? doc.models : {};

  const entries: RosterEntry[] = Object.entries(models).map(([id, raw]) => {
    const model = isObj(raw) ? raw : {};
    const detect = isObj(model.detect) ? model.detect : {};
    const routing = isObj(model.routing) ? model.routing : {};
    return {
      id,
      family: strOf(model.family) ?? UNKNOWN_FAMILY,
      roles: strArray(model.roles),
      modelMarkers: strArray(detect.model_markers).map((m) => m.toLowerCase()),
      hostMarkers: strArray(detect.host_markers).map((m) => m.toLowerCase()),
      provider: strOf(detect.provider),
      wire: strOf(model.wire),
      routingTier: strOf(routing.tier),
      routingTaskTypes: strArray(routing.task_types),
    };
  });

  const multiModelHosts = (Array.isArray(providers.multi_model_hosts) ? providers.multi_model_hosts : [])
    .filter(isObj)
    .map((entry) => ({ marker: strOf(entry.marker) ?? "", provider: strOf(entry.provider) ?? "" }))
    .filter((entry) => entry.marker.length > 0 && entry.provider.length > 0);

  const findings: string[] = [];
  if (entries.length === 0) {
    findings.push(`model roster degraded: ${ROSTER_SOURCE} has no models — active model resolves as unknown; token-only handling`);
  } else if (!entries.some((entry) => entry.family !== UNKNOWN_FAMILY)) {
    findings.push(`model roster degraded: ${ROSTER_SOURCE} models carry no roster fields (family/roles/detect) — detection limited`);
  }

  return {
    source: ROSTER_SOURCE,
    available: true,
    nativeProvider: strOf(roster.native_provider) ?? NATIVE_PROVIDER_FALLBACK,
    nativeFamily: strOf(roster.native_family) ?? UNKNOWN_FAMILY,
    nativeBaseUrl: strOf(roster.native_base_url) ?? ANTHROPIC_BASE_DEFAULT,
    nativeHosts: strArray(providers.native_hosts).map((h) => h.toLowerCase()),
    multiModelHosts,
    entries,
    findings,
  };
}

// --- Resolution helpers (all read only the roster data) ----------------------

function hostOf(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    const match = trimmed.replace(/^https?:\/\//, "").replace(/^\/+/, "").match(/^([^/]+)/);
    return match ? match[1].toLowerCase() : null;
  }
}

function providerFromHost(roster: ModelRoster, host: string): string {
  for (const entry of roster.entries) {
    if (entry.hostMarkers.some((marker) => host.includes(marker))) return entry.provider ?? entry.family;
  }
  for (const multi of roster.multiModelHosts) {
    if (host.includes(multi.marker)) return multi.provider;
  }
  return host;
}

// Family detection: a model id/hint marker wins over a host marker (a multi-model
// host only means a family when the model id says so — that ordering is why e.g.
// Fireworks carries no host marker in the data file).
function detectFamily(roster: ModelRoster, host: string | null, modelHint: string | null): ModelFamily {
  const hint = modelHint?.toLowerCase() ?? null;
  if (hint) {
    for (const entry of roster.entries) {
      if (entry.modelMarkers.some((marker) => hint.includes(marker))) return entry.family;
    }
  }
  if (host) {
    for (const entry of roster.entries) {
      if (entry.hostMarkers.some((marker) => host.includes(marker))) return entry.family;
    }
  }
  return UNKNOWN_FAMILY;
}

// The family's default worker/verifier mix, from per-model `roles` in the data file.
function familyRoster(roster: ModelRoster, family: ModelFamily): { worker: string | null; verifier: string | null } {
  if (family === UNKNOWN_FAMILY) return { worker: null, verifier: null };
  const inFamily = roster.entries.filter((entry) => entry.family === family);
  return {
    worker: inFamily.find((entry) => entry.roles.includes("worker"))?.id ?? null,
    verifier: inFamily.find((entry) => entry.roles.includes("verifier"))?.id ?? null,
  };
}

// Friendly provider label for an unrouted family (e.g. a declared GLM model with no
// base-URL override reads its provider from the family's detection entry).
function familyProvider(roster: ModelRoster, family: ModelFamily): string | null {
  if (family === UNKNOWN_FAMILY) return null;
  return roster.entries.find((entry) => entry.family === family && entry.provider)?.provider ?? null;
}

function isKnownModel(roster: ModelRoster, id: string): boolean {
  return roster.entries.some((entry) => entry.id === id);
}

// R-003 unknown-model honesty: label anything the data file cannot vouch for.
function modelFindings(roster: ModelRoster, worker: string, verifier: string): string[] {
  const findings = [...roster.findings];
  const flag = (id: string): void => {
    if (id === UNKNOWN_MODEL) {
      findings.push("unknown model: the active model could not be resolved (no declaration, no roster match) — token-only handling, no default-model rates assumed");
    } else if (roster.available && !isKnownModel(roster, id)) {
      findings.push(`unknown model: ${id} is not in ${roster.source} — token-only handling, no default-model rates assumed`);
    }
  };
  flag(worker);
  if (verifier !== worker) flag(verifier);
  return [...new Set(findings)];
}

// Derive the count_tokens endpoint from the active base URL (R-003). The Anthropic-shaped
// path (z.ai mirrors it under /api/anthropic) is `<base>/v1/messages/count_tokens`. This is
// the only place that endpoint is built, so it always follows the harness.
export function deriveCountTokensUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/messages/count_tokens`;
}

// Resolve the active provider/model from the single source. Reads the environment and
// the committed roster data only; pure given (env, roster) and testable. Every
// model-aware subsystem calls this and nothing else.
export function resolveActiveModel(env: NodeJS.ProcessEnv = process.env, roster: ModelRoster = loadModelRoster()): ActiveModel {
  const declaredModel = env.FOO_MODEL?.trim() || env.FOO_ACTOR_MODEL?.trim() || null;
  const declaredProvider = env.FOO_ACTOR_PROVIDER?.trim() || null;

  const nativeHosts = new Set(roster.nativeHosts);
  const anthropicHost = hostOf(env.ANTHROPIC_BASE_URL);
  const openaiHost = hostOf(env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE);

  let routedHost: string | null = null;
  let routedBase: string | null = null;
  let routedSource: string | null = null;
  if (anthropicHost && !nativeHosts.has(anthropicHost)) {
    routedHost = anthropicHost;
    routedBase = (env.ANTHROPIC_BASE_URL ?? "").trim();
    routedSource = "ANTHROPIC_BASE_URL";
  } else if (openaiHost && !nativeHosts.has(openaiHost)) {
    routedHost = openaiHost;
    routedBase = (env.OPENAI_BASE_URL ?? env.OPENAI_API_BASE ?? "").trim();
    routedSource = env.OPENAI_BASE_URL ? "OPENAI_BASE_URL" : "OPENAI_API_BASE";
  }
  const routed = Boolean(routedHost);
  const harnessModelHint = env.ANTHROPIC_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null;

  // 1. Explicit declaration wins — confirmed. The declared id is honored as-is: an id
  //    the data file does not know gets an "unknown model" finding (R-003), never a
  //    silent canonicalization onto another model's pricing key.
  if (declaredModel) {
    const family = detectFamily(roster, routedHost, declaredModel);
    const mix = familyRoster(roster, family);
    const worker = declaredModel;
    const verifier = isKnownModel(roster, declaredModel) ? mix.verifier ?? declaredModel : declaredModel;
    const provider =
      declaredProvider ??
      (routedHost ? providerFromHost(roster, routedHost) : familyProvider(roster, family) ?? roster.nativeProvider);
    const baseUrl = routedBase || roster.nativeBaseUrl;
    return {
      provider,
      family,
      worker,
      verifier,
      confidence: "confirmed",
      routed,
      baseUrl,
      countTokensUrl: deriveCountTokensUrl(baseUrl),
      source: env.FOO_MODEL ? "FOO_MODEL" : "FOO_ACTOR_MODEL",
      findings: modelFindings(roster, worker, verifier),
    };
  }

  // 2. Inference from a base-URL override — assumed (the honest tag). A recognized
  //    family resolves to that family's roster mix (server-side mapping makes the raw
  //    hint unreliable, so the family pricing key is the honest resolution); an
  //    unrecognized one resolves to the hint or "unknown" with a finding.
  if (routed && routedHost && routedBase) {
    const family = detectFamily(roster, routedHost, harnessModelHint);
    const mix = familyRoster(roster, family);
    const worker = mix.worker ?? harnessModelHint ?? UNKNOWN_MODEL;
    const verifier = mix.verifier ?? harnessModelHint ?? UNKNOWN_MODEL;
    return {
      provider: providerFromHost(roster, routedHost),
      family,
      worker,
      verifier,
      confidence: "assumed",
      routed: true,
      baseUrl: routedBase,
      countTokensUrl: deriveCountTokensUrl(routedBase),
      source: `${routedSource} (server-side model mapping may differ)`,
      findings: modelFindings(roster, worker, verifier),
    };
  }

  // 3. Native default — from the data file. Confirmed only when the roster actually
  //    vouches for the native mix; a degraded roster resolves honestly as unknown.
  const family = roster.nativeFamily;
  const mix = familyRoster(roster, family);
  const worker = mix.worker ?? UNKNOWN_MODEL;
  const verifier = mix.verifier ?? worker;
  return {
    provider: roster.nativeProvider,
    family,
    worker,
    verifier,
    confidence: worker === UNKNOWN_MODEL ? "assumed" : "confirmed",
    routed: false,
    baseUrl: roster.nativeBaseUrl,
    countTokensUrl: deriveCountTokensUrl(roster.nativeBaseUrl),
    source: "native default",
    findings: modelFindings(roster, worker, verifier),
  };
}

// One-line, human-only provenance description. Returns null when the active model is the
// genuinely-native default with nothing to flag (no signal worth showing). The caller owns
// glyph-gating (TTY-only, never into --json/contracts) — this returns plain text.
export function describeActiveModel(active: ActiveModel): string | null {
  if (!active.routed && active.confidence === "confirmed" && active.findings.length === 0) return null;
  const tag = active.confidence === "assumed" ? "model: unconfirmed" : `model: ${active.worker}`;
  const where = active.routed ? `routed to ${active.provider}` : `native ${active.provider}`;
  return `${where} — ${tag} (${active.family}); pricing/token follow the active model`;
}
