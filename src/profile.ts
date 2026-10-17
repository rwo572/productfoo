import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { agentLogPath, nextAgentEventId, readAgentTelemetryConfig, resolveTesterId } from "./commands/agent.js";
import { readJson } from "./jsonFile.js";
import { fileStatKey, readMemoized, writeMemoized, type MemoEntry } from "./processMemo.js";

// init-onboarding-survey-v0: the first-run profile. productfoo reads the project,
// then reads you — a few quick, skippable questions inside the once-ever
// `foo init` moment builds a local profile that personalizes foo. Bounded
// picks may enter the local usage log; no profile data is uploaded. The profile
// is gitignored local state (.foo/), same home as
// the first-run marker.
//
// T-004 (dogfood 2026-07-11): answers parse leniently ("1, 3", "product and
// agent"), roles are plural, productfoo echoes back what it understood in its own
// Read: grammar, the close line tells the truth about what saved, and
// `foo profile` shows or redoes the whole thing. The first real user answered
// "1, 3" and v1 silently dropped it — never again.

export type ProfileRole = "product" | "engineer" | "designer" | "founder" | "executive";

// Roles that mean "lead with the product view": people who think in outcomes,
// agreements, and proof before code. Engineers and designers keep the repo
// read first (their raw surfaces are the point).
export const PRODUCT_VIEW_ROLES: readonly ProfileRole[] = ["product", "founder", "executive"];

export interface FooProfile {
  roles?: ProfileRole[];
  /** #622: every coding agent the person builds with, in the order given. */
  harnesses?: string[];
  /** The first of `harnesses`, kept for readers of older profiles and the picks report. */
  harness?: string;
  building?: string; // free text; never leaves the machine (R-004 / B1)
  team?: "just-me" | "small-team" | "larger-org";
  answered_at: string;
}

// machine-wide-profile-v0: how you work is a fact about YOU, not about a repo —
// the same reasoning that already puts the tester id under the home dir (one
// human, one identity). So the profile's home is machine-wide by default:
// answer once, and every project foo touches leads with your view. A per-repo
// file is still honored as a deliberate override when someone wants a different
// lens in one repo. FOO_STATE_DIR overrides the home for tests (mirrors the
// tester-id resolution exactly).
function machineStateDir(): string {
  return process.env.FOO_STATE_DIR?.trim() || path.join(homedir(), ".foo");
}

export function machineProfilePath(): string {
  return path.join(machineStateDir(), "profile.json");
}

// The per-repo override path. Not written by the survey (which is about the
// person); present only when someone deliberately wants a repo-specific lens.
export function profilePath(root: string): string {
  return path.join(root, ".foo", "profile.json");
}

function readProfileFile(file: string): FooProfile | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = readJson<FooProfile & { role?: ProfileRole }>(file);
    if (!parsed || typeof parsed !== "object") return null;
    // v1 files carried a single `role`; fold it into `roles` so nobody's
    // first answer is lost to a schema change.
    if (!parsed.roles && parsed.role) parsed.roles = [parsed.role];
    return parsed;
  } catch {
    return null; // a corrupt profile never breaks a read (R-005)
  }
}

// Precedence: a repo override wins over the machine-wide profile. This is the
// same shape as telemetry (per-repo file can override the machine default).
// Memoized per process (cli_performance-v0 R-002): profile reads happen on
// several surfaces per invocation; the (mtime, size) key keeps an external
// write — a test fixture, `foo profile redo` from another process — honest.
const profileCache = new Map<string, MemoEntry<FooProfile | null>>();

export function loadProfile(root: string): FooProfile | null {
  const repoFile = profilePath(root);
  const machineFile = machineProfilePath();
  const key = `${fileStatKey(repoFile)}|${fileStatKey(machineFile)}`;
  const cached = readMemoized(profileCache, root, key);
  if (cached !== undefined) return cached;
  const value = readProfileFile(repoFile) ?? readProfileFile(machineFile);
  writeMemoized(profileCache, root, key, value);
  return value;
}

// Where the survey and `foo profile redo` write: machine-wide, so the answer
// follows the person across every project. `scope: "repo"` writes the override.
export function saveProfile(profile: FooProfile, opts?: { scope?: "machine" | "repo"; root?: string }): void {
  const file = opts?.scope === "repo" && opts.root ? profilePath(opts.root) : machineProfilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  // The machine file feeds every root's merge; a save is rare, so clearing the
  // whole per-process memo is the simple honest invalidation.
  profileCache.clear();
}

