import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { readMaskedSecret, readSecretFromStream } from "../src/secretInput.js";

class FakeTTY extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  resume() {}
  pause() {}
  setRawMode(value: boolean) {
    this.raw.push(value);
  }
}

test("masked input never echoes token characters", async () => {
  const input = new FakeTTY();
  let output = "";
  const promise = readMaskedSecret({
    input: input as never,
    output: { write: (chunk: string) => { output += chunk; return true; } } as never,
    prompt: "Access token: ",
  });
  input.emit("data", Buffer.from("foo-alpha-secret"));
  input.emit("data", Buffer.from("\r"));
  assert.equal(await promise, "foo-alpha-secret");
  assert.equal(output.includes("foo-alpha-secret"), false);
  assert.match(output, /^Access token: \*+\n$/);
  assert.deepEqual(input.raw, [true, false]);
});

test("descriptor/stdin secret input is bounded and trimmed without output", async () => {
  const input = new PassThrough();
  input.end("  foo-alpha-stdin  \n");
  assert.equal(await readSecretFromStream(input), "foo-alpha-stdin");

  const oversized = new PassThrough();
  oversized.end("x".repeat(9000));
  await assert.rejects(readSecretFromStream(oversized), /too large/);
});
