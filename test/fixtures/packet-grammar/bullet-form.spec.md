---
spec_id: work_queue_across_stages_v0
title: "The queue — one view across research, ideate, spec, preview, build"
mode: capability
lifecycle: draft
stage: shaping
owner: product
autonomy: human-in-loop
updated: 2026-07-17
---

# The queue

<!-- Identity (`spec_id`) is read from the YAML frontmatter above. Progress is rendered by `foo asp status`, never stored here. Source: interview-me deep session 2026-07-17 (5 questions), a 12-lens spec-swarm (`swarms/2026-07-17-approved-intake-summary-stack-ranked-vie.md`), and a product-shape-interview. The swarm reviewed an earlier flat-rank shape and largely refuted it; that intake is superseded and the refutations are carried into the ledger below rather than discarded. -->

## Shape Brief

**1. The work, in one line.** One view across productfoo's own five stages — research → ideate → spec → preview → build — with **one row per thread of work**, showing which stages that thread has, which it never had, and which productfoo cannot tell; ordered by a proposal foo derives from the owner's memory, overridable, with the gap between the two on screen.

**2. The product bet, and who it's for.** For **the owner**, dogfooding. productfoo has five front doors and four artifact homes and **no view across any of them**. Verified on disk 2026-07-17: 29 papers in `research/`, 17 files in `ideas/`, 93 packets in `specs/`, 192 tasks not done. `deriveTriage` (`src/packetIndex.ts:213`) already ranks the last stage — open tasks in live packets — and nothing ranks or even relates the other four.

The bet: **the queue is the product, and the rank is a property of it.** This packet exists because the first shape got that backwards. It proposed a flat stack rank of ~100 rows; twelve lenses found that foo already ranks those rows, that the chosen venue cannot read them, and that the chosen signal measures recency rather than importance. The reframe — that these are *stages of one pipeline* — is what survived.

**Confidence: medium.** The counts are verified, not assumed. The bet is not, and its weakest joint is named in D-006's dissent below.

**3. Sources and approval boundaries.**
- **Reads, all local:** `research/`, `ideas/`, `specs/`, and the owner's 43 memory files at `~/.claude/projects/…/memory/`. The ranker runs on the owner's laptop, because that is the only machine the memory exists on — Render's build has no `~/.claude`, so the view **renders** a rank, it never **computes** one.
- **Raw memory never leaves the laptop.** Only derived, owner-approved conclusions are committed. Approval runs through `foo source approve`, the mechanism this repo already built for exactly this.
- **Vulnerability notes are excluded at the ranker's input** by named-file denylist, not by a frontmatter filter — `alpha-token-not-rotated` is typed `project`, identical to any ordinary note, so no type selector separates them. See R-007 and its dissent.
- **No database, no new tables, no schema change, no foo-db involvement.** `rank.yaml` is a committed file. This keeps `admin-console-v1`'s stated boundary intact and requires no credential migration.
- **No loop, no budget** — the ranker runs when the owner types it, so B4 does not attach. It converts to a scheduled loop later without a rebuild, and that conversion is additive.
- **User-only:** approving what ships into `rank.yaml`; resolving OQ-1 (venue) and OQ-3 (validation claim).

**4. MVP scope and the validation bar.**

MVP, in dependency order:
- **Record the thread.** Nothing does today: **0 of 93** specs name an idea id that `ideas/` declares, and no paper points forward at all. Every hop gains a back-reference going forward; a one-time pass over what already exists marks unlinkable items **can't tell** and never guesses. This is the precondition — without it the view renders inferred edges, which is a guess wearing a table's punctuation.
- **Receipts for the two stages that are runs.** `research/` and preview both *happen* rather than *sit on disk*, and neither can prove when it ran. Research is the worse of the two: 0 of 29 papers carry the `research_run:` receipt B5 requires, and 28 have no frontmatter at all. Preview is narrower than it first looked — `foo preview` **does** write a committed artifact at `specs/<packet>/artifacts/previews/<run-id>/preview.html`, and 3 exist today — so the stage is readable from disk; what is missing is an **event**, so nothing records when a preview ran or which version of the spec it ran against. The artifact is the receipt; the event is the timestamp.
- **The reader**: stages assembled from disk, three states per cell — **happened · didn't happen · can't tell**.
- **The proposal**: deterministic matching shortlists ~20 threads; a model orders only those and writes one reason each, grounded in the row's own repo-visible text.
- **The view**: rank, thread, its stage cells, the owner's override, and the gap.
- **Exit, not ignore.** A thread leaves the queue; memory says why. The count of exited threads stays on screen, always, and one click shows them.

