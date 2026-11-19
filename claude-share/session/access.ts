import crypto from "node:crypto";

import type { ShareUser, UserStore } from "./users";

const LEASE_MS = 90_000;

export interface Enrollment {
  id: string;
  userId: string;
  deviceName: string;
  passwordHash: Buffer;
}

export interface AccessSession {
  id: string;
  enrollmentId: string;
  userId: string;
  passwordHash: Buffer;
  startedAt: number;
  lastActiveAt: number;
}

export type StartResult =
  | { ok: true; session: AccessSession; password: string }
  | { ok: false; reason: "disabled" | "limit" | "expired" };

function secret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hash(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

function parseBasic(header: string): [string, string] | null {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  const text = Buffer.from(match[1], "base64").toString("utf8");
  const colon = text.indexOf(":");
  return colon > 0 ? [text.slice(0, colon), text.slice(colon + 1)] : null;
}

function matches(expected: Buffer, password: string): boolean {
  return crypto.timingSafeEqual(expected, hash(password));
}

export class AccessRegistry {
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly sessions = new Map<string, AccessSession>();
  private readonly closeListeners = new Set<(sessionId: string) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    privateUsers: UserStore,
    privateUntil: Date,
    clock: () => number = Date.now,
  ) {
    this.users = privateUsers;
    this.sharedUntil = privateUntil;
    this.now = clock;
    this.unsubscribe = this.users.subscribe((user) => this.applyUserChange(user));
  }

  private readonly users: UserStore;
  private readonly sharedUntil: Date;
  private readonly now: () => number;

  enroll(userId: string, deviceName: string): { enrollment: Enrollment; password: string } {
    if (this.now() >= this.sharedUntil.getTime()) throw new Error("Sharing expired");
    const user = this.users.get(userId);
    if (!user || user.status !== "enabled") throw new Error("User is disabled or revoked");
    const password = secret();
    const enrollment: Enrollment = {
      id: crypto.randomUUID(),
      userId,
      deviceName,
      passwordHash: hash(password),
    };
    this.enrollments.set(enrollment.id, enrollment);
    return { enrollment, password };
  }

  authenticate(header: string): Enrollment | null {
    if (this.now() >= this.sharedUntil.getTime()) return null;
    const parsed = parseBasic(header);
    if (!parsed) return null;
    const enrollment = this.enrollments.get(parsed[0]);
    if (!enrollment || !matches(enrollment.passwordHash, parsed[1])) return null;
    return enrollment;
  }

  start(enrollment: Enrollment): StartResult {
    this.sweep();
    if (this.now() >= this.sharedUntil.getTime()) return { ok: false, reason: "expired" };
    if (this.enrollments.get(enrollment.id) !== enrollment) {
      return { ok: false, reason: "disabled" };
    }
    const user = this.users.get(enrollment.userId);
    if (!user || user.status !== "enabled") return { ok: false, reason: "disabled" };
    const count = [...this.sessions.values()].filter((session) => session.userId === user.id).length;
    if (count >= user.sessionLimit) return { ok: false, reason: "limit" };
    const password = secret();
    const session: AccessSession = {
      id: crypto.randomUUID(),
      enrollmentId: enrollment.id,
      userId: user.id,
      passwordHash: hash(password),
      startedAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return { ok: true, session, password };
  }

  authenticateProxy(header: string): AccessSession | null {
    this.sweep();
    const parsed = parseBasic(header);
    if (!parsed) return null;
    const session = this.sessions.get(parsed[0]);
    if (!session || !matches(session.passwordHash, parsed[1])) return null;
    return session;
  }

  heartbeat(enrollment: Enrollment, sessionId: string): boolean {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.enrollmentId !== enrollment.id ||
        this.enrollments.get(enrollment.id) !== enrollment) return false;
    session.lastActiveAt = this.now();
    return true;
  }

  end(enrollment: Enrollment, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.enrollmentId !== enrollment.id ||
        this.enrollments.get(enrollment.id) !== enrollment) return false;
    this.close(sessionId);
    return true;
  }

  onClose(listener: (sessionId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  sweep(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      const user = this.users.get(session.userId);
      if (now >= this.sharedUntil.getTime() || now - session.lastActiveAt >= LEASE_MS ||
          !user || user.status !== "enabled") {
        this.close(session.id);
      }
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const id of this.sessions.keys()) this.close(id);
    this.enrollments.clear();
  }

  private applyUserChange(user: ShareUser): void {
    const sessions = [...this.sessions.values()]
      .filter((session) => session.userId === user.id)
      .sort((a, b) => a.startedAt - b.startedAt);
    const keep = user.status === "enabled" ? user.sessionLimit : 0;
    for (const session of sessions.slice(keep)) this.close(session.id);
    if (user.status === "revoked") {
      for (const enrollment of this.enrollments.values()) {
        if (enrollment.userId === user.id) this.enrollments.delete(enrollment.id);
      }
    }
  }

  private close(id: string): void {
    if (!this.sessions.delete(id)) return;
    for (const listener of this.closeListeners) listener(id);
  }
}
