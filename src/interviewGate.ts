// Interview gate — route a real interview through `interview-me`, and let a single
// clarifying question through.
//
// Why this exists: the first version of this gate was an unconditional deny wired inline
// into `.claude/settings.json` — every AskUserQuestion in this repo was refused, always,
// with a message telling the agent to run `interview-me` instead. It fired on an agent
// that had found the three lines it was asked to edit and wanted to settle ONE thing
// before editing. There was nothing to interview about. The gate had matched the tool,
// not the behaviour.
//
// That is the same failure this repo already learned from twice in the research gate (B5):
// a gate that fires on the mention of a risk rather than the risk itself is one people
// learn to override on sight, and an override reached for on sight protects nothing. The
// repair is the same one: gate the BEHAVIOUR.
//
// An interview has a shape a clarification does not:
//
//   THE BATCH. Several questions handed over at once is a questionnaire — the exact thing
//   `interview-me` forbids ("ask one question at a time"). One question is a clarification.
//
//   THE ACCRETION. Question after question after question IS an interview, however each
//   one was phrased and whatever anyone called it. So the Nth ask in a few minutes trips
//   the gate: one or two are a clarification and stay free; the third is a run.
//
// Both tells are structural. Neither reads the wording of the question, because a gate that
// guesses at phrasing loses to phrasing it did not guess — that is how the research gate was
// walked through, and it is not a mistake worth making a third time.
//
// The policy lives here, in foo, so any harness can enforce it. Harness configs carry only
// a thin shim (`.githooks/guard-interview.sh` -> `foo interview gate`).
//
// FAILS OPEN on any error. Escape hatch: FOO_ALLOW_VANILLA_INTERVIEW=1.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DenialText } from "./harnessGates.js";

/** A PreToolUse-shaped payload. Harness-neutral: only these two fields are read. */
export interface InterviewCall {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

export interface InterviewDecision {
  readonly allow: boolean;
  /**
   * Present when allow=false. Two readers, two texts: `agent` carries the instruction and
   * the machinery, `user` is the one line the human sees. See DenialText in harnessGates.ts.
   */
  readonly reason?: DenialText;
  /** Why the gate decided this — for tests and `--json`, never for the agent. */
  readonly note?: string;
}

/** Harnesses disagree on the name of the ask-the-human tool. Accept the ones that exist. */
const ASK_TOOLS = new Set(["askuserquestion", "ask_user_question", "askuser"]);

/** Asks older than this stop counting — a question this morning is not this conversation. */
const ASK_WINDOW_SECONDS = 600;

/** Single questions that stay free before the counter calls it an interview. */
const ASK_ALLOWANCE = 2;

const asksPath = (root: string): string => path.join(root, ".foo", "interview-asks.json");

const windowMs = (): number =>
  (Number(process.env.FOO_INTERVIEW_WINDOW_SECONDS ?? ASK_WINDOW_SECONDS) || ASK_WINDOW_SECONDS) * 1000;

const allowance = (): number =>
  Number(process.env.FOO_INTERVIEW_ALLOWANCE ?? ASK_ALLOWANCE) || ASK_ALLOWANCE;

const recentAsks = (root: string, now: number): number[] => {
  const file = asksPath(root);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { asks?: unknown };
    return (Array.isArray(raw.asks) ? raw.asks : [])
      .map(Number)
      .filter((t) => Number.isFinite(t) && now - t < windowMs());
  } catch {
    // A corrupt counter must not deny anyone's question.
    return [];
  }
};

/** Record one question we let through. The accretion trip is only as good as its counter. */
export function recordInterviewAsk(root: string, now: number = Date.now()): void {
  const kept = recentAsks(root, now);
  kept.push(now);
  const file = asksPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ asks: kept }, null, 2)}\n`);
}

/** Cleared when a governed interview starts — a real one must not trip its own gate. */
export function clearInterviewAsks(root: string): void {
  const file = asksPath(root);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Has the agent asked enough times that this is plainly an interview, unnamed? */
export function asksLookLikeInterview(root: string, now: number = Date.now()): boolean {
  return recentAsks(root, now).length >= allowance();
}

/** How many questions this call hands over at once. A batch is a questionnaire. */
export function questionCount(call: InterviewCall): number {
  const questions = (call.tool_input ?? {}).questions;
  return Array.isArray(questions) ? questions.length : 1;
}

export function evaluateInterviewGate(
  call: InterviewCall,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): InterviewDecision {
  if (env.FOO_ALLOW_VANILLA_INTERVIEW) return { allow: true, note: "override" };

  const tool = (call.tool_name ?? "").trim().toLowerCase();
  if (!ASK_TOOLS.has(tool)) return { allow: true, note: "not-an-ask" };

  // The batch. Handing over several questions at once is the questionnaire shape, and it is
  // the one thing interview-me names outright: ask one question at a time.
  if (questionCount(call) > 1) return { allow: false, reason: BATCH_REASON, note: "batch" };

  // The accretion. Nobody called this an interview — and it is one. The agent has already
  // asked its allowance of questions in the last few minutes and is reaching for another.
  // One question is a clarification; this is a run.
  if (asksLookLikeInterview(root, now)) return { allow: false, reason: ACCRETION_REASON, note: "accretion" };

  // One question, asked once, to settle something the repo cannot answer. That is not an
  // interview. It is the thing an agent should do more of, not less.
  return { allow: true, note: "clarification" };
}

const HANDOFF =
  "  bin/foo spec start <work-item> --request \"<the user's request>\"\n\n" +
  "then run the interview-me skill (skills/interview-me/SKILL.md) with the Compound Engineering " +
  "posture: repo-first discovery, explicit scope boundaries, task/validation traceability. Ask one " +
  "question at a time as numbered text, highest-leverage question first, recommendation marked.";

// The user's line is not a shorter version of the agent's. It is a different sentence for a
// different reader: it says what took over and what happens next, in their words. It carries
// no path, no command and no env var, because none of those are theirs to run — the agent is
// about to run them. It does not apologise, and it does not read like a crash, because
// nothing broke: this is foo doing the one thing it is for.
const BATCH_REASON: DenialText = {
  user: "productfoo runs interviews — asking one question at a time instead of all at once.",
  agent:
    "this is a questionnaire, not a question: you are handing over several questions at once. " +
    "productfoo is installed, so an interview runs through foo:\n\n" +
    HANDOFF +
    "\n\nAsking one thing you genuinely cannot answer from the repo is fine and is not gated — ask it " +
    "as a single question. Deliberately going around foo? Set FOO_ALLOW_VANILLA_INTERVIEW=1.",
};

const ACCRETION_REASON: DenialText = {
  user: "That's a few questions in a row — productfoo is taking the interview from here.",
  agent:
    "nobody called this an interview, and it is one: you have already asked the user several questions " +
    "in the last few minutes and are reaching for another. One question is a clarification; this is a " +
    "run, and it goes through foo:\n\n" +
    HANDOFF +
    "\n\nThis fires on BEHAVIOUR, not on wording — a gate that reads phrasing loses to phrasing it did " +
    "not anticipate. Deliberately going around foo? Set FOO_ALLOW_VANILLA_INTERVIEW=1.",
};