**Validation bar (done = all true, each demonstrable):**
- The view renders a thread that is **missing** a stage distinctly from one foo **cannot tell** about. Blank never means zero.
- No edge on screen was inferred. Every relationship shown is one a file actually records.
- No reason string contains a token absent from the row it describes — enforced by a test, not by eyeballing.
- **The rank surfaced a thread the owner would not have named**, and the owner then started it. Not "the view renders."

**Out of MVP:** drag-to-reorder. Any second store. A scheduled ranker. Multi-user, and any graduation work — the graduation path is a **re-engine**, not a port, because the rank is good only while it reads *this* owner's memory (D-005).

**5. Judgment ledger seed.**
- **Belief:** productfoo's stages exist, and the relationships between them do not. **Confidence: high** on the gap — verified by count (0 of 93 idea links; 19 of 93 research links; 0 of 29 papers carry a receipt); **medium** on whether a view of it changes what gets built.
- **Evidence:** `src/packetIndex.ts:213` ranks one stage of five. `render.yaml` builds `rootDir: web/foo-site`, so the deployed site has no `specs/`, no `ideas/`, no `rank.yaml`. `web/foo-site/lib/adminData.ts` reads zero files today — every admin view is foo-db. `.github/workflows/security.yml` scans for secret *shapes*, so a memory-derived sentence passes every check productfoo owns.
- **Dissent (recorded, and it is the strongest argument against this packet):** `deriveTriage` already ranks the build stage, and `packet-index-triage-v0` **D-002 explicitly refused a manual pin field** — which a committed override in `rank.yaml` is. This packet reverses a decision the repo already made. **Counter:** D-002 governed one stage; the queue spans five, and four of them have no reader at all. That counter is an argument, not proof.
- **The assumption the recommendation rests on, flagged as an assumption:** that the owner wants to see *work moving*, not *artifacts existing*. If it is the second, the object model collapses to one row per artifact and this is a tenth of the build.
- **User-only decisions:** recorded in Decisions below.

## Intent

Show the owner one queue across productfoo's own five stages, so a thread that stalled between them is visible as a thread, not as an absence nobody is looking at. Today each stage has a home and none of them know about each other.

## Current Understanding

- **Five stages, five homes, one reader.** `research/` (29 papers), `ideas/` (17), `specs/` (93 packets, 192 tasks not done), and preview — which has a home after all, at `specs/<packet>/artifacts/previews/<run-id>/preview.html`, though only 3 of 93 packets have ever produced one. `deriveTriage` reads the build stage and nothing else.
- **Preview's gap is an event, not an artifact.** The corrected finding, recorded because the first version of this spec got it wrong: the artifact is committed and readable, but no packet's `events.jsonl` carries a preview event — the only types across the whole repo are `human`, `agent`, `decision`, `drift`, `risk`. So the reader can see *that* a preview exists and never *when* it ran or against which spec.
- **The stages barely link, and one does not link at all.** **0 of 93** specs name an `ideate_id` that `ideas/` declares; **19 of 93** cite a `research/` file that exists. So the research→spec hop is traced about one time in five, and the ideate→spec hop is traced **zero times**. Whether the 17 ideas died or converted silently is, today, unknowable — and no grep can recover it, because the hop was never written down.
- **Absence is not loss.** Most specs never came from an idea, and never should have. A missing stage is normal; the view must never render it as a gap. This is the same fact `web/foo-site/app/admin/ui.tsx:79-91` already makes load-bearing: "nothing happened" and "I couldn't find out" are different.
- **Memory is the exit log, not an importance score.** 39 of 43 files fall inside a 10-day window (12 on 2026-07-12); 20 of 43 carry *shipped / settled / don't re-propose* language. Read as importance it measures recency. Read as an exit log it is exactly right, and it already contains live hits: `ideas/2026-07-12-make-foo-an-even-thinner-client…` sits in the backlog while memory `thin-client-premise-is-false` says *don't re-propose*.
- **The venue does not work as stated.** `render.yaml` builds `rootDir: web/foo-site`. "Rendered at /admin, built from the repo" is false as written. See OQ-1.
- **No gate productfoo owns can stop a memory-derived sentence from being committed.** Every check is a credential-shape detector. This is the fabricated-citations failure exactly: the checks test form, not substance.

## Requirements

