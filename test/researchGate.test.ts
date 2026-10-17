import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import {
  consumeResearchLane,
  evaluateResearchGate,
  isFanOutResearch,
  markResearchActive,
  markResearchRequested,
  mintResearchRun,
  paperRunId,
  researchActive,
  recordWebRead,
  researchRequestTopic,
  researchRequested,
  sealResearchRun,
  verifyResearchRun,
  webReadsLookLikeResearch,
} from "../src/researchGate.js";
import { HARNESS_GATES, renderDenial } from "../src/harnessGates.js";

/** A denial's two audiences, minimal. See DenialText. */
const NO = { user: "no-user", agent: "no-agent" };

const tmpRoot = (): string => mkdtempSync(path.join(tmpdir(), "foo-research-gate-"));

// The call that actually happened — four subagents told to sweep the web and report
// back. This is the regression the gate exists for; if it ever allows, the gate is dead.
const REAL_MISS = {
  tool_name: "Agent",
  tool_input: {
    description: "Research a coding-agent product and positioning",
    subagent_type: "general-purpose",
    prompt:
      "Research a coding-agent product as of mid-2026. Use WebSearch and WebFetch extensively. " +
      "Return a dense, factual brief with source URLs and dates.",
  },
};

test("denies the fan-out that actually slipped through", () => {
  const root = tmpRoot();
  try {
    const decision = evaluateResearchGate(REAL_MISS, root, {});
    assert.equal(decision.allow, false);
    assert.match(decision.reason?.agent ?? "", /foo research/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delegation without the web is not research", () => {
  // The false positive that would get this gate deleted: ordinary code search.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        subagent_type: "Explore",
        prompt: "Find every caller of parseSpec across src/ and report the file:line for each.",
      },
    }),
    false,
  );
});

test("a prompt that forbids the web is not a web sweep", () => {
  // Found by productfoo's own spec-swarm: seven lenses were denied for saying "do not use
  // WebSearch". The gate matched the tool name and never saw the "not" — so the one
  // instruction that PROVES a prompt stays off the web is the instruction that blocked it.
  // An agent cannot reassure a gate that reads reassurance as intent.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        description: "Expert 6",
        prompt:
          "You are one expert lens in a design review. This is NOT research: do not use " +
          "WebSearch or WebFetch, do not touch the network. Read only local files in this " +
          "repo. Return your findings with evidence you can point to.",
      },
    }),
    false,
  );
});

test("negation does not launder a real sweep", () => {
  // The other side of that fix: stripping a negated clause must remove only that clause.
  // The breach prompt says "Do NOT trust search snippets" and is still, unmistakably, a web
  // sweep — the markers around the negation survive the strip.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt:
          "Fetch PRIMARY sources (vendor docs, GitHub repos, changelogs). Do NOT trust " +
          "search snippets. Report findings with citations.",
      },
    }),
    true,
  );
});

test("one ordinary product word does not beat explicit repo scope", () => {
  // `published` is a web marker and also a perfectly ordinary word in a product repo. A lens
  // prompt naming src/, "this repo" and grep was refused because it also said "productfoo's
  // published surface is ~8 commands". REPO_MARKERS was supposed to rescue it — the comment
  // above that list says exactly this — but the web-marker check returned first, so the
  // rescue could never fire. The gate did not do what its own comment promised.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt:
          "You are one expert lens. Read src/ and this repo, grep the codebase. productfoo's " +
          "published surface is ~8 commands, not 95. Return your top 2 questions with " +
          "evidence and findings.",
      },
    }),
    false,
  );
});

test("an ideator cell that says it reads local sources only is not a web fan-out (#614)", () => {
  // The sixth arrival, and the one that refused productfoo's own contract. `foo ideate`
  // at standard depth mandates five blind ideator cells; four ran and the fifth
  // was denied. Nothing about the fifth cell differed in kind — every cell read
  // two local files and named no web tool. What differed was wording: the ideate
  // contract's own vocabulary ("dissent must cite the observation", "the evidence
  // brief") trips the findings markers, and a cell whose prompt happened not to
  // name a src/-shaped path then fell through to default-deny.
  //
  // Reported as a fan-out-WIDTH trip (the 4th+ concurrent spawn). It is not:
  // there is no spawn counter anywhere in this gate, and the width loop below
  // pins that the same prompt is judged the same at any width.
  const cell = (extra: string) =>
    ({
      tool_name: "Task",
      tool_input: {
        description: "ideator cell",
        subagent_type: "general-purpose",
        prompt:
          "You are ideator-5. Cell: frame=inversion, lens=design, seed=17. " +
          "Return five idea objects as JSON; every claim must cite the observation it rests on, " +
          "and use the evidence brief you were given. " +
          extra,
      },
    }) as never;

  // The bug, still reproducible without the declaration: findings vocabulary, no
  // named path, so the gate presumes the web.
  assert.equal(isFanOutResearch(cell("")), true, "the reported false positive must still reproduce without a declaration");

  // The fix: the cell says where it reads.
  assert.equal(isFanOutResearch(cell("Read local sources only.")), false);
  assert.equal(isFanOutResearch(cell("This cell reads local files only.")), false);

  // Width is not the trigger and never was — same prompt, judged identically
  // whether it is the first spawn or the ninth.
  for (let i = 0; i < 9; i += 1) {
    assert.equal(isFanOutResearch(cell("Read local sources only.")), false, `spawn ${i + 1} must judge the same`);
  }

  // The declaration is not a skeleton key. A spawn that says both "local only"
  // and "use WebSearch" is a contradiction, and contradictions block.
  assert.equal(
    isFanOutResearch(cell("Read local sources only. Then use WebSearch for the competitive landscape.")),
    true,
    "a declared-local spawn that names a web tool is a contradiction, not an exemption",
  );
  assert.equal(
    isFanOutResearch(cell("Read local sources only, then survey the vendor documentation at https://example.com/docs.")),
    true,
    "a remote URL still wins over the declaration",
  );
});

