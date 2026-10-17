// Worker entry for the packet index's parallel per-packet derivation
// (cli-performance-v0 R-001).
//
// Message-free by design: the parent blocks synchronously in Atomics.wait
// (derivePacketIndex must stay synchronous for its callers), so it could not
// receive a postMessage while blocked. Results instead cross through this
// worker's SharedArrayBuffer slot: header cell (0 pending, 1 done, 2 failed),
// a byte-length cell, then the JSON-encoded entries.
//
// Each packet is still read once and parsed once (derivePacketEntry); workers
// only split the packets across cores.

import { workerData } from "node:worker_threads";
import { derivePacketEntry } from "./packetIndexEntry.js";

export interface PacketIndexWorkerData {
  root: string;
  dirs: string[];
  sab: SharedArrayBuffer;
  slotBase: number;
  regionBytes: number;
}

// Slot layout: [Int32 header][Int32 byteLength][Uint8 region].
const LENGTH_OFFSET = 4;
const REGION_OFFSET = 8;

const DONE = 1;
const FAILED = 2;

function finish(sab: SharedArrayBuffer, slotBase: number, state: number, payload?: Uint8Array): void {
  const header = new Int32Array(sab, slotBase, 1);
  if (payload) {
    new Int32Array(sab, slotBase + LENGTH_OFFSET, 1)[0] = payload.byteLength;
    new Uint8Array(sab, slotBase + REGION_OFFSET, payload.byteLength).set(payload);
  }
  Atomics.store(header, 0, state);
  Atomics.notify(header, 0);
}

try {
  const data = workerData as PacketIndexWorkerData;
  const entries = data.dirs.map((dir) => derivePacketEntry(data.root, dir));
  const encoded = new TextEncoder().encode(JSON.stringify(entries));
  const capacity = data.regionBytes - REGION_OFFSET;
  if (encoded.byteLength > capacity) {
    // Chunk too large for its slot: flag it and let the parent fall back to
    // the serial path rather than truncating output.
    finish(data.sab, data.slotBase, FAILED);
  } else {
    finish(data.sab, data.slotBase, DONE, encoded);
  }
} catch {
  const data = workerData as PacketIndexWorkerData;
  finish(data.sab, data.slotBase, FAILED);
}
