import { createHash } from "node:crypto";
import type { DiscoverySession } from "./discoverySources.js";

export type DiscoveryMatchTarget = {
  provider: string;
  expected_local_date: string | null;
  timezone: string;
  required_participants: string[];
  required_title_tokens: string[];
};

export type DiscoveryCandidateRef = { candidate_index: number; source_fingerprint: string };
export type DiscoveryMatchResult = {
  status: "none" | "unique" | "ambiguous";
  matches: DiscoverySession[];
  candidates: DiscoveryCandidateRef[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function localDate(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    return null;
  }
}

function sessionMatches(target: DiscoveryMatchTarget, session: DiscoverySession): boolean {
  if (session.completion_state !== "completed") return false;
  if (normalize(session.provider) !== normalize(target.provider)) return false;
  if (target.expected_local_date && localDate(session.completed_at, target.timezone) !== target.expected_local_date) return false;
  const title = normalize(session.title);
  if (!target.required_title_tokens.every((token) => title.includes(normalize(token)))) return false;
  const participants = session.participants.map(normalize);
  if (!target.required_participants.every((required) => participants.includes(normalize(required)))) return false;
  return true;
}

export function sourceFingerprint(session: DiscoverySession): string {
  const identity = [
    normalize(session.provider),
    normalize(session.connection_alias),
    session.runtime_handle,
    new Date(session.completed_at).toISOString(),
    normalize(session.title),
    session.stable_url ?? "",
  ].join("\n");
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export function matchDiscoverySessions(target: DiscoveryMatchTarget, sessions: DiscoverySession[]): DiscoveryMatchResult {
  const matches = sessions.filter((session) => sessionMatches(target, session));
  const candidates = matches.map((session, index) => ({ candidate_index: index + 1, source_fingerprint: sourceFingerprint(session) }));
  return { status: matches.length === 0 ? "none" : matches.length === 1 ? "unique" : "ambiguous", matches, candidates };
}

export type DiscoveryDuplicateProposal = {
  left_fingerprint: string;
  right_fingerprint: string;
  confidence: "medium" | "high";
  action: "review-canonical-source";
};

function participantOverlap(left: DiscoverySession, right: DiscoverySession): boolean {
  const rightNames = new Set(right.participants.map(normalize));
  return left.participants.map(normalize).some((name) => rightNames.has(name));
}

export function findProbableDiscoveryDuplicates(sessions: DiscoverySession[]): DiscoveryDuplicateProposal[] {
  const proposals: DiscoveryDuplicateProposal[] = [];
  for (let left = 0; left < sessions.length; left += 1) {
    for (let right = left + 1; right < sessions.length; right += 1) {
      const a = sessions[left];
      const b = sessions[right];
      if (normalize(a.provider) === normalize(b.provider)) continue;
      const minutes = Math.abs(Date.parse(a.completed_at) - Date.parse(b.completed_at)) / 60_000;
      if (minutes > 15 || normalize(a.title) !== normalize(b.title) || !participantOverlap(a, b)) continue;
      proposals.push({
        left_fingerprint: sourceFingerprint(a),
        right_fingerprint: sourceFingerprint(b),
        confidence: minutes <= 5 ? "high" : "medium",
        action: "review-canonical-source",
      });
    }
  }
  return proposals;
}
