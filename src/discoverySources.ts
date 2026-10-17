export type DiscoveryCapabilities = {
  list_sessions: boolean;
  open_transcript: boolean;
  stable_link: boolean;
  timestamps: boolean;
};

export type DiscoveryAccess = "available" | "denied" | "unknown";
export type DiscoveryCompletionState = "completed" | "in_progress" | "scheduled" | "cancelled";

// Contact hints (discovery-contact-capture-v0 R-003): identity the provider's
// own session metadata already states — display names, company from an email
// DOMAIN, a provider-carried title or LinkedIn URL. Hints become contact-card
// CANDIDATES for a person to confirm; they are never confirmed identity. The
// raw email address itself must die inside the adapter (R-004): a hint value
// containing an email is refused by validation below.
export type ContactHintField = "full_name" | "company" | "title" | "linkedin";
export type SessionContactHint = { field: ContactHintField; value: string; source: string };

export type DiscoverySession = {
  schema_version: "0.1";
  provider: string;
  connection_alias: string;
  runtime_handle: string;
  completed_at: string;
  completion_state: DiscoveryCompletionState;
  title: string;
  participants: string[];
  stable_url?: string;
  capabilities: DiscoveryCapabilities;
  access: DiscoveryAccess;
  contact_hints?: SessionContactHint[];
};

export interface DiscoverySourceAdapter<TRaw> {
  provider: string;
  normalizeSession(raw: TRaw, connectionAlias: string): DiscoverySession;
}

const PROVIDER_HOSTS: Record<string, string[]> = {
  // notes.granola.ai is Granola's share-link host — the owner pastes exactly these
  // (customer-signal-inbox-v0: its absence forced source_url null across the whole
  // first batch and refused an owner-approved ingestion).
  granola: ["app.granola.ai", "granola.ai", "notes.granola.ai"],
  fakecalls: ["review.fakecalls.test"],
  // Fireflies transcript links are believed path-based under fireflies.ai
  // (fireflies-discovery-connector-v0 R-006 — belief owned by the packet's
  // feasibility task): the global no-query rule applies, so hosts alone are
  // declared and no ProviderLinkForm is needed.
  fireflies: ["app.fireflies.ai", "fireflies.ai"],
  // notion-discovery-connector-v0 R-006: Notion's canonical page form is
  // https://www.notion.so/<page-id> — no query string. The global no-query rule
  // is what refuses tokenized share links (they carry query parameters); the
  // V0 stance is refuse, never de-tokenize, until the feasibility task (T-001)
  // verifies the exact link semantics.
  notion: ["notion.so", "www.notion.so"],
};

// Provider-declared canonical link forms (gong-discovery-connector-v0 R-006).
// The global rule stays "no query string". A provider whose only stable link
// carries the record identifier as a query parameter declares exactly that
// form here — hosts, one exact path, one parameter name, one identifier
// shape — and a URL that does not match the declared form is refused, never
// partially cleaned. Providers without a form keep the global rule unchanged.
export type ProviderLinkForm = {
  hosts: string[];
  // One extra leading label is allowed in front of this suffix (a company
  // subdomain); deeper nesting is refused.
  host_suffix?: string;
  path: string;
  query: { name: string; pattern: RegExp };
};

const PROVIDER_LINK_FORMS: Record<string, ProviderLinkForm> = {
  // Belief, owned by the packet's feasibility task: Gong links a call as
  // https://app.gong.io/call?id=<call-id> (or under a company subdomain).
  gong: { hosts: ["app.gong.io"], host_suffix: ".app.gong.io", path: "/call", query: { name: "id", pattern: /^[A-Za-z0-9_-]{4,64}$/ } },
  // Microsoft Teams declares NO host and NO link form yet
  // (microsoft-teams-discovery-connector-v0 R-006): Graph join URLs are
  // tokenized and are never stable links, and the canonical meeting/recording
  // link form is owned by the packet's feasibility task. Until that task
  // verifies a form, every Teams URL is refused here — never cleaned — and
  // the adapter reports stable_link: false. Other providers stay unchanged.
};

