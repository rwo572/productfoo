import assert from "node:assert/strict";
import { test } from "node:test";

import { parseGatherArgs, runResearchGather } from "../src/research.js";
import type { FetchLike, HttpResponse, YtDlp } from "../src/social/types.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");

function json(body: unknown, ok = true, status = 200): HttpResponse {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const HN = {
  hits: [
    {
      objectID: "42",
      title: "Show HN: recent thing",
      url: "https://example.com/x",
      author: "pg",
      created_at: "2026-07-05T00:00:00.000Z",
      points: 90,
      num_comments: 10,
    },
  ],
};

// Only Hacker News answers; every other host 404s so those sources report
// excluded — the executor still returns a report per source.
const fetchImpl: FetchLike = async (url) =>
  /hn\.algolia/.test(url) ? json(HN) : json({}, false, 404);
const noVideos: YtDlp = { search: async () => [] };

test("parseGatherArgs reads topic, window, sources, limit", () => {
  const a = parseGatherArgs(["agent memory", "--days", "7", "--sources", "hackernews,reddit", "--limit", "5"]);
  assert.equal(a.topic, "agent memory");
  assert.equal(a.recency.days, 7);
  assert.deepEqual(a.sources, ["hackernews", "reddit"]);
  assert.equal(a.limit, 5);
});

test("parseGatherArgs rejects an unknown source", () => {
  assert.throws(() => parseGatherArgs(["t", "--sources", "myspace"]), /unknown source/);
});

test("runResearchGather returns recent items and a report per source (json)", async () => {
  const result = await runResearchGather("/root", ["recent thing", "--json"], {
    fetchImpl,
    ytdlp: noVideos,
    now: NOW,
  });
  assert.equal(result.exitCode, 0);
  const out = JSON.parse(result.output);
  assert.equal(out.stage, "gather");
  assert.equal(out.recency.days, 30);
  // One report per default source; HN available, the rest excluded (not dropped).
  assert.equal(out.sources.length, 5);
  assert.ok(out.items.length >= 1);
  assert.equal(out.items[0].source, "hackernews");
});

test("runResearchGather renders a plain-text brief by default", async () => {
  const result = await runResearchGather("/root", ["recent thing"], { fetchImpl, ytdlp: noVideos, now: NOW });
  assert.match(result.output, /Recent signal for "recent thing" — last 30 day/);
  assert.match(result.output, /Show HN: recent thing/);
});
