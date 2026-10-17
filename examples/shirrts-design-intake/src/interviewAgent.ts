// The interviewing agent. (R-001, R-002)
//
// It drives the question set, routes every answer through the vagueness check and
// the rights check, and — the part the form could never do — refuses to report
// itself finished while any cut-critical field is still open, naming which one.

import {
  buildDesignBrief,
  openFields,
  type BriefResult,
  type CutCriticalAnswers,
} from "./designBrief.js";
import { CUT_CRITICAL_FIELDS, QUESTIONS, type CutCriticalField, type Question } from "./questions.js";
import { checkRights, type Refusal } from "./refusals.js";
import { judgeDesignAnswer } from "./vagueness.js";
import type { Garment, Placement, SizeRun } from "./types.js";

export interface AgentTurn {
  /** What the agent says next. Null only when the interview is finished. */
  say: string | null;
  /** True when the answer did not land and we are asking the same thing again. */
  reAsking: boolean;
  /** A rights problem raised by this answer, escalated to the owner. */
  refusals: Refusal[];
  finished: boolean;
  /** Which cut-critical fields are still open. Named, so nobody has to guess. */
  stillOpen: CutCriticalField[];
}

export class InterviewAgent {
  private index = 0;
  private readonly answers: CutCriticalAnswers = {};
  private readonly raisedRefusals: Refusal[] = [];

  /** The opening question. */
  start(): string {
    return QUESTIONS[0].ask;
  }

  private get current(): Question | null {
    return this.index < QUESTIONS.length ? QUESTIONS[this.index] : null;
  }

  private turn(say: string | null, reAsking: boolean, refusals: Refusal[]): AgentTurn {
    return {
      say,
      reAsking,
      refusals,
      finished: this.isFinished(),
      stillOpen: this.stillOpen(),
    };
  }

  /** Feed the customer's answer to whatever the agent last asked. */
  answer(text: string): AgentTurn {
    const question = this.current;
    if (!question) return this.turn(null, false, []);

    // The design answer is the one the old form let through. It gets the
    // vagueness check BEFORE anything else, and a vague one does not advance.
    if (question.field === "artwork") {
      const verdict = judgeDesignAnswer(text, question.followUp);
      if (verdict.vague) {
        return this.turn(`${verdict.reason} ${verdict.followUp}`, true, []);
      }

      // A design we cannot legally print stops here and goes to the owner.
      const refusals = checkRights(text);
      if (refusals.length > 0) {
        this.raisedRefusals.push(...refusals);
        const said = refusals
          .map((refusal) => `${refusal.message} ${refusal.alternative}`)
          .join(" ");
        return this.turn(`${said} ${question.followUp}`, true, refusals);
      }
    }

    const parsed = question.parse(text);
    if (!parsed.ok) {
      return this.turn(parsed.followUp, true, []);
    }

    this.record(question.field, parsed.value);
    this.index += 1;

    const next = this.current;
    if (next) return this.turn(next.ask, false, []);

    // Out of questions. Finished only if every cut-critical field actually landed.
    if (!this.isFinished()) {
      const open = this.stillOpen();
      const reAsk = QUESTIONS.find((entry) => entry.field === open[0]);
      this.index = QUESTIONS.findIndex((entry) => entry.field === open[0]);
      return this.turn(
        `Before we cut anything we still need one thing: ${reAsk?.ask ?? open[0]}`,
        true,
        [],
      );
    }

    return this.turn(null, false, []);
  }

  private record(field: Question["field"], value: unknown): void {
    switch (field) {
      case "artwork":
        this.answers.artwork = value as string;
        return;
      case "garment":
        this.answers.garment = value as Garment;
        return;
      case "sizeRun":
        this.answers.sizeRun = value as SizeRun[];
        return;
      case "placement":
        this.answers.placement = value as Placement;
        return;
      case "colors":
        this.answers.colors = value as string[];
        return;
      case "quantity":
        this.answers.quantity = value as number;
        return;
    }
  }

  /** The five things the cutting table depends on, still missing. */
  stillOpen(): CutCriticalField[] {
    const open = openFields(this.answers);
    return CUT_CRITICAL_FIELDS.filter((field) => open.includes(field));
  }

  /** Finished means: nothing the cutter needs is open, and we have a design. */
  isFinished(): boolean {
    return this.stillOpen().length === 0 && typeof this.answers.artwork === "string";
  }

  /** The brief — or, when the interview is not done, what is still open. */
  brief(): BriefResult {
    return buildDesignBrief(this.answers, this.raisedRefusals);
  }

  /** Every rights problem raised, for the owner. */
  escalations(): Refusal[] {
    return [...this.raisedRefusals];
  }
}
