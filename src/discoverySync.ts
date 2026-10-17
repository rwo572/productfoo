import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { approvalStates, sourceKey } from "./sourceIngress.js";
import { loadDiscoveryRun } from "./discoveryArtifacts.js";
import { parse } from "./vendorYaml.js";

export type DiscoverySyncAction = "list_metadata" | "match" | "open_authorized_transcript" | "apply_sanitized_evidence";

export type DiscoverySyncLane = {
  lane_id: string;
  kind: "study" | "inbox";
  provider: string;
  connection_alias: string;
  study_id?: string;
  scope_id?: string;
  lifecycle: string;
  allowed_actions: DiscoverySyncAction[];
};

export type DiscoverySyncPlan = {
  schema_version: "0.1";
  generated_at: string;
  lanes: DiscoverySyncLane[];
  errors: string[];
  connector_reads: 0;
};

type InboxScope = {
  scope_id?: string;
  provider?: string;
  connection_alias?: string;
  time_window?: { start?: string; end?: string };
  participant_allowlist?: string[];
  domain_allowlist?: string[];
  title_tokens?: string[];
  call_owners?: string[];
  // Zendesk selector kinds (zendesk-discovery-connector-v0 R-004); other
  // providers leave them unset, so this stays the generic inbox rule.
  organizations?: string[];
  brands?: string[];
  state?: string;
  approved_by?: string;
  approved_at?: string;
};

const TERMINAL = new Set(["complete", "revoked"]);

function actionsFor(lifecycle: string): DiscoverySyncAction[] {
  if (lifecycle === "awaiting_interview" || lifecycle === "draft" || lifecycle === "needs_review") return [];
  if (lifecycle === "ready_to_synthesize") return ["open_authorized_transcript", "apply_sanitized_evidence"];
  return ["list_metadata", "match", "open_authorized_transcript", "apply_sanitized_evidence"];
}

function hasCustomerSelector(scope: InboxScope): boolean {
  // call_owners is a gong selector kind (gong-discovery-connector-v0 R-004)
  // and organizations/brands are zendesk kinds (zendesk-discovery-connector-v0
  // R-004); other providers leave them unset, so this stays the generic inbox
  // rule.
  return [scope.participant_allowlist, scope.domain_allowlist, scope.title_tokens, scope.call_owners, scope.organizations, scope.brands]
    .some((values) => Array.isArray(values) && values.some((value) => typeof value === "string" && value.trim()));
}

function scopeApprovalAllows(inboxDir: string, scope: InboxScope): boolean {
  if (!scope.provider || !scope.connection_alias || !scope.scope_id) return false;
  const approval = approvalStates(inboxDir).get(sourceKey({ provider: scope.provider, connection_id: scope.connection_alias }));
  // Approvals accumulate per scope (#528): any approved scope on the connection
  // may cover this inbox scope; scopes arrive trimmed from approvalStates.
  return (
    approval?.state === "approved" &&
    approval.scopes.some((approved) => approved === "*" || approved === scope.scope_id || approved === `scope:${scope.scope_id}`)
  );
}