// Path-based canonical links on a per-workspace subdomain
// (zendesk-discovery-connector-v0 R-006): the host is exactly one subdomain
// label plus the declared suffix, the path is the declared canonical form,
// and the global no-query/no-fragment rules apply unchanged — a tokenized or
// authenticated link is refused, never cleaned. Providers without an entry
// keep the exact-host rule byte-for-byte.
const PROVIDER_PATH_FORMS: Record<string, { suffix: string; path: RegExp }> = {
  // Belief, owned by the packet's feasibility task: Zendesk links a ticket as
  // https://<subdomain>.zendesk.com/agent/tickets/<numeric-id>.
  zendesk: { suffix: ".zendesk.com", path: /^\/agent\/tickets\/\d+$/ },
  // Belief, owned by the packet's feasibility task (T-001): Zoom links a
  // recording as https://<subdomain>.zoom.us/recording/<id>. Because the
  // canonical form carries the identifier in the path and needs no query
  // parameter, Zoom declares no `ProviderLinkForm`; tokenized variants
  // (`/rec/share/...`, `?pwd=`, `?access_token=`) match no rule and are
  // refused, never cleaned.
  zoom: { suffix: ".zoom.us", path: /^\/recording\/[A-Za-z0-9_-]{16,128}$/ },
};

// Path-based canonical links on a per-workspace subdomain
// (zendesk-discovery-connector-v0 R-006): the host is exactly one subdomain
// label plus the declared suffix, the path is the declared canonical form,
// and the global no-query/no-fragment rules apply unchanged — a tokenized or
// authenticated link is refused, never cleaned. Providers without an entry
// keep the exact-host rule byte-for-byte.

export function providerLinkForm(provider: string): ProviderLinkForm | undefined {
  return PROVIDER_LINK_FORMS[provider.toLowerCase()];
}

// A provider whose canonical link carries its identifiers in the PATH rather
// than a query parameter (Slack's /archives/<channel>/p<ts> permalink) declares
// a path template instead: each `<placeholder>` occupies one path segment and
// must match its declared pattern, and the canonical URL is rebuilt from the
// captures — anything else is refused, never partially cleaned
// (slack-discovery-connector-v0 R-006).
export type ProviderPathTemplateForm = {
  hosts: string[];
  host_suffix?: string;
  template: string;
  placeholders: Record<string, RegExp>;
};

const PROVIDER_PATH_TEMPLATE_FORMS: Record<string, ProviderPathTemplateForm> = {
  // Belief, owned by the packet's feasibility task: Slack permalinks are
  // https://<workspace>.slack.com/archives/<channel>/p<ts> where the ts is the
  // message timestamp with the dot removed — a 10-digit epoch second plus a
  // 6-digit microsecond field, 16 digits total. The path-template grammar
  // matches whole segments only, so the `p` prefix lives inside the
  // placeholder's own pattern.
  slack: { hosts: ["slack.com"], host_suffix: ".slack.com", template: "/archives/<channel>/<permalink_ts>", placeholders: { channel: /^C[A-Za-z0-9]{8,}$/, permalink_ts: /^p\d{16}$/ } },
};

const PATH_PLACEHOLDER = /^<(\w+)>$/;

function sanitizeDeclaredPathTemplateForm(provider: string, url: URL, form: ProviderPathTemplateForm): string {
  const host = url.hostname.toLowerCase();
  const hostOk =
    form.hosts.includes(host) ||
    (form.host_suffix !== undefined && host.endsWith(form.host_suffix) && /^[a-z0-9-]+$/.test(host.slice(0, -form.host_suffix.length)));
  if (!hostOk) throw new Error(`stable URL must use an approved host for ${provider}`);
  if (url.hash) throw new Error("stable URL must not contain a fragment");
  if (url.search) throw new Error(`stable URL must not carry a query string for ${provider}`);
  const templateSegments = form.template.split("/").filter(Boolean);
  const actualSegments = url.pathname.split("/").filter(Boolean);
  if (templateSegments.length !== actualSegments.length) throw new Error(`stable URL must use the canonical ${provider} path`);
  const captured: Record<string, string> = {};
  for (const [index, segment] of templateSegments.entries()) {
    const placeholder = PATH_PLACEHOLDER.exec(segment);
    if (!placeholder) {
      if (segment !== actualSegments[index]) throw new Error(`stable URL must use the canonical ${provider} path`);
      continue;
    }
    const pattern = form.placeholders[placeholder[1]];
    if (!pattern || !pattern.test(actualSegments[index])) throw new Error(`stable URL ${placeholder[1]} does not look like a ${provider} identifier`);
    captured[placeholder[1]] = actualSegments[index];
  }
  const rebuilt = templateSegments.map((segment) => {
    const placeholder = PATH_PLACEHOLDER.exec(segment);
    return placeholder ? captured[placeholder[1]!] : segment;
  }).join("/");
  return `https://${host}/${rebuilt}`;
}