// The survey corpus (R-002): every user-visible survey string, exported as one
// constant so the language eval scans exactly what renders — same contract as
// FIRST_RUN_OPENER. productfoo voice: productfoo reads you the way it reads the project,
// options teach what the answer changes, and nothing sounds like a form.
export const SURVEY_INTRO = "It also reads you — a few quick questions so the work fits how you work. Enter skips any of them.";
export const SURVEY_Q_ROLE = "What's your role? Pick any — this chooses the view productfoo leads with.  1 product · 2 engineer · 3 designer · 4 founder · 5 executive";
export const SURVEY_Q_HARNESS = "Which coding agents do you build with? Pick any — productfoo offers to set up its commands in these.  1 Claude Code · 2 Cursor · 3 Codex · or type them";
export const SURVEY_Q_BUILDING = "What are you building? A few words is plenty — this stays on your machine.";
export const SURVEY_Q_TEAM = "Who's building with you?  1 just me · 2 a small team · 3 a bigger org";
export const SURVEY_CLOSE_PRODUCT = "productfoo leads with the product view from here — no flags needed. Redo any time: foo profile";
export const SURVEY_CLOSE_SAVED = "Saved — productfoo keeps this on your machine. Redo any time: foo profile";
export const SURVEY_CLOSE_SKIPPED = "Nothing saved — productfoo stays as-is. Ask again any time: foo profile";
export const SURVEY_DIDNT_CATCH = "didn't catch";
export const PROFILE_NONE = "foo hasn't read you yet. Run it any time: foo profile redo";
export const PROFILE_REDO_NEEDS_TTY = "Redo needs a live terminal — run foo profile redo where you can type.";

export const SURVEY_CORPUS: readonly string[] = [
  SURVEY_INTRO,
  SURVEY_Q_ROLE,
  SURVEY_Q_HARNESS,
  SURVEY_Q_BUILDING,
  SURVEY_Q_TEAM,
  SURVEY_CLOSE_PRODUCT,
  SURVEY_CLOSE_SAVED,
  SURVEY_CLOSE_SKIPPED,
  SURVEY_DIDNT_CATCH,
  PROFILE_NONE,
  PROFILE_REDO_NEEDS_TTY,
];

const ROLE_BY_DIGIT: Record<string, ProfileRole> = { "1": "product", "2": "engineer", "3": "designer", "4": "founder", "5": "executive" };
const ROLE_LABELS: Record<ProfileRole, string> = { product: "product", engineer: "engineer", designer: "designer", founder: "founder", executive: "executive" };
const HARNESS_BY_DIGIT: Record<string, string> = { "1": "claude-code", "2": "cursor", "3": "codex" };
const HARNESS_LABELS: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex" };
const TEAM_BY_DIGIT: Record<string, FooProfile["team"]> = { "1": "just-me", "2": "small-team", "3": "larger-org" };
const TEAM_LABELS: Record<string, string> = { "just-me": "just you", "small-team": "a small team", "larger-org": "a bigger org" };

// Lenient on purpose (T-004): "1, 3", "1 and 3", "product + agent", "pm" all
// land. Digits and words both count; order kept; duplicates dropped.
export function parseRoles(answer: string): ProfileRole[] {
  const roles: ProfileRole[] = [];
  const push = (role: ProfileRole | undefined) => {
    if (role && !roles.includes(role)) roles.push(role);
  };
  for (const ch of answer) push(ROLE_BY_DIGIT[ch]);
  const lower = answer.toLowerCase();
  if (/\b(product|pm)/.test(lower)) push("product");
  if (/\b(eng|dev|code)/.test(lower)) push("engineer");
  if (/\bdesign/.test(lower)) push("designer");
  if (/\bfound/.test(lower)) push("founder");
  if (/\b(exec|ceo|cpo|cto|vp)/.test(lower)) push("executive");
  return roles;
}

export function parseTeam(answer: string): FooProfile["team"] | undefined {
  const direct = TEAM_BY_DIGIT[answer.trim()];
  if (direct) return direct;
  const lower = answer.toLowerCase();
  if (/\b(just me|solo|alone|me)\b/.test(lower)) return "just-me";
  if (/\bsmall\b/.test(lower)) return "small-team";
  if (/\b(big|large|org|company)/.test(lower)) return "larger-org";
  return undefined;
}

// "Which do you build with MOST" — people lead with their main tool, so the
// first recognized mention (digit or name) wins: "1, sometimes 3" is Claude
// Code, "2 mostly, codex rarely" is Cursor. (Dogfood 2026-07-11: the digit was
// only matched against the whole answer, and the owner's pick was missed.)
const HARNESS_NAMES: Record<string, string> = { claude: "claude-code", cursor: "cursor", codex: "codex" };

