// Prompt Redaction Safety V0 — T-001 (R-001): the deterministic secrets
// detection engine. Pure text-in / findings-out, offline, no I/O — the CLI owns
// file reading and directory walking so this module stays fixture-testable
// (same purity discipline as sourceIngress.ts).
//
// R-007 hardening: a finding is METADATA-ONLY. A detected secret value is never
// stored in a finding, returned, or logged — only its type, location, and
// length. Detection is in-memory; the value is matched and discarded.
//
// Recall bias (R-001): provider patterns catch known credentials at high
// confidence; an entropy backstop catches unknown-format secrets at low
// confidence (advisory). Precision is recovered via a human-curated allowlist
// (R-007: never auto-populated), not by raising thresholds.

export type Confidence = "high" | "medium" | "low";

// A finding carries no secret material — type, place, and size only.
export type Finding = {
  detector: string; // which rule fired, e.g. "aws_access_key_id"
  category: string; // coarse class, e.g. "cloud_credential" | "private_key" | "entropy"
  confidence: Confidence;
  line: number; // 1-based
  column: number; // 1-based, start of the match
  length: number; // length of the matched value (metadata, not the value)
  entropy?: number; // bits/char, present for entropy findings
};

export type ScanResult = {
  schema_version: "0.1";
  findings: Finding[];
  counts: { high: number; medium: number; low: number; total: number };
};

export type ScanOptions = {
  // Human-curated suppressions (R-007). Literal values and/or regexes; a match
  // on the detected value drops the finding. Never auto-populated from input.
  allowlist?: string[];
  allowlistPatterns?: RegExp[];
  // Minimum token length the entropy backstop will consider. Default 20.
  minEntropyLen?: number;
  // Named detection profiles to run (T-005). Default ["secrets"] — the only
  // profile active in v1. Adding a profile is a PROFILE_REGISTRY entry.
  profiles?: string[];
};

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

type PatternDetector = {
  detector: string;
  category: string;
  confidence: Confidence;
  regex: RegExp; // global; whole match is the secret span
  // Optional: refine confidence from the matched value (e.g. env assignments).
  refine?: (value: string) => Confidence | null; // null => drop (e.g. placeholder)
};

// Order is fixed for deterministic output. Provider patterns first (high
// confidence), then credentialed connection strings, then keyed assignments.
const SECRET_DETECTORS: PatternDetector[] = [
  {
    detector: "aws_access_key_id",
    category: "cloud_credential",
    confidence: "high",
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    detector: "github_token",
    category: "vcs_credential",
    confidence: "high",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
  },
  {
    detector: "github_pat",
    category: "vcs_credential",
    confidence: "high",
    regex: /\bgithub_pat_[A-Za-z0-9_]{59,}\b/g,
  },
  {
    detector: "slack_token",
    category: "saas_credential",
    confidence: "high",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    detector: "stripe_secret_key",
    category: "saas_credential",
    confidence: "high",
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    detector: "stripe_test_key",
    category: "saas_credential",
    confidence: "medium",
    regex: /\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b/g,
  },
  {
    detector: "gcp_api_key",
    category: "cloud_credential",
    confidence: "high",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    detector: "openai_key",
    category: "saas_credential",
    confidence: "medium",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    detector: "anthropic_key",
    category: "saas_credential",
    confidence: "high",
    // productfoo's OWN provider — must not be a blind spot. sk-ant-<kind><n>-<long body>.
    regex: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{24,}\b/g,
  },
  {
    detector: "azure_storage_key",
    category: "cloud_credential",
    confidence: "high",
    // The AccountKey of an Azure Storage connection string (base64, >= 80 chars).
    regex: /AccountKey=[A-Za-z0-9+/=]{80,}/g,
  },
  {
    detector: "gcp_service_account",
    category: "cloud_credential",
    confidence: "medium",
    // Marker for a GCP service-account key file; the embedded private key is caught
    // at high confidence by private_key_block (which also covers OPENSSH SSH keys).
    regex: /"type"\s*:\s*"service_account"/g,
  },
  {
    detector: "private_key_block",
    category: "private_key",
    confidence: "high",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    detector: "jwt",
    category: "token",
    confidence: "medium",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    detector: "db_connection_string",
    category: "connection_string",
    confidence: "high",
    // Only flags when credentials are embedded (user:password@host).
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/g,
  },
  {
    detector: "secret_assignment",
    category: "keyed_secret",
    confidence: "high",
    // KEY=VALUE / KEY: VALUE where the key name signals a secret. The whole
    // match is treated as the span; refine() reads the value for confidence.
    regex:
      /\b[\w.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|credential)[\w.-]*\s*[:=]\s*["']?([^"'\s#]{4,})["']?/gi,
    refine: (value: string) => (isPlaceholder(value) || !looksLikeSecretValue(value) ? null : "high"),
  },
];

