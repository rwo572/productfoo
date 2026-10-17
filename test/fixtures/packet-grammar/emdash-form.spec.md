---
spec_id: fsg_v0
title: productfoo Status Glyphs V0
mode: product-definition
lifecycle: done
stage: building
owner: product
autonomy: human-in-loop
updated: 2026-07-07
---

# productfoo Status Glyphs V0

## Intent

Give productfoo's human-facing judgment surfaces a small, friendly status-glyph
vocabulary so the state of work and decisions is scannable at a glance — the
"emoji for what changed" feel — without diluting productfoo's rigor or its restrained,
checksum-like brand. The friendliness comes from *consistency*: one glyph means
one state on every surface, never a badge pile.

## Current Understanding

foo already has the state model; what it lacked was a friendly skin over it.
Task/proof states live in `src/packetIndex.ts` and `src/packetStatus.ts`
(`proven / done / doing / blocked / todo`); judgment fields live in
`src/questionModel.ts` (`belief / evidence / confidence / dissent`); semantic
tones live in `web/tokens.css` (`proof` blue-green, `attention` oxblood, `warn`
amber). Today these render as single-letter glyphs (`p/d/w/b/o`) and CSS tones —
deliberately spare, with zero emoji.

This packet adds an emoji layer that maps **1:1 onto those existing states** — it
invents no new taxonomy. The work is reversible (a presentation skin), not
agentic, not outbound; `foo classify` rates it **routine**, so spec-first is the
chosen reflex here, not a required boundary.

The pair that earns its keep is `✅ proven` vs `🟡 claimed`: it makes productfoo's
signature line — "Done is a claim. Proof is a receipt." — legible without two
look-alike checkmarks. `🚧 blocked` (stuck on a thing) and `✋ needs your input`
(stuck on you) are a second pair chosen so they can never be confused.

## Vocabulary

| Glyph | State (`FooState`) | Meaning | foo mapping | tone |
| --- | --- | --- | --- | --- |
| ✅ | `proven` | completely done — receipt exists | `done_when` checks met | proof |
| 🟡 | `claimed` | done, not yet proven (no receipt) | task `status: done` | neutral |
| 🔄 | `doing` | in progress | task `status: doing` | neutral |
| 🚧 | `blocked` | stuck behind a dependency/obstacle | task `status: blocked` | warn |
| ✋ | `needs_input` | locked on human judgment | open question / approval boundary | warn |
| 📋 | `todo` | not started | task `status: todo` | neutral |
| ⚠️ | `drift` | claim ≠ proof; restamp | lifecycle/proof mismatch, overdue review | attention |
| 🏷️ | `classification` | capability · risk · packet kind | `foo classify` / `foo shape` verdict | neutral |

## Requirements

### R-001 — Single source of truth
One module (`src/statusGlyphs.ts`) defines the glyph, text label, and tone for
each `FooState`. Every surface imports it; no surface hard-codes an emoji. Adding
or changing a glyph is a one-line edit in one place.

### R-002 — The word carries the meaning
A glyph is always paired with its text label; no surface is ever glyph-only. A
screen reader, a `grep`, or a reader without the legend still understands the
state. This is an accessibility requirement, not a preference.

### R-003 — Human surfaces only
Glyphs render only when the human-view gate is on — the same signal as the brand
frame (`resolveBrand`): off for `--json`, `NO_COLOR`, and piped/non-TTY output,
on for an interactive terminal. Machine-readable output — `events.jsonl`,
`tasks.yaml` values, any `--json` view — never carries a glyph.

### R-004 — Status ledger wired
`foo asp status` renders the vocabulary for the states it surfaces: `🟡 claimed`,
`🔄 doing`, `🚧 blocked`, `📋 todo` on the Tasks line; `✅ proven` on Proof;
`✋ needs your input` on open Questions; `⚠️ drift` on overdue review rows.

### R-005 — Classification and decision ledger
The `foo classify` / `foo shape` output carries `🏷️ classification` on the
verdict line and the decision states (`✅` resolved, `✋ needs your input`) in the
judgment-ledger seed — the surface that first inspired this work.

### R-006 — HTML packet index adopts the vocabulary
The web surface (`src/packetIndex.ts`) maps the same vocabulary onto its tone
tokens. Because it is a generated UI artifact, it passes the design swarm and
`$impeccable critique` before it ships (AGENTS.md UI gate).

### R-007 — Drift is computed, not just displayed
`⚠️ drift` is backed by a real check — header lifecycle says `draft` while work
is fully proven, or a suggested/discovered decision is overdue for review —
wherever status is shown.

## Decisions

The locked calls from the shaping interview (decision ledger):

- ✅ **D-001 — ✅ proven vs 🟡 claimed.** `✅` is reserved for completely-done work
  with a receipt; `🟡` marks a done-but-unproven claim. Two *unrelated* glyphs,
  not two checkmarks, so productfoo's "a claim is not a receipt" reads at a glance while
  `✅` keeps its conventional "verified" meaning.
