import {
  companyFromEmailDomain,
  contactHintsFromDisplayLabel,
  dedupeContactHints,
  isValidLinkedinUrl,
  sanitizeDiscoveryStableUrl,
  type DiscoverySession,
  type DiscoverySourceAdapter,
  type SessionContactHint,
} from "./discoverySources.js";

export type GranolaMeetingRecord = {
  id: string;
  title: string;
  datetime: string;
  attendees?: Array<{ name?: string; email?: string; company?: string; title?: string; linkedin?: string }>;
  url?: string;
  status?: string;
  // Observed per connection by the runtime that listed the note — never
  // assumed (nango-discovery-connector-v0 R-004, the Gong L173 treatment).
  // Absent means "not granted" (fail-closed), so a fixture cannot manufacture
  // transcript access.
  transcript_access?: "granted" | "missing";
};

const GRANOLA_MEETING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function granolaStableUrl(raw: GranolaMeetingRecord): string | undefined {
  if (raw.url) return sanitizeDiscoveryStableUrl("granola", raw.url);
  if (!GRANOLA_MEETING_UUID.test(raw.id)) return undefined;
  return sanitizeDiscoveryStableUrl("granola", `https://notes.granola.ai/d/${raw.id}`);
}

// Contact capture at ingest (discovery-contact-capture-v0 R-003/R-004): the
// provider's own attendee metadata seeds contact-card candidates instead of
// being discarded. Display strings yield name (+company); the email DOMAIN
// yields the company and the raw address is discarded right here — it never
// enters the normalized session; title and LinkedIn ride only when the payload
// actually carries them.
function granolaContactHints(raw: GranolaMeetingRecord): SessionContactHint[] | undefined {
  const hints: SessionContactHint[] = [];
  for (const attendee of raw.attendees ?? []) {
    const name = attendee.name?.trim();
    if (name) hints.push(...contactHintsFromDisplayLabel(name, "granola:attendee"));
    const email = attendee.email?.trim();
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "granola:attendee_email_domain" });
    }
    const company = attendee.company?.trim();
    if (company) hints.push({ field: "company", value: company, source: "granola:attendee" });
    const title = attendee.title?.trim();
    if (title) hints.push({ field: "title", value: title, source: "granola:attendee" });
    const linkedin = attendee.linkedin?.trim();
    if (linkedin && isValidLinkedinUrl(linkedin)) hints.push({ field: "linkedin", value: linkedin, source: "granola:attendee" });
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

