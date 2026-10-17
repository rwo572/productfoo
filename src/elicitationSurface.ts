// Elicitation surface selection for productfoo's branded question moment.
//
// Packet: specs/foo-branded-elicitation-v0 — T-001 (render-surface decision +
// capability detection). This module is the spike's durable artifact: it records the
// decision in code and resolves, for any runtime and output context, whether productfoo should
// ask a question as a branded widget or as numbered text.
//
// DECISION (R-001 / D-002): productfoo's branded question surface renders through an inline
// widget MCP (HTML + a `sendPrompt` round-trip), NOT the native Claude Code
// `AskUserQuestion` dialog and NOT a plain MCP tool. The `AskUserQuestion` chrome is
// unbrandable — only a <=12-char `header` chip plus the question/option text is
// controllable, and a `PreToolUse` hook can rewrite that input but never the chrome.
// A plain MCP tool renders no UI at all. An inline widget MCP (a `show_widget`-style
// elicitation surface with a `sendPrompt` callback) is the only mechanism that yields a
// fully productfoo-branded interactive question surface.
//
// CAPABILITY RULE (R-003 / R-004): the widget is opt-in and "full tier". Numbered text
// is the DEFAULT — every runtime can render it and a coding agent can read it. The
// widget is selected only when the caller has not forced text, output is an interactive
// TTY, and the active runtime advertises a branded-widget renderer. Precedence is
// safety-first:
//   1. FOO_ELICITATION_SURFACE=text    -> text   (forcing text is always safe)
//   2. non-interactive stdout          -> text   (never render a widget into a pipe or
//                                                  agent reader — the sharpest constraint)
//   3. FOO_ELICITATION_SURFACE=widget  -> widget  (explicit opt-in; TTY already confirmed)
//   4. runtime advertises a renderer   -> widget
//   5. otherwise                       -> text   (the default)

export type ElicitationSurface = "widget" | "text";

export type SurfaceDecision = {
  surface: ElicitationSurface;
  runtime: string;
  reason: string;
};

export type SurfaceContext = {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  widgetCapableRuntimes?: Iterable<string>;
};

// Runtimes that ship a productfoo-branded widget renderer today. Claude Code can render an
// inline widget MCP (show_widget elicitation + sendPrompt); Codex and unknown runtimes
// have no branded-widget renderer yet, so they take the text path. Extend the set with
// FOO_WIDGET_RUNTIMES (comma-separated) as new runtimes gain a renderer.
const DEFAULT_WIDGET_CAPABLE_RUNTIMES: readonly string[] = ["claude-code"];

// Detect the active coding-agent runtime from the environment, mirroring the runtime
// detection productfoo already uses for adapter and branch-prefix decisions. FOO_RUNTIME forces
// a value; Claude Code sets CLAUDECODE / CLAUDE_CODE_*; Codex identifies through its own
// adapter env. Anything else is "unknown" (and therefore takes the text path).
export function detectRuntimeId(env: NodeJS.ProcessEnv = process.env): string {
  const forced = env.FOO_RUNTIME?.trim();
  if (forced) return forced;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE === "1") return "claude-code";
  if (env.CODEX || env.CODEX_SANDBOX || env.CODEX_HOME) return "codex";
  return "unknown";
}

function widgetCapableRuntimes(context: SurfaceContext, env: NodeJS.ProcessEnv): Set<string> {
  if (context.widgetCapableRuntimes) return new Set(context.widgetCapableRuntimes);
  const fromEnv = env.FOO_WIDGET_RUNTIMES?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return new Set(fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_WIDGET_CAPABLE_RUNTIMES);
}

// Resolve which surface productfoo should use to ask a question in the given context. The
// default is "text"; "widget" is the earned, positively-detected exception.
export function detectElicitationSurface(context: SurfaceContext = {}): SurfaceDecision {
  const env = context.env ?? process.env;
  const runtime = detectRuntimeId(env);
  const override = env.FOO_ELICITATION_SURFACE?.trim().toLowerCase();

  if (override === "text") {
    return { surface: "text", runtime, reason: "forced by FOO_ELICITATION_SURFACE=text" };
  }

  const isTTY = context.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) {
    return {
      surface: "text",
      runtime,
      reason: "non-interactive output (piped or agent reader); numbered text is the readable fallback",
    };
  }

  if (override === "widget") {
    return { surface: "widget", runtime, reason: "forced by FOO_ELICITATION_SURFACE=widget" };
  }

  if (widgetCapableRuntimes(context, env).has(runtime)) {
    return { surface: "widget", runtime, reason: `runtime "${runtime}" advertises a branded-widget renderer` };
  }

  return { surface: "text", runtime, reason: `runtime "${runtime}" has no branded-widget renderer; text is the default` };
}