- ✅ **D-002 — 🚧 blocked vs ✋ needs your input.** `🚧` is stuck-on-a-thing;
  `✋` is stuck-on-you. Chose `🚧` over the owner's first instinct `❌` because
  `✅`/`❌` reads as pass/fail and would mislabel a *waiting* task as a *failed*
  one — the one place that misfire hurts most in a status product.
- ✅ **D-003 — 📋 todo, 🏷️ classification.** `📋` replaces the placeholder-y empty
  square; `🏷️` tags capability · risk · packet kind.
- ✅ **D-004 — Human surfaces only; the word always carries the meaning.** Glyphs
  ride the brand gate (`resolveBrand`); the text label is never dropped.
- ✅ **D-005 — Ship the status ledger first.** `foo asp status` is the first slice
  (T-002); the classify/shape line (T-003) and the HTML index (T-004) follow.
- ✅ **D-006 — `⚠️ drift` computes in the shared reader (resolves OQ1).**
  `derivePacketStatus` computes the restamp signal (lifecycle says `draft` while
  every task is done), so `asp status` and `asp index` read one definition rather
  than two. It mirrors the existing packetIndex restamp flag. Status payload
  the additive `drift` field rides the existing 1.0 status payload — no version
  bump, matching how main added `task_list`.
- ✅ **D-007 — `✋` uses the base codepoint, no skin-tone modifier (resolves OQ2).**
  Every emoji on the web is `aria-hidden` decoration with the word as the carrier,
  so skin tone is a visual-only concern; the base `✋` renders in the neutral
  (non-toned) presentation across platforms, so no modifier is added.
- ✅ **D-008 — HTML index adopts the vocabulary as words + an emoji legend, not
  per-row emoji (design swarm, T-004).** All three design lenses converged on
  Option C+: emoji-keyed accessible legend, labels aligned to the vocabulary, no
  emoji on data rows (honors the no-badge-pile Non-Goal and avoids color/glyph-only
  state). See `artifacts/design-review/T-004-html-index.md`.
- ✅ **D-009 — Impeccable critique passed at "Good" (T-004 C-008).** `$impeccable
  critique` scored the HTML index 29/40 (Good band), no P0/P1, detector clean.
  Snapshot committed at
  `.impeccable/critique/2026-06-23T22-57-15Z__packet-index-html.md`. Follow-ups are
  P2/P3 — text search / keyboard nav, a 12px label floor, and the silent
  error-state row (already filed) — logged, not blocking.
- ✅ **D-010 — Critique re-run improved 29 → 30 after the P2 fixes (T-007/T-008).**
  Added a keyboard-reachable text filter (`$impeccable layout`) and a 12px type floor
  (`$impeccable typeset`); the detector went from 3 `tiny-text` warnings to clean.
  Re-run snapshot: `.impeccable/critique/2026-06-23T23-09-48Z__packet-index-html.md`.
  The silent error-state row remains the one open P2 (separate task).

## Risks

- **Emoji-as-slop** if the set grows or stacks. Mitigation: a fixed 8-glyph
  vocabulary, one glyph per state, never piled on one item (see Non-Goals).
- **Cross-platform rendering variance** (terminal width, `⚠️`/`✋` variation
  selectors). Mitigation: the word is always present, so meaning never depends on
  the glyph rendering correctly.
- **Accessibility regression** if a surface ever renders glyph-only. Mitigation:
  the helpers pair glyph+word by construction (R-002), covered by a test.
- **`🟡` amber overlaps productfoo's `warn` tone token.** Tracked: `claimed` keeps a
  `neutral` tone for now; revisit when the HTML surface adopts the tokens (T-004).

## Validation

- Unit + render tests in `test/status_glyphs.test.ts`: every state has a
  glyph/label/tone, glyphs are unique, the pair is not two checkmarks, the gate
  adds glyphs only when on, and the `--json` view is byte-identical regardless of
  the flag. ✅ proven (5 tests pass).
- `foo asp status` shows glyphs on a terminal and stays plain when piped or
  `--json` — verified by hand (before/after) and by test.
- The HTML packet index (T-004) must pass the design swarm and
  `$impeccable critique` before it ships, with the critique snapshot committed.
- A fresh reader can distinguish the states without a legend (manual review bar).

## Evidence

- foo already encodes claim-vs-receipt *visually*: `src/packetIndex.ts` draws a
  done task at 42% opacity of the proof color and a proven task at full strength.
  The `🟡 → ✅` pair mirrors that existing "faded vs sealed" distinction.
- Brand voice already carries the concept: "Done is a claim. Proof is a receipt."
  (`specs/foo-brand-identity-v0`).
- The approach is proven by `test/status_glyphs.test.ts` and the before/after
  render of this very packet.

## Non-Goals

- A new state taxonomy. This is a skin over states foo already has.
- ANSI color or terminal styling. The glyph is the only device.
- Emoji in machine output, contracts, or persisted artifacts.
- Stacking multiple glyphs on one item (a badge pile). One item, one state.

## Open Questions

_None. OQ1 resolved in T-005 (D-006), OQ2 in T-004 (D-007); the Impeccable critique
(C-008) ran and passed at Good — see D-009._
