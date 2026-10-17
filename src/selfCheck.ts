import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./errorTaxonomy.js";
import { FOO_COMMAND_CONTRACT, validateCommandDocs, validateCommittedLaunchers } from "./commandContract.js";
import { gitRunOrNull } from "./gitRun.js";
import { commitTrailerSignal } from "./specLinkedCommits.js";
import { PII_PROFILE, scanText } from "./redactEngine.js";
import { loadRepoAllowlist, REDACT_ALLOW_FILE } from "./redactConfig.js";
import { ARMED_LOOP_STATES, loadLoopContracts } from "./loopContracts.js";
import { estimateLoopBudget, handshakeFloorUsd, hasExternalSources, loadPricing } from "./loopBudget.js";
import {
  allowlistDigest,
  loadScanCache,
  saveScanCache,
  SCAN_DETECTOR_VERSION,
  type CachedFinding,
  type ScanCacheEntry,
} from "./selfCheckCache.js";

// foo self check makes foo honor the contract it ships: the only things that
// block are the narrow, objective boundaries (B1 safety, B2 spec identity,
// B4 autonomy). Everything else is a signal: surfaced for judgment, never an
// automatic stop.

export type SelfCheckResult = { output: string; exitCode: number };

type Finding = { id: string; message: string };

const SECRET_NAME = /(^|[._-])(secret|secrets|credential|credentials|transcript|transcripts)([._-]|$)/i;
const SECRET_EXT = /\.(env|key|pem|pfx|p12)$/i;

