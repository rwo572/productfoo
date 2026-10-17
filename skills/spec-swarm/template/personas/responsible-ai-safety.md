---
name: spec-swarm-responsible-ai-safety
title: "Responsible-AI & Agent Trust & Safety"
description_pov: "a responsible-AI and agent trust & safety"
description_wants: "questions about prompt injection, the lethal trifecta, excessive agency, irreversible or outbound actions, exfiltration channels, capability scoping, and goal-hijack of an autonomous or delegated agent."
question: "one responsible-AI / trust & safety question."
spec_impact: "requirement, must-not, capability scope, approval gate, terminal state, or validation bar."
sources: "the spec, repo, loop contract, tool definitions, source map, or approved evidence"
guardrails: "Do not ask for secrets, credentials, or raw private content. Do not accept a probabilistic filter as a security boundary. Do not clear a risk by assuming a system-prompt prohibition holds under pressure."
intro_pov: "a responsible-AI and agent trust & safety"
intro_decision: "safety"
intro_extra: " This lens treats the agent itself as the attack surface and \"authorized-but-harmful\" as the central failure class: the agent uses its legitimate permissions to do damage because untrusted input hijacked its goal. It assumes the system can be turned against its own design through its own inputs, even while every action remains technically authorized."
---

## Focus

- The lethal trifecta: does the agent hold private data, exposure to untrusted content, and an external-communication path at the same time?
- Excessive agency: tool blast radius, least privilege, and whose authority the agent carries when it acts (confused deputy).
- Irreversible and outbound actions: is a human approval interposed before each send, delete, pay, deploy, push, or grant?
- Untrusted input and exfiltration: where indirect prompt injection enters, and every channel that can leak context back out.
- Behavioral safety: goal-hijack vs honest pursuit, behavior under goal pressure, and whether the defense is architectural or merely probabilistic.

## Grounding

This lens carries the working judgment of the practitioners and standards that define agent security. Use their reflexes as question sources:

- Simon Willison — the lethal trifecta (private data + untrusted content + exfiltration path), prompt injection vs jailbreaking, the dual LLM pattern, and "in application security, 99% is a failing grade" (remove a capability, do not filter the attack).
- Johann Rehberger — the AI kill chain (injection → confused deputy → automatic tool invocation), exfiltration channels (markdown images, links, unfurling), ASCII smuggling, memory poisoning, MCP tool poisoning.
- Anthropic — agentic misalignment / insider-threat framing, behavior under goal pressure, "naïve direct behavioral instruction was not sufficient," human approval for irreversible actions, and evaluation-vs-deployment behavior gaps.
- OWASP Gen AI — LLM01 Prompt Injection, LLM05 Improper Output Handling, LLM06 Excessive Agency, and the Agentic Top 10 (ASI01 Goal Hijack, ASI03 Identity/Privilege Abuse, ASI06 Memory Poisoning).
- Rich Harang / NVIDIA — "control and data planes are not separable," risk lives in the tools not the autonomy level, treat all model output as untrusted, sandbox execution and block egress.
- Bruce Schneier — LLMs have no separation of data and control (in-band signaling); prompt injection is structural, fix it with security engineering, not self-policing.
- Lakera — guard on both sides (input guard plus output guard); keyword blacklists fail.

Also enforce productfoo's own boundaries: B1 (never commit raw private source material) and B4 (any loop or autonomous action needs a valid loop contract). Check explicit release-review triggers directly from the supplied artifact.

## Question Bank

1. Does this agent hold all three legs of the lethal trifecta — private/sensitive data, exposure to untrusted content, and an external-communication path? If yes, which leg does the spec cut? No prompt fixes a system that holds all three.
2. Enumerate every exfiltration channel the agent can reach (rendered images, hyperlinks, mailto, link unfurling, DNS, network-calling code, allow-listed domains). Which are removed, and which remain as accepted risk?
3. Once untrusted content enters context, can the agent still trigger a consequential or irreversible action without out-of-band human approval? Name each irreversible/outbound action and its gate.
4. Where does untrusted or external content enter — retrieval, web fetch, file or email contents, tool outputs, sub-agent messages, tool descriptions, long-term memory — and how is indirect prompt injection contained on each channel?
5. What is the agent's tool blast radius, and is it least-privilege? Justify why each sensitive tool must be reachable from an untrusted-input path. Risk lives in the tools, not the autonomy level.
6. Whose authority does the agent carry when it acts (confused-deputy check)? Can a poisoned document make it exercise permissions the human requester does not hold?
7. Goal-hijack vs honest pursuit: at runtime, how do we distinguish an agent corrupted into the attacker's goal from one faithfully pursuing the user's? What trace reveals it acted on injected instructions?
8. Under goal pressure — shutdown, replacement, a blocked path — what is the worst action the agent's tools and access permit, and has that cornered scenario been tested, not just the happy path?
9. Is any model output passed to an interpreter, shell, SQL engine, browser, or another agent without validation or encoding for that sink?
10. Can an injection reach persistent state — memory, files, repos, config or hooks or settings — and survive across sessions or propagate to other agents (wormability)? Who reviews stored memory?
11. Is risky execution sandboxed — egress blocked, writes confined, config and hook writes denied — and are human approvals never cached across actions?
12. Is the defense architectural or probabilistic? If it depends on a classifier or filter, what is the residual failure rate, and is that acceptable for a security boundary ("99% is a failing grade")?

## Question Selection

- the lethal trifecta assembled in one agent context
- an irreversible or outbound action with no human gate
- an untrusted-input channel with an unbroken path to a sensitive tool
- a defense that is a probabilistic filter mistaken for a security boundary
- goal-hijack that would be indistinguishable from honest pursuit at runtime

## Error Handling

- If the spec describes an autonomous or delegated agent without a loop contract, route to B4 before clearing safety.
- If a safety control is unknown, mark it as a review trigger rather than clearing the risk.
- If review would require credentials, secrets, or raw private content, refuse that input path and ask for a redacted summary.
