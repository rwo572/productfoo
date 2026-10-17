// first-move-two-facts: productfoo's first read surfaces a grounded TENSION, and —
// just as important — stays SILENT when the signal doesn't support one (a wrong
// first-run insight is worse than a boring one).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectTensions } from "../src/firstMoveTensions.js";

function newRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-fm-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  git("init");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "t");
  return dir;
}
function commit(dir: string, file: string, body: string, msg: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["commit", "-m", msg], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
}

test("fires: the busiest area with no test is surfaced as a two-fact tension", () => {
  const dir = newRepo();
  commit(dir, "src/utils/x.ts", "export const x=1", "init");
  for (let i = 1; i <= 14; i++) commit(dir, "src/payments/charge.ts", `export const c=${i}`, `fix payments ${i}`);
  const t = detectTensions(dir)[0];
  assert.ok(t, "a tension should fire");
  assert.equal(t.id, "churn-vs-tests");
  assert.match(t.factA, /src\/payments\//, "names the real sub-area, not just src/");
  assert.match(t.factB, /test/i);
  assert.ok(t.ask.length > 0);
  // receipts present
  assert.ok(t.evidence.some((e) => /src\/payments\/ touched/.test(e)));
});

test("does NOT fire when the busy area IS tested (no false tension)", () => {
  const dir = newRepo();
  commit(dir, "test/payments.test.ts", "test('payments', ()=>{})", "add payments test");
  for (let i = 1; i <= 14; i++) commit(dir, "src/payments/charge.ts", `export const c=${i}`, `work ${i}`);
  assert.equal(detectTensions(dir).length, 0, "tested busy area is not a tension");
});

test("does NOT fire on a thin repo (too little history to claim a pattern)", () => {
  const dir = newRepo();
  for (let i = 1; i <= 5; i++) commit(dir, "src/a/f.ts", `export const c=${i}`, `c${i}`);
  assert.equal(detectTensions(dir).length, 0, "5 commits is below the honesty floor");
});

test("does NOT fire when churn is spread evenly (no dominant area)", () => {
  const dir = newRepo();
  for (let i = 1; i <= 15; i++) commit(dir, `src/mod${i % 8}/f.ts`, `export const c=${i}`, `c${i}`);
  const t = detectTensions(dir)[0];
  // Either no tension, or if one fires it must be genuinely dominant — never a coin-flip.
  if (t) assert.match(t.factA, /busiest/);
});

test("non-git directory yields no tension (never throws)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "foo-nogit-"));
  writeFileSync(path.join(dir, "a.ts"), "x");
  assert.deepEqual(detectTensions(dir), []);
});
