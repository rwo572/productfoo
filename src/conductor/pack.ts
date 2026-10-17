// methodology-as-data (R-001/R-002): a FamilyPack is a family definition
// rendered to DATA so the shipped client can run a family it does not hold.
//
// The move: everything in a family's emitted contract/record is determined by
// (family, depth, lean) EXCEPT two values that are the user's alone — the target
// (their idea / work item) and the run timestamp. So the server renders the
// contract/record once, with sentinels standing in for those two, using the
// EXACT same render functions (byte-compat is automatic — no re-expressed
// template to drift). The client fetches the pack and substitutes the real
// target + timestamp back in locally. The target never leaves the machine (B1);
// the wire request carries only {token, family, depth, lean} — enums and a bool.
//
// The engine that ships stays generic (cell arithmetic, gate evaluation, this
// substitution); the methodology PROSE + roster + gates travel in the pack,
// fetched per run, never written to the tester's disk.
import { renderContext, slugify } from "./engine.js";
import type { Depth, FamilyDefinition, GateSpec } from "./types.js";

// Sentinels: alphanumeric and unmistakable, so no methodology prose collides
// with them and each of the derived forms (raw / slug / JSON) stays distinct.
const S_TARGET = "Zx9TargetSentinel9xZ";
const S_TARGET_SLUG = slugify(S_TARGET); // "zx9targetsentinel9xz" — lowercased, alnum-only
const S_TARGET_JSON = JSON.stringify(S_TARGET); // "\"Zx9TargetSentinel9xZ\""
const S_AT = "0000-00-00T00:00:00.000Z";
const S_AT_DATE = S_AT.slice(0, 10); // "0000-00-00" — the only slice of `at` any family uses

// A pure-data family: the render functions are gone, replaced by their output
// (with sentinels), plus every non-function field the engine needs to run.
export interface FamilyPack {
  family: string;
  banner: string;
  tagline: string;
  skillRef: string;
  defaultDepth: Depth;
  phases: readonly string[];
  handoff: string;
  decider: "human";
  depth: Depth;
  lean: boolean;
  depths: FamilyDefinition["depths"];
  cells: FamilyDefinition["cells"];
  recordDir: string | null;
  contract: string[]; // rendered, sentinelised
  frontmatter: string[] | null; // rendered, sentinelised (null when family has no record)
  body: string[] | null;
  gates: GateSpec[];
}

// Server side: render a family to a pack for one (depth, lean). Uses the real
// render functions with sentinel target + at, so the bytes match a local run.
export function renderFamilyPack(family: FamilyDefinition, depth: Depth, lean: boolean): FamilyPack {
  const ctx = { ...renderContext(family, S_TARGET, depth, S_AT, "/"), lean };
  return {
    family: family.family,
    banner: family.banner,
    tagline: family.tagline,
    skillRef: family.skillRef,
    defaultDepth: family.defaultDepth,
    phases: family.phases,
    handoff: family.handoff,
    decider: family.decider,
    depth,
    lean,
    depths: family.depths,
    cells: family.cells,
    recordDir: family.record ? family.record.dir : null,
    contract: family.contract(ctx),
    frontmatter: family.record ? family.record.frontmatter(ctx) : null,
    body: family.record ? family.record.body(ctx) : null,
    gates: family.gates,
  };
}

// Client side: put the user's real target + timestamp back into sentinelised
// lines. Order is load-bearing: the JSON form is replaced before the raw form
// (the raw sentinel is a substring of the quoted JSON form), and the slug form
// is lowercase so it never collides with the mixed-case raw form.
function substitute(lines: string[], target: string, at: string): string[] {
  const slug = slugify(target);
  const json = JSON.stringify(target);
  const atDate = at.slice(0, 10);
  return lines.map((line) =>
    line
      .split(S_TARGET_JSON).join(json)
      .split(S_TARGET).join(target)
      .split(S_TARGET_SLUG).join(slug)
      .split(S_AT_DATE).join(atDate),
  );
}

// The client's stand-ins for renderContract / scaffoldRecord bodies, driven by
// a fetched pack instead of a local family. recordPath falls out of the
// substitution (it is dir + at-date + slug, all substituted).
export function contractFromPack(pack: FamilyPack, target: string, at: string): string[] {
  return substitute(pack.contract, target, at);
}

export function recordFromPack(pack: FamilyPack, target: string, at: string): { frontmatter: string[]; body: string[] } | null {
  if (pack.frontmatter === null || pack.body === null) return null;
  return {
    frontmatter: substitute(pack.frontmatter, target, at),
    body: substitute(pack.body, target, at),
  };
}
