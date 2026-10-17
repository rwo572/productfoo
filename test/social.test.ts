import assert from "node:assert/strict";
import { test } from "node:test";

import { dedupe, gatherSocial } from "../src/social/index.js";
import { fetchHackerNews } from "../src/social/hackernews.js";
import { fetchReddit } from "../src/social/reddit.js";
import type { FetchLike, SocialItem } from "../src/social/types.js";
import { parseVtt } from "../src/social/youtube.js";

test("parseVtt remains a pure text parser", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

1
00:00:00.000 --> 00:00:02.000
<c>hello</c> world

2
00:00:02.000 --> 00:00:04.000
hello world

3
00:00:04.000 --> 00:00:06.000
this is a talk
`;
  assert.equal(parseVtt(vtt), "hello world this is a talk");
});

test("dedupe remains a pure normalization helper", () => {
  const now = "2026-07-11T00:00:00.000Z";
  const items: SocialItem[] = [
    {
      source: "hackernews",
      id: "hn:1",
      title: "A",
      url: "https://example.com/post/",
      author: null,
      createdAt: now,
      score: 10,
      snippet: null,
    },
    {
      source: "reddit",
      id: "reddit:1",
      title: "A (crosspost)",
      url: "https://www.example.com/post",
      author: null,
      createdAt: now,
      score: 42,
      snippet: null,
    },
  ];

  const out = dedupe(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 42);
});

// --- Fetch timeout (#774) ----------------------------------------------------------------
// gatherSocial runs Promise.all over the adapters and relies on each one being
// total: a source that hung (no explicit timeout anywhere) stalled the whole
// gather for minutes, and an adapter that REJECTED on abort would crash it.
// These tests inject a fetch that never answers plus a minimal timeoutMs, and
// assert both halves of the contract: the fetch really aborts, and the adapter
// still returns its error result.

// Behaves like real fetch against a dead endpoint: never answers, rejects with
// the signal's abort reason (as undici does), and reports observed aborts.
function hangingFetch(onAbort?: () => void): FetchLike {
  return (_url, init) =>
    new Promise((_, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("hangingFetch: adapter passed no AbortSignal"));
        return;
      }
      if (signal.aborted) {
        onAbort?.();
        reject(signal.reason);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          onAbort?.();
          reject(signal.reason);
        },
        { once: true },
      );
    });
}

// AbortSignal.timeout's timer is unref'ed — it only fires while something else
// holds the event loop. A real gather always has such a handle (the hung
// fetch's own socket, the CLI's stdio), but a bare unit test does not, and the
// loop would drain before the ceiling fires. Hold the loop open for the
// duration, exactly as the live caller would, then release it.
async function withLiveLoop<T>(run: () => Promise<T>): Promise<T> {
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    return await run();
  } finally {
    clearTimeout(keepAlive);
  }
}

// 10s ceiling so a regression that forgets the abort fails the test instead of
// hanging the suite forever.
test("a hung fetch aborts and hackernews returns its error result, never rejects", { timeout: 10_000 }, async () => {
  await withLiveLoop(async () => {
    let aborts = 0;
    const result = await fetchHackerNews("timeouts", {
      timeoutMs: 5, // minimal: the injected fetch never answers, only the ceiling resolves this
      fetchImpl: hangingFetch(() => {
        aborts += 1;
      }),
    });
    assert.ok(aborts > 0, "the injected fetch must observe the abort, not just fail");
    assert.equal(result.status, "excluded");
    assert.deepEqual(result.items, []);
    assert.match(result.reason, /failed/i);
  });
});

test("reddit's strategy chain fails fast on the aborted signal and still returns excluded", { timeout: 10_000 }, async () => {
  await withLiveLoop(async () => {
    const result = await fetchReddit("timeouts", { timeoutMs: 5, fetchImpl: hangingFetch() });
    assert.equal(result.status, "excluded");
    assert.deepEqual(result.items, []);
  });
});

test("gatherSocial resolves when every HTTP source aborts — Promise.all gets no rejection", { timeout: 10_000 }, async () => {
  await withLiveLoop(async () => {
    const { items, reports } = await gatherSocial("timeouts", {
      timeoutMs: 5,
      sources: ["reddit", "hackernews", "arxiv", "github"],
      fetchImpl: hangingFetch(),
    });
    assert.deepEqual(items, []);
    assert.equal(reports.length, 4);
    for (const report of reports) {
      assert.equal(report.status, "excluded");
      assert.deepEqual(report.items, []);
    }
  });
});
