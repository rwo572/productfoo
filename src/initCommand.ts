import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { gatherRepoSignals, generateMoves, rankMoves, type Move, type RepoSignals } from "./repoRead.js";
import { detectTensions } from "./firstMoveTensions.js";
import { updateTask } from "./packetWrite.js";
import { gitRunOrNull } from "./gitRun.js";
import { readFileSync, readdirSync } from "node:fs";
import { loadProfile, PRODUCT_VIEW_ROLES, profileHarnesses, runFirstRunSurvey, saveProfile, reportProfile, type SurveyIO } from "./profile.js";
import { readPackageVersion } from "./commands/shared.js";
import { decisionRequestAuthoringComment } from "./specSections.js";
import { clientVersion } from "./updateNotice.js";

// foo init — the language-free first read. It reads what the developer already
// has, hands back a recommended first move plus options in plain English (a
// number or prose both work), and teaches productfoo's words in context as it goes.
// Picking a move scaffolds a real spec packet underneath — the user never has
// to type a foo verb to get the contract.
//
// It is also productfoo's orientation surface (cli-first-run-v0 R-013/D-011): the
// first-ever run in a repo opens with two plain lines, then goes quiet forever;
// a run outside a repo tells the short story instead of erroring. `foo learn`
// is a hidden alias for this command (dispatched in cli.ts).

// The first-run strings, exported as the eval corpus (R-007a): the language
// tests scan exactly these constants, so a wording change can't dodge the eval.
// T-006's render chokepoint should absorb these when it lands.
export const FIRST_RUN_OPENER: readonly string[] = [
  "productfoo helps you agree on work before building, and prove it when it's done.",
  "It starts by reading what's already in your project.",
];

export const NO_REPO_STORY: readonly string[] = [
  "productfoo — agree on work before building, prove it when it's done.",
  "",
  "The loop is short: say what you want to build, productfoo turns it into an",
  "agreed plan in writing, and when the work ships you attach proof so",
  "anyone can see it's really done — not just claimed done.",
  "",
  "This folder isn't a project yet, so there's nothing to read here.",
  "",
  "Next: cd into a project and run `foo init` again.",
];

