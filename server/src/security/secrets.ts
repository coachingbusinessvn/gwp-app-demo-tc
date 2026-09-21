import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { AppError } from "../shared/errors.js";

/**
 * Envelope encryption for customer-held secrets (spec §7.1/§9): the BYOK AI
 * key is the only secret stored in the database today. AES-256-GCM with a
 * random 96-bit nonce; the authentication tag binds the ciphertext to its
 * AAD — `companyId:keyVersion` — so an envelope copied to another company
 * or replayed under a different key version cannot be opened.
 *
 * Key material: APP_KEY is a versioned ring, `vN=<material>` comma-separated,
 * where the highest N encrypts and every retained version decrypts. A bare
 * string is the one-entry ring "v1". Material is hashed with SHA-256 to a
 * fixed 32-byte AES key, so the env format stays agnostic (any ≥32-char
 * secret works); rotation appends `v2=...` and keeps `v1=...` until all
 * envelopes are re-encrypted.
 *
 * Failure contract: every failure path throws a controlled AppError with a
 * stable code — never a raw crypto error carrying internal detail.
 */
export interface SecretEnvelope {
  ciphertext: string; // base64
  iv: string; // base64, 12 bytes
  tag: string; // base64, 16 bytes
  keyVersion: string;
}

export interface KeyRingEntry {
  version: string;
  key: Buffer;
}

export const SECRET_KEY_UNKNOWN_VERSION = "SECRET_KEY_UNKNOWN_VERSION";
export const SECRET_DECRYPT_FAILED = "SECRET_DECRYPT_FAILED";

const KEY_VERSION_RE = /^v[1-9][0-9]*$/;

function deriveKey(material: string): Buffer {
  return createHash("sha256").update(material, "utf8").digest();
}

/**
 * Parse APP_KEY into a ring. Accepts `v3=xxx,v1=yyy` or a bare `xxx` (→ v1).
 * Throws at boot on malformed input — a bad ring is a config error, fatal.
 */
export function parseKeyRing(raw: string): KeyRingEntry[] {
  const entries: KeyRingEntry[] = [];
  const seen = new Set<string>();
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("config: APP_KEY ring is empty");
  for (const part of parts) {
    const eq = part.indexOf("=");
    let version = "v1";
    let material = part;
    if (eq !== -1) {
      version = part.slice(0, eq).trim();
      material = part.slice(eq + 1).trim();
      if (!KEY_VERSION_RE.test(version))
        throw new Error(`config: APP_KEY entry has bad version "${version}"`);
    } else if (parts.length > 1) {
      throw new Error(
        "config: APP_KEY mixes bare and versioned entries — use vN= for all",
      );
    }
    if (material.length < 32)
      throw new Error(
        `config: APP_KEY ${version} material < 32 chars`,
      );
    if (seen.has(version))
      throw new Error(`config: APP_KEY repeats version ${version}`);
    seen.add(version);
    entries.push({ version, key: deriveKey(material) });
  }
  // Highest version encrypts; the whole ring decrypts.
  entries.sort(
    (a, b) =>
      Number(b.version.slice(1)) - Number(a.version.slice(1)),
  );
  return entries;
}

/** The ring's active (encrypting) entry — always entries[0] post-sort. */
function activeEntry(ring: KeyRingEntry[]): KeyRingEntry {
  const active = ring[0];
  if (!active) throw new Error("config: APP_KEY ring is empty");
  return active;
}

/**
 * Extend a parsed ring with a new encrypting version (task 4.5 rotation).
 * The new version must be strictly higher than every existing one — a
 * downgrade or duplicate is a config error, never a silent reuse. Returns
 * a NEW ring; the caller's ring is untouched.
 */
export function addRingEntry(
  ring: KeyRingEntry[],
  version: string,
  material: string,
): KeyRingEntry[] {
  if (!KEY_VERSION_RE.test(version)) {
    throw new Error(`rotate-key: bad version "${version}" — expected vN`);
  }
  if (ring.some((e) => e.version === version)) {
    throw new Error(`rotate-key: version ${version} already in the ring`);
  }
  const top = Number(activeEntry(ring).version.slice(1));
  if (Number(version.slice(1)) <= top) {
    throw new Error(
      `rotate-key: ${version} is not above the current active v${top}`,
    );
  }
  if (material.length < 32) {
    throw new Error("rotate-key: new material < 32 chars");
  }
  return [{ version, key: deriveKey(material) }, ...ring].sort(
    (a, b) => Number(b.version.slice(1)) - Number(a.version.slice(1)),
  );
}

function aadOf(companyId: string, keyVersion: string): Buffer {
  return Buffer.from(`${companyId}:${keyVersion}`, "utf8");
}

export function encryptSecret(
  plain: string,
  ring: KeyRingEntry[],
  companyId: string,
): SecretEnvelope {
  const { version, key } = activeEntry(ring);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadOf(companyId, version));
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion: version,
  };
}

/**
 * Open an envelope. Unknown version → SECRET_KEY_UNKNOWN_VERSION; a tag
 * mismatch (wrong key, wrong company, tampered envelope) → SECRET_DECRYPT_FAILED.
 * Both are AppError so callers serialise a controlled envelope, never a throw.
 */
export function decryptSecret(
  envelope: SecretEnvelope,
  ring: KeyRingEntry[],
  companyId: string,
): string {
  const entry = ring.find((e) => e.version === envelope.keyVersion);
  if (!entry) {
    throw new AppError(
      500,
      SECRET_KEY_UNKNOWN_VERSION,
      "APP_KEY không còn phiên bản giải mã được — cần nhập lại key",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      entry.key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(aadOf(companyId, envelope.keyVersion));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      500,
      SECRET_DECRYPT_FAILED,
      "Không giải mã được key AI đã lưu — APP_KEY đổi hoặc dữ liệu hỏng; hãy nhập lại key",
    );
  }
}
