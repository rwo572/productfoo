// Usage strings shared between the top-level `foo --help` and the per-domain
// help renderers, in one light module. The strings are pure data with no
// dependencies, so cli.ts's boot path can splice them into `--help` without
// pulling the asp/eval command domains in (cli_performance-v0 R-002 lazy
// dispatch). Two copies would drift, and a help text that lies about the flags
// is how the surplus-positional bug stayed invisible.

// The `foo asp` lines, in one place: the top-level `foo --help` splices them in,
// and `foo asp help` prints them.
export const ASP_USAGE_LINES: readonly string[] = [
  "  foo asp validate <packet-dir> [--strict] [--json] [--fix]",
  "  foo asp migrate <packet-dir> [--dry-run] [--json]   (mint missing anchor IDs in place; never rewrites existing text)",
  "  foo asp reconcile <packet-dir> [args...]",
  "  foo asp reconcile <packet-dir> --source github:<pr-or-repo-url> [--source-fixture <file.json>] [--json]",
  "  foo asp verify <packet-dir> [--json] [--strict] [--record]",
  "  foo asp status <packet-dir> [--json] [--deep] [--rich|--plain] [--html [path]]",
  "  foo asp index [--json] [--html [path]] [--serve [--port <n>]]",
  "  foo asp init <name|path>",
  "  foo asp event <packet-dir> <type> [--subject <s>] [--data <json>] [--summary <text>]",
  "  foo asp task <packet-dir> <task-id> --status <todo|doing|blocked|done|dropped> [--proof <p>] [--summary <text>] [--reason <text>] [--needs <a,b>]",
  "  foo asp verdict <packet-dir> <parked|killed|active|done> --reason <text>",
];

export const EVAL_SUBCOMMANDS = ["validate", "compile", "approve", "reject", "run", "label"] as const;

export const EVAL_USAGE_LINES: readonly string[] = [
  "  foo eval validate <packet-dir> [--json]   (records lint: identity, approval, no runner vocabulary)",
  "  foo eval compile <packet-dir> --roast <run.json> [--json]   (roast candidates -> unapproved eval records)",
  "  foo eval approve <packet-dir> --check <E-xxx> --by <who>",
  "  foo eval reject <packet-dir> --check <E-xxx> --by <who> --reason <why>",
  "  foo eval run <packet-dir> --target <file> [--strict] [--json]   (deterministic now; judges need a transport)",
  "  foo eval label <packet-dir> [--count=10] [--suite <name>] [--judge <E-xxx>] [--dispute <hash-prefix>]   (blind owner labels -> private corpus)",
];
