// argv parsing foo repeats everywhere: a boolean `--flag`, and a `--flag value`
// whose value is the token immediately after it. Every command module reached
// for its own `args.indexOf("--flag")` / `args[idx + 1]` inline (and one even
// re-declared a private `flag` helper); these name the idiom once so call sites
// read as intent.

// Is a bare boolean flag present?
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

// The token immediately after `flag`, or undefined when the flag is absent (or
// is the last token with no value following it).
export function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

// Which flags a command actually has: the ones that take the next token as a
// value (`--summary <text>`), and the ones that stand alone (`--json`).
export type FlagSpec = {
  value?: readonly string[];
  boolean?: readonly string[];
};

// The tokens nobody consumed.
//
// `flagValue` reads by `indexOf`, so it can answer "what came after --summary?"
// but never "was there a token here I didn't look at?" — and that blind spot is
// how `foo asp event <packet> <type> <summary>` silently dropped the summary and
// committed `data: {}` to an append-only ledger (alpha_tester_fixes_v0 R-001).
// A command that writes something it cannot take back must be able to see what
// it did not read, so it can refuse instead of guess.
//
// A bare word in the result is a positional the caller meant as an argument; a
// `--x` in the result is a flag this command does not have. Both are surplus.
export function surplusArgs(args: string[], spec: FlagSpec): string[] {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const surplus: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (valueFlags.has(token)) {
      index += 1; // the next token belongs to this flag, whatever it looks like
      continue;
    }
    if (booleanFlags.has(token)) continue;
    surplus.push(token);
  }
  return surplus;
}
