// methodology-as-data byte-compat proof: a fetched pack, substituted with the
// user's real target + timestamp on the client, must reproduce EXACTLY what a
// local family render produces — for every family, depth, lean mode, and a set
// of adversarial targets (quotes, backslashes, unicode, symbols, empty). If this
// holds, the shipped client can run a family it does not hold, byte-for-byte.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContext } from "../src/conductor/engine.js";
import { contractFromPack, recordFromPack, renderFamilyPack } from "../src/conductor/pack.js";
import { ideateFamily } from "../src/conductor/families/ideate.js";
import { interviewFamily } from "../src/conductor/families/interview.js";
import { specSwarmFamily } from "../src/conductor/families/specSwarm.js";

const FAMILIES = [ideateFamily, interviewFamily, specSwarmFamily];
const DEPTHS = ["fast", "standard", "deep"] as const;
const TARGETS = [
  "how to build productfoo's true-C skill service",
  'a target with "double quotes" and \\backslashes\\ and a newline-ish \\n',
  "unicode: café → naïve — 日本語 · emoji 🚀",
  "sym!bols? & (parens) [brackets] {braces} 100%",
  "", // slugify falls back to "idea"; JSON.stringify("") = '""'
];
const AT = "2026-07-12T20:00:00.000Z";

for (const family of FAMILIES) {
  for (const depth of DEPTHS) {
    for (const lean of [false, true]) {
      const pack = renderFamilyPack(family, depth, lean);
      for (const target of TARGETS) {
        const label = `${family.family}/${depth}/lean=${lean}/"${target.slice(0, 10)}"`;
        test(`pack round-trips byte-identically: ${label}`, () => {
          const localCtx = { ...renderContext(family, target, depth, AT, "/repo"), lean };
          assert.equal(
            contractFromPack(pack, target, AT).join("\n"),
            family.contract(localCtx).join("\n"),
            `contract mismatch: ${label}`,
          );
          if (family.record) {
            const rec = recordFromPack(pack, target, AT);
            assert.ok(rec, "record expected");
            assert.equal(rec.frontmatter.join("\n"), family.record.frontmatter(localCtx).join("\n"), `frontmatter mismatch: ${label}`);
            assert.equal(rec.body.join("\n"), family.record.body(localCtx).join("\n"), `body mismatch: ${label}`);
          } else {
            assert.equal(recordFromPack(pack, target, AT), null, "no record expected");
          }
        });
      }
    }
  }
}

// The sentinels must never leak into a substituted result (proves the four
// forms — raw / slug / JSON / at-date — are all replaced).
test("no sentinel survives substitution", () => {
  for (const family of FAMILIES) {
    const pack = renderFamilyPack(family, "standard", false);
    const all = [...contractFromPack(pack, "my real idea", AT), ...(recordFromPack(pack, "my real idea", AT)?.frontmatter ?? []), ...(recordFromPack(pack, "my real idea", AT)?.body ?? [])].join("\n");
    assert.doesNotMatch(all, /Sentinel9xZ/i, `${family.family}: raw/slug sentinel leaked`);
    assert.doesNotMatch(all, /0000-00-00/, `${family.family}: at-date sentinel leaked`);
  }
});
