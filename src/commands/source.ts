import path from "node:path";
import {
  approve as approveSource,
  buildReceipt,
  classifyProvider,
  discover as discoverSources,
  EVIDENCE_CLASS_GLOSS,
  loadSurface,
  recordClaim,
  revoke as revokeSource,
  type ClaimDirection,
  type IngressPath,
} from "../sourceIngress.js";
import { flagValue, hasFlag, resolvePacketDir } from "./shared.js";
import { UsageError } from "../errorTaxonomy.js";
import { fanOutDiscoveryTargetSuspension } from "../discoveryConnections.js";

// foo source <command>: the connector-substrate evidence ledger
// (nango_connector_substrate_v0). Read-only toward sources; discovery is fed
// the runtime tool surface as JSON (the spec's CLI-bridge override) so the
// flow is offline. Revoke additionally fans out privilege-reducing
// discovery_suspend_target calls to every registered hosted discovery target
// (nango-discovery-connector-v0 R-008).
export async function runSourceCommand(root: string, command: string | undefined, args: string[]): Promise<string> {
  const json = hasFlag(args, "--json");
  const at = new Date().toISOString();

  if (command === "classify") {
    const provider = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    if (!provider) throw new UsageError("foo source classify needs a <provider>", "E_BAD_FLAG");
    const c = classifyProvider(provider);
    if (json) return `${JSON.stringify({ schema_version: "0.1", provider, ...c }, null, 2)}\n`;
    const note = c.registered ? "registered category" : "unregistered → most-restrictive default";
    return `${provider}: ${c.source_category} · ${EVIDENCE_CLASS_GLOSS[c.evidence_class]} · sensitivity ${c.sensitivity} · ${note}\n`;
  }

  const { packetDir } = resolvePacketDir(root, args[1]);

  if (command === "discover") {
    const surfacePath = flagValue(args, "--surface");
    if (!surfacePath) throw new UsageError("foo source discover needs --surface <file.json> (the runtime hands the discovered MCP surface in as JSON)", "E_BAD_FLAG");
    const rows = discoverSources(packetDir, loadSurface(path.resolve(root, surfacePath)), at);
    if (json) return `${JSON.stringify({ schema_version: "0.1", discovered: rows }, null, 2)}\n`;
    const lines = ["Source discovery (read-only; classification + approval state):"];
    for (const r of rows) {
      lines.push(`  ${r.provider}/${r.connection_id} [${r.ingress_path}] — ${r.source_category} · ${r.evidence_class_label} · sensitivity ${r.sensitivity} · ${r.approval_state}`);
    }
    if (rows.length === 0) lines.push("  (no accessible sources in the provided surface)");
    return `${lines.join("\n")}\n`;
  }

  if (command === "approve" || command === "revoke") {
    const provider = flagValue(args, "--provider");
    const connection = flagValue(args, "--connection");
    const by = flagValue(args, "--by");
    if (!provider || !connection) throw new UsageError(`foo source ${command} needs --provider and --connection`, "E_BAD_FLAG");
    if (!by) throw new UsageError(`foo source ${command} needs --by <who>`, "E_BAD_FLAG");
    const ingress = (flagValue(args, "--ingress") ?? "mcp") as IngressPath;
    // Optional per-selection discriminator: required for GitHub per-PR keying so
    // PR #1 and PR #2 in one repo are distinct gate keys (github-integration-v0
    // R-011); absent for connection-keyed providers (Linear/Supabase).
    const externalId = flagValue(args, "--external-id");
    const id = { ingress_path: ingress, provider, connection_id: connection, ...(externalId ? { external_id: externalId } : {}) };
    const label = `${provider}/${connection}${externalId ? ` (${externalId})` : ""}`;
    const packetSlug = path.basename(packetDir);

    if (command === "approve") {
      const scope = flagValue(args, "--scope");
      if (!scope) throw new UsageError("foo source approve needs --scope <selection>", "E_BAD_FLAG");
      const result = approveSource(packetDir, id, { packet: packetSlug, scope, by, at });
      if (json) return `${JSON.stringify({ schema_version: "0.1", action: "approve", source_id: id, ...result }, null, 2)}\n`;
      // Idempotent only when the requested scope is genuinely covered (#528);
      // a new scope on an approved connection appends a scope-additive event.
      return result.idempotent
        ? `Already approved (idempotent): ${label} for ${packetSlug} — scope ${scope} is already covered.\n`
        : `Approved ${label} for ${packetSlug} (scope: ${scope}).\n`;
    }

    const result = revokeSource(packetDir, id, { packet: packetSlug, by, at });
    // Privilege-reducing fan-out (nango-discovery-connector-v0 R-008): every
    // hosted target registered from this approval gets a discovery_suspend_target
    // call bound to the revocation event digest. The local revoke above is
    // already applied and is never weakened; a service failure records
    // revocation_pending and never claims the hosted grant was revoked.
    const hosted = await fanOutDiscoveryTargetSuspension({
      localRoot: root,
      provider: id.provider,
      connection_id: id.connection_id,
      revocation_event_digest: result.event_digest,
      requested_by: by,
      at,
    });
    if (json) return `${JSON.stringify({ schema_version: "0.1", action: "revoke", source_id: id, ...result, hosted }, null, 2)}\n`;
    const lines = [`Revoked ${label}; purged ${result.purged} local summary line(s).`];
    if (hosted.registered > 0) {
      lines.push(
        hosted.pending === 0
          ? `Hosted discovery targets: suspended ${hosted.acknowledged} registered target(s) (acknowledged).`
          : `Hosted discovery targets: ${hosted.acknowledged} suspended · ${hosted.pending} REVOCATION_PENDING of ${hosted.registered} — remote suspension is not yet acknowledged; hosted reads may continue until the service confirms.`,
      );
    }
    return `${lines.join("\n")}\n`;
  }

  if (command === "claim") {
    const provider = flagValue(args, "--provider");
    const connection = flagValue(args, "--connection");
    const selection = flagValue(args, "--selection");
    const claim = flagValue(args, "--claim");
    const citesTask = flagValue(args, "--task");
    const direction = flagValue(args, "--direction") as ClaimDirection | undefined;
    if (!provider || !connection) throw new UsageError("foo source claim needs --provider and --connection", "E_BAD_FLAG");
    if (!selection || !claim) throw new UsageError("foo source claim needs --selection <schema.table> and --claim <text>", "E_BAD_FLAG");
    if (!citesTask) throw new UsageError("foo source claim needs --task <task-id> (the packet task the claim is evidence for or against)", "E_BAD_FLAG");
    if (direction !== "supports" && direction !== "contradicts") throw new UsageError("foo source claim needs --direction supports|contradicts", "E_BAD_FLAG");
    const ingress = (flagValue(args, "--ingress") ?? "mcp") as IngressPath;
    const externalId = flagValue(args, "--external-id");
    const id = { ingress_path: ingress, provider, connection_id: connection, ...(externalId ? { external_id: externalId } : {}) };
    const result = recordClaim(packetDir, id, { selection, claim, cites_task: citesTask, direction, at });
    if (json) return `${JSON.stringify({ schema_version: "0.1", action: "claim", source_id: id, selection, cites_task: citesTask, direction, ...result }, null, 2)}\n`;
    if (!result.recorded) return `Refused: ${result.reason}\n`;
    return `Recorded ${direction} claim on ${provider}/${connection} (${selection}) citing ${citesTask}. Claim text is local-only; provenance event committed.\n`;
  }

  if (command === "receipt") {
    const surfacePath = flagValue(args, "--surface");
    const servers = surfacePath ? loadSurface(path.resolve(root, surfacePath)) : [];
    const receipt = buildReceipt(packetDir, servers, at);
    if (json) return `${JSON.stringify(receipt, null, 2)}\n`;
    const lines = [
      `Source-boundary receipt — ${receipt.packet}`,
      `  discovered: ${receipt.discovered.length} · selected_and_read: ${receipt.selected_and_read.length} · claims: ${receipt.claims.length} · excluded: ${receipt.excluded_after_evaluation.length} · revoked: ${receipt.revoked.length}`,
      ...receipt.claims.map((c) => `  claim: ${c.source_id.provider}/${c.source_id.connection_id} (${c.selection}) ${c.direction} ${c.cites_task} — ${c.evidence_class_label}`),
      `  ${receipt.coverage_note}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  throw new UsageError(`unknown source command: ${command ?? "(none)"}. Try: discover | classify | approve | claim | revoke | receipt`, "E_BAD_FLAG");
}
