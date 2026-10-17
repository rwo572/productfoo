import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The posture flipped at T-008 of the open-source transition: the public
// release ships under Apache-2.0. The old checks guarded the closed alpha
// against a permissive-license leak; these guard the open-source release
// against the inverse drift — a LICENSE that stops being the canonical
// Apache-2.0 text, a package declaration that contradicts the file in its own
// tarball, or public-publish plumbing switched on before the attended cutover
// (T-010) turns it on deliberately.
//
// A license is not a style choice you can drift on: the file travels inside
// every tarball, and a wrong one is either an unenforceable secrecy claim or
// an unintended grant.

test("LICENSE is the canonical Apache-2.0 text", () => {
  const license = readFileSync("LICENSE", "utf8");
  assert.match(license, /Apache License/);
  assert.match(license, /Version 2\.0, January 2004/);
  assert.match(
    license,
    /APPENDIX: How to apply the Apache License to your work/,
    "the canonical appendix must survive — it is what makes the file recognizable as Apache-2.0"
  );
  // The secrecy posture lives in history, not in the shipped license: no
  // proprietary notices, no "not open source" carve-outs, no confidentiality
  // clauses swallowing what the license just granted.
  for (const marker of [/NOT open source/i, /proprietary/i, /confidential/i]) {
    assert.doesNotMatch(license, marker, `LICENSE must not carry the old secrecy posture — found ${marker}`);
  }
});

test("package.json declares the open-source license and does not pre-configure public publishing", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    license?: string;
    publishConfig?: { access?: string };
  };
  assert.equal(
    pkg.license,
    "Apache-2.0",
    "the npm declaration must match the LICENSE file in the same tarball"
  );
  assert.notEqual(
    pkg.publishConfig?.access,
    "public",
    "public publishing is configured at the attended cutover (T-010), not before"
  );
});

test("the alpha agreement says use-it-don't-republish, in the tester's language", () => {
  // The agreement is the document a private-alpha tester actually reads, and
  // it still governs private distribution until the cutover retires it. The
  // public LICENSE above governs the public release; both must stay honest.
  // Retirement takes the form of the file's absence in the public tree, so a
  // missing agreement is the post-cutover posture, not a failure.
  let agreement: string;
  try {
    agreement = readFileSync("ALPHA-AGREEMENT.md", "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  assert.match(agreement, /confidential/i);
  assert.match(agreement, /not open source/i);
  assert.match(agreement, /republish/i);
  // ...and it must still promise the tester their own work product is theirs.
  assert.match(agreement, /productfoo claims none of it/i);
});