test("a tool-less persona spawn is not a web fan-out (#521)", () => {
  // The fifth false-positive arrival: a synthetic-customer rehearsal spawned one
  // subagent to role-play the persona in isolation (the anti-sycophancy rule),
  // said "Do not use any tools", asked for hypothesis verdicts, and named no
  // location — a persona has no file path. Default-deny presumed the web and the
  // isolation the skill designed for was lost. A spawn that cannot reach the web
  // is not a web fan-out.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        description: "persona role-play",
        prompt:
          "You are Chris, a VP of Operations at a mid-market HVAC company. Do not use any tools. " +
          "Answer the interviewer's questions in character from the persona brief alone. At the end, " +
          "report which hypotheses your answers supported or refuted, with the quotes as evidence.",
      },
    }),
    false,
  );
});

test("a no-tools claim does not launder a prompt that also names a web tool", () => {
  // "No tools" next to "use WebSearch" is a contradiction, and contradictions
  // block: the positive tool name has already settled it before the declaration
  // is consulted.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt: "Do not use any tools except WebSearch; use WebSearch to gather sources and report findings.",
      },
    }),
    true,
  );
});

test("a declared tool surface without a web tool exempts the spawn; one with a web tool does not", () => {
  // Some harnesses pass the spawn's tool list. A surface that names no
  // web-capable tool is the caller's own statement the spawn stays offline; a
  // surface that includes one changes nothing about the prose verdict.
  const prompt = "Judge the three candidate designs and report findings with citations to the strongest sources.";
  assert.equal(isFanOutResearch({ tool_name: "Task", tool_input: { prompt, tools: ["Read", "Grep", "Glob"] } }), false);
  assert.equal(isFanOutResearch({ tool_name: "Task", tool_input: { prompt, tools: ["Read", "WebFetch"] } }), true);
});

test("repo scope rescues a weak marker, never a strong one", () => {
  // The line the fix has to hold. `docs` is ordinary; `scrape` and `vendor docs` are not.
  // Without this pair, "let repo scope win" is how B5's second breach walks straight back
  // in — that sweep said "GitHub repos", and a blanket rescue reads that as code search.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: { prompt: "Read the docs in this repo and report your findings." },
    }),
    false,
  );
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt:
          "Scrape the vendor docs for every GitHub repo in this repo's deps and report findings.",
      },
    }),
    true,
  );
});

test("the web without delegation is not research", () => {
  // Looking one thing up. Gating this is how you train someone to set the override
  // permanently, and an override that is always on is not a gate.
  assert.equal(
    isFanOutResearch({ tool_name: "WebSearch", tool_input: { query: "tsc --erasableSyntaxOnly flag" } }),
    false,
  );
});

test("a rival research skill is a front door too", () => {
  assert.equal(isFanOutResearch({ tool_name: "Skill", tool_input: { skill: "deep-research" } }), true);
  assert.equal(isFanOutResearch({ tool_name: "Skill", tool_input: { skill: "verify" } }), false);
});

