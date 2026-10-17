// Direct Firecrawl credentials are verified with Firecrawl and stored locally.
import {
  clearStoredFirecrawlKey,
  credentialsPath,
  resolveFirecrawlKey,
  writeStoredFirecrawlKey,
} from "../tokenStore.js";

export type VerifyResult =
  | { state: "valid" }
  | { state: "rejected" }
  | { state: "unreachable"; detail: string };

export type LoginOutcome = { output: string; exitCode: number };

function tokenFingerprint(token: string): string {
  return token.slice(-4);
}

export async function verifyFirecrawlKey(
  key: string,
  baseUrl: string,
  timeoutMs = 10_000,
): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/team/credit-usage`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    return { state: "unreachable", detail: String(err) };
  }
  if (res.status === 401 || res.status === 403) return { state: "rejected" };
  if (res.ok || res.status === 404) return { state: "valid" };
  return { state: "unreachable", detail: `HTTP ${res.status}` };
}

export async function firecrawlLoginCommand(
  key: string | undefined,
  opts: { force?: boolean; env?: NodeJS.ProcessEnv; machine?: boolean; args?: string[] } = {},
): Promise<LoginOutcome> {
  const env = opts.env ?? process.env;
  const trimmed = (key ?? "").trim();
  if (!trimmed) {
    return {
      output:
        "usage: foo login --firecrawl <key>     (your own Firecrawl API key)\n" +
        "       foo logout --firecrawl          (forget it)\n",
      exitCode: 1,
    };
  }

  const base = (env.FIRECRAWL_BASE_URL || "").trim() || "https://api.firecrawl.dev";
  const fp = tokenFingerprint(trimmed);

  if (!opts.force) {
    const result = await verifyFirecrawlKey(trimmed, base);
    if (result.state === "rejected") {
      return {
        output:
          `✋ needs your input — Firecrawl rejected that key (…${fp}). Nothing was saved.\n` +
          "Check you pasted the whole key from firecrawl.dev; it usually starts with fc-.\n",
        exitCode: 1,
      };
    }
    if (result.state === "unreachable") {
      return {
        output:
          "🚧 blocked — couldn't reach Firecrawl to check that key, so it was NOT saved.\n" +
          "Your key was not rejected; this is a network problem. Retry, or save it unchecked with:\n" +
          "  foo login --firecrawl <key> --force\n",
        exitCode: 1,
      };
    }
  }

  const file = writeStoredFirecrawlKey(trimmed, env);
  const lines = [
    opts.force
      ? `✅ saved — Firecrawl key (…${fp}) stored unchecked at ${file} (0600).`
      : `✅ proven — Firecrawl key (…${fp}) accepted by Firecrawl and saved to ${file} (0600).`,
    "Direct Firecrawl access is active; public-web output remains untrusted and is not research proof.",
  ];
  const shadowed = (env.FIRECRAWL_API_KEY ?? "").trim();
  if (shadowed && shadowed !== trimmed) {
    lines.push(
      "",
      `⚠️ drift — FIRECRAWL_API_KEY is also set in this shell (…${tokenFingerprint(shadowed)}) and it WINS over the saved one.`,
      "Unset it here — `unset FIRECRAWL_API_KEY` — for the key you just saved to take effect.",
    );
  }
  return { output: `${lines.join("\n")}\n`, exitCode: 0 };
}

export function firecrawlLogoutCommand(env: NodeJS.ProcessEnv = process.env): LoginOutcome {
  const file = credentialsPath(env);
  const removed = clearStoredFirecrawlKey(env);
  const stillEnv = (env.FIRECRAWL_API_KEY ?? "").trim();
  const lines = removed ? [`✅ proven — forgot the saved Firecrawl key (${file}).`] : ["📋 todo — no saved Firecrawl key to forget."];
  if (stillEnv) {
    lines.push(`⚠️ drift — FIRECRAWL_API_KEY remains set in this shell (…${tokenFingerprint(stillEnv)}), so direct Firecrawl access remains active.`);
  }
  return { output: `${lines.join("\n")}\n`, exitCode: 0 };
}

// Provider availability is inventory, not research proof.
export function firecrawlKeyStatus(env: NodeJS.ProcessEnv = process.env): { present: boolean; source: string; detail: string } {
  const { key, source } = resolveFirecrawlKey(env);
  if (!key) {
    return {
      present: false,
      source: "none",
      detail: "no Firecrawl credential — web research uses the free path",
    };
  }
  return {
    present: true,
    source,
    detail:
      source === "env"
        ? `direct Firecrawl access from FIRECRAWL_API_KEY in this shell (…${tokenFingerprint(key)}) — this shell only; output remains untrusted`
        : `direct Firecrawl access from ${credentialsPath(env)} (…${tokenFingerprint(key)}) — every shell on this machine; output remains untrusted`,
  };
}
