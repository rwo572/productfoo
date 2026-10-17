# productfoo Agent Contract

productfoo is the portable contract layer for coding-agent product work: intent,
agreed spec, proof, approval boundaries, and loop semantics. Keep rationale and
incident history in the canonical sources and tests below.

## Precedence

- The user's request defines the goal and scope. This root contract is the
  repository-wide floor. A scoped `AGENTS.md` adds local procedure; it cannot
  weaken a root boundary or approval requirement.
- productfoo's hard dependencies are its CLI, canonical skills, and packet contract.
  Detect harness affordances, then fall back to productfoo's CLI, files, JSON, and
  numbered text. Harness files are adapters unless intentionally shared.
- Compound Engineering, Superpowers, Impeccable, and generic spec frameworks are
  optional companions or references. productfoo cannot depend on one being installed.

## Start Here

1. Inspect repository sources and applicable expert lenses before asking the
   user. One isolated question needed to settle something the repo cannot answer
   is allowed. A batch or repeated questioning, including the third rapid
   question, is an interview: use `interview-me`, ask one numbered question at a
   time, and hand off through `bin/foo spec` or `bin/foo spec start`. The gate
   fails open, governed spec starts clear its counter, and deliberate bypass is
   `FOO_ALLOW_VANILLA_INTERVIEW=1`.
2. Shape before building. `bin/foo spec <work>` is the default short reflex. If
   the work may be irreversible, agentic/delegated, outbound-facing, research,
   or autonomous, read B3-B4 before acting.
3. Branch before every product edit. Run `git status --short` and inspect the
   current branch. On `main`, `master`, or the remote default branch, create a
   branch first; move existing uncommitted product work with it. A deliberate
   exception requires `FOO_ALLOW_MAIN_EDITS=1`.
4. Use one thread, one worktree, and one coherent workstream per branch. If this
   thread already owns the matching managed worktree, work in place. Otherwise
   prefer the harness's native worktree control. If it is unavailable, use
   `git worktree add` with a named branch and an unoccupied checkout path.
   Read-only Git and ordinary shell work are allowed in a claimed tree, but
   another holder's `checkout`, `switch`, `restore`, `reset`, `clean`, `stash`,
   `rebase`, and `merge` are blocked.
5. Write for someone who did not watch the run. Lead with the answer, name the
   decision, state the recommendation's one assumption, offer “don't do this,”
   and close with exactly what to type. Keep internal IDs off the user surface.
   Show belief, evidence, confidence, dissent, proof, and remaining human
   judgment. Put the recommendation first and number options.

## Boundaries

Boundaries are narrow and blocking. A required workflow must run but is not a
new boundary; inability to run it is resolved or recorded. A signal is advisory
evidence for judgment and never an automatic stop.

### B1 — Safety

- **Trigger:** tracked or staged content contains raw private source material,
  secrets, vault data, environment values, or unverified private context.
- **Do:** stop; use `bin/foo scan` or `bin/foo redact`. Clean the finding; never
  raise thresholds to pass. Never commit raw private material.
- **Proof:** `bin/foo self check` scans tracked text, `bin/foo self gate` fails
  closed on staged high-confidence secrets, and CI scans history.

### B2 — Spec identity

- **Trigger:** committing a real `spec.md`.
- **Do:** place it in an allowed spec home with a present, unique `Spec ID`.
  Runnable examples belong under `examples/`, not the real spec home.
- **Proof:** `bin/foo self check` blocks missing or duplicate identity.

### B3 — Risky work is spec-first

- **Trigger:** under-specified work is irreversible, agentic/delegated, or
  outbound-facing.
- **Do:** obtain an approved Shape Brief or intake summary before build; run
  `bin/foo classify "<work>"`, then `bin/foo spec <work>` or `bin/foo spec start`.
- **Proof:** classification carries confidence. A keyword is evidence, not
  proof: governing risky behavior becomes a reasoned signal, but `loop`,
  `autonomous`, `cron`, and `unattended` are never downgraded.
- **Override:** force block-on-match with `--strict` or
  `FOO_CLASSIFY_STRICT=1`.

### B4 — Bounded autonomy

