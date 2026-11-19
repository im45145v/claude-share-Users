import crypto from "node:crypto";
import { webcrypto } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import { toBase58 } from "@shared/base58";
import type { ConnectionFile, SharerAccount } from "@shared/types";
import { AccessRegistry } from "./access";
import { UserStore } from "./users";

function randomBytes(n: number): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(n));
}

export type SessionStatus = "waiting" | "active" | "expired" | "revoked";

export interface MachineSession {
  id: string;
  startedAt: Date;
  lastActiveAt: Date;
  active: boolean;
}

export interface Machine {
  id: string;
  userId: string;
  name: string;
  pairedAt: Date;
  sessions: Map<string, MachineSession>;
  proxyPass: string;
}

export type { ConnectionFile, SharerAccount } from "@shared/types";

export interface Session {
  id: string;
  /** Current pairing key — replaced each time a new pairing code is generated */
  key: Uint8Array;
  pairingCode: string;
  /** True after a machine successfully pairs with this code */
  pairingCodeUsed: boolean;
  pairingUserId: string | null;
  sharedUntil: Date;
  machines: Map<string, Machine>;
  status: SessionStatus;
  createdAt: Date;
  pairingAttempts: Map<string, number>;
  users: UserStore;
  access: AccessRegistry;
  unsubscribeUsers: () => void;
}

let currentSession: Session | null = null;

export function createSession(durationMs: number, users = new UserStore()): Session {
  const key = randomBytes(32);
  const sharedUntil = new Date(Date.now() + durationMs);
  currentSession = {
    id: crypto.randomUUID(),
    key,
    pairingCode: toBase58(key),
    pairingCodeUsed: true,
    pairingUserId: null,
    sharedUntil,
    machines: new Map(),
    status: "waiting",
    createdAt: new Date(),
    pairingAttempts: new Map(),
    users,
    access: new AccessRegistry(users, sharedUntil),
    unsubscribeUsers: () => {},
  };
  const session = currentSession;
  session.unsubscribeUsers = users.subscribe((user) => {
    if (user.id === session.pairingUserId && user.status !== "enabled") {
      session.key.fill(0);
      session.pairingCode = "";
      session.pairingCodeUsed = true;
      session.pairingUserId = null;
    }
  });
  session.access.onClose((id) => {
    for (const machine of session.machines.values()) {
      const active = machine.sessions.get(id);
      if (active) {
        active.active = false;
        active.lastActiveAt = new Date();
      }
    }
  });
  return session;
}

export function getSession(): Session | null {
  return currentSession;
}

/** Generates a fresh pairing code + key, allowing one more machine to pair. */
export function regeneratePairingCode(session: Session, userId: string): void {
  const user = session.users.get(userId);
  if (!user || user.status !== "enabled") throw new Error("User is disabled or revoked");
  const newKey = randomBytes(32);
  session.key.fill(0);
  session.key = newKey;
  session.pairingCode = toBase58(newKey);
  session.pairingCodeUsed = false;
  session.pairingUserId = userId;
  session.pairingAttempts.clear();
}

/** Encrypts a ConnectionFile for delivery to receiver. Returns hex-encoded blob. */
export function encryptConnectionFile(session: Session, file: ConnectionFile): string {
  const plaintext = new TextEncoder().encode(JSON.stringify(file));
  const nonce = randomBytes(24);
  const cipher = xchacha20poly1305(session.key, nonce);
  const ciphertext = cipher.encrypt(plaintext);
  return Buffer.from(nonce).toString("hex") + Buffer.from(ciphertext).toString("hex");
}

/** Constant-time pairing code check. Returns false if already used or brute-forced. */
export function checkPairingCode(session: Session, ip: string, code: string): boolean {
  if (session.pairingCodeUsed || !session.pairingUserId) return false;

  const attempts = session.pairingAttempts.get(ip) ?? 0;
  if (attempts >= (ip === "unknown" ? 20 : 5)) return false;

  const expected = Buffer.from(session.pairingCode.slice(0, 5), "utf8");
  const provided = /^[1-9A-HJ-NP-Za-km-z]{5}$/.test(code)
    ? Buffer.from(code, "utf8")
    : Buffer.alloc(5);
  const match = crypto.timingSafeEqual(expected, provided);

  if (!match) session.pairingAttempts.set(ip, attempts + 1);
  return match;
}

function deduplicateName(session: Session, baseName: string): string {
  const names = new Set([...session.machines.values()].map((m) => m.name));
  if (!names.has(baseName)) return baseName;
  let i = 2;
  while (names.has(`${baseName} (${i})`)) i++;
  return `${baseName} (${i})`;
}

/** Creates a Machine entry and burns the current pairing code (one-time use). */
export function addMachine(session: Session, name: string): Machine {
  if (!session.pairingUserId) throw new Error("No active invitation");
  const { enrollment, password } = session.access.enroll(session.pairingUserId, name);
  const machine: Machine = {
    id: enrollment.id,
    userId: enrollment.userId,
    name: deduplicateName(session, name),
    pairedAt: new Date(),
    sessions: new Map(),
    proxyPass: password,
  };
  session.machines.set(machine.id, machine);
  session.pairingCodeUsed = true;
  session.status = "active";
  return machine;
}

export function isSessionExpired(session: Session): boolean {
  return Date.now() >= session.sharedUntil.getTime();
}

export function destroySession(): void {
  if (currentSession) {
    currentSession.access.dispose();
    currentSession.unsubscribeUsers();
    currentSession.key.fill(0);
    currentSession = null;
  }
}
