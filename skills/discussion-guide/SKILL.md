---
name: discussion-guide
description: "Use when a research conversation needs a neutral, live-usable question guide from explicit study intent and approved sanitized context."
---

# Discussion Guide

## Usage

This draft keeps its file-ingress boundary. It may create an in-chat guide from
explicit study intent and approved sanitized evidence already in context; it must
not open, enumerate, inspect, or request a local/private file.

1. Identify the decision, segment, session length, hypotheses, and sensitive
   topics from supplied context. Ask only for information needed to shape the
   conversation that the context does not answer.
2. Draft an opening, past-behavior questions, probes, counterfactuals, and close.
   Map each question to a hypothesis or uncertainty and the decision it informs.
   Separate a stated problem from a possible deeper constraint; label the latter
   as a hypothesis rather than treating it as the participant's real motive.
3. Select 3–5 primary questions that fit the available time. Put reserve probes,
   rationale, and source context after the live prompts so the guide can be used
   during the conversation without reading a dossier.
4. For each primary question include **Exact wording · What it tests · Listen
   for · Follow-up · Decision use**. Listen-for cues describe observable answers,
   examples, hedges, or contradictions. An emotion, hesitation, or evasion does
   not prove a hidden motive; use a neutral follow-up to test interpretations.
5. Include **Sources used**, **Sources omitted**, **Trust status**, and **Limits**.
   Return an in-chat or requested local outline for human review; do not ingest
   an upload or treat the guide as customer evidence.

### Pain and priority probes

Use the families relevant to the decision rather than performing a fixed script:

- **Past attempts:** ask about the last time the problem happened, what was
  tried, and where that attempt failed.
- **Cost of inaction:** ask what staying with the current approach prevents,
  who bears that cost, and for a concrete recent example.
- **Priority competition:** ask what has previously displaced this work and
  what would make another problem outrank it.
- **Success and ownership:** ask what would change in the participant's work,
  which outcome would demonstrate relief, and who decides whether to change.
- **Risk:** ask what an outsider might oversimplify and where a proposed
  solution would fail. Do not pitch a solution before understanding the answer.

For example: **Question:** "Tell me about the last time this lost priority."
**What it tests:** whether acknowledged pain survives competing work.
**Listen for:** a named event, competing commitment and consequence.
**Follow-up:** "What happened to the work after that?"
**Decision use:** distinguish a problem hypothesis from an adoption constraint.

Keep questions neutral and about one idea at a time. Ask permission before a
sensitive deeper probe; offer a lighter question or move on when it is unwelcome.
End with a live gap check such as "What did I miss that would change my
understanding?" A use-later hook informs a later decision; it is not permission
to claim value, negotiate, send a follow-up, or record inferred motives as facts.

### Framework attribution

The pain-to-value and live gap-finding methods retain the source skill's
attribution to Jacob Warwick's conversation on Lenny's Podcast. The original
source link is recorded in the owning packet's method origins; this in-chat
guide does not fetch it.
This is adapted conversation craft, not evidence of effectiveness in every
research setting; the guide remains grounded in the current study's hypotheses.

## Error Handling

- If a required input exists only in a file, stop before observing it with
  `status: blocked`, `did_not_run: file read`, `missing: safe file-ingress`,
  `next action: provide an approved sanitized summary in chat`, `exit: nonzero`.
- Never suggest pasting raw transcripts or private messages as a workaround.
- With thin context, label assumptions and use questions to test them. Do not
  manufacture the participant's pain or a product advantage.