- **R-001** One row per thread of work; the five stages are its columns.
- **R-002** Three states per cell: happened · didn't happen · can't tell. Blank never renders as zero.
- **R-003** No inferred edges. Every relationship shown is recorded in a file; unrecorded ones render **can't tell**.
- **R-004** Every hop records a back-reference going forward; a one-time pass marks existing unlinkable items **can't tell** and guesses nothing.
- **R-005** `research/` papers carry a run receipt. Preview already writes a committed artifact and only needs an **event**, so the reader can tell when it ran and against which spec — not merely that a file exists. A stage that cannot prove *when* it ran is a column that cannot go stale honestly.
- **R-006** The proposal is deterministic to the shortlist; a model orders only the ~20 and writes one reason per row, composed only from that row's repo-visible text. Enforced by a provenance test.
- **R-007** Memory contributes a weight and a category, never prose. Vulnerability notes are excluded at the input by named-file denylist.
- **R-008** A thread exits the queue with its memory citation shown; exits are proposed, never auto-applied. The exited count is always on screen.
- **R-009** The ranker runs on demand from a typed command. No schedule, no loop, no budget.
- **R-010** `rank.yaml` is the only store. No database, no new table.

## Decisions

- **D-001** Hybrid rank: foo proposes, the owner overrides, the gap is displayed. *Owner, over the recommendation of derived-only.* The gap is the instrument — see OQ-3, which says it is not yet a valid one.
- **D-002** The unit of work is the queue across five stages, not a flat rank of rows. *Owner-originated; this reframe supersedes the intake the swarm reviewed.*
- **D-003** Importance is drawn from the owner's private memory. *Owner-originated.* It closes the gap nothing else could: no `tasks.yaml` says what a thing is worth.
- **D-004** Preview is the final pass, after spec. *Owner.* It is the stage with no artifact; R-005 is the consequence.
- **D-005** `rank.yaml` is an explicit for-now. It graduates when it stops being single-user. *Owner.* Recorded consequence: graduation is a re-engine, not a port.
- **D-006** A row is a thread of work; the stages are its columns. *Owner (Q1).* **Dissent:** nothing records a thread today, so R-003 and R-004 are what keep this from becoming inference. If threads prove unrecoverable, the object model falls back to one row per artifact and the bet weakens sharply.
- **D-007** Not every item has every stage; absence is not a leak. *Owner.* R-002 exists because of this.
- **D-008** The engine is a deterministic shortlist plus a model pass over ~20. *Owner.* Chosen so the proposal is stable — an order that jitters makes the override gap unreadable.
- **D-009** Ignore/exit has no expiry, deliberately. *Owner: "I don't exactly know what will get ignored yet."* Correct call: an expiry rule for an unobserved pattern is machinery built on a guess. The disclosed count (R-008) is what makes waiting safe.
- **D-010** Venue is `/admin`, owner-only, for dogfooding. *Owner.* Blocked as stated — see OQ-1.

## Validation

Done means all of these, each demonstrable — not asserted:

- **Absence reads as absence.** The view renders a thread that never had a stage differently from one productfoo cannot determine. Blank never renders as zero. (C-007)
- **Nothing on screen was inferred.** Every edge is one a file records; everything else says can't-tell, and the can't-tell count is a number on screen. (C-004)
- **Every reason is provable.** No reason string contains a token absent from the row it describes, enforced by a test in CI — not by reading them. (C-012)
- **The order is stable.** Two runs over unchanged inputs produce the same order; otherwise the override gap measures jitter. (C-011)
- **The two known-refused ideas are proposed as exits**, each with its memory citation, and neither leaves without a click. (C-009)
- **No vulnerability note reaches the ranker's input**, and the exclusion is a named list in code rather than a prompt instruction. (C-010)
- **A malformed `rank.yaml` cannot break the marketing site's build.** (C-014)
- **The bar that actually matters:** the rank surfaced a thread the owner would not have named, and the owner then started it. Override rate is a diagnostic, not this. See OQ-3 — until it is answered, this packet has a stated goal and no valid instrument, and that is recorded rather than papered over.

## Evidence

Every number here was counted on disk on 2026-07-17, not estimated. Where a claim is inference, it says so.

