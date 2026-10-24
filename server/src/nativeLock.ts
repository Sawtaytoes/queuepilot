/**
 * THE TV PIN LOCK — decision `2026-10-23-the-native-tv-plays-each-queue-as-its-own-profile-and-locks-queues-with-a-pin`.
 *
 * A queue marked `is_locked_on_tv` opens on the TV only after the household TV PIN. The server
 * enforces it: every native route that reads or plays one queue asks `assertUnlocked()`, and a
 * caller without a valid unlock gets 423. The TV only decides when to show the number pad.
 *
 * Four rules, each of which is the cheap thing to get wrong:
 *
 *  1. **The PIN is never stored.** One row in `native_tv_pin` holds an scrypt hash with its own
 *     salt and cost parameters, and a guess is compared with `timingSafeEqual` over the derived
 *     key, never with `===` over a string.
 *  2. **A wrong guess costs the HOUSEHOLD, not the device.** Five wrong PINs in a row lock every
 *     unlock attempt for 60 seconds. A per-device counter would let a second device (or a
 *     changed device header) reset it, and a 4-digit PIN has only 10 000 values.
 *  3. **An unlock is a bearer capability bound to who asked.** The token is random, only its
 *     SHA-256 is kept (in memory — a restart re-asks the PIN, which is the safe direction), and
 *     it is honored only for the same verified Plex account AND the same device header it was
 *     issued to, for four hours at most. Changing or clearing the PIN revokes every unlock.
 *  4. **No PIN means nothing is locked.** A queue can be marked before a PIN exists; it opens
 *     like any other until one is set, so marking a queue can never strand it.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { bookOfRecord, prepareChecked } from "./store/db/open.js";
import type { HomeUser } from "./plex.js";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** How long one unlock opens locked queues on one device. */
export const UNLOCK_TTL_MS = 4 * 3600_000;
/** Consecutive wrong PINs before every attempt waits. */
export const MAX_WRONG_ATTEMPTS = 5;
/** How long the household waits after `MAX_WRONG_ATTEMPTS`. */
export const LOCKOUT_MS = 60_000;

const PIN_PATTERN = /^[0-9]{4,8}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** A refusal with the status the native routes answer it with. */
export class NativeLockError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 423 | 429,
    readonly retryAfterSeconds: number | null = null,
    readonly attemptsLeft: number | null = null,
  ) {
    super(message);
    this.name = "NativeLockError";
  }
}

/** Who is asking, as the native routes read it from the request. */
export interface NativeDevice {
  /** The VERIFIED household Plex account the TV is signed in as. */
  account: HomeUser;
  /** `X-QueuePilot-Device`, the TV app's own stable install identifier. */
  deviceId: string;
  /** `X-QueuePilot-Unlock`, the token `POST /api/native/unlock` returned, or empty. */
  unlockToken: string;
}

export const isValidPin = (pin: unknown): pin is string =>
  typeof pin === "string" && PIN_PATTERN.test(pin);

/** A device header we will bind an unlock to: printable, short, and present. */
export const isValidDeviceId = (deviceId: unknown): deviceId is string =>
  typeof deviceId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(deviceId);

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const accountKey = (account: HomeUser): string =>
  account.admin ? "owner" : `${account.uuid ?? ""}:${account.id ?? ""}`;

function storedHash(): string | null {
  const row = prepareChecked<{ hash: string }>(
    bookOfRecord(),
    "SELECT hash FROM native_tv_pin WHERE id = 'household'",
  ).get({});
  return row?.hash ?? null;
}

export function hasPin(): boolean {
  return storedHash() !== null;
}

async function derive(pin: string, salt: Buffer, n: number, r: number, p: number, keylen: number) {
  return scrypt(pin, salt, keylen, { N: n, r, p, maxmem: 128 * n * r * 2 });
}