test("foo research does not trip its own gate", () => {
  const root = tmpRoot();
  try {
    assert.equal(evaluateResearchGate(REAL_MISS, root, {}).allow, false);
    markResearchActive(root, "coding-agent comparison");
    const decision = evaluateResearchGate(REAL_MISS, root, {});
    assert.equal(decision.allow, true, "foo research plans a fan-out; the agent must be able to run it");
    // Renamed from "foo-research-active": the allow now comes from a LANE the run budgeted,
    // not from a clock that was still ticking.
    assert.equal(decision.note, "foo-research-lane");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exemption expires instead of wedging open", () => {
  const root = tmpRoot();
  try {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    markResearchActive(root, "stale topic", threeHoursAgo);
    assert.equal(researchActive(root), false, "a 2h-old research run must not license tomorrow's fan-out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FOO_RESEARCH_TTL_SECONDS tunes recognition of a governed run and never admits an ungoverned one", () => {
  const root = tmpRoot();
  const original = process.env.FOO_RESEARCH_TTL_SECONDS;
  try {
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    markResearchActive(root, "stale topic", threeHoursAgo);
    assert.equal(researchActive(root), false, "the default 2h TTL has already expired this run");

    // Widening the window recognizes a run that is genuinely still in flight.
    process.env.FOO_RESEARCH_TTL_SECONDS = String(4 * 60 * 60);
    assert.equal(researchActive(root), true, "a longer TTL keeps the SAME governed run recognized");

    // What it must never do is manufacture a run. With no marker on disk there
    // is nothing to recognize, however long the window is: the control tunes
    // how long a governed run stays live, it is not a way past the gate.
    const empty = tmpRoot();
    try {
      process.env.FOO_RESEARCH_TTL_SECONDS = String(365 * 24 * 60 * 60);
      assert.equal(researchActive(empty), false, "no marker means no active run at any TTL");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    // A nonsense or non-positive value falls back to the default rather than
    // disabling expiry, so a typo cannot wedge the exemption open.
    for (const hostile of ["0", "-1", "not-a-number", ""]) {
      process.env.FOO_RESEARCH_TTL_SECONDS = hostile;
      assert.equal(researchActive(root), false, `TTL "${hostile}" must fall back to the 2h default, not to forever`);
    }
  } finally {
    if (original === undefined) delete process.env.FOO_RESEARCH_TTL_SECONDS;
    else process.env.FOO_RESEARCH_TTL_SECONDS = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the override is honoured", () => {
  const root = tmpRoot();
  try {
    assert.equal(evaluateResearchGate(REAL_MISS, root, { FOO_ALLOW_RAW_RESEARCH: "1" }).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty or unknown payload allows", () => {
  const root = tmpRoot();
  try {
    // A gate that denies on a payload it does not understand blocks every subagent
    // in the repo the first time a harness changes its schema.
    assert.equal(evaluateResearchGate({}, root, {}).allow, true);
    assert.equal(evaluateResearchGate({ tool_name: "Bash", tool_input: { command: "ls" } }, root, {}).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The second breach. Both of these passed the old gate; both should now deny.
// ---------------------------------------------------------------------------

// The exact fan-out that walked through the gate on 2026-07-14, verbatim in shape.
// It is unmistakably web research — vendor docs, GitHub repos, changelogs — and it
// named no web TOOL, so the old keyword list ("websearch", "webfetch", ...) matched
// nothing and let it by. The gate was guessing at phrasing, and it lost.
const SECOND_MISS = {
  tool_name: "Agent",
  tool_input: {
    description: "Verify identity platforms for MCP",
    prompt:
      "VERIFICATION TASK feeding a spec that will be built. Fetch PRIMARY sources " +
      "(vendor docs, GitHub repos, changelogs). Do NOT trust search snippets. Report a " +
      "comparison table with citations for each provider.",
  },
};

test("the prompt that slipped through is caught: web research that never says 'web'", () => {
  assert.equal(isFanOutResearch(SECOND_MISS), true);
  const root = tmpRoot();
  try {
    const decision = evaluateResearchGate(SECOND_MISS as never, root, {} as NodeJS.ProcessEnv);
    assert.equal(decision.allow, false);
    assert.match(String(decision.reason?.agent), /foo research/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("code search still passes — a repo-scoped findings run is not research", () => {
  const codeSearch = {
    tool_name: "Agent",
    tool_input: {
      description: "Find the callers",
      prompt:
        "Search this repo for callers of parseSpec. Read src/ and test/, grep for the " +
        "symbol, and report your findings with file:line citations.",
    },
  };
  assert.equal(isFanOutResearch(codeSearch), false);
});

test("naming a web tool beats any repo scope — 'use WebSearch' is never code search", () => {
  const mixed = {
    tool_name: "Agent",
    tool_input: {
      prompt: "Read src/cli.ts, then use WebSearch to find sources on how others solved it.",
    },
  };
  assert.equal(isFanOutResearch(mixed), true);
});

// ---------------------------------------------------------------------------
// The third failure, and the first one in this direction: a FALSE POSITIVE.
//
// The gate refused an Impeccable design critique — two subagents reading a local file and
// looking at a local dev server — as a raw web-research sweep. Every earlier breach was
// something slipping THROUGH; this one was the gate biting the hand it was meant to leave
// alone, and that is the more dangerous failure. A gate that fires on the mention of a risk
// rather than the risk is one people learn to override on sight, and an override reached
// for on sight protects nothing. B3's classifier and the interview gate each learned this
// already; this is the same lesson arriving a third time.
//
// It matched on "findings" (a review word), "http://" (a LOOPBACK address), and the absence
// of any token from a repo-marker list too narrow to recognise "read the source files".
// ---------------------------------------------------------------------------

// The critique subagent prompt, verbatim in shape, that was denied on 2026-07-16.
const CRITIQUE = {
  tool_name: "Agent",
  tool_input: {
    description: "Impeccable critique",
    prompt:
      "Assessment A: Design Review. Read the relevant source files for the target and " +
      "visually inspect the live page at http://localhost:4321/ using browser automation. " +
      "Think like a design director. Evaluate AI slop, holistic design, hierarchy, " +
      "typography, color, accessibility, states, copy, and edge cases. Report your " +
      "findings as P0/P1/P2 with a score.",
  },
};

test("a design critique of a local page is inspection, not research", () => {
  assert.equal(isFanOutResearch(CRITIQUE), false);
  const root = tmpRoot();
  try {
    assert.equal(evaluateResearchGate(CRITIQUE as never, root, {} as NodeJS.ProcessEnv).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a loopback URL is not the open web", () => {
  for (const host of ["http://localhost:3000/", "http://127.0.0.1:8080/x", "file:///tmp/a.html"]) {
    assert.equal(
      isFanOutResearch({
        tool_name: "Agent",
        tool_input: { prompt: `Review the page at ${host} and report your findings.` },
      }),
      false,
      `${host} is this machine, not the web`,
    );
  }
});

test("a real URL is still the open web, however local the rest of the prompt looks", () => {
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt: "Read src/cli.ts, then review https://vendor.example.com/pricing and report findings.",
      },
    }),
    true,
  );
});

test("a local path named 'docs' is a directory, not the vendor's documentation", () => {
  // `docs/` is a real directory in this repo, and "docs" is a web marker. Matching the raw
  // prompt made every findings run over it look like a documentation sweep.
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: { prompt: "Read docs/architecture.md in this repo and report your findings." },
    }),
    false,
  );
});

test("stripping the local does not disarm the sweep that breached the gate", () => {
  // The guard on the repair: SECOND_MISS names no local target, so nothing is stripped and
  // every marker that caught it still catches it.
  assert.equal(isFanOutResearch(SECOND_MISS), true);
  assert.equal(
    isFanOutResearch({
      tool_name: "Agent",
      tool_input: {
        prompt:
          "Read src/auth.ts for context, then fetch primary sources — vendor docs, " +
          "changelogs — and report a comparison with citations.",
      },
    }),
    true,
    "a local file for context does not launder a vendor-docs sweep",
  );
});

test("an output destination is not an inspection target — naming a file to write does not launder a sweep", () => {
  // The false-positive repair let a local target excuse a findings run. But a path the run
  // WRITES to is not something it reads: "research the web, save the results to a file" is a
  // web sweep whose only local thing is where the prose lands. It must still deny.
  for (const prompt of [
    "Research the top 5 auth providers and write your findings to docs/auth-research.md.",
    "Survey the market for vector databases and save the results to out/report.md.",
    "Compare the leading feature-flag vendors and output your synthesis to research/notes.md.",
  ]) {
    assert.equal(
      isFanOutResearch({ tool_name: "Agent", tool_input: { prompt } }),
      true,
      `naming an output file must not flip "${prompt}" from deny to allow`,
    );
  }
});

test("a bare domain with a path is the open web, not a file on disk", () => {
  // `example.com/blog/` and `vendor.io/docs/index.html` match the on-disk path shape (a
  // dotted word, a slash, a trailing slash or extension). Stripping them as "local" would
  // delete the .com/.io/docs signal that marks them as the web.
  for (const target of ["example.com/blog/", "vendor.io/docs/index.html", "acme.dev/pricing/"]) {
    assert.equal(
      isFanOutResearch({
        tool_name: "Agent",
        tool_input: { prompt: `Fan out subagents to read ${target} and report findings.` },
      }),
      true,
      `${target} is a web reference, not an on-disk path`,
    );
  }
});

test("a foo research run authorizes only the lanes it planned, then the gate closes", () => {
  const root = tmpRoot();
  try {
    markResearchActive(root, "mcp servers", Date.now(), 2);
    const allow = () => evaluateResearchGate(SECOND_MISS as never, root, {} as NodeJS.ProcessEnv);
    assert.equal(allow().allow, true, "lane 1 is authorized");
    consumeResearchLane(root);
    assert.equal(allow().allow, true, "lane 2 is authorized");
    consumeResearchLane(root);

    // The budget is spent. THIS is the hole: the old gate would have kept allowing for
    // two hours, on any topic at all.
    const spent = allow();
    assert.equal(spent.allow, false, "lanes are consumed, not merely aged");
    assert.match(String(spent.reason?.agent), /spent every fan-out lane/);
    assert.equal(researchActive(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a marker written before lanes existed is treated as spent, never as unlimited", () => {
  const root = tmpRoot();
  try {
    mkdirSync(path.join(root, ".foo"), { recursive: true });
    // The old on-disk shape: no lane count. It used to mean "allow everything for 2h".
    writeFileSync(
      path.join(root, ".foo", "research-active.json"),
      JSON.stringify({ at: Date.now(), topic: "something else entirely" }),
    );
    assert.equal(researchActive(root), false);
    assert.equal(evaluateResearchGate(SECOND_MISS as never, root, {} as NodeJS.ProcessEnv).allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Routing at the ASK, not just at the tool call.
//
// The fan-out gate never saw the other half of the reflex: read a few pages yourself,
// write confident prose. Same ungoverned evidence, no subagent involved. So productfoo has to
// see the human's turn — and the routing has to BIND, because advice loses to reflex.
// ---------------------------------------------------------------------------

test("a research ask is routed to foo; a code question and a lookup are not", () => {
  assert.equal(
    researchRequestTopic("research converting a cli to an mcp for a developer product"),
    "research converting a cli to an mcp for a developer product",
  );
  assert.ok(researchRequestTopic("what's the landscape of identity platforms?"));
  assert.ok(researchRequestTopic("compare WorkOS vs Keycloak"));

  // Not research: the codebase, a bug, a lookup.
  assert.equal(researchRequestTopic("fix this bug in src/cli.ts"), null);
  assert.equal(researchRequestTopic("why does this function throw?"), null);
  assert.equal(researchRequestTopic("what node version does this repo need"), null);
});

// #719: the prompt route fired on prompts that merely NAMED research.
//
// Two causes composed. The marker list was read with `has`, which anchors only the
// LEADING boundary — right for the fan-out gates that share it (`synthesi` must reach
// synthesis) and wrong here, so `market` fired inside "run the marketing swarm", a
// workflow AGENTS.md requires. And the local veto was purely deictic: it recognised a
// pointer at the code ("this file", "src/") but not the far more common shape of local
// work, which is an ACT — fix, rename, close — naming no path at all.
//
// Measured on main before the fix: five of six ordinary repo prompts misrouted. The
// route fails open, so the cost was not a block; it was an instruction to go run a
// research workflow instead of the task the human actually asked for.
//
// This corpus is the regression surface. Each row is a real prompt shape, and the two
// halves pull against each other — a veto broad enough to silence the left column is
// only correct if the right column still routes.
const ROUTES = [
  "research converting a cli to an mcp for a developer product",
  "research the landscape of identity platforms",
  "what's the landscape of identity platforms?",
  "compare WorkOS vs Keycloak",
  "what is the state of the art for spec-driven development",
  "is there prior art for governed agent loops?",
  "who else is building this",
  "how do others handle bug intake",
  "what are the options for hosted postgres",
  "find out about competitors in the agent-spec space",
  "/foo research the landscape of identity platforms",
  // An opening `research` is the ask itself, so it outranks the local veto — this one
  // contains "fix" and must still route.
  "research how others fix flaky tests",
  "please research the market for PM copilots",
];

const STAYS_QUIET = [
  // The prompt from the bug report, verbatim.
  "fix the #607/#690 research pair first. also, if we are not open source, how will coding agents discover foo?",
  "rename the research route marker list",
  "run the marketing swarm on the landing page", // `market` inside marketing
  "fix the competitive analysis renderer",
  "survey the failing tests and fix them",
  "compare the two implementations and pick one",
  "close the stale bugs vs the live ones",
  "update the research/ AGENTS.md heading",
  "debug why researchGate.ts throws",
  "refactor the market-sizing module",
  "triage the open bugs and stack rank them",
  "revert the competitive-analysis commit",
  "the tests vs the linter disagree — which is right",
  "implement the compare view",
];

test("#719: the route reads the shape of the ask, not a topic word inside it", () => {
  for (const prompt of ROUTES) {
    assert.ok(
      researchRequestTopic(prompt) !== null,
      `must route a genuine research ask: ${prompt}`,
    );
  }
  for (const prompt of STAYS_QUIET) {
    assert.equal(
      researchRequestTopic(prompt),
      null,
      `must not route ordinary repo work: ${prompt}`,
    );
  }
});

test("#719: an opening `research` outranks the local veto, elsewhere it does not", () => {
  // Same two words, two positions. Leading = the ask. Buried = a noun in someone's task.
  assert.ok(researchRequestTopic("research the fix for flaky teardowns"));
  assert.equal(researchRequestTopic("fix the research teardown flake"), null);
  // A slash command still opens with the ask.
  assert.ok(researchRequestTopic("/spec research the landscape of identity platforms"));
});

test("#719: an issue or PR number makes a turn local, whatever else it says", () => {
  assert.equal(researchRequestTopic("compare #719 vs #722"), null);
  assert.equal(researchRequestTopic("what are the options for #563"), null);
  // ...but the same ask without the reference is a real question about the world.
  assert.ok(researchRequestTopic("what are the options for hosted postgres"));
});

// A marker is a WORD, not a run of letters.
//
// `includes()` made `cite` match ex·cite·d and `market` match go-to-market. A blind
// ideation fan-out that called a founder "genuinely excited" was refused as a web sweep —
// and because it named no repo path, the default-deny caught it, which is the widest
// failure the gate has. It reads no web at all. Three of five ideators died this way.
test("an everyday word that merely contains a marker is not a findings ask", () => {
  const ideator = (prompt: string) => isFanOutResearch({ tool_name: "Agent", tool_input: { prompt } });

  // The exact shape that was refused: no web, no repo path, one unlucky word.
  assert.equal(
    ideator(
      "You are an ideator in a blind pool. You read nothing — no web, no files, no tools. " +
        "The founder is a non-engineer, one week into coding agents, and genuinely excited. " +
        "Generate 6-9 distinct ideas from your cell only.",
    ),
    false,
  );
  assert.equal(ideator("Score these directions. The lens is go-to-market. Read nothing."), false);
  assert.equal(ideator("Summarize the excitement in this pool of ideas. Do not read anything."), false);

  // ...and the real thing still trips it, on the same words used as words.
  assert.equal(ideator("Go and cite three sources on WorkOS pricing"), true);
  assert.equal(ideator("Survey the market for identity platforms and report findings"), true);
});

test("the harness talking to itself is not a human research ask", () => {
  // This is the payload that wedged a live session: a background agent completed, its
  // notification arrived on UserPromptSubmit, the body contained "research", and the
  // router wrote the whole envelope into the pending marker as the human's topic — after
  // which every delegation in the session was refused, and each completion re-armed it.
  const notification =
    "<task-notification>\n<task-id>a1519ed302227f80e</task-id>\n<status>completed</status>\n" +
    "<summary>Agent \"Explorer 13\" finished</summary>\n<result>claim: Do not build the recommender. " +
    "There is no supervised learning problem here. Compare that against the market baseline, " +
    "and research the landscape before shipping.</result>\n</task-notification>";
  assert.equal(researchRequestTopic(notification), null);

  assert.equal(
    researchRequestTopic("<system-reminder>Consider whether to research the competitive landscape.</system-reminder>"),
    null,
  );
  assert.equal(
    researchRequestTopic("[SYSTEM NOTIFICATION - NOT USER INPUT]\nresearch the landscape of identity platforms"),
    null,
  );

  // A human who genuinely asks still routes — the envelope check must not swallow the ask.
  assert.ok(researchRequestTopic("research the landscape of identity platforms"));
});

test("while a research ask is pending, even a single WebSearch is refused", () => {
  const root = tmpRoot();
  try {
    const lookup = { tool_name: "WebSearch", tool_input: { query: "workos dcr" } };

    // No pending ask: a lookup is a lookup. This is what keeps the gate narrow.
    assert.equal(evaluateResearchGate(lookup as never, root, {} as NodeJS.ProcessEnv).allow, true);

    // The human asked for research. Now reading the web IS the ungoverned research run.
    markResearchRequested(root, "identity platforms");
    const denied = evaluateResearchGate(lookup as never, root, {} as NodeJS.ProcessEnv);
    assert.equal(denied.allow, false, "the reflex to stop is 'just start reading'");
    assert.match(String(denied.reason?.agent), /bin\/foo research "identity platforms"/);

    // Running foo research clears the ask and authorizes its lanes — the web reopens.
    markResearchActive(root, "identity platforms");
    assert.equal(evaluateResearchGate(lookup as never, root, {} as NodeJS.ProcessEnv).allow, true);
    assert.equal(researchRequested(root), null, "routing the ask clears the pending flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The tool name arrives in the harness's own spelling.
//
// Supported harnesses and connectors do not agree on what the web tool is
// called: native tools and connectors use different names. Every recognized
// web-read spelling must stay gated, independent of installed agent adapters.
test("a web read is gated whatever the harness calls it — native tools and connectors", () => {
  for (const name of ["web_fetch", "google_web_search", "WebFetch", "web-search"]) {
    const root = tmpRoot();
    try {
      const call = { tool_name: name, tool_input: { query: "workos pricing" } };
      // No pending ask, no prior reads: a single lookup stays free, by design.
      assert.equal(
        evaluateResearchGate(call as never, root, {} as NodeJS.ProcessEnv).allow,
        true,
        `${name}: one lookup is a lookup`,
      );
      // The human asked for research. Reading the web IS the ungoverned run now — and this
      // must fire on the harness's tool name, not only on Claude's.
      markResearchRequested(root, "identity platforms");
      const denied = evaluateResearchGate(call as never, root, {} as NodeJS.ProcessEnv);
      assert.equal(denied.allow, false, `${name}: a pending research ask must gate this web tool`);
      assert.match(String(denied.reason?.agent), /bin\/foo research/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a Codex spawn_agent fan-out is delegation too — not only 'Agent'/'Task'", () => {
  const fanOut = {
    tool_name: "spawn_agent",
    tool_input: {
      prompt:
        "Fetch PRIMARY sources (vendor docs, GitHub repos, changelogs) and return a dense " +
        "brief with source URLs. Do NOT trust search snippets.",
    },
  };
  assert.equal(isFanOutResearch(fanOut as never), true, "spawn_agent is the same delegation Codex is wired to match");
  const root = tmpRoot();
  try {
    assert.equal(
      evaluateResearchGate(fanOut as never, root, {} as NodeJS.ProcessEnv).allow,
      false,
      "an ungoverned web fan-out is refused whatever the harness names the tool",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pending flag governs the turn, not the afternoon", () => {
  const root = tmpRoot();
  try {
    markResearchRequested(root, "mcp", Date.now() - 3600_000); // an hour ago
    assert.equal(researchRequested(root), null, "a stale flag that blocks lookups is one people delete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The user who never says "research" — which is most of them.
//
// Every layer above this one is a keyword list, and every keyword list is a guess at
// phrasing that loses to phrasing it did not guess. This layer does not read words at
// all. It watches what the agent DOES.
// ---------------------------------------------------------------------------

test("research nobody named is caught anyway — the third read trips the gate", () => {
  const root = tmpRoot();
  try {
    const search = (q: string) => ({ tool_name: "WebSearch", tool_input: { query: q } });
    const gate = (c: unknown) => evaluateResearchGate(c as never, root, {} as NodeJS.ProcessEnv);

    // "which auth provider should we use?" — no keyword fires. No prompt route. The old
    // gate saw nothing at all and the agent read the web until it had an opinion.
    assert.equal(researchRequestTopic("which auth provider should we use?"), null);

    // First read: a lookup. Free, and it must stay free.
    assert.equal(gate(search("workos pricing")).allow, true);
    recordWebRead(root);

    // Second: still a lookup.
    assert.equal(gate(search("clerk pricing")).allow, true);
    recordWebRead(root);

    // Third: this is a run. Nobody called it research; it is research.
    const denied = gate(search("stytch pricing"));
    assert.equal(denied.allow, false, "behaviour, not wording, is the tell");
    assert.match(String(denied.reason?.agent), /nobody called this research/);
    assert.match(String(denied.reason?.agent), /bin\/foo research/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a governed run reads freely — it must never trip its own gate", () => {
  const root = tmpRoot();
  try {
    const search = { tool_name: "WebSearch", tool_input: { query: "anything" } };
    recordWebRead(root);
    recordWebRead(root);
    recordWebRead(root);
    assert.equal(webReadsLookLikeResearch(root), true, "three reads look like research");

    // Running foo research clears the counter and authorizes the reading.
    markResearchActive(root, "auth providers");
    assert.equal(webReadsLookLikeResearch(root), false, "a governed run starts from zero");
    assert.equal(evaluateResearchGate(search as never, root, {} as NodeJS.ProcessEnv).allow, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("yesterday's lookups do not count against today", () => {
  const root = tmpRoot();
  try {
    const old = Date.now() - 3600_000;
    recordWebRead(root, old);
    recordWebRead(root, old);
    recordWebRead(root, old);
    assert.equal(webReadsLookLikeResearch(root), false, "a lookup an hour ago is not this run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The run receipt — the only layer that binds where productfoo has no hook.
//
// Hook coverage varies by host and wiring. Evidence validation is portable: a
// paper without a run the CLI actually minted is refused in every harness.

test("a paper naming no run is not evidence", () => {
  assert.equal(paperRunId("---\ntopic: auth\n---\n# Paper"), null);
});

test("a minted run verifies; a forged one does not", () => {
  const root = tmpRoot();
  try {
    const receipt = mintResearchRun(root, "auth providers");
    assert.ok(receipt.run_id.startsWith("r-"));
    assert.equal(verifyResearchRun(root, receipt.run_id)?.topic, "auth providers");

    // The failure mode this exists for: productfoo has already shipped a paper full of invented
    // citations that passed every check it had. Typed claims prove a paper is well-FORMED.
    // Only the receipt proves anybody did the run.
    assert.equal(verifyResearchRun(root, "r-fake-deadbeef"), null, "a forged id has no receipt on disk");
    assert.equal(verifyResearchRun(root, "../../etc/passwd"), null, "and the id cannot escape the runs dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verify resolves a receipt from either the working or the published store", () => {
  const root = tmpRoot();
  try {
    // The working store (.foo/, gitignored) is where mint writes; a receipt there resolves.
    const working = path.join(root, ".foo", "research-runs");
    mkdirSync(working, { recursive: true });
    writeFileSync(path.join(working, "r-work1-abcd1234.json"), JSON.stringify({ run_id: "r-work1-abcd1234", topic: "wip", at: 1 }));
    assert.equal(verifyResearchRun(root, "r-work1-abcd1234")?.topic, "wip", "working-store receipt resolves");

    // The published store (research/.runs/, tracked) is what ships with a committed paper.
    const published = path.join(root, "research", ".runs");
    mkdirSync(published, { recursive: true });
    writeFileSync(path.join(published, "r-pub1-abcd1234.json"), JSON.stringify({ run_id: "r-pub1-abcd1234", topic: "shipped", at: 1 }));
    assert.equal(verifyResearchRun(root, "r-pub1-abcd1234")?.topic, "shipped", "published-store receipt resolves");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seal publishes a minted receipt so its proof travels; a paper naming no run cannot be sealed", () => {
  const root = tmpRoot();
  try {
    const receipt = mintResearchRun(root, "mcp seal"); // lands in the gitignored working store
    assert.ok(!existsSync(path.join(root, "research", ".runs", `${receipt.run_id}.json`)), "not published yet");

    assert.equal(sealResearchRun(root, receipt.run_id), "sealed");
    assert.ok(existsSync(path.join(root, "research", ".runs", `${receipt.run_id}.json`)), "published copy exists");
    assert.equal(sealResearchRun(root, receipt.run_id), "already-sealed", "idempotent");

    // A run nobody minted here has no proof to publish from this machine.
    assert.equal(sealResearchRun(root, "r-nope-deadbeef"), "no-receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the paper's run id is read from its frontmatter", () => {
  const root = tmpRoot();
  try {
    const receipt = mintResearchRun(root, "mcp");
    const paper = `---\ntopic: mcp\nresearch_run: ${receipt.run_id}\n---\n# Paper`;
    assert.equal(paperRunId(paper), receipt.run_id);
    assert.ok(verifyResearchRun(root, paperRunId(paper) ?? ""));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Supported harnesses, one policy, explicit wire formats.
//
// Getting a wire format WRONG is not a loud failure — the harness cannot parse the output,
// shrugs, and runs the tool. A format bug is a SILENT ALLOW. So each shape is pinned.
// ---------------------------------------------------------------------------

test("every harness gets a denial in its own dialect — a wrong shape is a silent allow", () => {
  const claude = JSON.parse(renderDenial("claude", NO).stdout);
  assert.equal(claude.hookSpecificOutput.permissionDecision, "deny");
  // Codex deliberately mirrors Claude. One shape, two harnesses.
  assert.deepEqual(JSON.parse(renderDenial("codex", NO).stdout), claude);

  assert.equal(JSON.parse(renderDenial("cursor", NO).stdout).permission, "deny");
  assert.equal(JSON.parse(renderDenial("grok", NO).stdout).permission, "deny");
});

// A denial has two readers and they are not the same person. The agent needs the command,
// the contract and the override; the human needs one line saying what took over. foo sent
// ONE string to both for every deny it ever made, so `bin/foo spec start`, skill paths and
// FOO_ALLOW_VANILLA_INTERVIEW=1 all rendered into the user's terminal in red — machinery on
// the surface, on a product whose first rule is that the user never sees the machinery.
// Cursor's API had been asking for the two texts separately the whole time.
test("the agent's instructions never reach the user where the harness has a second channel", () => {
  const text = {
    user: "productfoo runs interviews — asking one question at a time instead of all at once.",
    agent: "run bin/foo spec start, see skills/interview-me/SKILL.md, or set FOO_ALLOW_VANILLA_INTERVIEW=1",
  };

  // Claude and Codex: permissionDecisionReason is shown to the USER; additionalContext
  // reaches the model only and never renders in the transcript.
  for (const format of ["claude", "codex"] as const) {
    const out = JSON.parse(renderDenial(format, text).stdout).hookSpecificOutput;
    assert.equal(out.permissionDecisionReason, text.user);
    assert.equal(out.additionalContext, text.agent);
    for (const machinery of ["bin/foo", "SKILL.md", "FOO_ALLOW"]) {
      assert.ok(!out.permissionDecisionReason.includes(machinery), `${format} leaked ${machinery} to the user`);
    }
  }

  // Cursor asks for the two audiences by name. Handing it the same string twice was foo
  // ignoring an API that had already made the distinction for it.
  const cursor = JSON.parse(renderDenial("cursor", text).stdout);
  assert.equal(cursor.user_message, text.user);
  assert.equal(cursor.agent_message, text.agent);
  assert.notEqual(cursor.user_message, cursor.agent_message);
});

// Some harnesses have no second channel. There the agent's text is what goes out, because
// a deny the agent cannot act on blocks the work with no route forward — worse than a leaky
// message. Pinned so it stays a KNOWN gap and never gets quietly reported as clean.
test("single-channel harnesses still send the agent's text — the gap is real and named", () => {
  const text = { user: "u", agent: "a" };
  assert.equal(renderDenial("opencode", text).stdout, text.agent);
  assert.equal(JSON.parse(renderDenial("grok", text).stdout).reason, text.agent);
});

test("a deny NEVER exits non-zero where non-zero means something else", () => {
  assert.equal(renderDenial("cursor", NO).exit, 0);
  assert.equal(renderDenial("claude", NO).exit, 0);

  // OpenCode is the one exception: it has no JSON deny channel, so exit 1 IS the deny and
  // its plugin turns that into a throw. Everything else there must fail open.
  assert.equal(renderDenial("opencode", NO).exit, 1);
});

test("coverage is reported honestly — never rounded up", () => {
  const cursor = HARNESS_GATES.find((g) => g.format === "cursor");
  // Cursor has no web-search tool to match, so the Nth-read trip cannot fire there. Saying
  // otherwise would be a boundary the user trusts and does not have.
  assert.equal(cursor?.coverage.webRead, false);
  assert.equal(cursor?.coverage.fanOut, true);

  // Codex will not run a hook it has not been told to trust. productfoo cannot self-trust.
  assert.equal(HARNESS_GATES.find((g) => g.format === "codex")?.coverage.needsTrust, true);

  // OpenCode is fail-closed: an internal error can deny the user's work.
  assert.equal(HARNESS_GATES.find((g) => g.format === "opencode")?.coverage.failsClosed, true);

});

test("a generated plugin actually invokes the gate — a silent allow is the worst failure", () => {
  // Caught in review, not by this suite: the plugins passed "script.sh opencode" as ONE
  // argument to execFileSync, which takes a PATH and an ARGV and does not split a command
  // string. It looked for a file with a space in its name, threw ENOENT, and the plugin's
  // own catch — the one written to fail open — swallowed it. The gate would have reported
  // success and enforced nothing, in the plugin where it matters most.
  for (const format of ["opencode"] as const) {
    const gate = HARNESS_GATES.find((g) => g.format === format);
    const src = gate!.render("./.githooks/guard-research.sh");
    assert.match(src, /execFileSync\("\.\/\.githooks\/guard-research\.sh", \["/, `${format}: path and argv, never a command string`);
    assert.ok(!/execFileSync\("[^"]* [^"]*"/.test(src), `${format}: no space-joined command string`);
  }
});
