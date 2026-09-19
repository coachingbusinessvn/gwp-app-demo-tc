import { argon2id, hash, verify, type HashOptions } from "argon2";

/**
 * Argon2id password hashing (spec §8: cost measured on the pilot hardware,
 * not copied from defaults).
 *
 * Measured on the dev machine (Apple Silicon, Node 26, argon2 0.45.1):
 *   m=19 MiB t=2 p=1 → hash ~49 ms / verify ~30 ms   (OWASP floor — too fast)
 *   m=64 MiB t=3 p=1 → hash ~242 ms / verify ~134 ms ← chosen
 *   m=64 MiB t=4 p=2 → hash ~90 ms / verify ~91 ms
 *   m=128 MiB t=3 p=4 → hash ~182 ms / verify ~97 ms
 *
 * 64 MiB / t=3 / p=1 lands in the ~250 ms budget for login/setup without
 * memory-pressure risk on the 8 GiB pilot target. Re-benchmark if the
 * deployment hardware differs.
 */
export const ARGON2ID_PARAMS = {
  type: argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const satisfies HashOptions;

export async function hashPassword(raw: string): Promise<string> {
  return hash(raw, ARGON2ID_PARAMS);
}

/** Returns false on any mismatch or malformed digest — never throws. */
export async function verifyPassword(
  digest: string,
  raw: string,
): Promise<boolean> {
  try {
    return await verify(digest, raw);
  } catch {
    return false;
  }
}
