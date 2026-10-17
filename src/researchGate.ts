import { randomBytes } from "node:crypto";
// Research gate — route fan-out web research through `foo research`.
//
// Why this exists: `foo research` was documented as the research front door and
// listed under Signals ("advisory; never an automatic stop"). An agent with
// AGENTS.md in context, a SessionStart reminder, and a memory note all pointing
// at it still spawned four raw web-research subagents on the first try — not to
// evade the rule, but because the reflex fired before the rule did. Advisory
// loses to reflex. The gates in this repo that hold are the ones that deny.
//
// The policy lives here, in foo, so any harness can enforce it. `.claude/settings.json`
// carries only a thin PreToolUse shim that calls `foo research gate`.
//
// Scope (deliberately narrow): fan-out — delegating to subagents to go read the web
// and report findings. A single WebSearch to check a package version or a stack trace
// is not research and stays free. The tell is delegation PLUS the web, not the web
// alone. A determined agent can still hand-roll research one search at a time; that is
// accepted. The target is the reflex, and the reflex is a fan-out.

import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DenialText } from "./harnessGates.js";

/** A PreToolUse-shaped payload. Harness-neutral: only these two fields are read. */
export interface ToolCall {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

export interface GateDecision {
  readonly allow: boolean;
  /**
   * Present when allow=false. Two readers, two texts: `agent` carries the instruction and
   * the machinery, `user` is the one line the human sees. See DenialText in harnessGates.ts.
   */
  readonly reason?: DenialText;
  /** Why the gate let this through — for tests and `--json`, never for the agent. */
  readonly note?: string;
}

/**
 * A tool name reduced to its bare letters — lowercased, with the separators harnesses
 * pick differently (`_`, `-`, spaces) removed. `web_fetch`, `WebFetch` and `web-fetch`
 * are the SAME tool wearing three harnesses' punctuation, and a gate that matches raw
 * strings enforces on one and silently allows the other two — the exact silent-allow this
 * whole boundary exists to prevent. Compare canonically so the name the harness sends is
 * matched however it is spelled.
 */
const canonicalTool = (name: string | undefined): string =>
  (name ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");

/**
 * Tools that delegate to a subagent. Harnesses disagree on the name — Claude/Cursor say
 * `Task` or `Agent`, Codex fires on `spawn_agent` — so these are stored canonically and
 * matched through `canonicalTool`.
 */
const DELEGATION_TOOLS = new Set(["agent", "task", "spawnagent"]);

/**
 * The subagent is being sent to the open web, and no amount of repo scope excuses it.
 *
 * This list used to name only the TOOLS ("websearch", "webfetch"). That was a guess at
 * phrasing, and it lost: a fan-out that said "Fetch PRIMARY sources (vendor docs, GitHub
 * repos, changelogs). Do NOT trust search snippets." matched nothing here and sailed
 * through. It was unmistakably web research; it just never said "web".
 *
 * So the markers name the WEB ITSELF. But a marker list has a second failure mode, and foo
 * hit it too: half the old list was ordinary product vocabulary. Those words moved to
 * WEAK_WEB_MARKERS below. What stays here is language that has no innocent reading in a
 * delegation prompt — you do not "scrape" or consult a "vendor doc" while searching src/.
 */
const STRONG_WEB_MARKERS = [
  "websearch",
  "webfetch",
  "web search",
  "web_search",
  "search the web",
  "browse the web",
  "search online",
  "google for",
  // verbs that only ever mean the open web
  "crawl",
  "scrape",
  "look up online",
  // objects that only ever live out there
  "http://",
  "https://",
  "pricing page",
  // how people describe reading it
  "primary source",
  "vendor doc",
  "official doc",
  "search snippet",
];

/**
 * Words that MIGHT mean the web, and in this repo usually do not.
 *
 * `docs`, `published`, `changelog`, `fetch`, `url` are everyday product vocabulary. They sat
 * in the strong list, where a single hit denied outright — and the REPO_MARKERS rescue below
 * was unreachable, because the web check returned first. So the gate refused a spec-swarm
 * lens whose prompt named `src/`, `this repo` and `grep`, on the strength of the sentence
 * "productfoo's published surface is ~8 commands". One ordinary word beat three explicit repo
 * signals, and the comment above REPO_MARKERS promised the opposite of what the code did.
 *
 * These still deny on their own — an unscoped findings run that says "read the changelog" is
 * presumed web, as before. They simply lose to a prompt that says where it is going.
 */
const WEAK_WEB_MARKERS = [
  "fetch",
  "url",
  ".com",
  ".io",
  "docs",
  "documentation",
  "changelog",
  "release notes",
  "blog",
  "spec at",
  "publicly",
  "published",
];

/**
 * A web name mentioned ONLY to forbid it.
 *
 * `do not use WebSearch` is the strongest evidence a prompt has that it stays off the web,
 * and the gate read it as proof of the opposite: it matched the tool name and never saw the
 * `not`. Seven of productfoo's own spec-swarm lenses were denied for saying it — the instruction
 * that proves a prompt is safe was the instruction that blocked it. An agent cannot reassure
 * a gate that reads reassurance as intent, so it learns to stop saying true things.
 *
 * Only NAMES are negatable — the tools, and the web itself. The verbs (`crawl`, `scrape`,
 * `fetch`) are deliberately absent: they name a behaviour, and "do not use WebSearch, crawl
 * the vendor docs instead" must keep its `crawl`.
 *
 * Known hole, named rather than rounded up: negation is scoped to the clause, so a single
 * clause that negates one thing and does another — "do not summarize, use WebSearch" — has
 * its tool name stripped. It survives only if the clause carries no other web signal, which
 * no real sweep manages; the Nth-read trip and `foo research validate` both still sit behind
 * this. Widening it further costs more false denials than it buys.
 */
const NEGATION_TRIGGER = /\b(?:do not|don'?t|does not|doesn'?t|never|avoid|without|must not|cannot|can'?t)\b/i;
const NEGATABLE_WEB =
  /\b(?:websearch|web[ _-]?search|webfetch|web[ _-]?fetch|the web|the internet|the network|online)\b/gi;

/** Drop web names that appear inside a clause which forbids them. */
const dropNegatedWeb = (text: string): string =>
  text
    .split(/([.!?;\n])/)
    .map((clause) => (NEGATION_TRIGGER.test(clause) ? clause.replace(NEGATABLE_WEB, " ") : clause))
    .join("");

/**
 * A spawn that cannot reach the web is not a web fan-out.
 *
 * The fifth arrival of the false-positive lesson (#521): a synthetic-customer
 * rehearsal spawned ONE subagent to role-play a persona in isolation — the
 * skill's anti-sycophancy rule — with "Do not use any tools" in the prompt and
 * no web anywhere. It asked for hypothesis verdicts, named no location (a
 * persona has no file path), and the default-deny branch presumed the web. The
 * one instruction that proves the spawn stays offline was invisible to the
 * gate, so the isolation the skill designed for moved inline and was lost.
 *
 * Two declarations count, and both are DECLARATIONS the caller makes, not
 * phrasing the gate guesses at: a structured tool surface that names no
 * web-capable tool, and a prompt-level prohibition on tool use entirely. A
 * prompt that positively names a web tool has already returned true above —
 * a spawn that says both "no tools" and "use WebSearch" is a contradiction,
 * and contradictions block.
 *
 * Why this widens nothing: the prompt line is advisory to the MODEL, but the
 * web is enforced at the TOOL — a subagent that disobeys and calls WebSearch
 * anyway hits this same hook on that call, where the pending marker and the
 * Nth-read trip still hold. The spawn-level check is a pre-filter; the tool
 * level is the promise.
 */
const NO_TOOLS_DECLARATIONS = [
  "do not use any tools",
  "don't use any tools",
  "do not use tools",
  "don't use tools",
  "use no tools",
  "without using any tools",
  "without using tools",
  "no tool use",
  "no tool calls",
  "tool use is not allowed",
  "you have no tools",
];

/**
 * The sixth arrival of the same lesson (#614), and the sharpest, because this
 * time the gate refused productfoo's own emitted contract.
 *
 * `foo ideate` at standard depth MANDATES five ideator cells, blind to each
 * other — blindness is only achievable by spawning them separately. Every cell
 * read two local files and named no web tool. Four ran; the fifth was denied,
 * because the ideate contract's own vocabulary ("dissent must **cite** the
 * observation", "the evidence **brief**") trips FINDINGS_MARKERS, and a cell
 * whose prompt happened not to name a `src/`-shaped path then fell through to
 * default-deny. Which cell died was decided by prompt wording, not by anything
 * about where the cell was pointed — so dogfooding foo tripped a boundary that
 * foo had just told the agent to cross.
 *
 * A declared tool surface would have settled it, but Claude Code's `Task`
 * payload carries no `tools` array, so `declaredToolSurface` is unreachable in
 * the harness where this fired. This is the same escape hatch in a form the
 * prompt can carry.
 *
 * Why this widens nothing, for the same reason as the no-tools case above: the
 * declaration is advisory to the MODEL, and the web is enforced at the TOOL. A
 * subagent that declares local-only and then reaches for WebSearch hits this
 * same hook on that call, where the pending marker and the Nth-read trip still
 * hold. Deciding a spawn is local is a pre-filter; staying local is the promise,
 * and the promise is still checked.
 *
 * Phrases here deliberately contain no negatable web word — `dropNegatedWeb`
 * runs first and would eat "do not read the web" down to "do not read",
 * silently unmatching the declaration the caller made.
 */
const LOCAL_ONLY_DECLARATIONS = [
  "local sources only",
  "read only local sources",
  "reads only local sources",
  "local files only",
  "read only local files",
  "reads only local files",
  "only sources already on this machine",
];

/** A declared tool surface, when the harness passes one on the spawn. */
const declaredToolSurface = (input: Record<string, unknown>): string[] | null => {
  const tools = (input as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((entry) => typeof entry === "string")) return null;
  return tools;
};

/** Web-capable by NAME, judged canonically and broadly — misjudging a web tool as local is the silent-allow this boundary exists to prevent, so anything that smells of the network stays web-capable. */
const WEB_CAPABLE_TOOL = /web|browser|fetch|curl|http|search|request/;

/**
 * A URL pointing at THIS machine. It is the single most important non-web signal there is,
 * and the gate used to read it as the opposite.
 *
 * `http://localhost:4321/` is not the open web. It is the thing you just built, being
 * served to you. But the web markers name "http://" and "url", so an Impeccable design
 * critique — "inspect the live page at http://localhost:4321 and report your findings" —
 * matched "the web" on a loopback address and was refused as a raw research sweep. Nobody
 * researches the open web through 127.0.0.1; a loopback URL is a local artifact wearing a
 * URL's punctuation, and reading it is inspection, not discovery.
 */
const LOCAL_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|[\w.-]+\.(?:local|localhost|test|internal))$/;

/** Every URL in the text, so each can be judged local or remote before anything is matched. */
const URL_PATTERN = /\b(?:https?:\/\/|file:\/\/)[^\s"'`)>\]]+|\blocalhost:\d+[^\s"'`)>\]]*/gi;

/**
 * A path to a file on disk. The other half of "the prompt named a local target".
 *
 * Deliberately shape-checked rather than existence-checked: it must have a real extension
 * or a trailing slash, so `site/index.html`, `src/`, and `.impeccable/critique/` are paths
 * while `P0/P1/P2` — which a critique prompt says constantly — is not. Existence on disk
 * would be a stronger signal and a more brittle one (a prompt may name a file in another
 * worktree), and this detector only ever moves a call toward "local", never toward "web".
 */
const LOCAL_PATH_PATTERN = /(?:^|\s|["'`(])((?:\.{0,2}\/)?[\w.@-]+\/[\w.@/-]*(?:\.[a-z]{1,6}|\/))/gi;

/**
 * A path whose first segment is a domain (`example.com/blog/`, `vendor.io/docs/x.html`)
 * is a web reference wearing a slash, not a file on disk. LOCAL_PATH_PATTERN matches it —
 * a dotted word, a slash, a trailing slash or extension — and stripping it would delete
 * the very `.com`/`.io`/`docs` tokens that mark it as the web. Leave those in `rest`.
 */
const DOMAIN_FIRST_SEGMENT =
  /^[\w-]+(?:\.[\w-]+)*\.(?:com|io|net|org|dev|ai|co|app|gov|edu|xyz|sh|so|me|info|page|tools?)$/i;

const looksLikeDomain = (captured: string): boolean =>
  DOMAIN_FIRST_SEGMENT.test(captured.replace(/^\.{0,2}\//, "").split("/")[0] ?? "");

/**
 * A path that is where the run WRITES ("write your findings to docs/report.md", "save the
 * results to out/notes.md") is an output destination, not something being read. It is not a
 * local target the run inspects, and it must never launder a web sweep into local work: the
 * subject of the research is still the open web, the file is just where the prose lands.
 */
const OUTPUT_DESTINATION =
  /\b(?:write|writes|writing|wrote|save|saves|saving|saved|output|outputs|dump|dumped|store|stored|export|exported|persist|persisted|append|appended|record|recorded|put|log)\b[^.!?;\n]*\bto\s*["'`(]?$/i;

interface Scoped {
  /** What remains once every local target is removed — where web markers are matched. */
  readonly rest: string;
  /** A remote URL was named. Unambiguously the open web; no local scope excuses it. */
  readonly remoteUrl: boolean;
  /** The prompt named something on this machine: a loopback URL or a path on disk. */
  readonly localTarget: boolean;
}

/**
 * Take the local out, then look for the web in what is left.
 *
 * This inversion is the whole repair. The gate used to match web markers against the raw
 * prompt, so any mention of a local artifact that happened to be spelled like the web
 * ("http://", "url", "docs") read as a trip to the open web — and `docs/` is a directory
 * in this very repo. Strip what is demonstrably local FIRST and the remaining markers mean
 * what they say: a prompt with a real web signal still has one, and a prompt whose only
 * "web" was its own dev server no longer does.
 */
function scopeOf(text: string): Scoped {
  let remoteUrl = false;
  let localTarget = false;

  let rest = text.replace(URL_PATTERN, (url) => {
    const host = /^\w+:\/\//.test(url)
      ? (url.split("//")[1] ?? "").split(/[/:?#]/)[0]
      : url.split(":")[0];
    if (url.toLowerCase().startsWith("file://") || LOCAL_HOST_PATTERN.test(host)) {
      localTarget = true;
    } else {
      remoteUrl = true;
    }
    return " ";
  });

  rest = rest.replace(LOCAL_PATH_PATTERN, (match: string, captured: string, offset: number, whole: string) => {
    // A bare domain with a path is the open web, not a file on disk — keep it so its
    // .com/.io/docs tokens survive to be matched as web markers.
    if (looksLikeDomain(captured)) return match;

    // A path the run WRITES to is an output destination, not an inspection target. Naming
    // one must not flip a web sweep to "local": leave it in place so the default-deny (and
    // any web token it carries, like `docs`) still fires.
    const before = whole.slice(0, offset + match.length - captured.length);
    if (OUTPUT_DESTINATION.test(before)) return match;

    localTarget = true;
    return match.startsWith(" ") ? " " : "";
  });

  return { rest, remoteUrl, localTarget };
}

/**
 * ...unless the subagent is being pointed at THIS repo. Code search is explicitly not
 * gated, and it is the thing most likely to trip a wider web-marker list ("fetch",
 * "docs", and "url" all appear in perfectly ordinary code-reading prompts).
 *
 * A repo-scoped delegation names the repo: a path, a grep, a symbol, the codebase. When one
 * of these is present, the call beats any WEAK_WEB_MARKERS hit and passes as code search.
 *
 * This comment used to describe a rescue the code did not have: the web check returned deny
 * before this list was ever consulted, so a repo-scoped prompt carrying one ordinary word
 * ("published") was refused, and the promise here was decorative. A strong marker or a
 * remote URL still beats repo scope — that direction was always real.
 */
const REPO_MARKERS = [
  "src/",
  "test/",
  "this repo",
  "the repo",
  "repository at /",
  "codebase",
  "grep",
  "ripgrep",
  "file:line",
  "read the file",
  "local git",
  "on disk",
];

/** Naming a web TOOL is unambiguous — no repo scope can excuse it. */
const EXPLICIT_WEB_TOOLS = ["websearch", "webfetch", "web_search", "web search"];

/**
 * The tools that read the open web directly, without delegating. Stored canonically and
 * matched through `canonicalTool`, because the harnesses foo wires the gate into name the
 * same tool differently: native tools use `WebSearch`/`WebFetch`, while connectors may
 * use `google_web_search` or `web_fetch`. The gate must recognize every one — declaring
 * `webRead: true` for a harness (see harnessGates.ts) and then not matching its tool name
 * is a boundary the user is told they have and does not.
 */
const WEB_TOOLS = new Set(["websearch", "webfetch", "googlewebsearch"]);

/**
 * The human asked for RESEARCH — not a lookup, not a code question.
 *
 * The fan-out gate catches "spawn agents to sweep the web". It does not catch the other
 * half of the reflex: reading a few pages yourself and writing confident prose. Same
 * ungoverned evidence, no subagent involved. So the routing has to start at the task, not
 * at the tool call.
 *
 * These markers are deliberately about the SHAPE of the ask — survey, compare, evaluate,
 * find out what exists — not about any topic. "Fix this bug", "read src/cli.ts", "what
 * version of node is this" are none of them, and stay free.
 */
const RESEARCH_REQUEST_MARKERS = [
  "research",
  "look into",
  "find out about",
  "what's the landscape",
  "what is the landscape",
  "state of the art",
  "prior art",
  "competitive",
  "competitors",
  "compare",
  "vs",
  "versus",
  "evaluate options",
  "what are the options",
  "survey",
  "market",
  "best practice",
  "who else is",
  "how do others",
  "what's out there",
  "landscape of",
];

/**
 * ...but a question about THIS codebase is not research, however it is phrased.
 *
 * Two kinds of local signal, and the second is the one #719 was missing.
 *
 * The original list was deictic — it recognised a *pointer* at the code ("this file",
 * "src/"). But most local work never points; it just says what to do. "Fix the #607
 * research pair", "rename the research route marker list", "survey the failing tests"
 * are all ordinary repo tasks that name no path and no `this`, so nothing vetoed them
 * and a topic word carried them straight into the research route.
 *
 * So the second kind is the ACT: a repair or edit performed on the repo. A turn that
 * says fix/debug/rename/close is a turn about work in front of us, whatever nouns it
 * also happens to contain.
 *
 * These match with a leading boundary only (see `has`), which is what we want for verbs:
 * `fix` must also catch fixes/fixing/fixed.
 */
const LOCAL_QUESTION_MARKERS = [
  // Pointing at the code in front of us.
  "src/",
  "test/",
  "scripts/",
  "skills/",
  "specs/",
  "dist/",
  "docs/",
  "research/",
  "web/",
  ".github/",
  "bin/foo",
  "this repo",
  "this file",
  "this function",
  "this bug",
  "this branch",
  "the codebase",
  "our code",
  "stack trace",
  // Acting on it. A task, not a question about the world.
  "fix",
  "debug",
  "repair",
  "patch",
  "refactor",
  "rename",
  "revert",
  "rebase",
  "implement",
  "triage",
  "reopen",
  "close",
  "update",
  "delete",
  "remove",
  "bump",
  // Local artifacts a dev task operates on.
  "the tests",
  "the test suite",
  "the failing",
  "the build",
  "the diff",
  "the branch",
  "the linter",
  "pull request",
  "implementation",
];

/**
 * A turn that names an issue or PR by number is about work in this repo. `#719` is not
 * a topic anyone researches. Kept as a pattern rather than a marker because the number
 * is the point and no fixed string can carry it.
 */
const LOCAL_ISSUE_REFERENCE = /(?<![\w-])#\d+\b/;

/**
 * Match a research marker as a WHOLE word — both ends.
 *
 * `has()` anchors only the leading boundary on purpose: `synthesi` must reach synthesis,
 * `cite` must reach cited. That is right for the fan-out gates that share it, and wrong
 * here, because this list is read on EVERY human turn. Leading-only is why `market` fired
 * inside "run the marketing swarm" — a workflow AGENTS.md actually requires — and why
 * `research` fired inside every mention of the research/ directory, the research route,
 * or a bug titled research (#719).
 *
 * Nothing in this list wants prefix behaviour, so both ends are anchored, and the hyphen
 * is treated as a word character for the same reason `has` does: "go-to-market" is one
 * compound word, not an ask to go read the market.
 */
const RESEARCH_MARKER_CACHE = new Map<string, RegExp>();

function researchMarkerPattern(needle: string): RegExp {
  const cached = RESEARCH_MARKER_CACHE.get(needle);
  if (cached) return cached;
  const re = new RegExp(`(?<![\\w-])${escapeRe(needle)}(?![\\w-])`, "i");
  RESEARCH_MARKER_CACHE.set(needle, re);
  return re;
}

const hasResearchMarker = (haystack: string): boolean =>
  RESEARCH_REQUEST_MARKERS.some((n) => researchMarkerPattern(n).test(haystack));

/**
 * Did the human OPEN with "research ..."?
 *
 * This is the one position where the word is unambiguously the ask rather than a noun in
 * it, so it overrides the local veto: "research how others fix flaky tests" is a research
 * request that happens to contain "fix", and must still route. Anywhere else in the
 * sentence, `research` is just as likely to be naming a file, a route, or a bug title.
 */
const RESEARCH_IMPERATIVE = /^(?:(?:please|can you|could you|go|now|first|also|and|then)[,\s]+)*research(?![\w-])/i;

/**
 * Should this human turn be routed through `foo research` before the agent does anything?
 *
 * Used by the UserPromptSubmit adapter. Returns the topic when it fires, so the directive
 * can name the exact command to run.
 */
/**
 * Not a human turn.
 *
 * `UserPromptSubmit` is documented as the human's own words, and foo believed it. It is
 * not only that: harnesses deliver their own machinery through the same door — background
 * task-notifications, system reminders, tool-result envelopes. Those are not asks, and
 * nobody typed them.
 *
 * This mattered, concretely. A background agent finished, its completion notification
 * arrived on this hook, the notification's *body* happened to contain the word "research",
 * and the router wrote an entire `<task-notification>` block into the pending marker as
 * the human's "topic" — after which the PreToolUse gate refused **every** delegation in
 * the session. Each subsequent agent completion re-armed it. A router that reads the
 * harness's own chatter as a human ask can wedge a session shut and be *right* every time
 * by its own logic.
 *
 * So the rule is: route the human, never the harness. Recognising an envelope by its
 * opening tag is a guess at shape, and B5's history says phrasing guesses lose — but this
 * guess is safe in the direction that matters. A missed envelope routes a turn that maybe
 * should not have been routed (recoverable, visible). Treating a notification as an ask
 * closes the web on work nobody asked to gate (invisible, and it compounds).
 */
const HARNESS_ENVELOPE =
  /^\s*(?:<(?:task-notification|system-reminder|function_(?:calls|results)|local-command-[a-z]+|command-(?:name|message|args))\b|\[SYSTEM NOTIFICATION)/i;

export function isHarnessEnvelope(prompt: string): boolean {
  return HARNESS_ENVELOPE.test(prompt ?? "");
}

export function researchRequestTopic(prompt: string): string | null {
  const text = (prompt ?? "").trim();
  if (!text) return null;
  // The harness talking to itself is not a research ask, whatever words it contains.
  if (isHarnessEnvelope(text)) return null;
  // Strip a leading slash-command before reading the ask: "/foo research X" opens with
  // research just as plainly as "research X" does.
  const ask = text.replace(/^\/\S+\s*/, "").trim();
  if (!ask) return null;
  const lower = ask.toLowerCase();

  // An opening "research ..." is the ask itself and outranks everything below.
  if (!RESEARCH_IMPERATIVE.test(lower)) {
    // Otherwise a local-work signal wins, and the asymmetry is not close.
    //
    // A miss costs a suggestion. A false fire costs the session: this route does not only
    // advise, it calls markResearchRequested, and a pending marker makes evaluateToolCall
    // return allow:false for every web tool AND every fan-out until `foo research` runs.
    // That is the same wedge the harness-envelope guard above was written for, reached
    // through the front door — on a prompt that merely said "fix" and happened to name
    // research (#719). So when the turn looks local, stay quiet.
    if (LOCAL_ISSUE_REFERENCE.test(lower)) return null;
    if (has(lower, LOCAL_QUESTION_MARKERS)) return null;
    if (!hasResearchMarker(lower)) return null;
  }
  // Keep the human's own words as the topic. productfoo's job is to govern the run, not to
  // reinterpret the ask.
  return ask;
}

/** ...and told to come back with findings. Research, not a lookup. */
const FINDINGS_MARKERS = [
  "research",
  "sources",
  "cite",
  "citation",
  "findings",
  "brief",
  "landscape",
  "competitive",
  "market",
  "state of the art",
  "prior art",
  "survey",
  "synthesi", // synthesis / synthesize
];

/**
 * Skills that are themselves research front doors. They are good tools; they are
 * not productfoo's, so their output arrives untyped, unpanelled, and with no packet — which
 * is precisely the evidence you should not act on.
 */
const RIVAL_RESEARCH_SKILLS = new Set(["deep-research"]);

/**
 * Does the text contain one of these markers *as a word*?
 *
 * This used to be a bare `includes()`, and that is a substring test, not a word test —
 * so `cite` matched **ex·cite·d** and `market` matched **go-to-market**. An ideation
 * fan-out that described a founder as "genuinely excited" was refused as a web sweep,
 * and, having named no repo path, was refused by *default-deny* — the widest possible
 * failure. Three of five ideators died on a run that reads no web at all.
 *
 * The repair is a **leading** boundary, and only a leading one: several markers are
 * deliberate prefixes (`synthesi` → synthesis/synthesize, `research ` carries its own
 * trailing space), so pinning the tail would break them. The marker still matches "cited"
 * and "cites" and no longer matches "excited", which is exactly the distinction.
 *
 * The boundary is `(?<![\w-])`, not `\b`, because `\b` counts a hyphen as a separator —
 * so `\bmarket` still fired inside **go-to-market**, a lens name, not an ask to go read
 * the market. A hyphen joins a compound word; it does not start a new one.
 *
 * Markers that begin with punctuation (`.com`, `http://`) have no boundary to anchor and
 * fall back to a plain substring test — `(?<![\w-])\.com` would misfire on its own dot.
 *
 * This is the fourth arrival of B5's own lesson: a gate that fires on the *mention* of a
 * risk rather than the risk is one people learn to override on sight. Here it did not
 * even fire on a mention — it fired on four letters inside an unrelated word.
 */
const has = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((n) => markerPattern(n).test(haystack));

const MARKER_CACHE = new Map<string, RegExp>();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function markerPattern(needle: string): RegExp {
  const cached = MARKER_CACHE.get(needle);
  if (cached) return cached;
  // Anchor only when the marker actually starts with a word character; `.com` and
  // `http://` cannot carry a boundary and must stay substring matches.
  const anchored = /^\w/.test(needle) ? `(?<![\\w-])${escapeRe(needle)}` : escapeRe(needle);
  const re = new RegExp(anchored, "i");
  MARKER_CACHE.set(needle, re);
  return re;
}

/**
 * Is this call a fan-out to the web for findings?
 *
 * Both signals are required. "Spawn a subagent to grep for callers of parseSpec"
 * has delegation but no web. "WebSearch for the current tsc flag" has web but no
 * delegation. Neither is research; neither is gated.
 */
export function isFanOutResearch(call: ToolCall): boolean {
  const tool = canonicalTool(call.tool_name);
  const input = call.tool_input ?? {};

  if (tool === "skill") {
    const skill = String(input.skill ?? "").trim().toLowerCase();
    return RIVAL_RESEARCH_SKILLS.has(skill);
  }

  if (!DELEGATION_TOOLS.has(tool)) return false;

  // Read every field the harness might carry the intent in. Prompt is the real one;
  // description and subagent_type are cheap corroboration.
  const raw = [input.prompt, input.description, input.subagent_type]
    .filter((v) => typeof v === "string")
    .join("\n")
    .toLowerCase();
  if (!raw) return false;

  // A web name the prompt only mentions in order to refuse it is evidence FOR the prompt,
  // not against it. Drop those before anything is matched.
  const text = dropNegatedWeb(raw);

  // Asking for findings is the constant: a subagent told to come back with sources,
  // citations, or a synthesis is doing research wherever it reads.
  if (!has(text, FINDINGS_MARKERS)) return false;

  // Naming a web tool settles it — a prompt that says "use WebSearch" is not code search
  // no matter how many file paths it also mentions.
  if (has(text, EXPLICIT_WEB_TOOLS)) return true;

  // Cannot-reach-the-web beats presume-the-web. A declared web-free tool
  // surface or an explicit no-tools prompt is the caller's own statement that
  // this spawn stays offline (#521) — and the tool-level gate still catches a
  // subagent that breaks the promise.
  const surface = declaredToolSurface(input);
  if (surface && !surface.some((tool) => WEB_CAPABLE_TOOL.test(canonicalTool(tool)))) return false;
  if (has(text, NO_TOOLS_DECLARATIONS)) return false;

  // Separate what is on this machine from what is on the web BEFORE matching either. A
  // dev-server URL and a path on disk are local targets; only what survives that removal
  // gets to argue that this prompt reaches the open web.
  const scope = scopeOf(text);
  if (scope.remoteUrl || has(scope.rest, STRONG_WEB_MARKERS)) return true;

  // A spawn that says where it reads is not ambiguous, and ambiguity is the only
  // thing the default-deny below is entitled to punish (#614). This sits AFTER
  // the remote-target check on purpose: unlike "no tools" — which is a statement
  // the subagent CANNOT reach the web — this is a statement that it WILL not,
  // and a prompt that says "local sources only" while naming a vendor's URL has
  // contradicted itself. Contradictions block. Put this any earlier and the
  // sentence becomes a skeleton key: prepend one line, keep the sweep.
  if (has(text, LOCAL_ONLY_DECLARATIONS)) return false;

  // Now — and only now — the rescue the REPO_MARKERS comment has always promised. A prompt
  // that says where it is going ("this repo", "grep", "the codebase") beats a word that only
  // might mean the web. Strong markers above are already past; nothing here can excuse them.
  const repoScoped = has(scope.rest, REPO_MARKERS);
  if (has(scope.rest, WEAK_WEB_MARKERS)) return !repoScoped;

  // No web signal left. A findings run pointed at a local target — a file on disk, a page
  // on a loopback port — is inspection, not discovery: a design critique, a code search, a
  // review of the thing you just built. That is the work this gate must never touch.
  if (scope.localTarget) return false;

  // Nothing local, nothing overtly web, and it wants findings. Presume the web, because
  // that is where an agent asked for "sources" and given no target will go. Default-deny
  // on ambiguity is the whole point — the previous default-allow is what let a vendor-docs
  // sweep through.
  return !repoScoped;
}

/**
 * How many fan-out lanes one `foo research` run authorizes.
 *
 * The standard depth contract bounds a run at 4 source classes plus a panel, and the agent
 * spawns roughly one subagent per lane. This is that budget, with headroom — not a number
 * to tune upward when a run feels cramped. If a run genuinely needs more lanes, it needs a
 * deeper depth, which prices itself.
 */
const DEFAULT_LANES = 8;

interface Marker {
  readonly at: number;
  readonly topic: string;
  /** Lanes still authorized by this run. Consumed, not just aged out. */
  readonly lanes: number;
}

function readMarker(root: string): Marker | null {
  const marker = markerPath(root);
  if (!existsSync(marker)) return null;
  try {
    const raw = JSON.parse(readFileSync(marker, "utf8")) as Partial<Marker>;
    const at = Number(raw.at ?? 0);
    if (!Number.isFinite(at) || at <= 0) return null;
    // A marker written before lanes existed authorized everything forever. Treat a missing
    // count as spent, not as unlimited — the whole bug was an exemption that outlived its run.
    const lanes = Number.isFinite(Number(raw.lanes)) ? Number(raw.lanes) : 0;
    return { at, topic: String(raw.topic ?? ""), lanes };
  } catch {
    // Unreadable marker: treat as absent and gate. Never fail open on a parse error.
    return null;
  }
}

/**
 * Is this fan-out one that a live `foo research` run actually planned?
 *
 * `foo research` plans the fan-out itself (source classes, page budget, panel) and the agent
 * executes it by spawning subagents — so without an exemption the gate would block the very
 * command it routes to.
 *
 * The exemption used to be time-only: any `foo research` run held the door open for TWO HOURS,
 * for ANY topic. It stored the topic and never read it. So one governed run on one subject
 * bought two hours of ungoverned research on every other subject — which is exactly how a
 * vendor-docs sweep for an unrelated spec walked straight through a boundary that was working
 * as designed.
 *
 * Now the exemption is CONSUMED. A run authorizes the lanes it planned; each fan-out spends
 * one; when they are gone the gate closes, whatever the clock says. The TTL stays as a
 * backstop for the run that is abandoned half-executed.
 */
export function researchActive(root: string, now: number = Date.now()): boolean {
  const marker = readMarker(root);
  if (!marker) return false;
  if (marker.lanes <= 0) return false;
  const ttlSeconds = Number(process.env.FOO_RESEARCH_TTL_SECONDS ?? 7200);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 7200;
  return now - marker.at < ttl * 1000;
}

/** True when a run is live but has spent every lane it planned. Earns its own message. */
export function researchLanesSpent(root: string, now: number = Date.now()): boolean {
  const marker = readMarker(root);
  if (!marker || marker.lanes > 0) return false;
  const ttlSeconds = Number(process.env.FOO_RESEARCH_TTL_SECONDS ?? 7200);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 7200;
  return now - marker.at < ttl * 1000;
}

/** Spend one authorized lane. Called when the gate lets a fan-out through on a live run. */
export function consumeResearchLane(root: string): void {
  const marker = readMarker(root);
  if (!marker || marker.lanes <= 0) return;
  writeFileSync(
    markerPath(root),
    `${JSON.stringify({ at: marker.at, topic: marker.topic, lanes: marker.lanes - 1 }, null, 2)}\n`,
  );
}

// ---------------------------------------------------------------------------
// The run receipt — the only layer that binds in a harness productfoo cannot hook.
//
// Tool hooks enforce only the coverage declared for a supported, wired host.
// An unwired or partially covered host can still read outside that path, so
// evidence validation must remain independent of hook availability.
//
// What foo CAN do in every harness is refuse to believe the result. `foo research` mints a
// receipt; a paper must carry that run id; `foo research validate` refuses a paper whose
// run it cannot find. The reading is not blocked — it cannot be blocked — but the evidence
// does not count, and evidence that does not count cannot enter a packet or a decision.
//
// This is the honest shape of the guarantee: productfoo cannot always stop you reading the web.
// It can always stop what you read from becoming proof. And it matters that this is a
// REFUSAL rather than a warning, because productfoo has already been burned by a hand-written
// paper full of invented citations that passed every check it had.
// ---------------------------------------------------------------------------

// A receipt is the portable proof that a governed run happened. Two stores, because
// minting and publishing pull in opposite directions:
//   - the WORKING store, gitignored `.foo/research-runs/`, is where every `foo research`
//     run mints. It must not be tracked: exploratory runs (and the test suite, which
//     spawns the CLI dozens of times) would otherwise litter the tree with a receipt per
//     invocation, most for papers that are never written.
//   - the PUBLISHED store, tracked `research/.runs/`, holds only the receipts of papers
//     that were committed. Committing a paper's one receipt here makes its proof travel
//     with it, so a governed paper's receipt row verifies for a reviewer on a fresh clone
//     — not only on the machine that ran it. Publish with `foo research seal <paper>`.
// `verify` reads the published store first, then the working store, so a receipt resolves
// whether it was minted-here or shipped-with-the-repo. This split exists because putting
// the mint target under `research/` tracked 28 test-run receipts in one commit — proof
// that "mint here, publish here" cannot be the same directory.
const runsDir = (root: string): string => path.join(root, ".foo", "research-runs");
const publishedRunsDir = (root: string): string => path.join(root, "research", ".runs");

/** Stable, collision-resistant, and derivable from nothing but the run itself. */
const runId = (topic: string, at: number): string =>
  `r-${at.toString(36)}-${randomBytes(12).toString("hex")}`;

export interface RunReceipt {
  readonly run_id: string;
  readonly topic: string;
  readonly at: number;
}

/** Called by `foo research` when it plans a run. The paper must carry the id it returns. */
export function mintResearchRun(root: string, topic: string, now: number = Date.now()): RunReceipt {
  const receipt: RunReceipt = { run_id: runId(topic, now), topic, at: now };
  mkdirSync(runsDir(root), { recursive: true });
  writeFileSync(path.join(runsDir(root), `${receipt.run_id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Does this paper's claimed run actually exist? A forged id has no receipt on disk.
 * Checks the published (tracked) store first, then the working `.foo/` store, so a receipt
 * resolves whether it shipped with the repo or was minted here. The `/^r-.../` guard also
 * stops an id from escaping the dir. */
export function verifyResearchRun(root: string, id: string): RunReceipt | null {
  if (!id || !/^r-[a-z0-9]+-[a-z0-9_-]+$/i.test(id)) return null;
  for (const dir of [publishedRunsDir(root), runsDir(root)]) {
    const file = path.join(dir, `${id}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RunReceipt>;
      if (!raw.run_id || raw.run_id !== id) continue;
      return { run_id: String(raw.run_id), topic: String(raw.topic ?? ""), at: Number(raw.at ?? 0) };
    } catch {
      continue;
    }
  }
  return null;
}

/** Publish a working-store receipt into the tracked store so its proof travels with the
 * committed paper. Idempotent. Returns what it did so the caller can speak plainly. */
export function sealResearchRun(root: string, id: string): "sealed" | "already-sealed" | "no-receipt" {
  if (!id || !/^r-[a-z0-9]+-[a-z0-9_-]+$/i.test(id)) return "no-receipt";
  const published = path.join(publishedRunsDir(root), `${id}.json`);
  if (existsSync(published)) return "already-sealed";
  const working = path.join(runsDir(root), `${id}.json`);
  if (!existsSync(working)) return "no-receipt";
  mkdirSync(publishedRunsDir(root), { recursive: true });
  writeFileSync(published, readFileSync(working, "utf8"));
  return "sealed";
}

/** Pull the run id a paper claims. Absent = the paper was not produced by a governed run. */
export function paperRunId(paperText: string): string | null {
  const m = /^research_run:\s*(\S+)\s*$/m.exec(paperText ?? "");
  return m ? m[1] : null;
}

/** Called by `foo research` when it hands the agent a research contract to execute. */
export function markResearchActive(
  root: string,
  topic: string,
  now: number = Date.now(),
  lanes: number = DEFAULT_LANES,
): void {
  const marker = markerPath(root);
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ at: now, topic, lanes }, null, 2)}\n`);
  // The ask has now been routed. Clear the pending flag so ordinary web lookups are free
  // again once the governed run is under way — and reset the read counter, because a
  // governed run reads the web a great deal and must never trip its own behavioural gate.
  clearResearchRequest(root);
  clearWebReads(root);
}

// ---------------------------------------------------------------------------
// Pending research request — set at the PROMPT, cleared when `foo research` runs.
//
// This is what makes "if productfoo is installed, a research task always goes through foo" true
// rather than aspirational. The UserPromptSubmit adapter injects a directive naming the
// command; the directive is advice, and advice loses to reflex. So it ALSO drops this
// marker, and while it is set the gate refuses the web outright — no fan-out required.
// You cannot read the web on a research task until productfoo has been run.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The behavioural trip — the part that does not depend on anybody saying the magic word.
//
// Every layer of this gate so far has been a KEYWORD list: web markers, then findings
// markers, then research-request markers. Each one was a guess at phrasing, and each one
// lost to phrasing it did not guess. The third guess was the prompt router: it catches
// "research identity platforms" and sails right past "which auth provider should we use?"
// — same task, same ungoverned reading, no magic word.
//
// You cannot fix that with a longer list. Phrasing is unbounded; behaviour is not.
//
// Research has a signature no wording can hide: the agent reads the web, and reads it
// again, and accumulates an answer. One read is a lookup (a stack trace, a package
// version) and must stay free, or the override goes on permanently and the gate is dead.
// Three reads in a few minutes is not a lookup. It is a research run that nobody routed.
//
// So: count the reads. The Nth trips the gate regardless of what anyone called the task.
// This is the layer that makes "if the task is research, it goes through foo" true for
// the user who never says the word "research" — which is most of them.
// ---------------------------------------------------------------------------

/** Reads allowed before the gate calls it research. 1-2 is a lookup; 3 is a pattern. */
const LOOKUP_ALLOWANCE = 3;

/** Reads older than this stop counting — a lookup this morning is not this run. */
const READ_WINDOW_SECONDS = 600;

const readsPath = (root: string): string => path.join(root, ".foo", "research-reads.json");

const readCount = (root: string, now: number): number[] => {
  const file = readsPath(root);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { reads?: unknown };
    const windowMs =
      (Number(process.env.FOO_RESEARCH_READ_WINDOW_SECONDS ?? READ_WINDOW_SECONDS) || READ_WINDOW_SECONDS) * 1000;
    return (Array.isArray(raw.reads) ? raw.reads : [])
      .map(Number)
      .filter((t) => Number.isFinite(t) && now - t < windowMs);
  } catch {
    return [];
  }
};

/** Record one web read. Called when the gate lets a lookup through. */
export function recordWebRead(root: string, now: number = Date.now()): void {
  const kept = readCount(root, now);
  kept.push(now);
  const file = readsPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ reads: kept }, null, 2)}\n`);
}

/** Cleared when a governed run starts — its own reading must not trip its own gate. */
export function clearWebReads(root: string): void {
  const file = readsPath(root);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Has the agent read the web enough times that this is plainly research, unnamed? */
export function webReadsLookLikeResearch(root: string, now: number = Date.now()): boolean {
  const allowance = Number(process.env.FOO_RESEARCH_LOOKUP_ALLOWANCE ?? LOOKUP_ALLOWANCE) || LOOKUP_ALLOWANCE;
  return readCount(root, now).length >= allowance - 1;
}

const requestPath = (root: string): string => path.join(root, ".foo", "research-requested.json");

export function markResearchRequested(root: string, topic: string, now: number = Date.now()): void {
  const file = requestPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ at: now, topic }, null, 2)}\n`);
}

export function clearResearchRequest(root: string): void {
  const file = requestPath(root);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** A research ask is on the table and `foo research` has not been run for it yet. */
export function researchRequested(root: string, now: number = Date.now()): string | null {
  const file = requestPath(root);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { at?: number; topic?: string };
    const at = Number(raw.at ?? 0);
    if (!Number.isFinite(at) || at <= 0) return null;
    // Short-lived on purpose: this governs the turn the ask arrived on, not the afternoon.
    // A stale flag that blocks an unrelated lookup an hour later is a gate people delete.
    const ttlSeconds = Number(process.env.FOO_RESEARCH_REQUEST_TTL_SECONDS ?? 900);
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 900;
    if (now - at >= ttl * 1000) return null;
    return String(raw.topic ?? "") || null;
  } catch {
    return null;
  }
}

const markerPath = (root: string): string => path.join(root, ".foo", "research-active.json");

// The user's line and the agent's are not long and short versions of one text. They are two
// sentences for two readers: the human learns what took over and why it is better, in their
// own words; the agent gets the command, the contract and the override. Nothing the user
// cannot act on belongs in their line — they are not the one about to run `bin/foo research`.
const DENY_REASON: DenialText = {
  user: "Research runs through foo — it cites its sources and says what it couldn't reach.",
  agent:
    "productfoo is installed: do not fan out raw web-research subagents. Research in this repo runs through " +
    "`bin/foo research \"<topic>\"` — the governed front door. It types the evidence, reports every source " +
    "class (including the ones it could NOT reach, so a gap is never silently dropped), bounds the fan-out " +
    "and prices it, runs an adversarial panel, and writes a paper you can cite. A raw subagent sweep returns " +
    "confident prose with no confidence levels, which is the kind of research that gets acted on and " +
    "shouldn't be. Run `bin/foo research \"<topic>\"` first, then execute the contract it prints. " +
    "Looking one thing up (a stack trace, a package version) is not research and is not gated — a single " +
    "WebSearch call passes. Deliberately going around foo? Set FOO_ALLOW_RAW_RESEARCH=1.",
};

const SPENT_REASON: DenialText = {
  user: "This research run has used the search budget it planned — a new subject needs a new run.",
  agent:
    "this `foo research` run has spent every fan-out lane it planned. A run authorizes the lanes " +
    "it budgeted — not a window of free rein — so a new subject needs a new run: " +
    "`bin/foo research \"<the new topic>\"`. (The old gate lifted for two hours on ANY topic, which " +
    "is how an unrelated vendor-docs sweep walked through a boundary that was working as designed.) " +
    "If this lane really is part of the current run and the budget was too tight, the run needed a " +
    "deeper depth — which prices itself — not a bigger exemption. Deliberately going around foo? " +
    "Set FOO_ALLOW_RAW_RESEARCH=1.",
};

/**
 * The whole policy. Pure except for the marker read, so it is testable and any harness
 * adapter can call it.
 *
 * Note the order: `researchLanesSpent` is checked before the generic deny, so an agent that
 * over-fans-out inside a real run is told THAT, rather than being told to run the command it
 * is already executing.
 */
export function evaluateResearchGate(
  call: ToolCall,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): GateDecision {
  if (env.FOO_ALLOW_RAW_RESEARCH) return { allow: true, note: "override" };

  const tool = canonicalTool(call.tool_name);

  // A research ask is live and productfoo has not been run for it. Now even a bare WebSearch is
  // part of an ungoverned research run, so it is refused — the ONE case where a single web
  // lookup is gated. Outside a pending research ask, lookups stay free, which is what keeps
  // this narrow enough to survive.
  if (WEB_TOOLS.has(tool)) {
    // A governed run is under way: its own reading is the point. Never gate it.
    if (researchActive(root)) return { allow: true, note: "foo-research-read" };

    // The human phrased it as research. Route it before a single page is read.
    const pending = researchRequested(root);
    if (pending) return { allow: false, reason: pendingReason(pending) };

    // Nobody called it research — and it is research anyway. This is the layer that does
    // not care what anyone said: the agent has already read the web LOOKUP_ALLOWANCE-1
    // times in the last few minutes and is reaching for another. That is not a lookup.
    if (webReadsLookLikeResearch(root)) return { allow: false, reason: UNNAMED_REASON };

    return { allow: true, note: "lookup" };
  }

  if (!isFanOutResearch(call)) return { allow: true, note: "not-research" };
  if (researchActive(root)) return { allow: true, note: "foo-research-lane" };
  if (researchLanesSpent(root)) return { allow: false, reason: SPENT_REASON };

  const pending = researchRequested(root);
  if (pending) return { allow: false, reason: pendingReason(pending) };
  return { allow: false, reason: DENY_REASON };
}

const UNNAMED_REASON: DenialText = {
  user: "That's several pages read — this is research now, so productfoo is taking it from here.",
  agent:
    "nobody called this research, and it is research: you have read the open web several times in the " +
    "last few minutes and are reaching for another page. One lookup is a lookup; this is a run. " +
    "It goes through foo — always:\n\n  bin/foo research \"<what you are actually trying to find out>\"\n\n" +
    "then execute the contract it prints. foo bounds and prices the fan-out, types every claim by " +
    "source class, reports the classes it could NOT reach so a gap is never silently dropped, runs an " +
    "adversarial panel, and writes a paper you can cite. What you are doing instead produces the same " +
    "shape of answer with no confidence levels and no record of what you missed — and that is exactly " +
    "the kind of evidence that gets acted on.\n\n" +
    "This fires on BEHAVIOUR, not on wording, because a gate that reads phrasing loses to phrasing it " +
    "did not anticipate — this one lost twice before it stopped guessing. Deliberately going around " +
    "foo? Set FOO_ALLOW_RAW_RESEARCH=1.",
};

// The topic goes to the agent only. It is the user's own phrasing, so it would read fine —
// but it is arbitrarily long, and a deny line is not the place to reflect a paragraph of
// their prompt back at them in red.
const pendingReason = (topic: string): DenialText => ({
  user: "Research runs through foo — it cites its sources and says what it couldn't reach.",
  agent:
    `this is a research task and productfoo is installed, so it runs through foo — always. ` +
    `Run this first, then execute the contract it prints:\n\n  bin/foo research "${topic}"\n\n` +
    `foo plans and prices the fan-out, types every claim by source class, reports the classes it ` +
    `could NOT reach (so a gap is never silently dropped), runs an adversarial panel, and writes a ` +
    `paper you can cite. Reading a few pages yourself and writing confident prose produces the same ` +
    `shape of answer with none of that — and it is the kind of evidence that gets acted on. ` +
    `Until productfoo has been run for this ask, the web is closed, including single lookups: ` +
    `the reflex this stops is "just start reading", not only "spawn subagents". ` +
    `Deliberately going around foo? Set FOO_ALLOW_RAW_RESEARCH=1.`,
});