export const granolaDiscoveryAdapter: DiscoverySourceAdapter<GranolaMeetingRecord> = {
  provider: "granola",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = granolaContactHints(raw);
    const stableUrl = granolaStableUrl(raw);
    return {
      schema_version: "0.1",
      provider: "granola",
      connection_alias: connectionAlias,
      runtime_handle: raw.id,
      completed_at: new Date(raw.datetime).toISOString(),
      completion_state: raw.status === "completed" ? "completed" : "in_progress",
      title: raw.title.trim(),
      participants: (raw.attendees ?? []).map((attendee) => attendee.name?.trim() ?? "").filter(Boolean),
      stable_url: stableUrl,
      // open_transcript is observed, not assumed (R-004): a note without an
      // observed transcript grant normalizes with open_transcript: false, and
      // the readiness operation is where the needs_provider_access stop lives.
      capabilities: { list_sessions: true, open_transcript: raw.transcript_access === "granted", stable_link: Boolean(stableUrl), timestamps: true },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

// Gong (gong-discovery-connector-v0 T-003). Contract-only: this adapter proves
// normalization against a synthetic call fixture; it claims nothing about
// authentication, listing, transcript access, or live support. Raw Gong keys
// (parties, speaker ids, CRM context, cursors) stay inside this module.
export type GongCallRecord = {
  id: string;
  title: string;
  started: string;
  ended?: string;
  duration_seconds?: number;
  state?: string;
  url?: string;
  parties?: Array<{ name?: string; email?: string; title?: string; affiliation?: string; speaker_id?: string }>;
  // Observed per connection and grant by the runtime that listed the call —
  // never assumed. Absent means "not granted" (fail-closed), so a fixture
  // cannot manufacture transcript access.
  transcript_access?: "granted" | "missing";
};

const GONG_CALL_ID = /^[A-Za-z0-9_-]{4,64}$/;

function gongStableUrl(raw: GongCallRecord): string | undefined {
  if (raw.url) return sanitizeDiscoveryStableUrl("gong", raw.url);
  if (!GONG_CALL_ID.test(raw.id)) return undefined;
  return sanitizeDiscoveryStableUrl("gong", `https://app.gong.io/call?id=${raw.id}`);
}

function gongCompletedAt(raw: GongCallRecord): string {
  if (raw.ended) return new Date(raw.ended).toISOString();
  const started = new Date(raw.started).getTime();
  const duration = Number.isFinite(raw.duration_seconds) ? Number(raw.duration_seconds) * 1000 : 0;
  return new Date(started + duration).toISOString();
}

// Contact hints follow the Granola discipline (discovery-contact-capture-v0
// R-003/R-004) with one Gong-specific rule: a party the provider marks as
// internal is the company's own rep, not a customer contact candidate, so it
// contributes no hint. Everyone still appears in `participants` for matching.
function gongContactHints(raw: GongCallRecord): SessionContactHint[] | undefined {
  const hints: SessionContactHint[] = [];
  for (const party of raw.parties ?? []) {
    if (party.affiliation?.trim().toLowerCase() === "internal") continue;
    const name = party.name?.trim();
    if (name) hints.push(...contactHintsFromDisplayLabel(name, "gong:party"));
    const email = party.email?.trim();
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "gong:party_email_domain" });
    }
    const title = party.title?.trim();
    if (title) hints.push({ field: "title", value: title, source: "gong:party" });
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

// Participant labels are party display names plus, for each external party
// with an address, a domain-only label ("@exampletonbros.example"). The domain label
// is what an inbox scope's domain_allowlist selects on; the local part of the
// address is discarded here and never leaves the adapter (R-004/R-005).
function gongParticipantLabels(raw: GongCallRecord): string[] {
  const labels: string[] = [];
  for (const party of raw.parties ?? []) {
    const name = party.name?.trim();
    if (name) labels.push(name);
    if (party.affiliation?.trim().toLowerCase() === "internal") continue;
    const email = party.email?.trim().toLowerCase();
    const at = email ? email.lastIndexOf("@") : -1;
    if (email && at > 0 && at < email.length - 1) labels.push(`@${email.slice(at + 1)}`);
  }
  return [...new Set(labels)];
}

export const gongDiscoveryAdapter: DiscoverySourceAdapter<GongCallRecord> = {
  provider: "gong",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = gongContactHints(raw);
    const stableUrl = gongStableUrl(raw);
    return {
      schema_version: "0.1",
      provider: "gong",
      connection_alias: connectionAlias,
      runtime_handle: raw.id,
      completed_at: gongCompletedAt(raw),
      completion_state: raw.state === "completed" ? "completed" : "in_progress",
      title: raw.title.trim(),
      participants: gongParticipantLabels(raw),
      stable_url: stableUrl,
      // timestamps: Gong transcript sentences carry millisecond offsets, so
      // envelope locators can cite them. open_transcript is observed, not
      // assumed (R-005).
      capabilities: { list_sessions: true, open_transcript: raw.transcript_access === "granted", stable_link: Boolean(stableUrl), timestamps: true },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

// Fireflies (fireflies-discovery-connector-v0 T-003). Contract-only: this
// adapter proves normalization against a synthetic transcript fixture; it
// claims nothing about authentication, listing, transcript access, or live
// support. Raw Fireflies keys (speaker emails, transcript ids) stay inside
// this module. The shape is the packet contract's pinned raw input.
export type FirefliesTranscriptRecord = {
  id: string;
  title: string;
  started_at: string;
  ended?: string;
  status?: string;
  participants?: Array<{ display_name?: string; email?: string }>;
  url?: string;
  // Observed per connection and grant by the runtime that listed the
  // transcript — never assumed. Absent means "not granted" (fail-closed), so
  // a fixture cannot manufacture transcript access (R-005).
  transcript_access?: "granted" | "missing";
};

const FIREFLIES_TRANSCRIPT_ID = /^[A-Za-z0-9_-]{8,64}$/;

function firefliesStableUrl(raw: FirefliesTranscriptRecord): string | undefined {
  if (raw.url) return sanitizeDiscoveryStableUrl("fireflies", raw.url);
  if (!FIREFLIES_TRANSCRIPT_ID.test(raw.id)) return undefined;
  // Belief, owned by the packet's feasibility task (T-001): Fireflies links a
  // transcript as a path under app.fireflies.ai.
  return sanitizeDiscoveryStableUrl("fireflies", `https://app.fireflies.ai/transcript/${raw.id}`);
}

// The distinct email domains the transcript's own participant metadata
// carries. OQ-002: Fireflies' role attribution (internal/external) is
// unverified, so externality derives from email domains only.
function firefliesParticipantDomains(raw: FirefliesTranscriptRecord): string[] {
  const domains = new Set<string>();
  for (const participant of raw.participants ?? []) {
    const email = participant.email?.trim().toLowerCase();
    const at = email ? email.lastIndexOf("@") : -1;
    if (email && at > 0 && at < email.length - 1) domains.add(email.slice(at + 1));
  }
  return [...domains];
}

// A transcript with every identified participant on ONE shared domain shows no
// external party by domain — the only internal signal the email-domain rule
// (OQ-002) can support — and is excluded by default. A transcript whose
// participants carry no emails, or whose emails span domains, is not excluded
// here; the scope's selectors still have to admit it. Domain-only labels and
// the internal-only rule are re-derived by the worker from this helper.
export function firefliesInternalOnly(raw: FirefliesTranscriptRecord): boolean {
  const domains = firefliesParticipantDomains(raw);
  return domains.length === 1;
}

// Contact hints follow the Granola discipline (discovery-contact-capture-v0
// R-003/R-004). Without provider-declared affiliation (OQ-002) a mixed-domain
// transcript cannot attribute internality per participant, so every emailed
// participant contributes a DOMAIN-ONLY company hint and every well-formed
// display name a full_name hint — candidates for a person to confirm, never
// confirmed identity. An internal-only transcript (everyone on one domain)
// yields no hints: its only domain is the company's own.
function firefliesContactHints(raw: FirefliesTranscriptRecord): SessionContactHint[] | undefined {
  if (firefliesInternalOnly(raw)) return undefined;
  const hints: SessionContactHint[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (name) hints.push(...contactHintsFromDisplayLabel(name, "fireflies:participant"));
    const email = participant.email?.trim();
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "fireflies:participant_email_domain" });
    }
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

// Participant labels are speaker display names plus, for each participant with
// an address, a domain-only label ("@exampletonbros.example") — the label an inbox
// scope's domain_allowlist selects on. OQ-002: with no affiliation field, no
// label is filtered; the raw email dies here and never leaves the adapter.
function firefliesParticipantLabels(raw: FirefliesTranscriptRecord): string[] {
  const labels: string[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (name) labels.push(name);
    const email = participant.email?.trim().toLowerCase();
    const at = email ? email.lastIndexOf("@") : -1;
    if (email && at > 0 && at < email.length - 1) labels.push(`@${email.slice(at + 1)}`);
  }
  return [...new Set(labels)];
}

export const firefliesDiscoveryAdapter: DiscoverySourceAdapter<FirefliesTranscriptRecord> = {
  provider: "fireflies",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = firefliesContactHints(raw);
    const stableUrl = firefliesStableUrl(raw);
    return {
      schema_version: "0.1",
      provider: "fireflies",
      connection_alias: connectionAlias,
      runtime_handle: raw.id,
      // The meeting's end time; the start is the honest fallback when the
      // provider reports no end (R-005).
      completed_at: new Date(raw.ended ?? raw.started_at).toISOString(),
      // Belief (T-001): Fireflies marks a finished transcript "processed";
      // "completed" is accepted as the generic terminal spelling. Anything
      // else (including "processing") is honestly in_progress.
      completion_state: (raw.status?.trim().toLowerCase() === "completed" || raw.status?.trim().toLowerCase() === "processed") ? "completed" : "in_progress",
      title: raw.title.trim(),
      participants: firefliesParticipantLabels(raw),
      stable_url: stableUrl,
      // timestamps: Fireflies transcript sentences carry millisecond offsets
      // (belief, T-001), so envelope locators can cite them.
      // open_transcript is observed, not assumed (R-005).
      capabilities: { list_sessions: true, open_transcript: raw.transcript_access === "granted", stable_link: Boolean(stableUrl), timestamps: true },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

// Zoom (zoom-discovery-connector-v0 T-003). Contract-only: this adapter proves
// normalization against a synthetic cloud-recording fixture; it claims nothing
// about authentication, listing, transcript access, or live support. Raw Zoom
// keys (meeting UUIDs, host ids, tracking fields, addresses) stay inside this
// module.
export type ZoomRecordingRecord = {
  meeting_uuid: string;
  topic: string;
  start_time: string;
  end_time?: string;
  state?: string;
  host_display_name?: string;
  participants?: Array<{ display_name?: string; email?: string }>;
  // Observed per connection by the runtime that listed the recording — never
  // assumed. Absent means "not observed" (fail-closed), so a fixture cannot
  // manufacture transcript access (R-005).
  transcript_available?: boolean;
  url?: string;
};

// Zoom marks exactly one participant as the account's own: the recording host.
// The host is the company's rep — no domain label, no contact hint — and every
// other named participant is treated as external (Gong's internal-party
// discipline with the only internal marker the recording contract provides).
// A host name matching nobody leaves every participant external: nothing else
// is assumed, because Zoom participant records carry no affiliation field.
function zoomIsHost(raw: ZoomRecordingRecord, displayName: string | undefined): boolean {
  const host = raw.host_display_name?.trim().toLowerCase();
  return Boolean(host) && displayName?.trim().toLowerCase() === host;
}

function zoomContactHints(raw: ZoomRecordingRecord): SessionContactHint[] | undefined {
  const hints: SessionContactHint[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (!name || zoomIsHost(raw, name)) continue;
    hints.push(...contactHintsFromDisplayLabel(name, "zoom:participant"));
    const email = participant.email?.trim();
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "zoom:participant_email_domain" });
    }
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

// Participant labels are display names plus, for each non-host participant
// with an address, a domain-only label ("@exampletonbros.example") — what an inbox
// scope's domain_allowlist selects on. The local part of the address is
// discarded here and never leaves the adapter (R-004/R-005).
function zoomParticipantLabels(raw: ZoomRecordingRecord): string[] {
  const labels: string[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (name) labels.push(name);
    const email = participant.email?.trim().toLowerCase();
    if (email && name && !zoomIsHost(raw, name)) {
      const at = email.lastIndexOf("@");
      if (at > 0 && at < email.length - 1) labels.push(`@${email.slice(at + 1)}`);
    }
  }
  return [...new Set(labels)];
}

// Honest completion: the recording's end when observed, otherwise the meeting
// start — never a fabricated end (R-005).
function zoomCompletedAt(raw: ZoomRecordingRecord): string {
  return new Date(raw.end_time ?? raw.start_time).toISOString();
}

export const zoomDiscoveryAdapter: DiscoverySourceAdapter<ZoomRecordingRecord> = {
  provider: "zoom",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = zoomContactHints(raw);
    // A tokenized or credential-bearing link throws here: refused, never
    // cleaned (R-006). No canonical URL is built from the bare UUID — the
    // account subdomain is unknown to the adapter.
    const stableUrl = raw.url ? sanitizeDiscoveryStableUrl("zoom", raw.url) : undefined;
    return {
      schema_version: "0.1",
      provider: "zoom",
      connection_alias: connectionAlias,
      runtime_handle: raw.meeting_uuid,
      completed_at: zoomCompletedAt(raw),
      completion_state: raw.state === "completed" ? "completed" : "in_progress",
      title: raw.topic.trim(),
      participants: zoomParticipantLabels(raw),
      stable_url: stableUrl,
      // timestamps: VTT cue timing is a belief owned by the feasibility task
      // (T-001); until a real transcript is observed it is not claimed.
      capabilities: { list_sessions: true, open_transcript: raw.transcript_available === true, stable_link: Boolean(stableUrl), timestamps: false },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

export type FakeCallsRecord = {
  key: string;
  ended: string;
  subject: string;
  people: { labels: string[] };
  review_link?: string;
  done: boolean;
  // Structurally different from Granola/Gong's enum: a plain boolean the fake
  // provider reports per connection, still fail-closed — absent means false.
  transcript_available?: boolean;
};

// Microsoft Teams (microsoft-teams-discovery-connector-v0 T-003), built by
// the gong playbook with Graph deltas only (D-001). Contract-only: this
// adapter proves normalization against a synthetic online-meeting fixture; it
// claims nothing about authentication, listing, transcript access, or live
// support. Raw Graph keys (attendee SMTP addresses, AAD ids, join URLs) stay
// inside this module.
//
// The raw input is the packet contract's closed union
// (`TeamsMeetingRecord`): meeting identifier, subject, times, provider state,
// organizer display name, attendee display names with optional addresses,
// observed transcript availability, and the canonical link T-001 verifies.
// Attendee entries tolerate dirty provider data (`display_name`/`email` may
// be absent or blank) because refusing garbage is the adapter's job, not the
// type's: blanks are dropped and addresses never survive normalization.
export type TeamsMeetingRecord = {
  meeting_id: string;
  subject: string;
  start_time: string;
  end_time?: string;
  state?: string;
  organizer_display_name?: string;
  attendees?: Array<{ display_name?: string; email?: string }>;
  // Observed on the connection by the runtime that listed the meeting —
  // never assumed. Absent or false means "not observed" (fail-closed), so a
  // fixture cannot manufacture transcript access (R-005).
  transcript_available?: boolean;
  // The canonical meeting/recording link the packet's feasibility task
  // (T-001) verifies. Teams declares no link form yet, so every URL handed
  // here is refused by the stable-URL sanitizer — tokenized Graph join URLs
  // are refused, never cleaned (R-006).
  url?: string;
};

function teamsCompletedAt(raw: TeamsMeetingRecord): string {
  // Honest completion: an explicit provider end wins; without one the start
  // stands in and the record is not yet completed (the state check below).
  const end = raw.end_time?.trim() || raw.start_time;
  if (!Number.isFinite(Date.parse(end))) throw new Error("a Teams meeting needs a parseable start and end time");
  return new Date(end).toISOString();
}

// Participants are attendee display names only (R-005): no addresses, no AAD
// ids, no domain labels — the meeting identifier plus these names are all the
// shared model carries.
function teamsParticipants(raw: TeamsMeetingRecord): string[] {
  const names = (raw.attendees ?? []).map((attendee) => attendee.display_name?.trim() ?? "").filter(Boolean);
  return [...new Set(names)];
}

// Contact hints are external-only (R-005): the tenant-owned meeting is
// organized by the company's own staff, so the attendee whose display name
// matches the organizer is the company's representative and contributes no
// hint. Every other attendee yields a name hint plus, when the record carries
// an address, a DOMAIN-only company hint — the address itself dies here
// (R-004), and free-mail domains yield nothing.
function teamsContactHints(raw: TeamsMeetingRecord): SessionContactHint[] | undefined {
  const organizer = raw.organizer_display_name?.trim().toLowerCase();
  const hints: SessionContactHint[] = [];
  for (const attendee of raw.attendees ?? []) {
    const name = attendee.display_name?.trim();
    if (!name) continue;
    if (organizer && name.toLowerCase() === organizer) continue;
    hints.push(...contactHintsFromDisplayLabel(name, "microsoft-teams:attendee"));
    const email = attendee.email?.trim();
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "microsoft-teams:attendee_email_domain" });
    }
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

export const teamsDiscoveryAdapter: DiscoverySourceAdapter<TeamsMeetingRecord> = {
  provider: "microsoft-teams",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = teamsContactHints(raw);
    // A carried URL is sanitized or the record is refused loudly: with no
    // declared Teams form, any URL (tokenized join links included) throws
    // here — never partially cleaned (R-006).
    const stableUrl = raw.url ? sanitizeDiscoveryStableUrl("microsoft-teams", raw.url) : undefined;
    return {
      schema_version: "0.1",
      provider: "microsoft-teams",
      connection_alias: connectionAlias,
      runtime_handle: raw.meeting_id,
      completed_at: teamsCompletedAt(raw),
      completion_state: raw.state === "completed" ? "completed" : "in_progress",
      title: raw.subject.trim(),
      participants: teamsParticipants(raw),
      stable_url: stableUrl,
      // timestamps: the Graph transcript's locator capability is unverified
      // (T-001 owns it), so the capability fails closed until observed.
      // open_transcript is observed, never assumed (R-005).
      capabilities: { list_sessions: true, open_transcript: raw.transcript_available === true, stable_link: Boolean(stableUrl), timestamps: false },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

export const fakeDiscoveryAdapter: DiscoverySourceAdapter<FakeCallsRecord> = {
  provider: "fakecalls",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    return {
      schema_version: "0.1",
      provider: "fakecalls",
      connection_alias: connectionAlias,
      runtime_handle: raw.key,
      completed_at: new Date(raw.ended).toISOString(),
      completion_state: raw.done ? "completed" : "in_progress",
      title: raw.subject.trim(),
      participants: raw.people.labels.map((label) => label.trim()).filter(Boolean),
      stable_url: raw.review_link ? sanitizeDiscoveryStableUrl("fakecalls", raw.review_link) : undefined,
      capabilities: { list_sessions: true, open_transcript: raw.transcript_available === true, stable_link: Boolean(raw.review_link), timestamps: false },
      access: "unknown",
    };
  },
};

// Zendesk (zendesk-discovery-connector-v0 T-003): the first support-class
// adapter. A ticket is a session, not a call — the shared session contract
// holds unchanged — but the support class changes the admissibility gate: the
// completed evidence set is solved/closed (D-001), the completion instant is
// the provider-observed solved time (never invented), and comment-thread
// access is observed per connection, never assumed (R-005).
export type ZendeskTicketRecord = {
  id: string;
  subject: string;
  status: string;
  solved_at?: string;
  requester?: { display_name?: string; email?: string };
  assignee_display_name?: string;
  brand?: string;
  url?: string;
  comment_access?: "granted" | "missing";
};

const ZENDESK_COMPLETED_STATUSES = new Set(["solved", "closed"]);

// Participant labels are display names plus, for the external requester with
// an address, a domain-only label ("@exampletonbros.example") — the label an inbox
// scope's domain_allowlist selects on. The assignee is the company's own
// agent and contributes no domain label. The local part of the requester
// address is discarded here and never leaves the adapter (R-004/R-005).
function zendeskParticipantLabels(raw: ZendeskTicketRecord): string[] {
  const labels: string[] = [];
  const requesterName = raw.requester?.display_name?.trim();
  if (requesterName) labels.push(requesterName);
  const email = raw.requester?.email?.trim().toLowerCase();
  const at = email ? email.lastIndexOf("@") : -1;
  if (email && at > 0 && at < email.length - 1) labels.push(`@${email.slice(at + 1)}`);
  const assigneeName = raw.assignee_display_name?.trim();
  if (assigneeName) labels.push(assigneeName);
  return [...new Set(labels)];
}

// Contact hints follow the Granola discipline (discovery-contact-capture-v0
// R-003/R-004) with the support-class rule: only the requester is a customer
// contact candidate — the assignee is company staff, and the raw address dies
// here, replaced by its domain.
function zendeskContactHints(raw: ZendeskTicketRecord): SessionContactHint[] | undefined {
  const hints: SessionContactHint[] = [];
  const name = raw.requester?.display_name?.trim();
  if (name) hints.push(...contactHintsFromDisplayLabel(name, "zendesk:requester"));
  const email = raw.requester?.email?.trim();
  if (email) {
    const company = companyFromEmailDomain(email);
    if (company) hints.push({ field: "company", value: company, source: "zendesk:requester_email_domain" });
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

// Gmail (gmail-discovery-connector-v0 T-003). Contract-only: this adapter
// proves normalization against a synthetic thread fixture; it claims nothing
// about authentication, listing, message-body access, or live support. Gmail
// raw keys (message ids, thread ids, internalDate, labelIds, base64 body
// parts) stay inside the adapter and the provider module (R-001).
//
// The packet contract pins the raw input shape as
// {thread_id, snippet_subject, last_message_at, participants?, labels?, url?}.
// The three optional fields the runtime supplies are observed scope context,
// not provider payload: without them the adapter could not apply D-001's
// admissibility rule (which is measured against the approved scope window),
// honor the internal-mailbox exclusion (R-004), or keep body access observed
// rather than assumed. Like Gong's transcript_access, every one dies in
// normalization and none can be manufactured by a fixture (absent fails
// closed).
export type GmailThreadRecord = {
  thread_id: string;
  snippet_subject: string;
  // The thread's last message date — becomes completed_at (R-005).
  last_message_at: string;
  participants?: Array<{ display_name?: string; email?: string }>;
  labels?: string[];
  url?: string;
  // D-001 admissibility boundary: the runtime stamps the approved scope's
  // quiet-period instant (window end minus the policy quiet period). A thread
  // whose last message predates it is settled evidence.
  quiet_period_ends_at?: string;
  // The mailbox owner's address, observed once from the connection profile.
  // Defines "external" for a per-user mailbox (D-002): the owner's domain is
  // the internal one, so their own sent mail yields no hint.
  mailbox_owner_email?: string;
  // Observed per connection and grant by the runtime that listed the thread —
  // never assumed. Absent means "not granted" (fail-closed), so a fixture
  // cannot manufacture message-body access (R-005).
  body_access?: "granted" | "missing";
};

// D-001's explicit done-label override (T-005): a thread carrying any of these
// labels is completed evidence regardless of recency. Kept beside the email
// class rather than the transport policy — it is class semantics every Gmail
// runtime shares, versioned with the class, not a request ceiling.
export const GMAIL_DONE_LABELS: readonly string[] = ["done"];

// D-001 (gmail-discovery-connector-v0 T-005, pinned per OQ-001's
// recommendation): a thread is "completed" evidence when its last message
// predates the approved scope's quiet-period boundary, or when it carries an
// explicit done label. Without a stamped boundary and without a done label the
// thread is not settled — in_progress, never guessed.
export function gmailThreadAdmissibility(
  raw: Pick<GmailThreadRecord, "last_message_at" | "labels" | "quiet_period_ends_at">,
): "completed" | "in_progress" {
  const labels = new Set((raw.labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean));
  if (GMAIL_DONE_LABELS.some((label) => labels.has(label))) return "completed";
  const boundary = Date.parse(raw.quiet_period_ends_at ?? "");
  const last = Date.parse(raw.last_message_at);
  if (Number.isFinite(boundary) && Number.isFinite(last) && last < boundary) return "completed";
  return "in_progress";
}

function gmailDomainLabel(email: string): string | undefined {
  // Domain labels exist so an inbox scope's domain_allowlist can select on
  // them (the raw address never leaves the adapter, R-005). Free-mail domains
  // yield no label: "@gmail.com" is noise for a customer selector, and the
  // shared rule already refuses to derive an employer from them.
  if (!companyFromEmailDomain(email)) return undefined;
  return `@${email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase()}`;
}

function internalDomain(raw: GmailThreadRecord): string | undefined {
  const owner = raw.mailbox_owner_email?.trim().toLowerCase();
  const at = owner ? owner.lastIndexOf("@") : -1;
  return owner && at > 0 && at < owner.length - 1 ? owner.slice(at + 1) : undefined;
}

// R-004: a thread with no participant outside the mailbox owner's own domain
// is the company talking to itself in one person's mailbox and is excluded by
// default. A thread whose participants carry no addresses stays in — the
// scope's own selectors still have to admit it.
export function gmailInternalOnly(raw: GmailThreadRecord): boolean {
  const own = internalDomain(raw);
  if (!own) return false;
  const addressed = (raw.participants ?? []).filter((participant) => participant.email?.trim());
  if (addressed.length === 0) return false;
  return addressed.every((participant) => participant.email!.trim().toLowerCase().endsWith(`@${own}`));
}

// Contact hints follow the shared discipline: display names become full_name
// candidates, a non-free email DOMAIN becomes the company, and the address
// itself dies here. The mailbox owner is the company's own rep — their
// identity contributes no hint and no domain label (per-user ownership,
// D-002).
function gmailContactHints(raw: GmailThreadRecord): SessionContactHint[] | undefined {
  const own = internalDomain(raw);
  const hints: SessionContactHint[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    const email = participant.email?.trim();
    if (own && email?.toLowerCase().endsWith(`@${own}`)) continue;
    if (name) hints.push(...contactHintsFromDisplayLabel(name, "gmail:participant"));
    if (email) {
      const company = companyFromEmailDomain(email);
      if (company) hints.push({ field: "company", value: company, source: "gmail:participant_email_domain" });
    }
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

export const zendeskDiscoveryAdapter: DiscoverySourceAdapter<ZendeskTicketRecord> = {
  provider: "zendesk",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    // A solved-class ticket with no observed solved time stays in_progress
    // rather than inventing a completion instant (D-001).
    const solvedAt = raw.solved_at?.trim();
    const stableUrl = raw.url ? sanitizeDiscoveryStableUrl("zendesk", raw.url) : undefined;
    const contactHints = zendeskContactHints(raw);
    return {
      schema_version: "0.1",
      provider: "zendesk",
      connection_alias: connectionAlias,
      runtime_handle: raw.id,
      completed_at: solvedAt ? new Date(solvedAt).toISOString() : "",
      completion_state: ZENDESK_COMPLETED_STATUSES.has(raw.status.toLowerCase()) && solvedAt ? "completed" : "in_progress",
      title: raw.subject.trim(),
      participants: zendeskParticipantLabels(raw),
      stable_url: stableUrl,
      // Comment threads carry a created_at per comment, so the timestamps
      // capability rides the same observed grant as open_transcript (R-005):
      // neither is claimed without the connection-level observation.
      capabilities: { list_sessions: true, open_transcript: raw.comment_access === "granted", stable_link: Boolean(stableUrl), timestamps: raw.comment_access === "granted" },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

// Participant labels are display names plus, for each non-free-mail address,
// a domain-only label ("@exampletonbros.example"). The local part of every address
// is discarded here and never leaves the adapter (R-005).
function gmailParticipantLabels(raw: GmailThreadRecord): string[] {
  const own = internalDomain(raw);
  const labels: string[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (name) labels.push(name);
    const email = participant.email?.trim().toLowerCase();
    if (!email || (own && email.endsWith(`@${own}`))) continue;
    const domain = gmailDomainLabel(email);
    if (domain) labels.push(domain);
  }
  return [...new Set(labels)];
}

export const gmailDiscoveryAdapter: DiscoverySourceAdapter<GmailThreadRecord> = {
  provider: "gmail",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = gmailContactHints(raw);
    // R-006: Gmail declares no ProviderLinkForm in V0 — the believed web
    // thread URL carries the identifier in a fragment (or query) form that the
    // global stable-link rule refuses, and the feasibility task owns verifying
    // the real forms. Links stay unset with a coverage caveat; a tokenized or
    // authenticated URL is never stored. The raw url field dies here.
    void raw.url;
    return {
      schema_version: "0.1",
      provider: "gmail",
      connection_alias: connectionAlias,
      runtime_handle: raw.thread_id,
      completed_at: new Date(raw.last_message_at).toISOString(),
      completion_state: gmailThreadAdmissibility(raw),
      title: raw.snippet_subject.trim() || "(no subject)",
      participants: gmailParticipantLabels(raw),
      // No declared link form → no stable link, and sanitizeDiscoveryStableUrl
      // keeps refusing every Gmail URL shape (query or fragment) unchanged.
      stable_url: undefined,
      // timestamps: email messages carry no per-locus timestamps an envelope
      // locator could cite (the locator format is mm:ss of a recording), so
      // this stays honestly false. open_transcript (body access) is observed,
      // not assumed (R-005).
      capabilities: { list_sessions: true, open_transcript: raw.body_access === "granted", stable_link: false, timestamps: false },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};

// Slack (slack-discovery-connector-v0 T-004). Contract-only: this adapter
// proves thread normalization against fixtures; it claims nothing about
// authentication, listing, or live support. A thread record is channel-level
// metadata plus the explicitly selected thread timestamp — it carries no user
// identity, because chat evidence is decision_context with summary-only
// exposure: the channel is the disclosure level, not the speaker.
export type SlackThreadRecord = {
  channel_id: string;
  thread_ts: string;
  channel_name?: string;
  last_message_at?: string;
  permalink?: string;
};

export const slackDiscoveryAdapter: DiscoverySourceAdapter<SlackThreadRecord> = {
  provider: "slack",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const stableUrl = raw.permalink ? sanitizeDiscoveryStableUrl("slack", raw.permalink) : undefined;
    const lastMessageSeconds = raw.last_message_at ? Number(raw.last_message_at.split(".")[0]) : undefined;
    const fallbackSeconds = Number(raw.thread_ts.split(".")[0]);
    return {
      schema_version: "0.1",
      provider: "slack",
      connection_alias: connectionAlias,
      runtime_handle: `${raw.channel_id}:${raw.thread_ts}`,
      // A thread is complete by selection: processing reads exactly the thread
      // the scope named. Truncation inside a read is recorded on the envelope
      // (transcript_complete), not by pretending the conversation is unfinished.
      completed_at: raw.last_message_at && lastMessageSeconds
        ? new Date(lastMessageSeconds * 1000).toISOString()
        : new Date(fallbackSeconds * 1000).toISOString(),
      completion_state: "completed",
      // Channel-level label (D-001): the disclosure level for chat evidence is
      // the channel, never a speaker, so participants stay empty and the title
      // names the channel or the selector — not people.
      title: raw.channel_name?.trim() ? `Slack thread in #${raw.channel_name.trim()}` : `Slack thread ${raw.channel_id} ${raw.thread_ts}`,
      participants: [],
      stable_url: stableUrl,
      capabilities: { list_sessions: true, open_transcript: true, stable_link: Boolean(stableUrl), timestamps: true },
      access: "unknown",
    };
  },
};

// Outlook (outlook-discovery-connector-v0 T-003). Contract-only: this adapter
// proves normalization against a synthetic conversation fixture; it claims
// nothing about authentication, listing, message-body access, or live support.
// Outlook raw keys (Graph message ids, conversation ids, odata metadata,
// HTML body parts, smtp addresses) stay inside the adapter and the provider
// module (R-001).
//
// The packet contract pins the raw input shape as
// {conversation_id, subject, last_message_at, participants?, folders?, url?}
// with Graph naming (smtp, folders) preserved verbatim. Like Gmail's record,
// the optional fields the runtime supplies are observed scope context, not
// provider payload: without them the adapter could not apply the email class's
// admissibility rule (measured against the approved scope window), honor the
// internal-mailbox exclusion (R-004), or keep body access observed rather than
// assumed. Every one dies in normalization and none can be manufactured by a
// fixture (absent fails closed).
export type OutlookConversationRecord = {
  // The Graph conversation group identifier — becomes runtime_handle (R-005).
  conversation_id: string;
  subject: string;
  // The conversation's last message received date — becomes completed_at
  // (R-005).
  last_message_at: string;
  participants?: Array<{ display_name?: string; smtp?: string }>;
  // Graph folders the conversation's messages were observed in. Scope
  // vocabulary, never stored: the approved scope names the folders, and the
  // conversation's own folder set is excluded from the normalized session.
  folders?: string[];
  url?: string;
  // The email class's quiet-period boundary: the runtime stamps the approved
  // scope's quiet-period instant (window end minus the policy quiet period).
  // A conversation whose last message predates it is settled evidence.
  quiet_period_ends_at?: string;
  // The mailbox owner's address, observed once from the connection profile.
  // Defines "external" for a per-user mailbox (D-002): the owner's domain is
  // the internal one, so their own sent mail yields no hint.
  mailbox_owner_email?: string;
  // Observed per connection and grant by the runtime that listed the
  // conversation — never assumed. Absent means "not granted" (fail-closed),
  // so a fixture cannot manufacture message-body access (R-005).
  body_access?: "granted" | "missing";
  // Graph categories observed on the conversation's messages (the runtime
  // supplies the union). The email class's done-override vocabulary (T-005);
  // dies in normalization like every other scope marker.
  categories?: string[];
};

// The email class's explicit done override (T-005), adapted to conversation
// groups: Outlook has no label store, so the override maps Gmail's done label
// onto Graph message categories — the closest per-message marker a mailbox
// owner sets by hand. Same value list as GMAIL_DONE_LABELS; same class
// semantics (a category marker is intent, not transport policy).
export const OUTLOOK_DONE_CATEGORIES: readonly string[] = ["done"];

// The email class's admissibility rule (outlook-discovery-connector-v0 T-005,
// pinned as the Gmail packet's D-001 rule applied to conversation groups): a
// conversation is "completed" evidence when its last message predates the
// approved scope's quiet-period boundary, or when a message in the group
// carries an explicit done category. Without a stamped boundary and without a
// done category the conversation is not settled — in_progress, never guessed.
export function outlookConversationAdmissibility(
  raw: Pick<OutlookConversationRecord, "last_message_at" | "categories" | "quiet_period_ends_at">,
): "completed" | "in_progress" {
  const categories = new Set((raw.categories ?? []).map((category) => category.trim().toLowerCase()).filter(Boolean));
  if (OUTLOOK_DONE_CATEGORIES.some((category) => categories.has(category))) return "completed";
  const boundary = Date.parse(raw.quiet_period_ends_at ?? "");
  const last = Date.parse(raw.last_message_at);
  if (Number.isFinite(boundary) && Number.isFinite(last) && last < boundary) return "completed";
  return "in_progress";
}

function outlookDomainLabel(smtp: string): string | undefined {
  // Same discipline as Gmail's: domain labels exist so an inbox scope's
  // domain_allowlist can select on them (the raw address never leaves the
  // adapter, R-005), and free-mail domains yield no label — "@outlook.com" is
  // noise for a customer selector, and the shared rule already refuses to
  // derive an employer from free-mail domains.
  if (!companyFromEmailDomain(smtp)) return undefined;
  return `@${smtp.slice(smtp.lastIndexOf("@") + 1).trim().toLowerCase()}`;
}

function outlookInternalDomain(raw: OutlookConversationRecord): string | undefined {
  const owner = raw.mailbox_owner_email?.trim().toLowerCase();
  const at = owner ? owner.lastIndexOf("@") : -1;
  return owner && at > 0 && at < owner.length - 1 ? owner.slice(at + 1) : undefined;
}

// R-004: a conversation with no participant outside the mailbox owner's own
// domain is the company talking to itself in one person's mailbox and is
// excluded by default. A conversation whose participants carry no smtp
// addresses stays in — the scope's own selectors still have to admit it.
export function outlookInternalOnly(raw: OutlookConversationRecord): boolean {
  const own = outlookInternalDomain(raw);
  if (!own) return false;
  const addressed = (raw.participants ?? []).filter((participant) => participant.smtp?.trim());
  if (addressed.length === 0) return false;
  return addressed.every((participant) => participant.smtp!.trim().toLowerCase().endsWith(`@${own}`));
}

// Contact hints follow the shared discipline: display names become full_name
// candidates, a non-free smtp DOMAIN becomes the company, and the address
// itself dies here. The mailbox owner is the company's own rep — their
// identity contributes no hint and no domain label (per-user ownership,
// D-002).
function outlookContactHints(raw: OutlookConversationRecord): SessionContactHint[] | undefined {
  const own = outlookInternalDomain(raw);
  const hints: SessionContactHint[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    const smtp = participant.smtp?.trim();
    if (own && smtp?.toLowerCase().endsWith(`@${own}`)) continue;
    if (name) hints.push(...contactHintsFromDisplayLabel(name, "outlook:participant"));
    if (smtp) {
      const company = companyFromEmailDomain(smtp);
      if (company) hints.push({ field: "company", value: company, source: "outlook:participant_smtp_domain" });
    }
  }
  const deduped = dedupeContactHints(hints);
  return deduped.length ? deduped : undefined;
}

// Participant labels are display names plus, for each non-free-mail address,
// a domain-only label ("@exampletonbros.example"). The local part of every address
// is discarded here and never leaves the adapter (R-005).
function outlookParticipantLabels(raw: OutlookConversationRecord): string[] {
  const own = outlookInternalDomain(raw);
  const labels: string[] = [];
  for (const participant of raw.participants ?? []) {
    const name = participant.display_name?.trim();
    if (name) labels.push(name);
    const smtp = participant.smtp?.trim().toLowerCase();
    if (!smtp || (own && smtp.endsWith(`@${own}`))) continue;
    const domain = outlookDomainLabel(smtp);
    if (domain) labels.push(domain);
  }
  return [...new Set(labels)];
}

export const outlookDiscoveryAdapter: DiscoverySourceAdapter<OutlookConversationRecord> = {
  provider: "outlook",
  normalizeSession(raw, connectionAlias): DiscoverySession {
    const contactHints = outlookContactHints(raw);
    // R-006: Outlook declares no ProviderLinkForm in V0 — Graph web links
    // embed the item id as an opaque token in the path (or carry it in a
    // query), a form the global stable-link rule refuses, and the feasibility
    // task owns verifying the real forms. Links stay unset; a tokenized or
    // authenticated URL is never stored. The raw url field dies here.
    void raw.url;
    return {
      schema_version: "0.1",
      provider: "outlook",
      connection_alias: connectionAlias,
      runtime_handle: raw.conversation_id,
      completed_at: new Date(raw.last_message_at).toISOString(),
      completion_state: outlookConversationAdmissibility(raw),
      title: raw.subject.trim() || "(no subject)",
      participants: outlookParticipantLabels(raw),
      // No declared link form → no stable link, and
      // sanitizeDiscoveryStableUrl keeps refusing every Outlook web-link
      // shape (tokenized path or query) unchanged.
      stable_url: undefined,
      // timestamps: email messages carry no per-locus timestamps an envelope
      // locator could cite (the locator format is mm:ss of a recording), so
      // this stays honestly false. open_transcript (body access) is observed,
      // not assumed (R-005).
      capabilities: { list_sessions: true, open_transcript: raw.body_access === "granted", stable_link: false, timestamps: false },
      access: "unknown",
      ...(contactHints ? { contact_hints: contactHints } : {}),
    };
  },
};
