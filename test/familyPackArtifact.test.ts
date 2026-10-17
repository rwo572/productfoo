import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  parseFamilyPackArtifact,
  renderFamilyPackArtifact,
} from "../src/conductor/familyPackArtifact.js";
import { ideateFamily } from "../src/conductor/families/ideate.js";

const artifactPath = path.resolve("skills/ideate/references/family-packs.md");

function mutateArtifact(mutator: (payload: any) => void): string {
  const artifact = renderFamilyPackArtifact(ideateFamily);
  const jsonStart = artifact.indexOf("\n", artifact.indexOf("```json")) + 1;
  const jsonEnd = artifact.lastIndexOf("\n```");
  const payload = JSON.parse(artifact.slice(jsonStart, jsonEnd));
  mutator(payload);
  return `${artifact.slice(0, jsonStart)}${JSON.stringify(payload)}${artifact.slice(jsonEnd)}`;
}

test("the committed signed-family resource is generated exactly from the canonical ideate family", () => {
  assert.equal(readFileSync(artifactPath, "utf8"), renderFamilyPackArtifact(ideateFamily));
});

test("every signed ideate family variant parses to the requested closed pack", () => {
  const artifact = renderFamilyPackArtifact(ideateFamily);
  for (const depth of ["fast", "standard", "deep"] as const) {
    for (const lean of [false, true]) {
      const pack = parseFamilyPackArtifact(artifact, "ideate", depth, lean);
      assert.equal(pack.family, "ideate");
      assert.equal(pack.depth, depth);
      assert.equal(pack.lean, lean);
      assert.equal(pack.recordDir, "ideas");
      assert.equal(pack.skillRef, "ideate");
      assert.ok(pack.contract.length > 10);
    }
  }
});

test("a signed but unsafe family pack cannot escape the caller project", () => {
  const hostile = renderFamilyPackArtifact(ideateFamily).replaceAll(
    '"recordDir":"ideas"',
    '"recordDir":"../outside"',
  );
  assert.throws(
    () => parseFamilyPackArtifact(hostile, "ideate", "standard", false),
    /invalid signed family-pack artifact/,
  );
});

test("signed family-pack gates must match the closed executable schema", () => {
  const cases = [
    mutateArtifact((payload) => { payload.variants["standard:0"].gates = []; }),
    mutateArtifact((payload) => { payload.variants["standard:0"].gates = [{}]; }),
    mutateArtifact((payload) => {
      payload.variants["standard:0"].gates = [{ type: "unknown", check: "unknown" }];
    }),
    mutateArtifact((payload) => {
      payload.variants["standard:0"].gates[1].pattern = "(a+)+$";
    }),
    mutateArtifact((payload) => {
      payload.variants["standard:0"].gates.push({
        type: "section-present",
        check: "unsafe-heading",
        heading: "(",
        detail: "unsafe heading present",
        failDetail: "unsafe heading missing",
      });
    }),
    mutateArtifact((payload) => {
      payload.variants["standard:0"].gates.push({
        type: "section-present",
        check: "complex-heading",
        heading: "(.+)+",
        detail: "complex heading present",
        failDetail: "complex heading missing",
      });
    }),
  ];
  for (const artifact of cases) {
    assert.throws(
      () => parseFamilyPackArtifact(artifact, "ideate", "standard", false),
      /invalid signed family-pack artifact/,
    );
  }
});

test("an invalid unselected variant refuses the complete signed family-pack artifact", () => {
  const artifact = mutateArtifact((payload) => {
    payload.variants["fast:1"].gates = [{}];
  });
  assert.throws(
    () => parseFamilyPackArtifact(artifact, "ideate", "standard", false),
    /invalid signed family-pack artifact/,
  );
});
