// YouTube adapter — keyless, but via the yt-dlp binary rather than an HTTP API
// (upstream last30days does the same: "no API keys needed — just have yt-dlp
// installed"). yt-dlp is a *dependency*, not a secret, so YouTube stays a
// free-tier source (D-004). When yt-dlp is absent the source degrades honestly
// and the run continues — it never crashes (R-003 done_when).
//
// V0 covers recency-scoped search with view-count engagement. Transcript
// extraction (a bounded per-video enrichment) is a follow-on — see OQ-5 — kept
// out of V0 because it needs on-disk subtitle handling that would ship untested.
//
// The yt-dlp boundary is injected (types.ts YtDlp) so the adapter's recency and
// status logic is unit-tested with a fake and no binary runs in the suite.

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AdapterOptions, AdapterResult, SocialItem, YtDlp, YtVideo } from "./types.js";
import { resolveOptions, settleStatus, withinWindow } from "./types.js";

const execFileAsync = promisify(execFile);

// How many top videos to enrich with a transcript per run — bounded so a run
// never fans out an unbounded number of subtitle fetches.
const TRANSCRIPT_LIMIT = 3;
const TRANSCRIPT_MAX_CHARS = 500;

// Hard ceiling on each yt-dlp process. A shell-out has no fetch signal to
// respect, so without this a hung yt-dlp stalled the whole gather for minutes
// (#774). Generous — a ytsearch fans out several upstream requests — but a
// bound: the child is killed and the adapter reports `excluded` like any other
// failure.
const YTDLP_TIMEOUT_MS = 120_000;

// Thrown by a YtDlp implementation when the binary is not installed, so the
// adapter can distinguish "not set up" (degrade + how-to) from "ran and failed".
export class MissingBinaryError extends Error {
  constructor(message = "yt-dlp is not installed") {
    super(message);
    this.name = "MissingBinaryError";
  }
}

interface RawVideo {
  id?: string;
  title?: string;
  webpage_url?: string;
  url?: string;
  uploader?: string;
  channel?: string;
  upload_date?: string; // YYYYMMDD
  view_count?: number;
}

// Default implementation: shells out to yt-dlp and streams one JSON object per
// result. `ytsearchN:` is yt-dlp's search selector; --dump-json emits full
// metadata (upload_date, view_count) per video.
export const defaultYtDlp: YtDlp = {
  async search(query: string, n: number): Promise<YtVideo[]> {
    try {
      const { stdout } = await execFileAsync(
        "yt-dlp",
        ["--dump-json", "--no-warnings", `ytsearch${n}:${query}`],
        { maxBuffer: 32 * 1024 * 1024, timeout: YTDLP_TIMEOUT_MS },
      );
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): YtVideo | null => {
          try {
            const v = JSON.parse(line) as RawVideo;
            if (!v.id || !v.title) return null;
            return {
              id: v.id,
              title: v.title,
              url: v.webpage_url || v.url || `https://www.youtube.com/watch?v=${v.id}`,
              uploader: v.uploader ?? v.channel ?? null,
              uploadDate: v.upload_date ?? "",
              viewCount: typeof v.view_count === "number" ? v.view_count : null,
            };
          } catch {
            return null;
          }
        })
        .filter((v): v is YtVideo => v !== null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new MissingBinaryError();
      if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
        throw new Error(`yt-dlp did not finish within ${YTDLP_TIMEOUT_MS / 1000}s (process killed)`);
      }
      throw err;
    }
  },

  // Best-effort auto-subtitle fetch. yt-dlp writes subtitles to disk, so we use
  // an isolated temp dir, read the VTT back, and always clean up. Any failure
  // (no captions, network, missing binary) yields null — a transcript is
  // enrichment, never a reason to fail the item.
  async transcript(videoId: string): Promise<string | null> {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "foo-yt-"));
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      await execFileAsync(
        "yt-dlp",
        [
          "--skip-download",
          "--write-auto-subs",
          "--sub-lang",
          "en",
          "--sub-format",
          "vtt",
          "--no-warnings",
          "-o",
          path.join(dir, "%(id)s.%(ext)s"),
          url,
        ],
        { maxBuffer: 32 * 1024 * 1024, timeout: YTDLP_TIMEOUT_MS },
      );
      const files = await readdir(dir);
      const vttFile = files.find((f) => f.endsWith(".vtt"));
      if (!vttFile) return null;
      const text = parseVtt(await readFile(path.join(dir, vttFile), "utf8"));
      return text || null;
    } catch {
      return null;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

// Reduce a WebVTT caption file to plain running text: drop the header, cue
// indices, timestamp lines, and inline tags, and collapse the duplicate lines
// that auto-generated rolling captions produce.
export function parseVtt(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT") continue;
    if (line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.includes("-->")) continue; // timestamp cue
    if (/^\d+$/.test(line)) continue; // cue index
    const text = line
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
    if (!text || out[out.length - 1] === text) continue; // dedupe rolling captions
    out.push(text);
  }
  return out.join(" ");
}

// yt-dlp's upload_date is "YYYYMMDD"; normalize to an ISO instant so the shared
// recency filter can parse it. Pass through anything already ISO-ish.
function normalizeDate(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
  return raw;
}

function toItem(v: YtVideo): SocialItem | null {
  if (!v.uploadDate) return null; // no date → cannot place in the window
  return {
    source: "youtube",
    id: `youtube:${v.id}`,
    title: v.title,
    url: v.url,
    author: v.uploader,
    createdAt: normalizeDate(v.uploadDate),
    score: v.viewCount,
    snippet: null,
  };
}

export async function fetchYouTube(
  query: string,
  opts: AdapterOptions = {},
): Promise<AdapterResult> {
  const { days, limit, now } = resolveOptions(opts);
  const ytdlp = opts.ytdlp ?? defaultYtDlp;

  try {
    const videos = await ytdlp.search(query, limit);
    const items = videos
      .map(toItem)
      .filter((it): it is SocialItem => it !== null)
      .filter((it) => withinWindow(it.createdAt, now, days))
      .slice(0, limit);
    if (items.length === 0) {
      return {
        source: "youtube",
        status: "degraded",
        reason: `yt-dlp ran but found no videos within ${days}d.`,
        items,
      };
    }
    // Best-effort transcript enrichment for the top few videos (bounded).
    let transcribed = 0;
    if (ytdlp.transcript) {
      const fetchTranscript = ytdlp.transcript.bind(ytdlp);
      await Promise.all(
        items.slice(0, TRANSCRIPT_LIMIT).map(async (it) => {
          const text = await fetchTranscript(it.id.replace(/^youtube:/, ""));
          if (text) {
            it.snippet = text.slice(0, TRANSCRIPT_MAX_CHARS);
            transcribed += 1;
          }
        }),
      );
    }
    return {
      source: "youtube",
      status: settleStatus("available", items.length),
      reason:
        `yt-dlp returned ${items.length} video(s) within ${days}d` +
        (transcribed > 0 ? `, ${transcribed} with transcript.` : "."),
      items,
    };
  } catch (err) {
    if (err instanceof MissingBinaryError) {
      return {
        source: "youtube",
        status: "excluded",
        reason: "yt-dlp is not installed; install it (e.g. brew install yt-dlp) to enable YouTube.",
        items: [],
      };
    }
    return {
      source: "youtube",
      status: "excluded",
      reason: `yt-dlp failed: ${(err as Error).message}`,
      items: [],
    };
  }
}