// #622: plural, like roles. "1, 3", "claude and codex", "cursor + claude" all
// land, in the order given; duplicates dropped. With no known agent named, a
// free-typed answer is kept as the single value (it is still the person's word).
export function parseHarnesses(answer: string): string[] {
  const lower = answer.toLowerCase();
  const hits: Array<{ at: number; id: string }> = [];
  for (const [name, id] of Object.entries(HARNESS_NAMES)) {
    for (let at = lower.indexOf(name); at !== -1; at = lower.indexOf(name, at + 1)) hits.push({ at, id });
  }
  for (const [digit, id] of Object.entries(HARNESS_BY_DIGIT)) {
    for (let at = answer.indexOf(digit); at !== -1; at = answer.indexOf(digit, at + 1)) hits.push({ at, id });
  }
  const ids: string[] = [];
  for (const { id } of hits.sort((a, b) => a.at - b.at)) if (!ids.includes(id)) ids.push(id);
  if (ids.length > 0) return ids;
  const typed = answer.trim();
  return typed ? [typed] : [];
}

export function parseHarness(answer: string): string | undefined {
  return parseHarnesses(answer)[0];
}

/** Every harness a profile names, from the plural field or an older single one. */
export function profileHarnesses(profile: Pick<FooProfile, "harnesses" | "harness"> | null | undefined): string[] {
  if (profile?.harnesses?.length) return [...profile.harnesses];
  return profile?.harness ? [profile.harness] : [];
}

export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

// The read-back (T-004): foo answers the survey the way it answers a repo —
// one Read: line naming exactly what it understood. This is the legibility
// beat v1 was missing: a dropped answer becomes visible the moment it happens.
export function renderProfileReadback(profile: FooProfile): string {
  const parts: string[] = [];
  if (profile.roles?.length) parts.push(profile.roles.map((role) => ROLE_LABELS[role]).join(" + "));
  const harnesses = profileHarnesses(profile);
  if (harnesses.length) parts.push(harnesses.map(harnessLabel).join(" + "));
  if (profile.building) parts.push(`building ${profile.building}`);
  if (profile.team) parts.push(TEAM_LABELS[profile.team] ?? profile.team);
  return parts.length ? `Read: ${parts.join(" · ")}.` : "";
}

export function surveyClose(profile: FooProfile): string {
  const answered = Boolean(profile.roles?.length || profile.harness || profile.building || profile.team);
  if (profile.roles?.some((role) => PRODUCT_VIEW_ROLES.includes(role))) return SURVEY_CLOSE_PRODUCT;
  return answered ? SURVEY_CLOSE_SAVED : SURVEY_CLOSE_SKIPPED;
}

export interface SurveyIO {
  input: Readable;
  output: Writable;
}

// Ask four optional questions. Answers remain on this machine.
// Every answer is optional: Enter moves on, an answer productfoo can't place is named
// out loud — `(didn't catch "…" — skipped)` — never silently dropped (T-004),
// and the survey never nags (R-002/R-005). Streams are injected for tests.
export async function runFirstRunSurvey(io: SurveyIO, now: () => string = () => new Date().toISOString()): Promise<FooProfile> {
  const rl = readline.createInterface({ input: io.input, output: io.output });
  const ask = async (question: string): Promise<string> => (await rl.question(`${question}\n> `)).trim();
  const missed = (answer: string) => io.output.write(`(${SURVEY_DIDNT_CATCH} "${answer}" — skipped)\n`);
  try {
    io.output.write(`${SURVEY_INTRO}\n\n`);

    const roleAnswer = await ask(SURVEY_Q_ROLE);
    const roles = parseRoles(roleAnswer);
    if (roleAnswer && roles.length === 0) missed(roleAnswer);

    const harnesses = parseHarnesses(await ask(SURVEY_Q_HARNESS));
    const building = (await ask(SURVEY_Q_BUILDING)) || undefined;

    const teamAnswer = await ask(SURVEY_Q_TEAM);
    const team = parseTeam(teamAnswer);
    if (teamAnswer && !team) missed(teamAnswer);

    const profile: FooProfile = {
      ...(roles.length ? { roles } : {}),
      ...(harnesses.length ? { harnesses, harness: harnesses[0] } : {}),
      ...(building ? { building } : {}),
      ...(team ? { team } : {}),
      answered_at: now(),
    };
    const readback = renderProfileReadback(profile);
    if (readback) io.output.write(`${readback}\n`);
    io.output.write(`${surveyClose(profile)}\n\n`);
    return profile;
  } finally {
    rl.close();
  }
}