// B1 for feedback content (feedback_triage_v0 RISK-001). A feedback document is
// raw private material about a named person, so it may not be tracked until it
// has been through the `pii` profile.
//
// Recognising feedback content is deliberately NARROW, and it is the whole
// design decision here. Matching on the word "feedback" anywhere would fire on
// src/feedback.ts and every skill that mentions the word — a gate that fires on
// the mention of a risk rather than the risk, which is the failure this repo has
// now learned four times. So a tracked file is feedback content only when it
// says so, or when it sits in a directory that exists to hold it:
//   1. it carries an explicit `foo-feedback: true` marker line (what
//      `foo triage-feedback` will write), or
//   2. it is a .md/.txt document inside a directory named `feedback`.
// Everything else — including source files about feedback — is untouched.
const FEEDBACK_DOC_EXT = /\.(md|txt)$/i;
const FEEDBACK_MARKER = /^\s*(?:#\s*)?foo-feedback:\s*true\s*$/im;

function isFeedbackContent(file: string, text: string): boolean {
  if (FEEDBACK_MARKER.test(text)) return true;
  return FEEDBACK_DOC_EXT.test(file) && file.split("/").slice(0, -1).includes("feedback");
}

function trackedFiles(root: string): string[] | null {
  const out = gitRunOrNull(["ls-files"], { cwd: root });
  if (out === null) return null;
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

// Crude binary guard: a NUL byte in the first chunk means skip (not text).
function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

// B1 — never commit raw private source material. Two layers: (1) productfoo's local
// state, legacy private scratch paths, and secret-shaped filenames must not be
// tracked; (2) content-aware
// (prompt_redaction_safety_v0 T-003) — scan tracked text for high-confidence
// secrets via the redaction engine, honoring the repo allowlist and inline
// `foo-redact: allow` pragmas. High-confidence only blocks (D-003); findings
// are metadata-only (R-007). The commit-time enforcement is `foo self gate`.
//
// The content scan is incremental (cli_performance_v0 R-003/D-003): per-file
// scan results are cached under the machine state dir, keyed on git HEAD +
// allowlist digest + detector-set version, with each file keyed on
// (mtime, size). Any mismatch reads as cold — a full scan, which is exactly
// what a first run or a CI runner does. HEAD is part of the key because a
// commit (checkout, rebase) can rewrite content in place without touching
// working-tree mtimes.
//
// Correctness is the bar (B1): a secret added to any tracked file changes that
// file's (mtime, size), so the next run rescans it and still reports it. The
// cache holds scan metadata only — detector names, line numbers, mtime, size —
// never file contents or matched values.

// One file's content-scan outcome. Cacheable as scan metadata only (D-003):
// detector names and line numbers, never contents or matched values.
type FileScan = { skipped?: "large" | "binary"; findings: CachedFinding[]; pii: CachedFinding[] | null };

// The two B1 messages, built in exactly one place so a cached finding and a
// live scan produce byte-identical output.
function secretFindingMessage(file: string, f: CachedFinding): string {
  return `high-confidence ${f.detector} in ${file}:${f.line} — redact (\`foo redact\`) or mark the line with a foo-redact:allow pragma`;
}
function piiFindingMessage(file: string, f: CachedFinding): string {
  return `unredacted personal detail (${f.detector}) in tracked feedback content ${file}:${f.line} — run \`foo redact ${file} --profile secrets,pii --write\` before tracking it`;
}

function pushFileFindings(findings: Finding[], file: string, scan: FileScan): void {
  for (const f of scan.findings) {
    findings.push({ id: "B1", message: secretFindingMessage(file, f) });
  }
  if (scan.pii === null) return;
  for (const f of scan.pii) {
    findings.push({ id: "B1", message: piiFindingMessage(file, f) });
  }
}

function scanTrackedFile(absPath: string, relPath: string, allowlist: string[]): FileScan | null {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null; // tracked but unreadable (deleted, permissions) — same skip as before
  }
  if (buf.length > 512 * 1024) return { skipped: "large", findings: [], pii: null };
  if (!isProbablyText(buf)) return { skipped: "binary", findings: [], pii: null };
  const text = buf.toString("utf8");
  const findings: CachedFinding[] = [];
  for (const f of scanText(text, { allowlist }).findings) {
    if (f.confidence === "high") findings.push({ detector: f.detector, line: f.line });
  }
  // Feedback content gets the pii profile on top of the secrets scan (only
  // high-confidence personal identifiers block — see the isFeedbackContent
  // note above). `pii: null` records "not feedback content" so the warm path
  // reproduces the exact decision without re-reading.
  let pii: CachedFinding[] | null = null;
  if (isFeedbackContent(relPath, text)) {
    pii = [];
    for (const f of scanText(text, { allowlist, profiles: [PII_PROFILE] }).findings) {
      if (f.confidence === "high") pii.push({ detector: f.detector, line: f.line });
    }
  }
  return { findings, pii };
}

function statSafe(absPath: string): { mtimeMs: number; size: number } | null {
  try {
    // statSync (not lstat): readFileSync follows symlinks, so the content key
    // must describe the target, not the link.
    const st = statSync(absPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

// A cache entry is a hit only when the file it describes is unchanged on disk:
// same mtime, same size. Anything else reads as cold — a rescan.
function cacheHit(absPath: string, entry: ScanCacheEntry): boolean {
  const st = statSafe(absPath);
  return st !== null && st.mtimeMs === entry.mtimeMs && st.size === entry.size;
}

function sameEntries(a: Record<string, ScanCacheEntry>, b: Record<string, ScanCacheEntry>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

function checkSafety(root: string, tracked: string[] | null, full: boolean): { findings: Finding[]; verified: boolean } {
  if (!tracked) return { findings: [], verified: false };

  const findings: Finding[] = [];
  for (const file of tracked) {
    const base = path.basename(file);
    if (file === ".foo" || file.startsWith(".foo/")) {
      findings.push({ id: "B1", message: `tracked file under local productfoo state: ${file}` });
    } else if (["docs/pitch", "docs/playbooks", "docs/research"].some((prefix) => file === prefix || file.startsWith(`${prefix}/`))) {
      findings.push({ id: "B1", message: `tracked file under legacy private scratch: ${file}` });
    } else if (SECRET_NAME.test(base) || SECRET_EXT.test(base)) {
      findings.push({ id: "B1", message: `tracked file looks like raw private material: ${file}` });
    }
  }

  const allowlist = loadRepoAllowlist(root);
  const head = gitRunOrNull(["rev-parse", "HEAD"], { cwd: root })?.trim() ?? null;
  const allowDigest = allowlistDigest(root, REDACT_ALLOW_FILE);
  // --full rescans every tracked file (the first-run/CI path, on demand) — but
  // it still records results, so it doubles as a cache refresh.
  const cache = full ? null : loadScanCache(root, head, SCAN_DETECTOR_VERSION, allowDigest);
  // Caching is on whenever the run is keyable (HEAD known) — a cold run records
  // entries too, that is how the cache warms. `cache` being null only means no
  // prior results to reuse.
  const caching = head !== null;
  const entries: Record<string, ScanCacheEntry> = {};
  for (const file of tracked) {
    if (file === REDACT_ALLOW_FILE) continue; // the allowlist itself lists secret-shaped values
    const abs = path.join(root, file);
    if (cache) {
      const cached = cache.entries[file];
      if (cached && cacheHit(abs, cached)) {
        entries[file] = cached;
        pushFileFindings(findings, file, cached);
        continue;
      }
    }
    const scan = scanTrackedFile(abs, file, allowlist);
    if (scan === null) continue; // unreadable — same skip as before, nothing to cache
    if (caching) {
      const st = statSafe(abs);
      if (st) entries[file] = { ...scan, mtimeMs: st.mtimeMs, size: st.size };
    }
    pushFileFindings(findings, file, scan);
  }
  // Skip the rewrite when nothing changed: a warm run over an unchanged tree
  // stays read-only. `repo` is resolved so the same repo reached as "." and as
  // an absolute path shares one cache file and one validity check.
  if (caching && (cache === null || !sameEntries(entries, cache.entries))) {
    saveScanCache({
      schema_version: 1,
      repo: path.resolve(root),
      head,
      detector_version: SCAN_DETECTOR_VERSION,
      allowlist_digest: allowDigest,
      entries,
    });
  }
  return { findings, verified: true };
}

function specHomes(root: string): string[] {
  const homes: string[] = [];
  for (const dir of ["specs", "examples"]) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const specPath = path.join(base, entry.name, "spec.md");
      if (existsSync(specPath)) homes.push(specPath);
    }
  }
  return homes;
}

// B2 — every committed spec.md has a present, unique Spec ID, read from YAML
// frontmatter (`spec_id`, canonical per T-013) or the transitional `Spec ID:`
// line.
function specIdFor(specText: string): string | null {
  if (specText.startsWith("---")) {
    const end = specText.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = specText.slice(3, end).match(/^spec_id:\s*(\S+)\s*$/m);
      if (fm) return fm[1];
    }
  }
  const line = specText.match(/^Spec ID:\s*(\S+)\s*$/m);
  return line ? line[1] : null;
}

function checkSpecIdentity(root: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  for (const specPath of specHomes(root)) {
    const rel = path.relative(root, specPath);
    const id = specIdFor(readFileSync(specPath, "utf8"));
    if (!id) {
      findings.push({ id: "B2", message: `${rel} is missing a Spec ID` });
      continue;
    }
    const prior = seen.get(id);
    if (prior) findings.push({ id: "B2", message: `duplicate Spec ID ${id}: ${rel} and ${prior}` });
    else seen.set(id, rel);
  }
  return findings;
}

// B4 — autonomy. An autonomous loop needs a well-formed contract AND an agreed
// budget. This boundary used to be honor-system: `foo loop check` enforced it,
// but nothing invoked `foo loop check` — no hook, no skill, and `self check`
// itself only covered B1/B2. So a packet could carry a scheduled, acting,
// unbudgeted loop and every automated gate in the repo would pass it. B1 gets a
// fail-closed pre-commit hook; B4 got a command you had to remember to type.
//
// Now B4 is checked wherever B1 and B2 are. Strictly READ-ONLY: `foo loop check`
// may WRITE an auto-approved budget, but a checker must never mutate the thing it
// is checking — so this re-derives the same decision purely and reports it.
//
// Two things keep this from being merely strict:
//   1. Only an ARMED loop blocks. B4 governs "any loop or autonomous action" — a
//      `draft` contract takes no action, so drafting one must not make the repo
//      un-committable. A draft is a signal; the moment it is armed (ready/active)
//      the budget handshake becomes a hard boundary. That is exactly when the
//      money can start being spent.
//   2. An unbudgeted loop that provably prices BELOW the handshake floor is a
//      signal, not a block — cheap work keeps its momentum (B4's size-aware rule).
// Otherwise it blocks: malformed contract, or armed + unbudgeted + unable to prove
// it is cheap (unpriced, unmeasurable sources, or genuinely at/above the floor).
function checkAutonomy(root: string): { boundaries: Finding[]; signals: Finding[] } {
  const boundaries: Finding[] = [];
  const signals: Finding[] = [];
  const specsDir = path.join(root, "specs");
  if (!existsSync(specsDir)) return { boundaries, signals };

  const floor = handshakeFloorUsd();
  const pricing = loadPricing(root);

  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packetDir = path.join(specsDir, entry.name);
    if (!existsSync(path.join(packetDir, "loops.yaml"))) continue;

    let loops;
    try {
      loops = loadLoopContracts(packetDir).loops;
    } catch (error) {
      boundaries.push({
        id: "B4",
        message: `specs/${entry.name}/loops.yaml is a malformed loop contract: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const loop of loops) {
      if (loop.budget?.agreed) continue; // handshake already done
      const estimate = estimateLoopBudget({
        packetDir,
        sources: loop.observe.sources,
        pricing,
        unit: "usd",
        budget: loop.budget,
      });
      const unmeasurable = hasExternalSources(estimate.measured);
      const belowFloor = estimate.priced && !unmeasurable && estimate.usd.expected < floor;

      if (belowFloor) {
        signals.push({
          id: "signal",
          message: `specs/${entry.name} loop ${loop.id} has no agreed budget but prices below the $${floor.toFixed(2)} floor ($${estimate.usd.expected.toFixed(2)} expected) — foo loop check will auto-approve it${ARMED_LOOP_STATES.has(loop.status) ? "" : " once it is armed"}`,
        });
        continue;
      }

      // Never quote a dollar figure for an unmeasurable loop — its cost is unknown,
      // and a number here would be invented.
      const why = unmeasurable
        ? "its cost is unknown (it reads sources productfoo cannot size), so it can never prove it is cheap"
        : !estimate.priced
          ? "its cost could not be priced"
          : `it prices at $${estimate.usd.expected.toFixed(2)} expected, at or above the $${floor.toFixed(2)} floor`;
      const fix = unmeasurable
        ? `run foo loop estimate specs/${entry.name} --agree --limit <usd> (you set the cap; productfoo will not invent one)`
        : `run foo loop estimate specs/${entry.name} --agree`;

      // A draft loop cannot act, so it cannot spend — surface it, don't block the
      // repo. Arming it (status: ready|active) is what makes the handshake due.
      if (!ARMED_LOOP_STATES.has(loop.status)) {
        signals.push({
          id: "signal",
          message: `specs/${entry.name} loop ${loop.id} (${loop.status}) has no agreed budget — ${why}; budget it before arming it (${fix})`,
        });
        continue;
      }

      boundaries.push({
        id: "B4",
        message: `specs/${entry.name} loop ${loop.id} is ${loop.status} (armed) with no agreed budget and ${why} — ${fix}`,
      });
    }
  }
  return { boundaries, signals };
}

// Signal — skill structure and runtime-neutral wording. Surfaced, never blocking.
// The command surface is what a user reads before they run anything, so a
// description that no longer matches the contract is a live lie in every
// harness's picker. Both halves are checked: `commands/*.md` (the docs) and the
// committed launchers (`.claude/commands/foo/*`, plugin skills).
//
// A signal, not a boundary — AGENTS.md keeps boundaries narrow (B1/B2/B4), and
// stale copy does not cross one. `foo commands validate` is the gating check;
// this makes the drift visible in the run people actually do.
function commandSurfaceSignals(root: string, tracked: string[] | null): Finding[] {
  const findings: Finding[] = [];
  const docs = validateCommandDocs(root);
  for (const d of docs.drift) {
    findings.push({
      id: "signal",
      message: `command contract drift: ${d.id}.${d.field} in ${
        FOO_COMMAND_CONTRACT.find((c) => c.id === d.id)?.docs_path ?? "docs"
      } — run \`foo commands validate\` for the detail.`,
    });
  }
  if (tracked === null) return findings; // no git: the same posture B1 takes.
  const launchers = validateCommittedLaunchers(root, tracked);
  for (const d of launchers.drift) {
    findings.push({
      id: "signal",
      message: `committed launcher drift: ${d.file} advertises ${d.field} "${
        d.launcher ?? "(missing)"
      }" but the contract says "${d.contract}" — re-run \`foo agent setup\` and commit the result.`,
    });
  }
  return findings;
}

function skillSignals(root: string): Finding[] {
  const skillsDir = path.join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  const registry = existsSync(path.join(skillsDir, "skill-registry.yaml"))
    ? readFileSync(path.join(skillsDir, "skill-registry.yaml"), "utf8")
    : "";
  const forbidden = [
    "AskUserQuestion",
    "TodoWrite",
    "Task tool",
    "Skill tool",
    "WebFetch",
    "ToolSearch",
    "mcp__",
    "Claude Code",
  ];
  const findings: Finding[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const skillPath = path.join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const text = readFileSync(skillPath, "utf8");
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) findings.push({ id: "signal", message: `skill folder name not kebab-case: ${name}` });
    if (!text.startsWith("---\n")) findings.push({ id: "signal", message: `${name}/SKILL.md missing frontmatter` });
    if (!text.includes(`name: ${name}`)) findings.push({ id: "signal", message: `${name}/SKILL.md frontmatter name mismatch` });
    if (!text.includes("## Usage")) findings.push({ id: "signal", message: `${name}/SKILL.md missing ## Usage` });
    if (!text.includes("## Error Handling")) findings.push({ id: "signal", message: `${name}/SKILL.md missing ## Error Handling` });
    if (registry && !registry.includes(`id: "${name}"`)) findings.push({ id: "signal", message: `${name} missing from skill-registry.yaml` });
    text.split(/\r?\n/).forEach((line, index) => {
      for (const token of forbidden) {
        if (line.includes(token)) findings.push({ id: "signal", message: `${name}/SKILL.md:${index + 1} runtime-specific wording: ${token}` });
      }
    });
  }
  return findings;
}

/** Supported checks for this build. */
export function selfUsage(): string {
  return [
    "foo self — check foo against its own boundaries.",
    "",
    "  foo self check [--json] [--full]",
    "                            run the boundary checks (B1 safety, B2 spec identity, B4 autonomy).",
    "                            Results are cached per file (mtime, size) under the machine state dir;",
    "                            --full rescans every tracked file and refreshes the cache.",
    "  foo self gate             fail-closed secret gate (used as the pre-commit hook)",
    "  foo self which            which build is running, and from where",
    "  foo self help             this",
    "",
    "",
  ].join("\n");
}

export function runSelfCheck(root: string, command: string | undefined, args: string[]): SelfCheckResult {
  // A typo is not a crash. Throwing a bare Error here classified as command_error, which
  // `pages()` treats as report-worthy — so `foo self help` manufactured a bug report about
  // itself. UsageError classifies as usage_error: told to the human, never filed.
  if (command && command !== "check") {
    throw new UsageError(`unknown self command: ${command}\n\n${selfUsage()}`, "E_BAD_FLAG");
  }
  const asJson = args.includes("--json");
  const full = args.includes("--full");

  // One `git ls-files` per run, shared by the B1 scan and the launcher-surface
  // signals — the scan used to spawn it twice (cli_performance_v0 R-003).
  const tracked = trackedFiles(root);
  const safety = checkSafety(root, tracked, full);
  const autonomy = checkAutonomy(root);
  const boundaries = [...safety.findings, ...checkSpecIdentity(root), ...autonomy.boundaries];
  const signals = [
    ...autonomy.signals,
    ...skillSignals(root),
    ...commandSurfaceSignals(root, tracked),
    ...commitTrailerSignal(root).map((message) => ({ id: "signal", message })),
  ];
  const exitCode = boundaries.length > 0 ? 1 : 0;

  if (asJson) {
    const payload = {
      schema_version: "0.1",
      blocked: exitCode !== 0,
      safety_verified: safety.verified,
      boundaries,
      signals,
    };
    return { output: `${JSON.stringify(payload, null, 2)}\n`, exitCode };
  }

  const lines = [
    "foo self check",
    "",
    "Boundaries (block):",
    ...(boundaries.length === 0
      ? ["  none — B1 safety, B2 spec identity, and B4 autonomy hold."]
      : boundaries.map((f) => `  [${f.id}] ${f.message}`)),
    ...(safety.verified ? [] : ["  note: B1 could not be verified (git unavailable); treating as advisory."]),
    "",
    "Signals (surface, do not block):",
    ...(signals.length === 0 ? ["  none."] : signals.map((f) => `  - ${f.message}`)),
    "",
    exitCode === 0 ? "Result: boundaries hold." : "Result: boundary violation — resolve before committing.",
    "",
  ];
  return { output: lines.join("\n"), exitCode };
}