| Claim | Evidence | Type |
| --- | --- | --- |
| Five stages exist; one has a reader | `deriveTriage`, `src/packetIndex.ts:213` — ranks open tasks in live packets by lane, priority, unlocks, recency. Nothing reads `research/`, `ideas/`, or preview. | repo-evidence |
| The stages hold 29 / 17 / 93 / 192 | `ls research/*.md` = 29; `ls ideas/*.md` = 17; 93 packets; 192 tasks not done (171 todo + 19 doing + 2 dropped/blocked). Counted 2026-07-17 after rebasing onto main — the earlier draft said 28 / 13 / 83 / 133, true one merge before, which is this packet's own staleness problem arriving early. | repo-evidence |
| The ideate→spec hop is **not traced at all** | **0 of 93** specs name an `ideate_id` that `ideas/` actually declares. Not "few" — none. | repo-evidence |
| The research→spec hop is traced ~1 in 5 | **19 of 93** specs cite a `research/` file that exists on disk. A further 10 mention the string `research/` in prose and cite nothing. | repo-evidence |
| **Correction, recorded rather than quietly fixed** | This table first claimed "3 of 83 reference an `ideate_id`; 28 reference `research/`", typed `repo-evidence`. Both were substring greps, not evidence: `ideate-cost-v1` matched **its own `spec_id`**, and this very spec matched because its prose *discusses* the field. The build preview inherited the same bug and rendered four green cells that were all invented — R-003's exact prohibition, in the column R-003 is about, failing toward the flattering answer. Caught by an Impeccable design review, not by any gate. It is the argument for R-006's provenance test in miniature: intention is not enforcement. | agent-inference, refuted |
| No research paper carries a receipt | 0 of 29 carry `research_run:`; 28 have no frontmatter at all; exactly 1 has the structured shape B5 describes | repo-evidence |
| Preview writes a committed artifact | `specs/<packet>/artifacts/previews/<run-id>/preview.html` — **3 of 93** packets have one, including this packet's own. Not gitignored. | repo-evidence |
| Preview records no event | Across every packet's `events.jsonl`, the only types are `human` (391), `agent` (310), `decision` (3), `drift` (2), `risk` (1). No preview event exists, so the artifact's existence is knowable and its timing is not. | repo-evidence |
| **Correction, recorded rather than quietly fixed** | The first version of this spec claimed "preview leaves nothing — no `previews/` directory." That was a failed search reported as a fact: the artifacts live under each packet, not at the repo root. It is exactly R-002's failure mode — can't-tell rendered as didn't-happen — committed into the packet that defines R-002. Kept here because a spec that hides its own corrections is the thing this repo keeps legislating against. | agent-inference, refuted |
| `/admin` cannot read repo files | `render.yaml` — foo-site is `rootDir: web/foo-site`, `autoDeploy: true`. `web/foo-site/lib/adminData.ts` reads zero files; every admin view is foo-db via `unstable_cache`. | repo-evidence |
| Memory skews recent and decided | 39 of 43 files fall inside a 10-day window, 12 on 2026-07-12; 20 of 43 carry shipped/settled/don't-re-propose language | repo-evidence |
| A build preview exists for this packet | `artifacts/previews/2026-07-17-01/preview.html` — generated from live repo state, reviewed by an Impeccable critique that caught the fabricated-edge bug above. Every count in it is computed at generation time; it contains no literals. | repo-evidence |
| Two refused ideas sit in the backlog | `ideas/2026-07-12-make-foo-an-even-thinner-client…` vs memory `thin-client-premise-is-false` ("don't re-propose"); the server-side-IP idea vs `output-surface-ip-premise-wrong` | repo-evidence |
| No gate catches a memory-derived sentence | `.github/workflows/security.yml` runs gitleaks for secret patterns and `foo scan` advisory-only; `src/redactEngine.ts` defaults to the `secrets` profile | repo-evidence |
| Order bias would contaminate the gap | `specs/orchestrator-evals-v0/spec.md` R-003 — order bias flips 10–30% of pairwise verdicts; R-001 — recall failures dominate, so regret must be decomposed | repo-evidence |
| A committed override reverses a prior decision | `specs/packet-index-triage-v0` is `lifecycle: done`; its D-002 chose momentum tiebreak and explicitly refused a manual pin field | repo-evidence |
| The queue is worth building at all | Not evidence. The gap is verified; that a view of it changes what gets built is the bet, and T-001 is the measurement that can refute it. | agent-inference |
| What the owner wants to see is work moving | Owner's framing across the shaping session; the object model in D-006 rests on it. If it is artifacts existing, the packet is a tenth of this size. | user-judgment |

**Approved sources:** `research/`, `ideas/`, `specs/` (repo, tracked). The owner's 43 memory files are **context, approved for this shaping run only** — read locally, never committed, and contributing a weight and a category rather than prose (R-007). Vulnerability notes are excluded at the input.

**Source productfoo could not reach:** whether any of the 17 ideas converted into a spec without recording it. **Zero** link, so **all 17** are indistinguishable from ideas that died. That is OQ-4 — and the build preview is the proof it matters: a grep that tried to recover the hop invented four edges and got every one wrong.