// The report (R-004, amended by onboarding-trust-boundary-v0): picks only. A
// free-typed harness reports as "other" so no free text ever rides along; the
// `building` answer is structurally absent — the event is built from an
// allowlist, not by filtering the profile.
export function profileReportEvent(profile: FooProfile, version: string): Record<string, unknown> | null {
  if (!profile.roles?.length && !profile.harness && !profile.team) return null;
  return {
    schema_version: "0.1",
    event_type: "profile",
    id: nextAgentEventId(),
    timestamp: profile.answered_at,
    version,
    ...(profile.roles?.length ? { roles: profile.roles } : {}),
    ...(profile.harness ? { harness: HARNESS_LABELS[profile.harness] ? profile.harness : "other" } : {}),
    ...(profile.team ? { team: profile.team } : {}),
  };
}

// Record bounded profile picks locally; free text stays only in the profile.
export function reportProfile(root: string, profile: FooProfile, version: string, env: NodeJS.ProcessEnv = process.env): Promise<void> | undefined {
  try {
    const event = profileReportEvent(profile, version);
    if (!event || env.DO_NOT_TRACK) return undefined;
    if (!readAgentTelemetryConfig(root).config.enabled) return undefined;
    const testerId = resolveTesterId(root);
    const keyed = { ...event, ...(testerId ? { tester_id: testerId } : {}) };

    const logPath = agentLogPath(root);
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(keyed)}\n`);

    return undefined;
  } catch {
    return undefined; // reporting never alters the read (R-005)
  }
}

// `foo profile` (T-004): what productfoo knows about how you work, in the same Read:
// grammar the survey closes with — plus where it lives and how to redo it.
export function renderProfileStatus(root: string): string {
  const profile = loadProfile(root);
  if (!profile) return `${PROFILE_NONE}\n`;
  const lines: string[] = [];
  const readback = renderProfileReadback(profile);
  lines.push(readback || "Nothing answered yet.");
  const overriding = readProfileFile(profilePath(root)) !== null;
  lines.push(
    overriding
      ? "  This repo has its own profile (.foo/profile.json); what you typed free-form never leaves the machine."
      : "  Lives on your machine and follows you across projects; what you typed free-form never leaves it.",
  );
  lines.push("  Redo any time: foo profile redo");
  return `${lines.join("\n")}\n`;
}

// `foo profile redo` (T-004): the recovery path v1 didn't have. Re-runs the
// same survey on a live terminal, saves, and records local profile picks.
export async function runProfileRedo(root: string, version: string, io?: SurveyIO & { inputTTY?: boolean; outputTTY?: boolean }): Promise<string> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;
  const inputTTY = io?.inputTTY ?? Boolean(process.stdin.isTTY);
  const outputTTY = io?.outputTTY ?? Boolean(process.stdout.isTTY);
  if (!inputTTY || !outputTTY) return `${PROFILE_REDO_NEEDS_TTY}\n`;
  const profile = await runFirstRunSurvey({ input, output });
  saveProfile(profile); // machine-wide: the answer follows the person
  void reportProfile(root, profile, version);
  return "";
}

// `foo profile set` (conversational-onboarding-v0): the non-interactive writer.
// The TTY survey can't run through an agent, so a coding-agent harness that
// asked the four questions in chat records the answers here. Same lenient
// parsers as the survey ("1,4", "product and founder" both land), same
// machine-wide home, same bounded local profile log. Free
// text (`building`) is written to the local profile only and never reported.
export interface ProfileSetInput {
  roles?: string;
  harness?: string;
  team?: string;
  building?: string;
  json?: boolean;
}

export const PROFILE_SET_EMPTY = "Nothing to set — give at least one of --role, --harness, --team, --building.";

export function runProfileSet(root: string, version: string, input: ProfileSetInput, now: () => string = () => new Date().toISOString()): string {
  const roles = input.roles ? parseRoles(input.roles) : [];
  const harnesses = input.harness ? parseHarnesses(input.harness) : [];
  const team = input.team ? parseTeam(input.team) : undefined;
  const building = input.building?.trim() || undefined;
  if (!roles.length && !harnesses.length && !building && !team) throw new Error(PROFILE_SET_EMPTY);

  const profile: FooProfile = {
    ...(roles.length ? { roles } : {}),
    ...(harnesses.length ? { harnesses, harness: harnesses[0] } : {}),
    ...(building ? { building } : {}),
    ...(team ? { team } : {}),
    answered_at: now(),
  };
  saveProfile(profile); // machine-wide: the profile is about the person
  void reportProfile(root, profile, version);

  if (input.json) {
    // The free text is deliberately absent from the machine-readable echo the
    // agent parses — the surface never invites it back out.
    return `${JSON.stringify({ roles: profile.roles ?? [], harnesses: profileHarnesses(profile), harness: profile.harness ?? null, team: profile.team ?? null }, null, 2)}\n`;
  }
  const readback = renderProfileReadback(profile);
  return `${readback ? `${readback}\n` : ""}${surveyClose(profile)}\n`;
}