function isGitRepo(root: string): boolean {
  return gitRunOrNull(["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }) !== null;
}

// The once-ever marker lives in gitignored local state (.foo/), so the opener
// never renders twice on the same checkout and never ships in a commit.
function firstRunMarkerPath(root: string): string {
  return path.join(root, ".foo", "first-run");
}

function hasSeenFirstRun(root: string): boolean {
  return existsSync(firstRunMarkerPath(root));
}

function markFirstRunSeen(root: string): void {
  const marker = firstRunMarkerPath(root);
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, `${new Date().toISOString()}\n`);
}

function plainRead(signals: RepoSignals): string {
  const parts: string[] = [];
  parts.push(signals.languages.length ? `a ${signals.languages.slice(0, 2).join("/")} project` : "a project");
  parts.push(`${signals.sourceFileCount} source file${signals.sourceFileCount === 1 ? "" : "s"}`);
  parts.push(signals.hasTests ? "tests present" : "no tests");
  parts.push(signals.hasCI ? "CI set up" : "no CI");
  if (signals.readmeBytes === 0) parts.push("no README");
  else if (signals.readmeBytes < 400) parts.push("a thin README");
  return parts.join(", ");
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "first-move";
}

// Scaffold a minimal, structurally valid spec packet from a chosen move. This is
// the "packet created invisibly" — the durable foo contract appears without the
// user naming it.
export function scaffoldPacket(root: string, title: string, evidence: string[], intent: string): string {
  const slug = slugify(title);
  const specId = `${slug.replace(/-/g, "_")}_v0`;
  const packetDir = path.join(root, "specs", `${slug}-v0`);
  mkdirSync(packetDir, { recursive: true });
  const now = new Date().toISOString();

  const ev = evidence.length ? evidence.join("; ") : "captured from foo init";
  const spec = [
    "---",
    `spec_id: ${specId}`,
    `title: ${JSON.stringify(title)}`,
    "mode: capability",
    "lifecycle: draft",
    "stage: shaping",
    "owner: product",
    "autonomy: human-in-loop",
    `updated: ${now}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Intent",
    "",
    `${title}. ${intent}`.trim(),
    "",
    "## Current Understanding",
    "",
    `Started by foo init from a repo read. Evidence: ${ev}.`,
    "",
    "## Requirements",
    "",
    `- R-001 (must): ${title}.`,
    "",
    "## Decisions",
    "",
    "- Started from the foo init recommendation; scope to be confirmed in shaping.",
    "",
    "## Risks",
    "",
    "- Scope is unconfirmed — shape before building.",
    "",
    "## Validation",
    "",
    "- inspection: the plan reads back cleanly once shaped.",
    "",
    "## Evidence",
    "",
    `- foo init repo read: ${ev}.`,
    "",
    "## Open Questions",
    "",
    decisionRequestAuthoringComment(),
    "",
  ].join("\n");

  const tasks = [
    'schema_version: "0.1"',
    `spec_id: ${specId}`,
    `spec_ref: specs/${slug}-v0/spec.md`,
    `updated: "${now}"`,
    "",
    "defaults:",
    "  autonomy: human-in-loop",
    "  stale_after_days:",
    "    suggested: 7",
    "    discovered: 7",
    "",
    "ledger:",
    "  segment_order:",
    "    - events.jsonl",
    "",
    "tasks:",
    "  - id: T-001",
    `    title: Shape ${title}`,
    "    status: todo",
    "    agreement: agreed",
    "    stage: shaping",
    "    refs: [R-001]",
    "    depends_on: []",
    "    owner: agent:any",
    "    autonomy: human-in-loop",
    "    do:",
    `      - Interview to confirm scope for: ${title}.`,
    "    done_when:",
    "      - id: C-001",
    "        text: Scope is confirmed and the smallest useful slice is named.",
    "        done: false",
    '        proof: ""',
    "    completed: null",
    "    blocked: null",
    "    review:",
    "      owner: product",
    "      due: null",
    "      stale_after_days: null",
    "    extensions: {}",
    "",
  ].join("\n");

  const event =
    JSON.stringify({
      specversion: "0.1",
      id: "evt_init_001",
      source: "agent://foo/init",
      type: "com.adaptivespec.spec.created",
      subject: `spec:${specId}`,
      time: now,
      actor: { type: "agent", id: "foo-init", mode: "human-in-loop" },
      data: { mode: "capability", stage: "shaping", summary: `Created by foo init from a repo read: ${title}.` },
      extensions: {},
    }) + "\n";

  writeFileSync(path.join(packetDir, "spec.md"), spec);
  writeFileSync(path.join(packetDir, "tasks.yaml"), tasks);
  writeFileSync(path.join(packetDir, "events.jsonl"), event);
  return packetDir;
}

// The structured surface a coding-agent harness fills with sharper
// judgment. The deterministic moves are the floor; this contract is the ceiling.
function agentContract(signals: RepoSignals, moves: Move[]) {
  return {
    instructions:
      "Compose a recommended first move plus 2-3 options for this repo. Lead with the recommendation, number the options, and give each a one-line reason grounded in the signals below. Say why the top option beats the runner-up. Use the developer's own words; when you use a foo term (shaping, spec, boundary), define it inline on first use in <=6 words. Never show an option without a concrete repo fact.",
    grammar: ["recommendation-first", "numbered options", "comparative why", "plain language", "define foo terms inline"],
    signals,
    deterministic_moves: moves,
  };
}

type InitOptions = { json: boolean; pick: number | null; intent: string | null; pm: boolean; attachProof: string | null };

export function parseInitArgs(args: string[]): InitOptions {
  const options: InitOptions = { json: false, pick: null, intent: null, pm: false, attachProof: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--pick") {
      const value = args[i + 1];
      if (!value || !/^[0-9]+$/.test(value)) throw new Error("--pick requires a number");
      options.pick = Number(value);
      i += 1;
    } else if (arg === "--intent") {
      const value = args[i + 1];
      if (!value) throw new Error("--intent requires text");
      options.intent = value;
      i += 1;
    } else if (arg === "--pm") options.pm = true;
    else if (arg === "--attach-proof") {
      const value = args[i + 1];
      if (!value) throw new Error("--attach-proof requires text (what shows it's done)");
      options.attachProof = value;
      i += 1;
    } else throw new Error(`unknown init argument: ${arg}`);
  }
  return options;
}

// The most recent init-scaffolded spec: where --attach-proof lands. Found by
// the foo-init creation event, newest first, so the PM never names a path.
function latestInitSpec(root: string): string | null {
  const specsDir = path.join(root, "specs");
  if (!existsSync(specsDir)) return null;
  const candidates = readdirSync(specsDir)
    .map((name) => path.join(specsDir, name))
    .filter((dir) => {
      const events = path.join(dir, "events.jsonl");
      return existsSync(events) && readFileSync(events, "utf8").includes("agent://foo/init");
    })
    .sort((a, b) => (readFileSync(path.join(b, "events.jsonl"), "utf8") > readFileSync(path.join(a, "events.jsonl"), "utf8") ? 1 : -1));
  return candidates[0] ?? null;
}

// foo-pm-surface-v0 R-004 guard: these internal words must never render on the
// PM surface; the raw layer keeps them exactly. The canonical list lives with
// the linter (productDetect JARGON_TERMS) so the PM guard and the shipped-prose
// jargon signal can never drift apart. Re-exported for the regression tests.
// `export ... from` re-exports without binding the name locally, and
// pmSurfaceLeaks below needs it in scope — so import, then re-export.
import { JARGON_TERMS } from "./productDetect.js";
export { JARGON_TERMS as PM_SURFACE_FORBIDDEN };

// comprehension-loop-v0 T-002: the one membership check, lowercased on BOTH
// sides — "Packet ASP Done_When Reconcile" used to walk straight past a
// case-sensitive includes(). Every surface eval goes through this helper so
// the Shift key never beats the list again.
export function pmSurfaceLeaks(text: string): string[] {
  const lower = text.toLowerCase();
  return JARGON_TERMS.filter((word) => lower.includes(word.toLowerCase()));
}

function firstCheckText(packetDir: string): string {
  const tasks = readFileSync(path.join(packetDir, "tasks.yaml"), "utf8");
  const m = tasks.match(/^\s+text: (.+)$/m);
  return m ? m[1].trim() : "Scope is confirmed and the smallest useful slice is named.";
}

// T-003: the jargon-free scaffold message — the spec, what it believes, what
// counts as done, and the proof move. Raw-layer filenames never appear.
// The line that replaced a broken promise. init used to say "Next I'd ask a
// few quick questions to lock the scope" — and nothing anywhere asked; the
// asking lives with the coding agent (the init handoff instructs it) or in
// `foo spec`. Name the real next step instead of promising one that never comes.
function scopeNextStep(title: string): string {
  return `Scope is unconfirmed until a short interview locks it — your coding agent runs that next, or start it yourself: foo spec "${title}"`;
}

function pmScaffoldMessage(root: string, dir: string, title: string): string {
  const specName = path.basename(dir);
  return [
    `Started the spec for "${title}".`,
    `  Where it lives: specs/${specName} (the spec is a short written agreement; productfoo keeps the full history underneath)`,
    `  What it believes so far: ${scopeNextStep(title)}`,
    `  What counts as done: ${firstCheckText(dir)}`,
    "When the work is done, attach proof:",
    '  foo init --pm --attach-proof "what shows it\'s done"',
    "Any time after that, check for drift — foo compares the spec against what actually got built.",
    "",
  ].join("\n");
}

export function runInit(root: string, args: string[]): string {
  const options = parseInitArgs(args);

  // init-onboarding-survey-v0 R-003: the profile personalizes the surface.
  // Product-view roles (product, founder, executive) make the PM surface the
  // default — no more typing --pm. Explicit flags still win, and --json never
  // changes shape (the PM render branch already excludes it).
  if (!options.pm && loadProfile(root)?.roles?.some((role) => PRODUCT_VIEW_ROLES.includes(role))) options.pm = true;

  // R-013: a bare read with no repo underneath tells the short story and ends
  // on the one next step — the empty state is the orientation, never an error.
  // Explicit actions (--pick/--intent/--attach-proof) and --json keep their
  // existing behavior everywhere.
  const bareRead = !options.json && options.pick === null && !options.intent && !options.attachProof;
  if (bareRead && !isGitRepo(root)) return `${NO_REPO_STORY.join("\n")}\n`;

  // R-013: the first-ever read in a repo opens with two plain lines, then goes
  // quiet forever. Human read paths only — never --json (agents read that), and
  // an explicit action flag means they have already met foo.
  let opener = "";
  if (bareRead && !hasSeenFirstRun(root)) {
    opener = `${FIRST_RUN_OPENER.join("\n")}\n\n`;
    markFirstRunSeen(root);
  }

  // PM surface: attach proof to the newest init-started spec (T-003 — the
  // proof moment in plain language; the raw contract is updated underneath).
  if (options.pm && options.attachProof) {
    const dir = latestInitSpec(root);
    if (!dir) return "No spec started by foo init yet — start one first: foo init --pm\n";
    updateTask({ packetDir: dir, taskId: "T-001", status: "done", proof: options.attachProof, summary: "First done_when proven via foo init --pm." });
    return [
      "Proof attached — the first check is now proven.",
      `  What counted as done: ${firstCheckText(dir)}`,
      `  Your proof: ${options.attachProof}`,
      "Next: check for drift any time — productfoo will compare the spec against what actually got built.",
      "",
    ].join("\n");
  }

  const signals = gatherRepoSignals(root);
  const moves = generateMoves(signals);
  const ranked = rankMoves(moves);
  const ordered = ranked.recommended ? [ranked.recommended, ...ranked.rest] : [];
  // first-move-two-facts: a real, grounded tension (two facts the repo already
  // holds, in conflict) outranks every hygiene chore as the headline first move.
  // Human read paths only (agents read --json's raw moves); only fires when the
  // signal genuinely supports it, so a boring hygiene move or the honest floor
  // still leads when there's no real tension to surface.
  if (!options.json) {
    const topTension = detectTensions(root)[0] ?? null;
    if (topTension) {
      ordered.unshift({ id: `tension:${topTension.id}`, title: topTension.title, evidence: topTension.evidence, risk: 3, leverage: 3, effort: 2, tension: topTension });
    }
  }

  // Act on an explicit pick or a free-text intent: scaffold the packet.
  if (options.intent) {
    const dir = scaffoldPacket(root, options.intent, [], "Stated directly to foo init.");
    if (options.pm) return pmScaffoldMessage(root, dir, options.intent);
    return [
      `Got it — we'll shape "${options.intent}".`,
      `I started a plan (a spec) for it at ${path.relative(root, dir) || dir}.`,
      scopeNextStep(options.intent),
      "",
    ].join("\n");
  }
  if (options.pick !== null) {
    const move = ordered[options.pick - 1];
    if (!move) throw new Error(`no option ${options.pick}; run foo init to see the options`);
    const dir = scaffoldPacket(root, move.title, move.evidence, "Picked from the foo init read.");
    if (options.pm) return pmScaffoldMessage(root, dir, move.title);
    return [
      `Got it — we'll shape "${move.title}".`,
      `I started a plan (a spec) for it at ${path.relative(root, dir) || dir}.`,
      scopeNextStep(move.title),
      "",
    ].join("\n");
  }

  // T-002: the persona-shaped PM first move — same repo facts, the signed-off
  // vocabulary (vocabulary-map.md): "the spec", "expert review", "what counts
  // as done", "proof attached", "check for drift". Never a raw-layer word.
  if (options.pm && !options.json) {
    if (ordered.length === 0) {
      return opener + [
        "foo — a first read of your project",
        "",
        `Read: ${plainRead(signals)}. Not enough here yet to point at one thing.`,
        "",
        "Tell me what you want to ship and we'll shape it into an agreed spec:",
        '  foo init --pm --intent "…"',
        "",
      ].join("\n");
    }
    const lines = [
      "foo — a first read of your project",
      "",
      `Read: ${plainRead(signals)}.`,
      "",
      "Pick one and foo shapes it with you: a short agreed spec — what we're",
      "building, what it believes and why, and what counts as done. An expert",
      "review (product, design, engineering, data, GTM) is available on anything risky.",
      "",
    ];
    ordered.forEach((m, i) => {
      if (i === 0 && m.tension) {
        // Two facts, one friction: stack them so the tension sits in the gap.
        lines.push("→ 1 (recommended) — the thing hiding in plain sight:");
        lines.push(`    ${m.tension.factA}`);
        lines.push(`    ${m.tension.factB}`);
        lines.push(`    ${m.tension.ask}`);
      } else if (i === 0) {
        lines.push(`→ 1 (recommended) ${m.title}`);
        lines.push(`    seen in your project: ${m.evidence.join("; ")}`);
        if (ranked.why) lines.push(`    Why this first: ${ranked.why}.`.replace("..", "."));
      } else {
        lines.push(`  ${i + 1} ${m.title}  —  ${m.evidence[0]}`);
      }
    });
    lines.push("");
    lines.push("Reply with a number, or say it in your own words:");
    lines.push("  foo init --pm --pick 1");
    lines.push('  foo init --pm --intent "…"');
    lines.push("Once the work is done, attach proof:");
    lines.push('  foo init --pm --attach-proof "what shows it\'s done"');
    lines.push("");
    return opener + lines.join("\n");
  }

  if (options.json) {
    return (
      JSON.stringify(
        {
          schema_version: "0.1",
          read: plainRead(signals),
          options: ordered.map((m, i) => ({
            n: i + 1,
            id: m.id,
            title: m.title,
            evidence: m.evidence,
            recommended: i === 0,
            why: i === 0 ? ranked.why : null,
          })),
          agent_contract: agentContract(signals, moves),
        },
        null,
        2,
      ) + "\n"
    );
  }

  // Thin-repo fallback: never invent options. Ask what they came to build.
  if (ordered.length === 0) {
    return opener + [
      "foo init — a first read of your repo",
      "",
      `Read: ${plainRead(signals)}. Not enough here yet for me to point at one thing.`,
      "",
      "Tell me what you came to build and we'll shape it:",
      '  foo init --intent "…"',
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "foo init — a first read of your repo",
    "",
    `Read: ${plainRead(signals)}.`,
    "",
    "Here's what I'd pick up first. Choosing one starts shaping it — in foo,",
    "shaping just means turning a rough idea into an agreed spec (a short written",
    "plan) before any code gets written.",
    "",
  ];
  ordered.forEach((m, i) => {
    if (i === 0) {
      lines.push(`→ 1 (recommended) ${m.title}`);
      lines.push(`    ${m.evidence.join("; ")}`);
      if (ranked.why) lines.push(`    Why this first: ${ranked.why}.`.replace("..", "."));
    } else {
      lines.push(`  ${i + 1} ${m.title}  —  ${m.evidence[0]}`);
    }
  });
  lines.push("");
  lines.push("Reply with a number to start, or say it in your own words:");
  lines.push("  foo init --pick 1");
  lines.push('  foo init --intent "…"');
  lines.push("");
  return opener + lines.join("\n");
}

// The survey can only ask on a live terminal, so an agent-run `foo init` leaves
// foo not knowing who it is talking to. Then — and only then — the handoff asks
// the agent to run the four questions in its own voice. foo already knows
// whether a profile exists, so this decision belongs to the CLI, not to a static
// line in a launcher that would ask every user forever.
export function initHandoffSteps(root: string): string[] {
  if (loadProfile(root)) return [];
  return [
    'Get to know the user first — once, ever. Ask four quick questions in your own words, each one skippable: their role (product, engineer, designer, founder, or executive — any that fit), the coding agent they build with most, what they are building (a few words), and who is building with them (just them, a small team, a bigger org). Record the answers with `foo profile set --role <r> [--role <r2>] --harness <agent> --team <just-me|small-team|larger-org> --building "<their words>"`. This personalizes foo across every project on their machine; the free-text "building" answer stays on their machine and is never reported. Never re-ask once it is recorded.',
  ];
}

// init-onboarding-survey-v0 R-001, amended by machine-wide-profile-v0: the
// survey fires once per PERSON, not once per repo — so it gates on "no profile
// yet anywhere" rather than the per-repo first-run marker. Still only on a live
// terminal, a bare read, in a repo; piped/agent runs (--json, action flags,
// non-TTY) never see it. Answer in one project and every other project already
// leads with your view — no re-ask.
export function surveyApplies(root: string, args: string[], io: { inputTTY: boolean; outputTTY: boolean }): boolean {
  let options: InitOptions;
  try {
    options = parseInitArgs(args);
  } catch {
    return false; // bad args fail in runInit with today's message, not mid-survey
  }
  const bareRead = !options.json && options.pick === null && !options.intent && !options.attachProof;
  return bareRead && io.inputTTY && io.outputTTY && isGitRepo(root) && !loadProfile(root);
}

// The interactive front door cli.ts dispatches to. When the survey applies it
// owns the whole first-run moment: opener lines, then the four skippable
// questions, then the repo read — and the marker is consumed up front so the
// moment can never replay (R-001). Any survey failure degrades to today's
// read untouched (R-005).
export async function runInitInteractive(
  root: string,
  args: string[],
  io?: SurveyIO & { inputTTY?: boolean; outputTTY?: boolean },
): Promise<string> {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;
  const ttys = {
    inputTTY: io?.inputTTY ?? Boolean(process.stdin.isTTY),
    outputTTY: io?.outputTTY ?? Boolean(process.stdout.isTTY),
  };
  if (surveyApplies(root, args, ttys)) {
    // Emit the opener only if this repo hasn't shown it; either way mark it so
    // runInit doesn't repeat it after the survey.
    if (!hasSeenFirstRun(root)) output.write(`${FIRST_RUN_OPENER.join("\n")}\n\n`);
    markFirstRunSeen(root);
    try {
      const profile = await runFirstRunSurvey({ input, output });
      saveProfile(profile); // machine-wide: the answer follows the person
      // Record the fixed profile picks in the local agent log.
      void reportProfile(root, profile, readPackageVersion(root));
    } catch {
      // The read always renders (R-005); foo just never asks again.
    }
  }
  // #913/#622: the boot path skips init so the offer comes HERE, after the
  // survey, naming the agents the person just picked. Ask-first: nothing is
  // written without an explicit yes; the answer is remembered.
  if (ttys.inputTTY && ttys.outputTTY && !args.includes("--json")) {
    try {
      const { autoWireMessage, maybeAutoWireHarnesses } = await import("./commands/agent.js");
      const outcome = await maybeAutoWireHarnesses(readPackageVersion(root), {
        preferred: profileHarnesses(loadProfile(root)),
        ask: async (question) => {
          const readline = await import("node:readline/promises");
          const rl = readline.createInterface({ input, output });
          try {
            // Enter means yes; only an explicit n/no declines (#913).
            return !/^(n|no)$/i.test((await rl.question(question)).trim());
          } finally {
            rl.close();
          }
        },
      });
      if (outcome) output.write(autoWireMessage(outcome));
    } catch {
      // Best-effort: the read always renders.
    }
  }
  return runInit(root, args);
}
