// bug-owner-autolog-v0: the owner-lane auto-logging engine behind `foo bug log`
// and the discovery signal bug destination (`foo discovery review <F-id>
// reassign --bug`). Dedupe-first, owner-gated, never silent.
//
// The dedupe stage is BLOCKING by construction, not by convention: the create
// path takes a `CreateVerdict` value that only `evaluateBugDedupe` returns, so
// a filing cannot be pipelined past the search the way the #521/#535 incident
// was — the search result must exist and be evaluated before create is even
// callable (R-002, D-001).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scrubDiagnostic } from "./bugCapture.js";

export type GhCall = { args: string[] };
export type GhExecResult = { ok: boolean; stdout: string; stderr: string };
export type GhExec = (args: string[]) => GhExecResult;

export const defaultGhExec: GhExec = (args) => {
  const run = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000 });
  if (run.error) return { ok: false, stdout: "", stderr: String(run.error.message ?? run.error) };
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

export type BugLogIntake = {
  /** Candidate issue title (pre-scrub). */
  title: string;
  /** Full markdown issue body (pre-scrub). */
  body: string;
  /** Text evaluated for dedupe matching. */
  search_text: string;
  /** Companion issue refs, e.g. ["#528", "#529"]. */
  refs: string[];
};

export type BugLogMatch = {
  issue_number: number;
  issue_url: string;
  issue_title: string;
  issue_state: string;
  score: number;
  matched_terms: string[];
};

export type BugLogStatus = "reproduced" | "filed" | "refused" | "retryable";

export type BugLogResult = {
  schema_version: "0.1";
  status: BugLogStatus;
  repo: string | null;
  issue_number: number | null;
  issue_url: string | null;
  match: BugLogMatch | null;
  withheld: string | null;
  errors: Array<{ code: string; message: string }>;
  next_actions: string[];
};

/** Per-run bounded-autonomy state (R-006): creation ceiling + title-hash guard. */
export type BugLogSession = {
  created: number;
  max_creates: number;
  title_hashes: Set<string>;
};

// The ceiling only restrains a loop if it counts creations that already
// happened in earlier invocations — a per-process counter resets to zero every
// run, so a loop that re-invokes the verb once per issue never trips it. The
// creation log below is the cross-invocation memory; the window keeps it a
// rolling budget (a filing last week is not this loop) rather than a lifetime
// cap that would eventually brick honest owner use.
const CREATE_WINDOW_SECONDS = 3600;

type BugCreateEntry = { at: number; repo: string };

function bugCreateLogPath(root: string): string {
  return path.join(root, ".foo", "bug-log-creates.json");
}

function createWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.FOO_BUG_LOG_WINDOW_SECONDS ?? CREATE_WINDOW_SECONDS);
  return (Number.isFinite(raw) && raw > 0 ? raw : CREATE_WINDOW_SECONDS) * 1000;
}

function readCreateEntries(root: string, env: NodeJS.ProcessEnv, now: number): BugCreateEntry[] {
  const file = bugCreateLogPath(root);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { creates?: unknown };
    const windowMs = createWindowMs(env);
    return (Array.isArray(raw.creates) ? raw.creates : [])
      .map((entry) => ({ at: Number((entry as BugCreateEntry)?.at), repo: String((entry as BugCreateEntry)?.repo ?? "") }))
      .filter((entry) => Number.isFinite(entry.at) && now - entry.at < windowMs);
  } catch {
    return [];
  }
}

/** Recent auto-creations for the configured owner repo, within the rolling window. */
export function recentBugCreateCount(root: string, env: NodeJS.ProcessEnv, now: number = Date.now()): number {
  const repo = (env.FOO_BUG_OWNER_REPO ?? "").trim();
  return readCreateEntries(root, env, now).filter((entry) => !repo || entry.repo === repo).length;
}

