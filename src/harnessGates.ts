// Supported harness gate adapters share one policy with explicit wire formats.
// Claude Code and Codex use the same denial schema; Cursor has separate user
// and agent fields. OpenCode denies by throwing and must fail open on internal
// errors. Grok Bot coverage remains provisional. Preserve each host's actual
// coverage rather than claiming every hook can intercept every tool.

export type HarnessGateFormat = "claude" | "cursor" | "codex" | "opencode" | "grok";

/** What the gate can actually intercept in a given harness. Reported honestly, never rounded up. */
export interface GateCoverage {
  /** Can we refuse a subagent fan-out? */
  readonly fanOut: boolean;
  /** Can we refuse a direct web read? (The behavioural trip needs this.) */
  readonly webRead: boolean;
  /** Does a foo crash DENY the user's tool call instead of allowing it? */
  readonly failsClosed: boolean;
  /** Does the harness refuse to run a hook it has not been told to trust? */
  readonly needsTrust: boolean;
  readonly note?: string;
}

export interface HarnessGate {
  readonly format: HarnessGateFormat;
  readonly label: string;
  /** Where the gate config belongs, relative to the repo. */
  readonly configPath: string;
  readonly coverage: GateCoverage;
  /** The config productfoo would write. */
  render(shim: string): string;
}

/**
 * A denial has TWO audiences, and they are not the same reader.
 *
 * The `agent` text is an instruction: the command to run instead, the escape hatch, the
 * reason the gate fired. It is productfoo's machinery, and the agent is the only one who can act
 * on any of it. The `user` text is one calm line telling the human what just took over —
 * because a denial is not a failure, it is foo doing its job, and it should not read like
 * a crash in their transcript.
 *
 * foo used to send one string to both. Every deny therefore printed skill paths, `bin/foo`
 * invocations and env-var overrides into the user's terminal in red, on a product whose
 * first rule is that the user never sees the machinery. Cursor's own API had been saying so
 * the whole time — it asks for `user_message` and `agent_message` separately, and foo handed
 * it the same string twice.
 */
export interface DenialText {
  /** One line, for the human. No paths, no commands, no env vars, no foo vocabulary. */
  readonly user: string;
  /** The instruction, for the agent. Machinery belongs here and only here. */
  readonly agent: string;
}

/**
 * Render a denial in the shape a given harness understands.
 *
 * Returns the stdout to print and the exit code to use. Getting either wrong is a silent
 * allow — the harness shrugs at output it cannot parse and runs the tool anyway.
 *
 * Some harnesses have a second channel for the agent. Where there is
 * no split, the agent's text is what goes out, because a deny the agent cannot act on just
 * blocks the work with no route forward — a worse failure than a leaky message. Those gaps
 * are named below rather than quietly rounded up: productfoo does not report a thing as clean in a
 * harness where it isn't.
 */
export function renderDenial(format: HarnessGateFormat, text: DenialText): { stdout: string; exit: number } {
  switch (format) {
    case "claude":
    case "codex":
      // Codex deliberately mirrors Claude's schema. One shape, two harnesses.
      // permissionDecisionReason is shown to the USER; additionalContext reaches the MODEL
      // only, and never renders in the transcript. That is the whole split.
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: text.user,
            additionalContext: text.agent,
          },
        }),
        exit: 0,
      };
    case "cursor":
      // Two audiences, two fields — as Cursor intended.
      return {
        stdout: JSON.stringify({ permission: "deny", user_message: text.user, agent_message: text.agent }),
        exit: 0,
      };
    case "opencode":
      // OpenCode has no JSON deny channel — the plugin throws. The shim prints the reason
      // and exits 1; the generated plugin turns that into a throw.
      return { stdout: text.agent, exit: 1 };
    case "grok":
      // Grok Bot wire format provisional — conservatively fail open with no message until verified.
      // No second channel for now.
      return { stdout: JSON.stringify({ permission: "deny", reason: text.agent }), exit: 0 };
  }
}

/** An allow. Silence is the safe answer everywhere: no harness treats empty stdout as a deny. */
export const ALLOW = { stdout: "", exit: 0 } as const;