function sanitizeDeclaredLinkForm(provider: string, url: URL, form: ProviderLinkForm): string {
  const host = url.hostname.toLowerCase();
  const hostOk =
    form.hosts.includes(host) ||
    (form.host_suffix !== undefined && host.endsWith(form.host_suffix) && /^[a-z0-9-]+$/.test(host.slice(0, -form.host_suffix.length)));
  if (!hostOk) throw new Error(`stable URL must use an approved host for ${provider}`);
  if (url.hash) throw new Error("stable URL must not contain a fragment");
  if (url.pathname !== form.path) throw new Error(`stable URL must use the canonical ${provider} path`);
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0][0] !== form.query.name) throw new Error(`stable URL must carry exactly the ${form.query.name} parameter for ${provider}`);
  const id = params[0][1];
  if (!form.query.pattern.test(id)) throw new Error(`stable URL ${form.query.name} does not look like a ${provider} identifier`);
  return `https://${host}${form.path}?${form.query.name}=${id}`;
}

export function sanitizeDiscoveryStableUrl(provider: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("stable URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("stable URL must use HTTPS");
  if (url.username || url.password) throw new Error("stable URL must not contain credentials");
  const templateForm = PROVIDER_PATH_TEMPLATE_FORMS[provider.toLowerCase()];
  if (templateForm) return sanitizeDeclaredPathTemplateForm(provider, url, templateForm);
  const form = PROVIDER_LINK_FORMS[provider.toLowerCase()];
  if (form) return sanitizeDeclaredLinkForm(provider, url, form);
  if (url.search) throw new Error("stable URL must not contain a query string");
  if (url.hash) throw new Error("stable URL must not contain a fragment");
  const pathForm = PROVIDER_PATH_FORMS[provider.toLowerCase()];
  if (pathForm) {
    const host = url.hostname.toLowerCase();
    const hostOk = host.endsWith(pathForm.suffix) && /^[a-z0-9-]+$/.test(host.slice(0, -pathForm.suffix.length));
    if (!hostOk) throw new Error(`stable URL must use an approved host for ${provider}`);
    if (!pathForm.path.test(url.pathname)) throw new Error(`stable URL must use the canonical ${provider} path`);
    return url.toString();
  }
  const approved = PROVIDER_HOSTS[provider.toLowerCase()];
  if (!approved || !approved.includes(url.hostname.toLowerCase())) throw new Error(`stable URL must use an approved host for ${provider}`);
  return url.toString();
}

export function isValidLinkedinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"));
  } catch {
    return false;
  }
}

const EMAIL_SHAPE = /[\w.+-]+@[\w-]+\.[\w.-]+/;

// Domains where the mailbox says nothing about the company. Deriving "Gmail"
// as an employer is noise, not a candidate.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "fastmail.com", "hey.com", "gmx.com", "zoho.com",
]);

// R-004: the email-privacy rule. The company is derived from the DOMAIN and the
// address itself is discarded here, before any hint exists — a raw attendee
// email must never persist in a committed file. Free-mail domains yield null.
export function companyFromEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return null;
  const base = domain.split(".")[0];
  if (!base || /^\d+$/.test(base)) return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Parses a provider display label. "Chris Exampleton from Exampleton Brothers"
// yields the name AND the company; a plain capitalized person name yields the
// name; an email-shaped or unrecognized label yields nothing — conservative on
// purpose, because every hint is a suggestion a person will read.
const DISPLAY_NAME = /^([A-Z][a-zA-Z'’.-]*(?: [A-Z][a-zA-Z'’.-]*)+)$/;
const DISPLAY_NAME_WITH_COMPANY = /^([A-Z][a-zA-Z'’.-]*(?: [A-Z][a-zA-Z'’.-]*)+)\s+(?:from|of|at)\s+([A-Z][A-Za-z0-9&.'’-]*(?: [A-Z][A-Za-z0-9&.'’-]*){0,3})$/;

export function contactHintsFromDisplayLabel(label: string, source: string): SessionContactHint[] {
  const trimmed = label.trim();
  if (!trimmed || EMAIL_SHAPE.test(trimmed)) return [];
  const withCompany = DISPLAY_NAME_WITH_COMPANY.exec(trimmed);
  if (withCompany) {
    return [
      { field: "full_name", value: withCompany[1], source },
      { field: "company", value: withCompany[2].replace(/[.,;:]$/, ""), source },
    ];
  }
  const plain = DISPLAY_NAME.exec(trimmed);
  return plain ? [{ field: "full_name", value: plain[1], source }] : [];
}

