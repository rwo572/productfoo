// productfoo's research signing key — T-005 wiring, Decision 1 (owner-agreed 2026-07-20).
//
// productfoo self-signs research completion receipts. The private key is machine-local
// (never committed — B1); the public key is published in a repo-tracked trust
// store so any reviewer on a fresh clone can verify a paper's receipt. Forgery
// needs the private key, which never leaves the machine; verification is public.
//
// Residual (recorded, deferred): one active key, no rotation/revocation ceremony
// yet. The envelope already carries key status (active/retired/revoked), so
// rotation is additive later. This is the minimal answer for the foo namespace
// only — it does not resolve the customer key ceremony verdict still waits on.

import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SplitTrustStores, TrustStore, TrustedSigningKey } from "./trustEnvelope.js";

export interface FooSigningKey {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface KeyProvisionOptions {
  /** Override the machine-local key directory (tests only). */
  keyDir?: string;
  /** Timestamp for a freshly-minted key's valid_from (tests inject; prod uses now). */
  now?: string;
}

const defaultKeyDir = (): string => path.join(homedir(), ".foo", "keys");
const privPath = (dir: string): string => path.join(dir, "research-signing.pem");
const pubPath = (dir: string): string => path.join(dir, "research-signing.pub.pem");
const trustStorePath = (root: string): string => path.join(root, "research", ".trust", "foo-research.json");

function keyIdFor(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `foo-research-${createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

function readTrustStoreFile(root: string): TrustStore<"foo"> {
  const file = trustStorePath(root);
  if (!existsSync(file)) return { namespace: "foo", keys: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && (raw as TrustStore).namespace === "foo" && Array.isArray((raw as TrustStore).keys)) {
      return raw as TrustStore<"foo">;
    }
  } catch {
    /* fall through to empty — an unreadable store verifies nothing, which is safe */
  }
  return { namespace: "foo", keys: [] };
}

function writeTrustStore(root: string, store: TrustStore<"foo">): void {
  const file = trustStorePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** Add a public key to the tracked trust store if not already present. */
function publishPublicKey(root: string, key: TrustedSigningKey): void {
  const store = readTrustStoreFile(root);
  if (store.keys.some((k) => k.key_id === key.key_id)) return;
  writeTrustStore(root, { namespace: "foo", keys: [...store.keys, key] });
}

/** The split trust stores a verifier loads: productfoo's published research keys, and an
 *  empty customer store (research receipts are foo-namespace). */
export function loadFooResearchTrustStores(root: string): SplitTrustStores {
  return {
    customer: { namespace: "customer", keys: [] },
    foo: readTrustStoreFile(root),
  };
}

/** Load productfoo's research signing key, generating it on first use. Generating also
 *  publishes the public key into the tracked trust store, so a receipt minted
 *  here verifies for anyone who clones the repo. Idempotent. */
export function loadOrCreateFooSigningKey(root: string, options: KeyProvisionOptions = {}): FooSigningKey {
  const dir = options.keyDir ?? defaultKeyDir();
  if (existsSync(privPath(dir))) {
    const privateKeyPem = readFileSync(privPath(dir), "utf8");
    const publicKeyPem = existsSync(pubPath(dir))
      ? readFileSync(pubPath(dir), "utf8")
      : createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
    const keyId = keyIdFor(publicKeyPem);
    // ensure the tracked store carries this key (e.g. a clone missing the store)
    publishPublicKey(root, {
      key_id: keyId,
      public_key_pem: publicKeyPem,
      status: "active",
      valid_from: options.now ?? new Date().toISOString(),
      valid_until: null,
    });
    return { keyId, privateKeyPem, publicKeyPem };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = keyIdFor(publicKeyPem);
  mkdirSync(dir, { recursive: true });
  writeFileSync(privPath(dir), privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath(dir), publicKeyPem, { mode: 0o644 });
  publishPublicKey(root, {
    key_id: keyId,
    public_key_pem: publicKeyPem,
    status: "active",
    valid_from: options.now ?? new Date().toISOString(),
    valid_until: null,
  });
  return { keyId, privateKeyPem, publicKeyPem };
}