export function planDiscoverySync(root: string, now: string): DiscoverySyncPlan {
  const lanes: DiscoverySyncLane[] = [];
  const errors: string[] = [];
  const discoveryRoot = path.join(root, "discovery");
  if (!existsSync(discoveryRoot)) return { schema_version: "0.1", generated_at: now, lanes, errors: ["discovery/ is missing"], connector_reads: 0 };
  for (const entry of readdirSync(discoveryRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === "inbox") continue;
    const dir = path.join(discoveryRoot, entry.name);
    try {
      const run = loadDiscoveryRun(dir);
      if (TERMINAL.has(run.state)) continue;
      lanes.push({
        lane_id: `study:${run.study_id}`,
        kind: "study",
        provider: run.source.provider,
        connection_alias: run.source.connection_alias,
        study_id: run.study_id,
        lifecycle: run.state,
        allowed_actions: actionsFor(run.state),
      });
    } catch {
      errors.push(`${entry.name}: invalid discovery run`);
    }
  }
  const inboxDir = path.join(discoveryRoot, "inbox");
  const scopePath = path.join(inboxDir, "scope.yaml");
  if (existsSync(scopePath)) {
    let scopes: InboxScope[] = [];
    try {
      const doc = parse(readFileSync(scopePath, "utf8")) as { scopes?: InboxScope[] };
      scopes = Array.isArray(doc.scopes) ? doc.scopes : [];
    } catch {
      errors.push("inbox/scope.yaml is invalid");
    }
    for (const scope of scopes) {
      if (scope.state !== "approved") continue;
      if (!hasCustomerSelector(scope)) {
        errors.push(`${scope.scope_id ?? "inbox scope"}: approved ingestion requires at least one customer selector`);
        continue;
      }
      if (!scope.time_window?.start || !scope.time_window?.end) {
        errors.push(`${scope.scope_id ?? "inbox scope"}: bounded time window is required`);
        continue;
      }
      if (!scopeApprovalAllows(inboxDir, scope)) {
        errors.push(`${scope.scope_id ?? "inbox scope"}: matching source approval is missing`);
        continue;
      }
      if (!scope.scope_id || !scope.provider || !scope.connection_alias) {
        errors.push("inbox scope identity is incomplete");
        continue;
      }
      lanes.push({
        lane_id: `inbox:${scope.scope_id}`,
        kind: "inbox",
        provider: scope.provider,
        connection_alias: scope.connection_alias,
        scope_id: scope.scope_id,
        lifecycle: "approved",
        allowed_actions: ["list_metadata", "match", "open_authorized_transcript", "apply_sanitized_evidence"],
      });
    }
  }
  return { schema_version: "0.1", generated_at: now, lanes, errors, connector_reads: 0 };
}

export type DiscoveryLaneResult = {
  lane_id: string;
  provider: string;
  status: "clean_no_op" | "needs_review" | "blocked" | "provider_failure";
  writes: string[];
  error_code?: string;
};

export type DiscoverySyncAggregate = {
  status: "clean_no_op" | "ok" | "needs_review" | "invalid";
  writes: string[];
  errors: Array<{ lane_id: string; provider: string; code: string }>;
  coverage: { lanes: number; succeeded: number; failed: number; partial_failure: boolean };
};

export function aggregateDiscoverySync(results: DiscoveryLaneResult[]): DiscoverySyncAggregate {
  const errors = results
    .filter((entry) => entry.status === "provider_failure" || entry.status === "blocked")
    .map((entry) => ({ lane_id: entry.lane_id, provider: entry.provider, code: entry.error_code ?? "E_DISCOVERY_VALIDATION" }));
  const writes = [...new Set(results.flatMap((entry) => entry.writes))].sort();
  const succeeded = results.length - errors.length;
  const status = results.length === 0
    ? "clean_no_op"
    : results.some((entry) => entry.status === "needs_review")
      ? "needs_review"
      : errors.length === results.length
        ? "invalid"
        : writes.length
          ? "ok"
          : "clean_no_op";
  return { status, writes, errors, coverage: { lanes: results.length, succeeded, failed: errors.length, partial_failure: errors.length > 0 && succeeded > 0 } };
}

export type RepoSnapshot = { root: string; files: Record<string, string> };

function snapshotFiles(root: string, dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (relative === ".foo" || relative.startsWith(".foo/")) {
        if (relative !== ".foo" && relative !== ".foo/discovery" && !relative.startsWith(".foo/discovery/")) continue;
      }
      Object.assign(files, snapshotFiles(root, full));
    } else if (entry.isFile()) {
      files[relative] = readFileSync(full, "utf8");
    }
  }
  return files;
}

export function snapshotDiscoverySyncPaths(root: string): RepoSnapshot {
  return { root: path.resolve(root), files: snapshotFiles(path.resolve(root)) };
}

export function validateDiscoverySyncWrites(before: RepoSnapshot, after: RepoSnapshot): { ok: boolean; changed: string[]; forbidden: string[] } {
  if (before.root !== after.root) return { ok: false, changed: [], forbidden: ["snapshot roots differ"] };
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changed = [...paths].filter((file) => before.files[file] !== after.files[file]).sort();
  const forbidden = changed.filter((file) => !file.startsWith("discovery/") && !file.startsWith(".foo/discovery/"));
  return { ok: forbidden.length === 0, changed, forbidden };
}
