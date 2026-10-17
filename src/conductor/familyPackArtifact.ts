import { canonicalJson, type JsonValue } from "../trustEnvelope.js";
import { renderFamilyPack, type FamilyPack } from "./pack.js";
import type { Depth, FamilyDefinition, GateSpec, Tier } from "./types.js";

const PREFIX = "# Foo signed family packs v1\n\n```json foo-family-packs\n";
const SUFFIX = "\n```\n";
const DEPTHS: readonly Depth[] = ["fast", "standard", "deep"];
const MAX_ARTIFACT_BYTES = 256 * 1024;
const SAFE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_PATTERN = /^[A-Za-z0-9_().|^$-]{1,256}$/;
const SAFE_HEADING = /^[A-Za-z0-9][A-Za-z0-9 _&:,'"/-]{0,255}$/;

type FamilyPackArtifact = {
  schema_version: "1";
  family: string;
  variants: Record<string, FamilyPack>;
};

function variantKey(depth: Depth, lean: boolean): string {
  return `${depth}:${lean ? 1 : 0}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, maxItems = 512): value is string[] {
  return Array.isArray(value)
    && value.length <= maxItems
    && value.every((entry) => typeof entry === "string" && Buffer.byteLength(entry, "utf8") <= 32 * 1024);
}

function boundedString(value: unknown, maxBytes = 4096): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validPattern(value: unknown): value is string {
  if (typeof value !== "string" || !SAFE_PATTERN.test(value)) return false;
  try {
    void new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function validGate(value: unknown): value is GateSpec {
  if (!plain(value) || typeof value.type !== "string" || typeof value.check !== "string"
    || !SAFE_NAME.test(value.check)) {
    return false;
  }
  const commonFrontmatter = () =>
    typeof value.field === "string"
      && SAFE_KEY.test(value.field)
      && boundedString(value.detail)
      && boundedString(value.failDetail);
  switch (value.type) {
    case "frontmatter-present": {
      const hasPattern = Object.hasOwn(value, "pattern");
      return exactKeys(
        value,
        hasPattern
          ? ["type", "check", "field", "pattern", "detail", "failDetail"]
          : ["type", "check", "field", "detail", "failDetail"],
      )
        && commonFrontmatter()
        && (!hasPattern || validPattern(value.pattern));
    }
    case "frontmatter-nonempty":
      return exactKeys(value, ["type", "check", "field", "detail", "failDetail"])
        && commonFrontmatter();
    case "frontmatter-equals":
      return exactKeys(value, ["type", "check", "field", "expect", "detail", "failDetail"])
        && commonFrontmatter()
        && boundedString(value.expect, 1024);
    case "diversity-meter":
      return exactKeys(value, ["type", "check", "floorCap", "floorKey"])
        && Number.isSafeInteger(value.floorCap)
        && (value.floorCap as number) >= 0
        && (value.floorCap as number) <= 1024
        && typeof value.floorKey === "string"
        && SAFE_KEY.test(value.floorKey);
    case "diversity-provenance":
      return exactKeys(value, ["type", "check"]);
    // frames-v1 (#697): both new gates are closed shapes — frame-reasoning
    // carries no payload beyond its check name, and versioned-keyline is the
    // frontmatter-nonempty shape gated on the record's contract version.
    case "frame-reasoning":
    case "ideate-falsification":
    case "ideate-decision":
      return exactKeys(value, ["type", "check"]);
    case "versioned-keyline":
      return exactKeys(value, ["type", "check", "field", "detail", "failDetail"])
        && commonFrontmatter();
    case "section-present":
      return exactKeys(value, ["type", "check", "heading", "detail", "failDetail"])
        && typeof value.heading === "string"
        && SAFE_HEADING.test(value.heading)
        && boundedString(value.detail)
        && boundedString(value.failDetail);
    case "ledger-types":
      return exactKeys(value, ["type", "check", "taxonomy"])
        && stringList(value.taxonomy, 64)
        && value.taxonomy.length > 0
        && value.taxonomy.every((entry) => SAFE_NAME.test(entry));
    default:
      return false;
  }
}

function validGates(value: unknown): value is GateSpec[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 64
    && value.every(validGate);
}

function validTier(value: unknown): value is Tier {
  if (!plain(value) || Object.keys(value).length > 32) return false;
  return Object.entries(value).every(([key, entry]) =>
    SAFE_KEY.test(key)
      && (typeof entry === "boolean"
        || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 && entry <= 1024)),
  );
}

function validDepthMap(value: unknown): boolean {
  return plain(value)
    && exactKeys(value, DEPTHS)
    && DEPTHS.every((depth) => validTier(value[depth]));
}

function validCells(value: unknown): boolean {
  if (value === null) return true;
  if (!plain(value)
    || !exactKeys(value, ["rolePrefix", "countKey", "maxCount", "pools", "seed"])
    || typeof value.rolePrefix !== "string"
    || !SAFE_KEY.test(value.countKey as string)
    || !Number.isSafeInteger(value.maxCount)
    || (value.maxCount as number) < 1
    || (value.maxCount as number) > 64
    || !plain(value.pools)
    || Object.keys(value.pools).length > 32) {
    return false;
  }
  for (const [attribute, pool] of Object.entries(value.pools)) {
    if (!SAFE_KEY.test(attribute)
      || !plain(pool)
      || !exactKeys(pool, Object.hasOwn(pool, "cycleKey") ? ["values", "cycleKey"] : ["values"])
      || !stringList(pool.values, 64)
      || pool.values.length === 0
      || pool.values.some((entry) => !SAFE_NAME.test(entry))
      || (Object.hasOwn(pool, "cycleKey") && (typeof pool.cycleKey !== "string" || !SAFE_KEY.test(pool.cycleKey)))) {
      return false;
    }
  }
  if (value.seed !== null) {
    if (!plain(value.seed)
      || !exactKeys(value.seed, ["attr", "base", "step"])
      || typeof value.seed.attr !== "string"
      || !SAFE_KEY.test(value.seed.attr)
      || !Number.isSafeInteger(value.seed.base)
      || !Number.isSafeInteger(value.seed.step)) {
      return false;
    }
  }
  return true;
}

const PACK_KEYS = [
  "family",
  "banner",
  "tagline",
  "skillRef",
  "defaultDepth",
  "phases",
  "handoff",
  "decider",
  "depth",
  "lean",
  "depths",
  "cells",
  "recordDir",
  "contract",
  "frontmatter",
  "body",
  "gates",
] as const;

function validPack(value: unknown, family: string, depth: Depth, lean: boolean): value is FamilyPack {
  if (!plain(value)
    || !exactKeys(value, PACK_KEYS)
    || value.family !== family
    || value.depth !== depth
    || value.lean !== lean
    || value.skillRef !== family
    || value.decider !== "human"
    || !DEPTHS.includes(value.defaultDepth as Depth)
    || typeof value.banner !== "string"
    || typeof value.tagline !== "string"
    || typeof value.handoff !== "string"
    || !stringList(value.phases, 32)
    || !validDepthMap(value.depths)
    || !validCells(value.cells)
    || !stringList(value.contract)
    || !stringList(value.frontmatter)
    || !stringList(value.body)
    || !validGates(value.gates)) {
    return false;
  }
  // V1 serves only ideate. Pinning the one writable directory makes a signed
  // release bug fail closed before path.resolve can observe an escape.
  return family === "ideate" && value.recordDir === "ideas";
}

export function renderFamilyPackArtifact(family: FamilyDefinition): string {
  const variants: Record<string, FamilyPack> = {};
  for (const depth of DEPTHS) {
    for (const lean of [false, true]) {
      variants[variantKey(depth, lean)] = renderFamilyPack(family, depth, lean);
    }
  }
  const payload: FamilyPackArtifact = {
    schema_version: "1",
    family: family.family,
    variants,
  };
  return `${PREFIX}${canonicalJson(payload as unknown as JsonValue)}${SUFFIX}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export function parseFamilyPackArtifact(
  text: string,
  family: string,
  depth: Depth,
  lean: boolean,
): FamilyPack {
  const invalid = (): never => {
    throw new TypeError("invalid signed family-pack artifact");
  };
  if (!SAFE_NAME.test(family)
    || Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES
    || !text.startsWith(PREFIX)
    || !text.endsWith(SUFFIX)) {
    return invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(text.slice(PREFIX.length, -SUFFIX.length));
  } catch {
    return invalid();
  }
  if (!plain(value)
    || !exactKeys(value, ["schema_version", "family", "variants"])
    || value.schema_version !== "1"
    || value.family !== family
    || !plain(value.variants)) {
    return invalid();
  }
  const expectedVariants = DEPTHS.flatMap((candidateDepth) => [
    variantKey(candidateDepth, false),
    variantKey(candidateDepth, true),
  ]);
  if (!exactKeys(value.variants, expectedVariants)) return invalid();
  for (const candidateDepth of DEPTHS) {
    for (const candidateLean of [false, true]) {
      if (!validPack(
        value.variants[variantKey(candidateDepth, candidateLean)],
        family,
        candidateDepth,
        candidateLean,
      )) {
        return invalid();
      }
    }
  }
  const selected = value.variants[variantKey(depth, lean)];
  return deepFreeze(selected as FamilyPack);
}
