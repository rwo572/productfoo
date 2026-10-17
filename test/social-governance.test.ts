// The social source inventory remains explicit and stable — a change to the
// default set is a deliberate act, not a silent drift.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SOURCES } from "../src/social/index.js";

test("the social source inventory remains explicit and stable", () => {
  assert.deepEqual(DEFAULT_SOURCES, ["reddit", "hackernews", "arxiv", "github", "youtube"]);
});