/** Records one auto-creation so the next invocation's ceiling counts it (R-006/RISK-002). */
export function recordBugCreate(root: string, env: NodeJS.ProcessEnv, repo: string, now: number = Date.now()): void {
  const entries = readCreateEntries(root, env, now);
  entries.push({ at: now, repo });
  const file = bugCreateLogPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ creates: entries }, null, 2)}\n`);
}

export function newBugLogSession(env: NodeJS.ProcessEnv, root?: string): BugLogSession {
  const raw = Number(env.FOO_BUG_LOG_MAX_CREATES ?? "3");
  // A malformed or non-positive ceiling disables creation rather than
  // inventing an unbounded one (bug-capsule-v0 ceiling precedent).
  const maxCreates = Number.isFinite(raw) && raw > 0 && Number.isInteger(raw) ? raw : 0;
  // Seed from the persisted creation log so the ceiling spans invocations.
  const created = root ? recentBugCreateCount(root, env) : 0;
  return { created, max_creates: maxCreates, title_hashes: new Set() };
}

type OwnerIssue = { number: number; title: string; state: string; url: string; body: string };

// --- Dedupe evaluation --------------------------------------------------------

const STOPWORDS = new Set(["about", "after", "again", "also", "because", "been", "before", "being", "between", "command", "could", "does", "every", "issue", "from", "have", "into", "just", "only", "should", "that", "then", "these", "they", "this", "those", "through", "using", "when", "where", "which", "will", "with", "without", "would"]);

// Mechanism tokens outrank symptom wording (R-002): the #521/#535 pair
// described one classifier defect in fully disjoint symptom vocabulary, but
// shared error codes, file names, and command tokens.
const MECHANISM_PATTERN = /\b(E_[A-Z][A-Z0-9_]+|[a-zA-Z][\w-]*\.(?:ts|js|mjs|py|yaml|yml|json|md)|foo\s+[a-z][a-z-]+(?:\s+[a-z][a-z-]+)?)\b/g;

function plainTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((token) => token.length >= 4 && !STOPWORDS.has(token)));
}

function mechanismTokens(text: string): Set<string> {
  return new Set([...text.matchAll(MECHANISM_PATTERN)].map((match) => match[1].toLowerCase().replace(/\s+/g, " ")));
}

export type DedupeVerdict = CommentVerdict | CreateVerdict;
export type CommentVerdict = { decision: "comment"; match: BugLogMatch };
/** Only `evaluateBugDedupe` constructs this; `createOwnerIssue` requires it. */
export type CreateVerdict = { decision: "create"; evaluated_issues: number; proof: "dedupe_evaluated" };

export function evaluateBugDedupe(intake: BugLogIntake, issues: OwnerIssue[]): DedupeVerdict {
  const intakePlain = plainTokens(intake.search_text);
  const intakeMechanism = mechanismTokens(intake.search_text);
  let best: BugLogMatch | null = null;
  for (const issue of issues) {
    const issueText = `${issue.title}\n${issue.body}`;
    const issuePlain = plainTokens(issueText);
    const issueMechanism = mechanismTokens(issueText);
    const mechanismShared = [...intakeMechanism].filter((token) => issueMechanism.has(token));
    const plainShared = [...intakePlain].filter((token) => issuePlain.has(token));
    const weightedOverlap = mechanismShared.length * 3 + plainShared.length;
    const weightedIntake = intakeMechanism.size * 3 + intakePlain.size;
    const score = weightedIntake === 0 ? 0 : weightedOverlap / weightedIntake;
    // The bar: concentrated overlap with mechanism agreement, or overwhelming
    // plain overlap. Tunable per the packet's open question; deterministic here.
    const matched = (score >= 0.35 && mechanismShared.length >= 1) || score >= 0.6;
    if (!matched) continue;
    if (!best || score > best.score) {
      best = {
        issue_number: issue.number,
        issue_url: issue.url,
        issue_title: issue.title,
        issue_state: issue.state,
        score: Number(score.toFixed(3)),
        matched_terms: [...mechanismShared, ...plainShared.slice(0, 8)],
      };
    }
  }
  if (best) return { decision: "comment", match: best };
  return { decision: "create", evaluated_issues: issues.length, proof: "dedupe_evaluated" };
}

// --- Intake builders ----------------------------------------------------------

function scrubOrNull(text: string, root: string): string | null {
  const scrubbed = scrubDiagnostic(text, root);
  return scrubbed.state === "collected" ? scrubbed.value : null;
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n")[0].trim().replace(/\s+/g, " ");
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function buildBugLogIntake(fields: { expected: string; actual: string; reproduction?: string; suggested?: string; refs?: string[] }): BugLogIntake {
  const refs = (fields.refs ?? []).filter((ref) => /^#\d+$/.test(ref));
  const body = [
    "## Expected",
    "",
    fields.expected.trim(),
    "",
    "## Actual",
    "",
    fields.actual.trim(),
    ...(fields.reproduction ? ["", "## Reproduction", "", fields.reproduction.trim()] : []),
    ...(fields.suggested ? ["", "## Suggested directions", "", fields.suggested.trim()] : []),
    ...(refs.length ? ["", "## Companions", "", refs.map((ref) => `- ${ref}`).join("\n")] : []),
    "",
    "_Filed by `foo bug log` (owner lane); dedupe searched state:all before this filing._",
  ].join("\n");
  return {
    title: firstLine(fields.actual, 90),
    body,
    search_text: [fields.expected, fields.actual, fields.reproduction ?? "", fields.suggested ?? ""].join("\n"),
    refs,
  };
}

/** Seeds the engine from a discovery inbox signal: headline → title candidate,
 *  paraphrase → evidence body with provenance. Signals are already sanitized
 *  paraphrases; provenance names the finding, call date, and attribution basis. */
export function buildSignalBugIntake(record: Record<string, unknown>): BugLogIntake {
  const paraphrase = String(record.paraphrase ?? "").trim();
  const colon = paraphrase.indexOf(":");
  const lead = colon > 0 && colon < 70 && !paraphrase.slice(0, colon).includes(".") ? paraphrase.slice(0, colon) : null;
  // Seeding rule (bug-owner-autolog-v0): the purpose-built `headline` field is the
  // intended title candidate. Fall back to the paraphrase kicker, then its first
  // sentence, only when no headline is present (#567). Normalize the headline with
  // firstLine (single line + 90-char cap) so a long/multi-line headline can't
  // produce a broken title GitHub rejects — matching every other title path here.
  const headline = String(record.headline ?? "").trim();
  const title = headline ? firstLine(headline, 90) : (lead ?? firstLine(paraphrase, 90));
  const provenance = [
    `- Signal: ${String(record.finding_id ?? "unknown")} (discovery inbox)`,
    `- Call date: ${String(record.completed_at ?? "unknown")}`,
    `- Attribution basis: scope ${String(record.inbox_scope_id ?? "unknown")}, evidence ${String(record.evidence_type ?? "unknown")}, confidence ${String(record.confidence ?? "unknown")}`,
    ...(typeof record.dissent === "string" && record.dissent ? [`- Dissent: ${record.dissent}`] : []),
  ];
  const body = [
    "## Evidence",
    "",
    paraphrase,
    "",
    "## Provenance",
    "",
    ...provenance,
    "",
    "_Filed from a discovery signal via `foo discovery review … --bug`; dedupe searched state:all before this filing._",
  ].join("\n");
  return { title, body, search_text: paraphrase, refs: [] };
}

// --- The engine ---------------------------------------------------------------

function normalizedTitleHash(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function bugLogRefusal(code: string, message: string, nextActions: string[], repo: string | null = null, withheld: string | null = null): BugLogResult {
  return { schema_version: "0.1", status: "refused", repo, issue_number: null, issue_url: null, match: null, withheld, errors: [{ code, message }], next_actions: nextActions };
}

function retryable(code: string, message: string, nextActions: string[], repo: string): BugLogResult {
  return { schema_version: "0.1", status: "retryable", repo, issue_number: null, issue_url: null, match: null, withheld: null, errors: [{ code, message }], next_actions: nextActions };
}

function createOwnerIssue(gh: GhExec, repo: string, title: string, body: string, verdict: CreateVerdict): GhExecResult {
  // `verdict` is the dedupe proof token — reaching here without an evaluated
  // search is a type error, and a malformed token fails closed at runtime.
  if (verdict.proof !== "dedupe_evaluated") return { ok: false, stdout: "", stderr: "dedupe verdict missing; refusing to create" };
  return gh(["issue", "create", "--repo", repo, "--title", title, "--body", body]);
}

export function runBugLog(options: {
  env: NodeJS.ProcessEnv;
  gh: GhExec;
  session: BugLogSession;
  intake: BugLogIntake;
  root: string;
}): BugLogResult {
  const { env, gh, session, intake, root } = options;

  // R-005: owner-lane gating. No configured repo, no action at all.
  const repo = (env.FOO_BUG_OWNER_REPO ?? "").trim();
  if (!repo) {
    return bugLogRefusal("E_BUG_OWNER_REPO", "The owner bug queue is not configured; nothing was searched or written.", ["Set the owner repository, then rerun: export FOO_BUG_OWNER_REPO=<owner>/<repo>"]);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return bugLogRefusal("E_BUG_OWNER_REPO", `FOO_BUG_OWNER_REPO must be <owner>/<repo>; got "${repo}". Nothing was searched or written.`, ["Fix the value, then rerun: export FOO_BUG_OWNER_REPO=<owner>/<repo>"]);
  }

  // Scrub everything before it can travel (RISK-005). A withheld scrub blocks
  // the whole filing for a person rather than guessing.
  const title = scrubOrNull(intake.title, root);
  const body = scrubOrNull(intake.body, root);
  if (title === null || body === null) {
    return bugLogRefusal("E_BUG_SCRUB_WITHHELD", "Scrubbing could not prove the intake is secret- and path-free; nothing was written.", ["Rewrite the ambiguous fragment and rerun foo bug log."], repo);
  }

  // Cut line: never post to a public repository.
  const view = gh(["repo", "view", repo, "--json", "visibility,isPrivate"]);
  if (!view.ok) {
    return retryable("E_BUG_GH_UNAVAILABLE", "Could not reach GitHub through gh; nothing was searched or written.", ["Check gh auth status (gh auth login) and network, then rerun the same command."], repo);
  }
  let isPrivate = false;
  try {
    isPrivate = Boolean((JSON.parse(view.stdout) as { isPrivate?: boolean }).isPrivate);
  } catch {
    return retryable("E_BUG_GH_UNAVAILABLE", "gh returned an unreadable repository description; nothing was written.", ["Rerun the same command; if it persists, check gh --version."], repo);
  }
  if (!isPrivate) {
    return bugLogRefusal("E_BUG_REPO_PUBLIC", `${repo} is public; the owner lane only writes to private repositories. Nothing was written.`, ["Point FOO_BUG_OWNER_REPO at the private owner tracker and rerun."], repo);
  }

  // R-002: the BLOCKING dedupe stage. state:all because duplicates get closed.
  const listed = gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", "number,title,state,url,body"]);
  if (!listed.ok) {
    return retryable("E_BUG_SEARCH_FAILED", "The dedupe search failed, so no issue was created or commented — the search result must gate the filing.", ["Rerun the same command once gh can list issues in the owner repository."], repo);
  }
  let issues: OwnerIssue[] = [];
  try {
    const parsed = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    issues = parsed.map((issue) => ({ number: Number(issue.number), title: String(issue.title ?? ""), state: String(issue.state ?? ""), url: String(issue.url ?? ""), body: String(issue.body ?? "") }));
  } catch {
    return retryable("E_BUG_SEARCH_FAILED", "The dedupe search returned unreadable results, so no issue was created or commented.", ["Rerun the same command."], repo);
  }

  const verdict = evaluateBugDedupe({ ...intake, title, body }, issues);

  if (verdict.decision === "comment") {
    const match = verdict.match;
    const comment = [
      "Reproduced by `foo bug log` (owner lane).",
      "",
      body,
      "",
      `_Dedupe match evidence: score ${match.score}, shared terms: ${match.matched_terms.slice(0, 6).join(", ") || "none listed"}. A comment is the ceiling of automatic action — nothing was closed or edited._`,
    ].join("\n");
    const commented = gh(["issue", "comment", String(match.issue_number), "--repo", repo, "--body", comment]);
    if (!commented.ok) {
      return retryable("E_BUG_COMMENT_FAILED", `The reproduction comment on #${match.issue_number} failed; nothing else was written.`, ["Rerun the same command."], repo);
    }
    session.title_hashes.add(normalizedTitleHash(title));
    return {
      schema_version: "0.1",
      status: "reproduced",
      repo,
      issue_number: match.issue_number,
      issue_url: match.issue_url,
      match,
      withheld: null,
      errors: [],
      next_actions: [`Tell the owner: this defect reproduces existing issue ${match.issue_url} (${match.issue_state.toLowerCase()}); the reproduction context was added as a comment.`],
    };
  }

  // R-006: title-hash duplicate guard against existing issues and this run.
  const titleHash = normalizedTitleHash(title);
  const existingTitleHashes = new Set(issues.map((issue) => normalizedTitleHash(issue.title)));
  if (session.title_hashes.has(titleHash) || existingTitleHashes.has(titleHash)) {
    return bugLogRefusal("E_BUG_DUPLICATE_TITLE", `An issue with this normalized title already exists in ${repo}; creation was withheld.`, ["Retitle the defect if it is genuinely different, or comment on the existing issue by hand."], repo, `duplicate title: ${title}`);
  }

  // R-006: creation ceiling. session.created is seeded from the persisted
  // creation log, so this bounds a loop across invocations, not just within one
  // process (RISK-002) — rerunning in a fresh invocation no longer resets it.
  if (session.created >= session.max_creates) {
    return bugLogRefusal("E_BUG_CREATE_CEILING", `The recent-creation ceiling (${session.max_creates}) is reached; this filing was withheld, not lost.`, [`Withheld: "${title}". File it by hand, or wait for the creation window to clear before the verb files automatically again.`], repo, `ceiling reached: ${title}`);
  }

  const created = createOwnerIssue(gh, repo, title, body, verdict);
  if (!created.ok) {
    return retryable("E_BUG_CREATE_FAILED", "Issue creation failed after dedupe cleared it; nothing was recorded.", ["Rerun the same command."], repo);
  }
  const url = created.stdout.trim().split("\n").pop() ?? "";
  const numberMatch = /\/issues\/(\d+)\s*$/.exec(url);
  session.created += 1;
  session.title_hashes.add(titleHash);
  recordBugCreate(root, env, repo);
  return {
    schema_version: "0.1",
    status: "filed",
    repo,
    issue_number: numberMatch ? Number(numberMatch[1]) : null,
    issue_url: url || null,
    match: null,
    withheld: null,
    errors: [],
    next_actions: [`Tell the owner: a new defect was filed at ${url || repo} after the dedupe search over ${verdict.evaluated_issues} issue(s) found no match.`],
  };
}