// Obvious non-secrets in assignment values: template/placeholder text.
function isPlaceholder(value: string): boolean {
  return (
    /^[*x.\-_]+$/i.test(value) ||
    /^(changeme|change_me|placeholder|your[_-]?\w+|example|examplekey|todo|none|null|undefined|test|dummy|redacted)$/i.test(
      value,
    ) ||
    /^<.+>$/.test(value) ||
    /^\$\{?\w+\}?$/.test(value) // ${ENV_VAR} / $VAR interpolation
  );
}

// Per-character Shannon entropy (bits/char) over the token.
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Distinguish a literal secret value from a code reference. Real secrets are
// long, high-entropy, and contain a digit; identifiers, member access, and
// calls are rejected. The gate blocks high-confidence findings only, so the
// keyed-assignment detector must be precise — this kills source-code FPs like
// `authToken = req.headers` or `tokensPerCall = estimate`.
function looksLikeSecretValue(value: string): boolean {
  if (/[.()[\]{}<>]/.test(value)) return false; // code: a.b.c, getToken(, arr[1], <T>, {x}
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false; // need mixed alnum
  return value.length >= 12 && shannonEntropy(value) >= 3.4;
}

// Charset-aware entropy thresholds (detect-secrets defaults: 4.5 base64 / 3.0
// hex). Pure-numeric runs are treated as IDs, not secrets (false-positive cut).
function entropyFinding(token: string, minLen: number): { ok: boolean; entropy: number } {
  if (token.length < minLen) return { ok: false, entropy: 0 };
  if (/^[0-9]+$/.test(token)) return { ok: false, entropy: 0 };
  const entropy = shannonEntropy(token);
  if (/^[A-Fa-f0-9]+$/.test(token)) return { ok: entropy >= 3.0, entropy };
  if (/^[A-Za-z0-9+/=_-]+$/.test(token)) return { ok: entropy >= 4.5, entropy };
  return { ok: false, entropy };
}

type LineIndex = number[]; // offset of the start of each line