/** Set (or replace) the household TV PIN. Every unlock issued under the old PIN ends. */
export async function setPin(pin: unknown): Promise<void> {
  if (!isValidPin(pin)) throw new NativeLockError("The TV PIN is 4 to 8 digits", 400);
  const salt = randomBytes(16);
  const key = await derive(pin, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  const hash = [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
  prepareChecked(
    bookOfRecord(),
    `INSERT INTO native_tv_pin (id, hash, updated_at) VALUES ('household', :hash, :updated_at)
     ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
  ).run({ hash, updated_at: new Date().toISOString() });
  revokeAll();
}

/** Remove the PIN. With no PIN nothing is locked, so every unlock is moot and is dropped. */
export function clearPin(): void {
  prepareChecked(bookOfRecord(), "DELETE FROM native_tv_pin WHERE id = 'household'").run({});
  revokeAll();
}

async function matches(pin: string, hash: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(pin, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── Attempts and unlocks: process memory, on purpose ────────────────────────────────────────

let wrongAttempts = 0;
let lockedUntil = 0;
const unlocks = new Map<string, { account: string; deviceId: string; expiresAt: number }>();

function revokeAll(): void {
  unlocks.clear();
  wrongAttempts = 0;
  lockedUntil = 0;
}

/** Test seam: forget every attempt and unlock. */
export function resetLockState(): void {
  revokeAll();
}

/**
 * Trade the PIN for an unlock token. A wrong PIN is 403 with how many tries are left; the fifth
 * wrong PIN in a row, and every attempt during the wait after it, is 429 with `retryAfterSeconds`.
 */
export async function unlock(
  account: HomeUser,
  deviceId: unknown,
  pin: unknown,
  now = Date.now(),
): Promise<{ unlockToken: string; expiresAt: number }> {
  if (!isValidDeviceId(deviceId))
    throw new NativeLockError("Send X-QueuePilot-Device with this TV's identifier", 400);
  const hash = storedHash();
  if (!hash) throw new NativeLockError("No TV PIN is set, so no queue is locked", 409);
  if (now < lockedUntil)
    throw new NativeLockError(
      "Too many wrong PINs. Wait, then try again.",
      429,
      Math.ceil((lockedUntil - now) / 1000),
    );
  // A malformed PIN still counts as a wrong one, so the shape cannot be probed for free.
  const isMatch = isValidPin(pin) && (await matches(pin, hash));
  if (!isMatch) {
    wrongAttempts++;
    if (wrongAttempts >= MAX_WRONG_ATTEMPTS) {
      wrongAttempts = 0;
      lockedUntil = now + LOCKOUT_MS;
      throw new NativeLockError(
        "Too many wrong PINs. Wait, then try again.",
        429,
        Math.ceil(LOCKOUT_MS / 1000),
      );
    }
    throw new NativeLockError(
      `That PIN is not correct. ${MAX_WRONG_ATTEMPTS - wrongAttempts} tries left.`,
      403,
      null,
      MAX_WRONG_ATTEMPTS - wrongAttempts,
    );
  }
  wrongAttempts = 0;
  for (const [key, value] of unlocks) if (value.expiresAt <= now) unlocks.delete(key);
  const unlockToken = randomBytes(32).toString("base64url");
  const expiresAt = now + UNLOCK_TTL_MS;
  unlocks.set(sha256(unlockToken), { account: accountKey(account), deviceId, expiresAt });
  return { unlockToken, expiresAt };
}

/** Is this device's unlock valid right now? False for a missing, foreign, or expired token. */
export function isUnlocked(device: NativeDevice, now = Date.now()): boolean {
  if (!device.unlockToken || device.unlockToken.length > 256) return false;
  const found = unlocks.get(sha256(device.unlockToken));
  if (!found || found.expiresAt <= now) return false;
  return found.account === accountKey(device.account) && found.deviceId === device.deviceId;
}

/** Is this queue locked right now? Only when it is marked AND a PIN exists. */
export function isQueueLocked(set: { is_locked_on_tv?: boolean } | null | undefined): boolean {
  return Boolean(set?.is_locked_on_tv) && hasPin();
}

/** Refuse a locked queue to a device without a valid unlock. */
export function assertUnlocked(
  set: { is_locked_on_tv?: boolean } | null | undefined,
  device: NativeDevice,
): void {
  if (isQueueLocked(set) && !isUnlocked(device))
    throw new NativeLockError("This queue is locked. Enter the TV PIN to open it.", 423);
}