## Risks

- **This may be a second ranker.** `deriveTriage` already orders the build stage, and `packet-index-triage-v0` D-002 refused a manual pin field — which a committed override is. Four lenses raised this independently. **Mitigation:** T-001 is a measurement with a kill verdict, run before anything is built.
- **The thread may not be recoverable.** D-006 assumes a row is a thread, and nothing records threads today (0 of 93 for ideate; 19 of 93 for research). If a one-time pass cannot recover them honestly, the view fills with can't-tell and the object model has to fall back to one row per artifact. **Mitigation:** R-003 forbids inferred edges, so the failure is visible rather than silent.
- **Repo-grounded reasons may gut the feature (OQ-2).** If a reason can only restate its row, the model pass is decoration and the honest product is a deterministic sort plus an exit list.
- **A memory-derived sentence can be committed and no gate will catch it.** Every check productfoo owns is a credential-*shape* detector. `.github/workflows/security.yml` scans for secrets; `src/redactEngine.ts` defaults to the `secrets` profile. A reason naming a customer, the ICP thesis, or an unrotated token passes green. **Mitigation:** R-006's provenance test — structural, not reviewed by eye.
- **Excluding vulnerability notes corrupts the instrument.** R-007 blinds the ranker to the foo-db migration, arguably the highest-stakes thread in the queue; the owner notices it missing and overrides; override rate inflates; the thing the validation bar rests on reports noise. **Named, not solved** — the trade is stated so it is chosen rather than discovered.
- **`rank.yaml` can wedge the marketing site.** It ships in the repo that `autoDeploy`s the public site. A hand-edited override producing malformed YAML must not fail `next build`. **Mitigation:** T-007's `force-dynamic` + parse-failure-as-a-row + schema test.
- **Staleness has no signal.** `rank.yaml` has no server-side refresh path, so it would be the first admin surface that can be arbitrarily old while looking current — and the rows it ranks move on every merge.
- **Recency masquerading as importance.** 39 of 43 memory files fall inside a 10-day window. If the shortlist turns out to be the July 12–14 cluster, the engine ranks up what is already top-of-mind — the structural inverse of the validation bar. **Mitigation:** the base-rate count runs before the engine is trusted.

## Open Questions

- **OQ-1 — the venue does not work.** `render.yaml` builds `rootDir: web/foo-site`; the deployed site cannot see `specs/`, `ideas/`, `research/`, or a repo-root `rank.yaml`. Either `rank.yaml` moves under `web/foo-site/` as a **denormalized snapshot** carrying every rendered field, or the venue moves to the local surface `foo asp index --serve` already provides. **User-only.** Notes: every other admin view is `force-dynamic` over live foo-db, so a repo-baked tab would give one page two truth clocks.
- **OQ-2 — does R-006 gut the feature?** If reasons must be composed from the row's own text, the reason column degrades toward "P1, unlocks 3" — which `foo asp index` already prints — and the model pass becomes decoration. The honest version of this packet may be a deterministic sort plus an exit list. **Better answered in the spec than after the build.**
- **OQ-3 — the gap is not yet an instrument.** The owner's rank is produced *after* seeing productfoo's, so the two are not independent; and override rate measures agreement while the validation bar measures novelty. productfoo's own canon forbids this shape: `specs/orchestrator-evals-v0/spec.md` R-003 records that order bias flips 10–30% of pairwise verdicts. Either a blind pre-commit pass ships with it, or the validation claim is dropped. **User-only.**
- **OQ-4 — is the thread recoverable at all**, or only recordable going forward? R-004 assumes the second and refuses to guess. If a one-time pass can recover most threads honestly, MVP shrinks.

## Minority Report

Confining this to `/admin` as an internal cockpit may be under-claiming it. productfoo's landed thesis is *excellent but disposable judgment* — judgment that evaporates. A view that persists importance across the owner's own memory and shows the delta against their override is arguably the most on-thesis thing productfoo has proposed, and filing it as a private dashboard may be mislabelling the flagship as a demo. Recorded against the recommendation that produced D-010.

## What Would Change Our Mind

`deriveTriage`'s own recorded risk is that it trusts `tasks.yaml` hygiene — and the ~90 rows here are zero-progress drafts, exactly where hygiene is worst. Serve `foo asp index --html` over the real 93 packets, mark a true top 10 by hand, and compare. If the shipped order is already right, this packet re-sorts a correct list and the real defect is that the rank lives behind a flag nobody types. That is a measurement, not an opinion, and it costs an afternoon.
