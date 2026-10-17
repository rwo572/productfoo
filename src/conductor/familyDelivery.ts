// Resolve bundled family definitions; missing package files are installation errors.
import { SkillDeliveryError } from "../skillLocal.js";
import { renderFamilyPack, type FamilyPack } from "./pack.js";
import type { Depth, FamilyDefinition } from "./types.js";

const LOCAL_FAMILIES: Record<string, () => Promise<FamilyDefinition>> = {
  ideate: () => import("./families/ideate.js").then((m) => m.ideateFamily),
  interview: () => import("./families/interview.js").then((m) => m.interviewFamily),
  "spec-swarm": () => import("./families/specSwarm.js").then((m) => m.specSwarmFamily),
};

export function familyPacksNotBundledMessage(name: string): string {
  return `family packs for "${name}" are not bundled with this productfoo install.`;
}

export function isKnownFamily(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_FAMILIES, name);
}

const packCache = new Map<string, FamilyPack>();

export function clearFamilyPackCache(): void {
  packCache.clear();
}

export async function resolveFamilyPack(
  name: string,
  depth: Depth,
  lean: boolean,
): Promise<FamilyPack> {
  if (!isKnownFamily(name)) {
    throw new SkillDeliveryError("not-found", `"${name}" is not a known foo method (expected: ${Object.keys(LOCAL_FAMILIES).join(", ")}).`);
  }
  const key = `${name}:${depth}:${lean ? 1 : 0}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  let family: FamilyDefinition;
  try {
    family = await LOCAL_FAMILIES[name]();
  } catch (cause) {
    throw new SkillDeliveryError("not-found", familyPacksNotBundledMessage(name), { cause });
  }
  const pack = renderFamilyPack(family, depth, lean);
  packCache.set(key, pack);
  return pack;
}