- **Trigger:** any loop or autonomous action.
- **Do:** require a loop contract with purpose, observation source, allowed
  actions, verification check, record format, terminal states, approval
  boundaries, and an agreed budget.
- **Proof:** a draft unbudgeted loop is a signal; a ready/active armed loop
  without budget blocks. Run `bin/foo loop check` and, when needed,
  `bin/foo loop estimate <packet-dir> --agree`. Only a proven sub-floor loop may
  auto-approve. Web observation cannot be sized offline and needs the handshake.
- **Override:** require every budget with `--strict-budget` or
  `FOO_BUDGET_REQUIRED=1`.

### Cross-cutting approvals

- Connector data becomes packet evidence only after `bin/foo source discover`
  and per-packet `bin/foo source approve`; discovery itself may be read-only.
- Never silently clone or install companion repositories from package hooks.
  Detect the gap, verify the version and path, explain the tradeoff, and ask for
  confirmation before installation.
- Treat auto memory, logs, private notes, messages, transcripts, and caches as
  context only until verified or explicitly approved. B1 still forbids
  committing the raw material.
- Pushing to the default branch blocks. Dropping commits already present on the
  remote also blocks. Push a named branch and open a pull request; integrate
  remote commits before rewriting history. This public repository does not ship
  Git hooks; agents must honor these rules and maintainers configure repository
  protections separately.
  Genuine exceptions require `FOO_ALLOW_MAIN_PUSH=1` or
  `FOO_ALLOW_FORCE_PUSH=1` after reading the affected commits.
- Approval overrides are deliberate and human-authorized: claim expiry uses
  `FOO_CLAIM_TTL_SECONDS`; sharing a checkout uses
  `FOO_ALLOW_SHARED_CHECKOUT=1`; editing the default branch uses
  `FOO_ALLOW_MAIN_EDITS=1`.

## Required Workflows

- Dogfood productfoo on productfoo: run applicable productfoo skills, swarms, gates, and artifact
  checks before user handoff. Record drift, missing modules, or unmapped work in
  the judgment ledger; never silently drop a finding.
- After packet edits, run `bin/foo asp validate <packet-dir>`. After
  implementation-relevant changes tied to a packet, run
  `bin/foo asp reconcile <packet-dir> --git-diff`, pass changed files, or use
  `--source github:<pr-url>` (fixture: `--source-fixture <file.json>`). A draft
  loop budget gap stays a signal; an armed gap is B4.
- Before showing generated or substantially redesigned UI, HTML, landing,
  marketing, workbench, Build Preview, or scenario artifacts, run the design
  swarm and marketing swarm, capture findings, and resolve or escalate them.
  Run Impeccable shape before substantial unshaped work, critique before done,
  and audit or polish when production-like gaps remain. If Impeccable is absent,
  record a manual-review gap. Commit `.impeccable/critique/` when it is evidence.
- `src/statusGlyphs.ts` owns interactive human labels: `done — proof pending`
  maps to internal `claimed`. Keep `claimed` in JSON/artifacts/types/CSS/data/
  history. Pair glyphs with text; never use them in machine/piped output,
  `events.jsonl`, or contracts.
- Select builds explicitly: installed `foo` runs the npm package; `bin/foo`
  runs the repository build. A separately installed channel shim may support
  `FOO_USE`; it is not part of a normal npm installation.
- Keep one branch to one workstream. Stage only requested files; never commit
  directly on the default branch. Resolve a new branch prefix from an explicit
  human choice, then the detected harness, then `agent/`; preserve an existing
  name. Add `.worktreeinclude` only after deciding which ignored setup files a
  managed worktree needs.
- Land work through a pull request: push the named branch and open the PR.
  Branch and tag pushes remain normal. Before rewriting remote history, fetch
  and integrate the named commits; blocking triggers and deliberate exceptions
  live under Cross-cutting approvals.
- Product-substance commits tied to a packet carry
  `Foo-Spec: specs/<packet> (<spec-id>) <url>`, generated by
  `bin/foo commit-trailer <packet>`. `FOO_BRAND_URL` selects the URL before the
  package fallback. Pure chores, merges, and docs-only commits are exempt;
  `Foo-Spec: none (<reason>)` records deliberate unowned work.