export function dedupeContactHints(hints: SessionContactHint[]): SessionContactHint[] {
  const seen = new Set<string>();
  const out: SessionContactHint[] = [];
  for (const hint of hints) {
    const key = `${hint.field}:${hint.value.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hint);
  }
  return out;
}

export function adapterCapabilityState(capabilities: DiscoveryCapabilities): "needs_provider_connector" | "ready_with_coverage_caveat" | "ready" {
  if (!capabilities.list_sessions || !capabilities.open_transcript) return "needs_provider_connector";
  if (!capabilities.stable_link || !capabilities.timestamps) return "ready_with_coverage_caveat";
  return "ready";
}

export function validateNormalizedSession(session: DiscoverySession): string[] {
  const errors: string[] = [];
  if (session.schema_version !== "0.1") errors.push("schema_version must be 0.1");
  if (!session.provider?.trim()) errors.push("provider is required");
  if (!session.connection_alias?.trim()) errors.push("connection_alias is required");
  if (!session.runtime_handle?.trim()) errors.push("runtime_handle is required in private runtime memory");
  if (session.completion_state !== "completed") errors.push("completion_state must be completed");
  if (!session.title?.trim()) errors.push("title is required");
  if (!Array.isArray(session.participants)) errors.push("participants must be an array");
  if (!Number.isFinite(Date.parse(session.completed_at))) errors.push("completed_at must be an ISO timestamp");
  if (session.stable_url) {
    try {
      sanitizeDiscoveryStableUrl(session.provider, session.stable_url);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "invalid stable URL");
    }
  }
  if (session.contact_hints !== undefined) {
    if (!Array.isArray(session.contact_hints)) errors.push("contact_hints must be an array");
    else {
      for (const [index, hint] of session.contact_hints.entries()) {
        const label = `contact hint ${index + 1}`;
        if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
          errors.push(`${label} must be an object`);
          continue;
        }
        if (hint.field !== "full_name" && hint.field !== "company" && hint.field !== "title" && hint.field !== "linkedin") errors.push(`${label}: invalid field`);
        if (typeof hint.value !== "string" || !hint.value.trim()) errors.push(`${label}: value is required`);
        else if (EMAIL_SHAPE.test(hint.value)) errors.push(`${label}: value must not contain an email address — derive the company from the domain and keep the address out`);
        else if (hint.field === "linkedin" && !isValidLinkedinUrl(hint.value)) errors.push(`${label}: linkedin value must be an https linkedin.com URL`);
        if (typeof hint.source !== "string" || !hint.source.trim()) errors.push(`${label}: source is required`);
      }
    }
  }
  return errors;
}

const NORMALIZED_SESSION_KEYS = new Set([
  "schema_version",
  "provider",
  "connection_alias",
  "runtime_handle",
  "completed_at",
  "completion_state",
  "title",
  "participants",
  "stable_url",
  "capabilities",
  "access",
  "contact_hints",
]);
const CAPABILITY_KEYS = new Set(["list_sessions", "open_transcript", "stable_link", "timestamps"]);
const CONTACT_HINT_KEYS = new Set(["field", "value", "source"]);

export function assertNormalizedSessionShape(value: unknown): asserts value is DiscoverySession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session metadata must be an object");
  const session = value as Record<string, unknown>;
  for (const key of Object.keys(session)) {
    if (!NORMALIZED_SESSION_KEYS.has(key)) throw new Error(`session metadata contains forbidden or unknown field ${key}`);
  }
  if (!session.capabilities || typeof session.capabilities !== "object" || Array.isArray(session.capabilities)) throw new Error("session capabilities must be an object");
  for (const key of Object.keys(session.capabilities as Record<string, unknown>)) {
    if (!CAPABILITY_KEYS.has(key)) throw new Error(`session capabilities contain unknown field ${key}`);
  }
  if (session.contact_hints !== undefined) {
    if (!Array.isArray(session.contact_hints)) throw new Error("session contact_hints must be an array");
    for (const hint of session.contact_hints) {
      if (!hint || typeof hint !== "object" || Array.isArray(hint)) throw new Error("session contact hints must be objects");
      for (const key of Object.keys(hint as Record<string, unknown>)) {
        if (!CONTACT_HINT_KEYS.has(key)) throw new Error(`session contact hint contains forbidden or unknown field ${key}`);
      }
    }
  }
  const errors = validateNormalizedSession(session as DiscoverySession);
  if (errors.length) throw new Error(`invalid normalized session metadata: ${errors.join("; ")}`);
}
