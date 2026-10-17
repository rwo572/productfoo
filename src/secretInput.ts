import type { Readable, Writable } from "node:stream";

const MAX_SECRET_BYTES = 8192;

export interface MaskedSecretIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WritableStream;
  prompt: string;
}

export async function readSecretFromStream(input: Readable, maxBytes = MAX_SECRET_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(String(chunkValue));
    total += chunk.length;
    if (total > maxBytes) throw new Error("secret input is too large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("secret input is not valid UTF-8");
  bytes.fill(0);
  const trimmed = text.trim();
  if (!trimmed) throw new Error("secret input is empty");
  return trimmed;
}

export function readMaskedSecret(io: MaskedSecretIO): Promise<string> {
  const input = io.input;
  const output = io.output as Writable;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("masked secret input requires an interactive terminal"));
  }
  output.write(io.prompt);
  return new Promise<string>((resolve, reject) => {
    let secret = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      try {
        input.setRawMode(false);
      } catch {
        // Best effort terminal restoration after the descriptor disappears.
      }
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else if (!secret.trim()) reject(new Error("secret input is empty"));
      else resolve(secret.trim());
    };
    const onData = (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue.toString("utf8") : chunkValue;
      for (const character of chunk) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("secret input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character <= "~") {
          if (Buffer.byteLength(secret) >= MAX_SECRET_BYTES) {
            finish(new Error("secret input is too large"));
            return;
          }
          secret += character;
          output.write("*");
        }
      }
    };
    try {
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("could not read masked secret"));
    }
  });
}