function lineStarts(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

// Map a 0-based string offset to a 1-based line/column.
function locate(starts: LineIndex, offset: number): { line: number; column: number } {
  // Binary search for the last line start <= offset.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

function isAllowed(value: string, opts: ScanOptions): boolean {
  if (opts.allowlist?.some((entry) => entry === value || value.includes(entry))) return true;
  if (opts.allowlistPatterns?.some((re) => re.test(value))) return true;
  return false;
}

// --- Detection profiles (T-005 / R-006) --------------------------------------
// A profile bundles pattern detectors and whether the entropy backstop runs.
// Adding coverage — internal infra, PII, sales-transcript — is a registry entry
// here, NOT an engine change. v1 runs only "secrets" by default.

// Opt-in seed profile: internal-infrastructure identifiers. Not active by
// default; medium confidence so it never gates. Exists to demonstrate that a
// new profile is purely a registry entry (and to seed the future infra pack).
const INTERNAL_DETECTORS: PatternDetector[] = [
  {
    detector: "private_ip",
    category: "internal_infra",
    confidence: "medium",
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    detector: "internal_hostname",
    category: "internal_infra",
    confidence: "medium",
    regex: /\b[a-z0-9][a-z0-9-]*\.(?:internal|local|corp|intranet)\b/gi,
  },
];

// --- The `pii` profile (feedback_triage_v0 T-001 / RISK-001) -----------------
// A feedback document is raw private material about a named person, and the
// engine could not touch it: `secrets` strips API keys, not a person's name,
// home path, employer, or machine. This profile is the prerequisite that lets
// feedback content be tracked at all.
//
// WHAT IT CAN AND CANNOT DO — read this before trusting it:
//
//   Reliable (high confidence, blocks): email addresses, home directory paths,
//   MAC addresses, and identity/employer fields that are LABELLED
//   ("Reporter: Jane Doe", "Employer: Acme Corp"). These have a syntax, so a
//   deterministic matcher can be precise about them.
//
//   Best-effort (medium confidence, redacted at the default threshold but never
//   blocking): device names, `.local` hostnames, install UUIDs, and employer
//   mentions in prose ("works at Acme Corp").
//
//   NOT DETECTED AT ALL: an arbitrary personal name in free prose. "I asked
//   Jordan and she agreed" is indistinguishable, by regex, from any other
//   capitalised word, and every generic name-matcher is either a name list
//   (fails on the name you have not listed) or a capitalised-token heuristic
//   that fires on every sentence start and product noun. Shipping either would
//   be the failure this repo keeps re-learning: a gate that fires on the shape
//   of a risk rather than the risk is one people override on sight. So this
//   profile catches names where they carry a marker — a field label, an email
//   local part, a home-path segment — and states plainly that free-prose names
//   are the caller's job (pass them via `allowlist`'s inverse: redact them
//   before handing text to the engine, or review the document).
//
// Consequence for callers: passing this profile is NOT proof a document is
// anonymous. It is proof the document carries no *machine-detectable* personal
// identifier. `foo self check` blocks on that, and says exactly that.

// Shared account names on shared machines — a home path under one of these
// identifies a CI runner, not a person. Precision, not a threshold change.
const IMPERSONAL_ACCOUNTS = new Set([
  "runner", "root", "admin", "administrator", "ubuntu", "ec2-user", "user", "username", "you", "vagrant", "docker", "node", "shared", "public", "default",
]);

// The trailing path segment of a home directory: /Users/<account>, /home/<account>.
function homeAccountOf(value: string): string {
  const parts = value.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

// A person's or company's name as written in a labelled field: one to four
// capitalised words. Deliberately strict — the label already carries the
// evidence, so the value only has to be name-SHAPED, not name-guessed.
const PROPER_NOUN = /^[A-Z][A-Za-z'’.-]*(?: (?:&|of|and|de|van|von|der|la|[A-Z][A-Za-z'’.,-]*)){0,3}$/;

function looksLikeProperNoun(value: string): boolean {
  const trimmed = value.trim().replace(/[.,;]$/, "");
  if (isPlaceholder(trimmed)) return false;
  return trimmed.length >= 2 && PROPER_NOUN.test(trimmed);
}

const PII_DETECTORS: PatternDetector[] = [
  {
    detector: "pii_email",
    category: "personal_contact",
    confidence: "high",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}\b/g,
  },
  {
    detector: "pii_home_path",
    category: "personal_path",
    confidence: "high",
    // The whole `/Users/<account>` prefix is the span; the rest of the path is
    // left intact so the document still reads. Group 1 == whole match so that
    // refine() can inspect the account without changing what gets replaced.
    regex: /((?:\/Users\/|\/home\/|\\Users\\|C:\\Users\\)[A-Za-z0-9._-]+)/g,
    refine: (value: string) => (IMPERSONAL_ACCOUNTS.has(homeAccountOf(value)) ? null : "high"),
  },
  {
    detector: "pii_identity_field",
    category: "personal_identity",
    confidence: "high",
    // A LABELLED name. The label is the evidence; the value must still be
    // name-shaped so a stray `name: foo` in YAML does not fire.
    regex: /\b(?:reporter|reported by|submitted by|filed by|author|full name|name|from|contact|signed)\s*[:=]\s*([^\n,;<(|]{2,60})/gi,
    refine: (value: string) => (looksLikeProperNoun(value) ? "high" : null),
  },
  {
    detector: "pii_employer",
    category: "employer",
    confidence: "high",
    regex: /\b(?:employer|company|organi[sz]ation|workplace)\s*[:=]\s*([^\n,;<(|]{2,60})/gi,
    refine: (value: string) => (looksLikeProperNoun(value) ? "high" : null),
  },
  {
    detector: "pii_employer_mention",
    category: "employer",
    confidence: "medium",
    // Best-effort: an employer named in prose. Medium, so it is redacted at the
    // default threshold but never blocks — the phrasing space is unbounded.
    regex: /\b(?:works? at|worked at|working at|employed by|employer is)\s+([A-Z][A-Za-z0-9&'’.-]*(?: [A-Z][A-Za-z0-9&'’.-]*){0,3})/g,
    refine: (value: string) => (looksLikeProperNoun(value) ? "medium" : null),
  },
  {
    detector: "pii_mac_address",
    category: "machine_id",
    confidence: "high",
    regex: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
  },
  {
    detector: "pii_device_name",
    category: "machine_id",
    confidence: "medium",
    // "Jordans-MacBook-Pro", "jvance-laptop.local" — a device name usually
    // carries its owner's name. Best-effort: naming conventions vary.
    // `.local` first so a full `host.local` is one span, not a device name with
    // a dangling suffix.
    regex: /\b[a-z0-9][a-z0-9-]*\.local\b|\b[A-Za-z0-9]+(?:['’]?s)?-(?:MacBook(?:-Pro|-Air)?|iMac|Mac-mini|Mac-Studio|Laptop|PC)\b/gi,
  },
  {
    detector: "pii_machine_uuid",
    category: "machine_id",
    confidence: "medium",
    // Hardware/install UUID. Medium: a UUID is also a perfectly ordinary
    // record id, so this informs redaction without gating a commit.
    regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
];

type Profile = { name: string; detectors: PatternDetector[]; entropyBackstop: boolean };

const PROFILE_REGISTRY: Record<string, Profile> = {
  secrets: { name: "secrets", detectors: SECRET_DETECTORS, entropyBackstop: true },
  internal: { name: "internal", detectors: INTERNAL_DETECTORS, entropyBackstop: false },
  pii: { name: "pii", detectors: PII_DETECTORS, entropyBackstop: false },
};

// The profile that governs personal material in feedback content (RISK-001).
export const PII_PROFILE = "pii";

// Only "secrets" runs unless the caller opts into more (R-006: secrets-first v1).
export const DEFAULT_PROFILES = ["secrets"];

export function knownProfiles(): string[] {
  return Object.keys(PROFILE_REGISTRY);
}

function resolveProfiles(names: string[]): Profile[] {
  return names.map((name) => {
    const profile = PROFILE_REGISTRY[name];
    if (!profile) throw new Error(`unknown redaction profile: ${name} (known: ${knownProfiles().join(", ")})`);
    return profile;
  });
}

// A detection with raw string offsets — the shared core for both scanText (a
// line/column view) and redactText (span replacement). Keeping one code path
// means scan and redact can never disagree about what is a secret.
type RawFinding = {
  detector: string;
  category: string;
  confidence: Confidence;
  offset: number; // 0-based start of the value to redact
  length: number;
  entropy?: number;
};

// Deterministic: same input + options => identical detections, ordered by
// offset then detector.
function detect(text: string, options: ScanOptions = {}): RawFinding[] {
  const opts: ScanOptions = { minEntropyLen: 20, ...options };
  const profiles = resolveProfiles(opts.profiles ?? DEFAULT_PROFILES);
  const detectors = profiles.flatMap((p) => p.detectors);
  const runEntropy = profiles.some((p) => p.entropyBackstop);
  const raw: RawFinding[] = [];
  const covered: Array<[number, number]> = []; // [start, end) offsets already claimed

  // Inline allow pragma (OQ2): a line containing `foo-redact: allow` suppresses
  // findings on that line — for deliberate fixtures/examples. Pairs with the
  // repo allowlist file. Human-authored only (R-007).
  const starts = lineStarts(text);
  const pragmaLines = new Set<number>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (/foo-redact:\s*allow/i.test(line)) pragmaLines.add(i + 1);
  });
  const pragmaAllowed = (offset: number) => pragmaLines.has(locate(starts, offset).line);

  for (const det of detectors) {
    for (const match of text.matchAll(det.regex)) {
      const whole = match[0];
      const start = match.index ?? 0;
      // For keyed assignments, the secret of interest is the captured value.
      const value = det.refine ? (match[1] ?? whole) : whole;
      let confidence: Confidence = det.confidence;
      if (det.refine) {
        const refined = det.refine(value);
        if (refined === null) continue; // placeholder => not a secret
        confidence = refined;
      }
      const valueStart = det.refine ? start + whole.indexOf(value) : start;
      if (isAllowed(value, opts) || pragmaAllowed(valueStart)) continue;
      raw.push({ detector: det.detector, category: det.category, confidence, offset: valueStart, length: value.length });
      covered.push([start, start + whole.length]);
    }
  }

  // Entropy backstop over long tokens not already claimed by a pattern. Runs
  // only for profiles that enable it (the secrets profile).
  if (runEntropy) {
    for (const match of text.matchAll(/[A-Za-z0-9+/=_-]{12,}/g)) {
      const token = match[0];
      const start = match.index ?? 0;
      const end = start + token.length;
      if (covered.some(([cs, ce]) => start < ce && end > cs)) continue;
      if (isAllowed(token, opts) || pragmaAllowed(start)) continue;
      const { ok, entropy } = entropyFinding(token, opts.minEntropyLen ?? 20);
      if (!ok) continue;
      // Advisory only — the gate (T-003) blocks high-confidence findings.
      raw.push({ detector: "high_entropy_string", category: "entropy", confidence: "low", offset: start, length: token.length, entropy: Math.round(entropy * 100) / 100 });
    }
  }

  raw.sort((a, b) => a.offset - b.offset || a.detector.localeCompare(b.detector));

  // Dedupe detections starting at the same offset (e.g. a keyed assignment and
  // a provider pattern over the same value), keeping the highest confidence.
  const deduped: RawFinding[] = [];
  for (const f of raw) {
    const prior = deduped[deduped.length - 1];
    if (prior && prior.offset === f.offset) {
      if (CONFIDENCE_RANK[f.confidence] > CONFIDENCE_RANK[prior.confidence]) deduped[deduped.length - 1] = f;
      continue;
    }
    deduped.push(f);
  }
  return deduped;
}

// Scan a single text blob and return metadata-only findings (R-007).
export function scanText(text: string, options: ScanOptions = {}): ScanResult {
  const starts = lineStarts(text);
  const findings: Finding[] = detect(text, options).map((r) => {
    const { line, column } = locate(starts, r.offset);
    const finding: Finding = { detector: r.detector, category: r.category, confidence: r.confidence, line, column, length: r.length };
    if (r.entropy !== undefined) finding.entropy = r.entropy;
    return finding;
  });
  const counts = {
    high: findings.filter((f) => f.confidence === "high").length,
    medium: findings.filter((f) => f.confidence === "medium").length,
    low: findings.filter((f) => f.confidence === "low").length,
    total: findings.length,
  };
  return { schema_version: "0.1", findings, counts };
}

// Parse an allowlist file: one literal value per line, `#` comments and blank
// lines ignored. Human-curated trusted config (R-007).
export function parseAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// --- Redaction (T-002 / R-002, R-003) ----------------------------------------

export type RedactThreshold = Confidence;

// Metadata-only (R-007): the receipt records what was redacted and what was
// kept-and-why — never a secret value. `placeholders` are the typed tokens
// emitted; `kept` are sub-threshold findings surfaced for human review.
export type RedactionReceipt = {
  schema_version: "0.1";
  redactions: number; // occurrences replaced (a repeated value counts each time)
  by_type: Record<string, number>;
  by_confidence: { high: number; medium: number; low: number };
  placeholders: string[];
  kept: Array<{ detector: string; confidence: Confidence; line: number; column: number; reason: string }>;
};

export type RedactionResult = { redactedText: string; receipt: RedactionReceipt };

export type RedactOptions = ScanOptions & {
  // Minimum confidence to redact. Default "medium": high+medium are replaced;
  // low-confidence (entropy) hits are reported in `kept` for human review.
  threshold?: RedactThreshold;
};

// Replace detected secrets with typed, consistent, irreversible placeholders.
// Same value => same token within the document (readability + diff stability).
// No value->token map is persisted (D-004): the mapping lives only for this
// call and is discarded on return, so redaction cannot be reversed.
export function redactText(text: string, options: RedactOptions = {}): RedactionResult {
  const threshold: RedactThreshold = options.threshold ?? "medium";
  const minRank = CONFIDENCE_RANK[threshold];
  const starts = lineStarts(text);
  const raw = detect(text, options);

  const tokens = new Map<string, string>(); // value -> consistent placeholder (in-memory only)
  const perType = new Map<string, number>();
  const tokenFor = (detector: string, value: string): string => {
    const existing = tokens.get(value);
    if (existing) return existing;
    const n = (perType.get(detector) ?? 0) + 1;
    perType.set(detector, n);
    const token = `[${detector.toUpperCase()}_${n}]`;
    tokens.set(value, token);
    return token;
  };

  const by_type: Record<string, number> = {};
  const by_confidence = { high: 0, medium: 0, low: 0 };
  const placeholders = new Set<string>();
  const kept: RedactionReceipt["kept"] = [];

  let out = "";
  let cursor = 0;
  let redactions = 0;
  for (const f of raw) {
    if (f.offset < cursor) continue; // overlap guard
    if (CONFIDENCE_RANK[f.confidence] < minRank) {
      const { line, column } = locate(starts, f.offset);
      kept.push({ detector: f.detector, confidence: f.confidence, line, column, reason: `below redaction threshold (${threshold})` });
      continue;
    }
    const value = text.slice(f.offset, f.offset + f.length);
    const token = tokenFor(f.detector, value);
    out += text.slice(cursor, f.offset) + token;
    cursor = f.offset + f.length;
    redactions += 1;
    by_type[f.detector] = (by_type[f.detector] ?? 0) + 1;
    by_confidence[f.confidence] += 1;
    placeholders.add(token);
  }
  out += text.slice(cursor);

  return {
    redactedText: out,
    receipt: {
      schema_version: "0.1",
      redactions,
      by_type,
      by_confidence,
      placeholders: [...placeholders].sort(),
      kept,
    },
  };
}
