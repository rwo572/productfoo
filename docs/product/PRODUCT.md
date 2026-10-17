# Product

## Register

product

## Users

The primary users are AI-native founder-builders and senior builder ICs who delegate meaningful product and implementation work to agents inside real repos. They are shaping, specifying, prototyping, implementing, and reviewing product work while trying to keep human judgment, source boundaries, task status, and proof inspectable.

Executives are a later rollup audience. They need visibility into agent-led work, drift, risk, proof, and decisions, but the product should earn that surface by first making individual work contracts reliable.

## Product Purpose

productfoo is a collaboration service for humans and agents building agentic products. It turns natural product intent into an inspectable working system: shaped judgment, executable tasks, packet-local artifacts, validation, reconciliation, and proof.

It exists because agent output can move faster than humans can safely steer, inspect, or compound into product quality. Success means the user can describe work naturally while a productfoo-aware agent behaves like a much stronger product partner: clarifying the right things, using expert lenses, preserving source boundaries, keeping packet truth current, catching drift, and escalating only decisions that need human judgment.

## Brand Personality

Pragmatic, exacting, transparent.

The product should feel like a serious builder tool: calm, inspectable, direct, and operational. It should build trust by showing reasoning, evidence, boundaries, and proof instead of hiding them behind confident prose.

## Anti-references

Do not make productfoo feel like:

- A generic prompt or skill library.
- A PRD generator that turns weak evidence into polished certainty.
- A static Build Preview gallery or decorative prototype showcase.
- A project dashboard that claims executive certainty before the underlying work contract has proof.
- An agent output machine that rewards more artifacts over clearer delegation.
- A chat transcript with no durable contract.
- A narrow observability layer that only explains agent reasoning without improving how humans and agents collaborate.

Avoid vague AI-product aesthetics: generic purple gradients, inflated confidence metrics, abstract agent diagrams, fake precision, and status surfaces that hide source authority or approval boundaries.

## Design Principles

- Make collaboration feel natural. Users should state product work in their own words while productfoo-aware agents invoke the right interviews, expert lenses, packet checks, and reconciliation gates.
- Make judgment legible. Show what the agent believes, why it believes it, what evidence supports it, how confident it is, who might dissent, and what still needs human judgment.
- Preserve momentum. Read interview depth and question budget from the conductor run contract; do not maintain a second budget here. The interview family defaults to fast, with at most three questions. Ask only what the available evidence cannot answer, one question at a time, and escalate depth deliberately. See `src/conductor/families/interview.ts` and `skills/interview-me/SKILL.md`.
- Stack-rank before interrupting. productfoo should generate many candidate questions internally, but ask only the highest-impact questions whose answers change the product bet, source boundary, approval boundary, MVP scope, validation bar, risk posture, or implementation churn.
- Provide a framework for agentic products. Agent loops, approval boundaries, source authority, generated artifacts, task state, events, and proof should have durable places to live.
- Inspect before escalating. Use repo evidence, accepted specs, tasks, events, and approved context before asking the user to restate facts.
- Treat the spec as the contract. Product truth, task state, source boundaries, event history, and proof should stay connected.
- Separate agreed work from discovered work. New tasks and risks can emerge, but they must be labeled and accepted, rejected, or revised.
- Make artifacts useful review surfaces. Packet-local artifacts should help shape or review decisions without silently mutating canonical packet files.

## Accessibility & Inclusion

Default to WCAG AA for contrast, keyboard accessibility, visible focus states, and reduced-motion support for generated or reviewed UI artifacts. Keep product surfaces readable, dense enough for expert work, and explicit about state, errors, approvals, and privacy boundaries.