export const HARNESS_GATES: readonly HarnessGate[] = [
  {
    format: "claude",
    label: "Claude Code",
    configPath: ".claude/settings.json",
    coverage: { fanOut: true, webRead: true, failsClosed: false, needsTrust: false },
    render: () => "", // already wired by productfoo's existing settings.json
  },
  {
    format: "cursor",
    label: "Cursor",
    configPath: ".cursor/hooks.json",
    coverage: {
      fanOut: true,
      webRead: false,
      failsClosed: false,
      needsTrust: false,
      note: "Cursor has no web-search tool to match, so the Nth-read trip cannot fire here — only the fan-out gate does. Reported, not rounded up.",
    },
    render: (shim) =>
      `${JSON.stringify(
        {
          version: 1,
          hooks: {
            // Scoped to Task, NOT the unmatched default: Cursor's preToolUse fires for
            // EVERY tool, and there is no documented default timeout. An unscoped foo hook
            // would spawn a subprocess on every keystroke-adjacent action the agent takes.
            subagentStart: [{ command: shim, timeout: 10, failClosed: false }],
            preToolUse: [{ command: shim, matcher: "Task", timeout: 10, failClosed: false }],
          },
        },
        null,
        2,
      )}\n`,
  },
  {
    format: "codex",
    label: "Codex",
    configPath: ".codex/hooks.json",
    coverage: {
      fanOut: true,
      webRead: false,
      failsClosed: false,
      needsTrust: true,
      note: "Codex will NOT run a hook it has not been told to trust, and productfoo cannot self-trust. This is the correct design and productfoo should copy it, not route around it.",
    },
    render: (shim) =>
      `${JSON.stringify(
        {
          description: "foo research gate (B5) — routes web research through `foo research`",
          hooks: {
            PreToolUse: [
              { matcher: "^(spawn_agent|Agent)$", hooks: [{ type: "command", command: shim, timeout: 10 }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
  },
  {
    format: "opencode",
    label: "OpenCode",
    configPath: ".opencode/plugins/foo-research-gate.ts",
    coverage: {
      fanOut: true,
      webRead: true,
      failsClosed: true,
      needsTrust: false,
      note: "FAIL-CLOSED with NO timeout: an unhandled throw in productfoo's plugin kills every tool call, forever, with no escape. The plugin below swallows every error except a deliberate deny.",
    },
    render: (shim) => `// foo research gate (B5). Generated by \`foo agent setup --gate\`. Safe to delete.
//
// OpenCode's only deny channel is a throw, it is fail-closed, and it has NO timeout wrapper.
// So a BUG in foo here is indistinguishable from a foo POLICY to the user: every tool call
// dies with a stack trace and nothing saves them. Hence the shape below — the try/catch
// swallows everything except the one throw we mean.
import { execFileSync } from "node:child_process";
import type { Plugin } from "@opencode-ai/plugin";

export const FooResearchGate: Plugin = async () => ({
  "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => {
    let denial: string | null = null;
    try {
      // execFileSync takes a PATH and an ARGV — it does not split a command string. Passing
      // "script.sh opencode" as one argument looks for a file with a space in its name, throws
      // ENOENT, and the catch below fails open: the gate would silently never enforce, while
      // reporting success. A silent allow is the worst failure this module has, so: argv.
      execFileSync(${JSON.stringify(shim)}, ["opencode"], {
        input: JSON.stringify({ tool_name: input.tool, tool_input: output.args }),
        encoding: "utf8",
        timeout: 10_000,
      });
    } catch (err) {
      // Exit 1 with a reason IS the deny. Anything else — foo missing, node missing, a bug
      // in the gate — must fail OPEN, because a gate that blocks every tool call the moment
      // it breaks is a gate the user rips out, and here they cannot even see why.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1 && e.stdout) denial = String(e.stdout);
    }
    if (denial) throw new Error(denial);
  },
});
`,
  },
  {
    format: "grok",
    label: "Grok Bot",
    configPath: ".grok/hooks.json",
    coverage: {
      fanOut: false,
      webRead: false,
      failsClosed: false,
      needsTrust: false,
      note: "Grok Bot gate coverage unverified — wire format and hook surface are provisional pending x.ai platform docs. Conservatively reported as no coverage until confirmed.",
    },
    render: (shim) =>
      `${JSON.stringify(
        {
          version: 1,
          description: "foo research gate (B5) — routes web research through `foo research`",
          hooks: {
            preToolUse: [{ command: shim, timeout: 10 }],
          },
        },
        null,
        2,
      )}\n`,
  },
];