- Treat `.agents/` as a pinned helper bundle, not canonical productfoo source. Promote
  durable behavior into canonical skills, governance, root instructions, or an
  accepted packet. Compare every untracked artifact with existing artifacts
  before committing it. Pre-spec `foo ideate` output uses
  `ideas/YYYY-MM-DD-<slug>.md` with `ideate_id`; exclude retired vocabulary.

## Attribution maintenance

- When adding, adapting, replacing, or removing outside code, skills, prompts,
  frameworks, or design patterns, review the README’s **Acknowledgments &
  inspiration** in the same pull request. Update it when the change affects a
  credit; retain historical inspiration while describing its role accurately.
- Link the original creator and primary source. Distinguish inspiration,
  adaptation, development tools, and runtime dependencies. Attribute individual
  quotes and frameworks to their speakers, and credit an intermediary curator
  separately when its adaptation is used. Do not infer provenance from similar
  names or imply endorsement.
- For reused material, record its source and upstream revision alongside the
  affected file or its reference documentation, and preserve applicable license
  and notice text. README thanks do not replace those records.
- Keep `skills-lock.json` current when changing installed helper skills. For
  runtime dependency changes, regenerate `docs/THIRD_PARTY_NOTICES.md` with
  `node scripts/gen-third-party-notices.mjs`; do not hand-edit that generated file.
- State in the pull request whether attribution changed, or that it was reviewed
  and no update was needed. Record uncertain provenance as an explicit follow-up
  rather than inventing a source or silently dropping the credit.

## Signals

- When product code shipped without an agreed spec, run
  `bin/foo spec from <what-you-built>` to recover intent and surface drift.
- Skill-structure and runtime-neutral wording findings, `foo-roast` findings,
  release-readiness gaps, missing modules, and unmapped work inform judgment;
  they do not block unless they independently cross B1-B4.
- A draft loop without an agreed budget is a signal. Budget it before arming;
  ready or active without budget is the B4 boundary.
- Comprehension is a signal, never a gate:
  `foo comprehension observe` logs a local `comprehension_miss` when the human
  asks for a translation ("in english", "what does that mean"),
  `foo comprehension rate` reads the scoreboard, and `foo comprehension lint`
  reports foo-internal vocabulary on shipped surfaces (`commands/`, `skills/`)
  in CI without failing the build. Never give it a blocking verdict path, and
  never gate or rewrite output on a model's judgment of whether a human
  understood: that gates on fluency, the exact property that made the observed
  bad messages dangerous. Signals over gates.

## Scoped Instructions

The root contract always applies. Scoped files add local procedure and checks:

- `skills/AGENTS.md` — canonical skill layout, registry, and skill verification.
- `specs/AGENTS.md` — packet layout, event writes, validation, and reconciliation.

No boundary, override, approval requirement, or destructive-action rule may
exist only in a scoped file.

## Verification

- Product code: `npm test`.
- Repository boundaries: `bin/foo self check`.
- Packet structure: `bin/foo asp validate <packet-dir>`.
- Packet/build alignment: `bin/foo asp reconcile <packet-dir> --git-diff`.
- Before commit, inspect `git status --short`, compare untracked artifacts, stage
  only the workstream, and generate the packet trailer when required.

## Product Context

Product intent and design live in `docs/product/PRODUCT.md` and
`docs/product/DESIGN.md`; supporting references are indexed in `docs/README.md`.
Bundled runtime data lives in `config/`; existing project-root overrides remain
supported. Keep supporting documents out of the repository root.

## Canonical References

- Gate behavior: `src/interviewGate.ts`, `src/researchGate.ts`,
  `src/harnessGates.ts`, `src/redactEngine.ts`, and their tests.
- Status rendering: `src/statusGlyphs.ts` and its tests.
- Packet format: `docs/foo-spec.md`, `schemas/`, and `specs/AGENTS.md`.
- Skills: `skills/skill-registry.yaml` and `skills/README.md`.
- Research artifacts: `skills/research-brief/SKILL.md` and `src/research.ts`.
- Staged-content checks: `src/redactGate.ts`; CI: `.github/workflows/security.yml`.
