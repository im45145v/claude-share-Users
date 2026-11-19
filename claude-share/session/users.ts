import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShareUser {
  id: string;
  name: string;
  sessionLimit: number;
  status: "enabled" | "disabled" | "revoked";
}

interface UserFile {
  version: 1;
  users: ShareUser[];
}

function validateUser(user: ShareUser): void {
  if (
    typeof user.id !== "string" ||
    !user.id ||
    typeof user.name !== "string" ||
    !user.name.trim() ||
    user.name.length > 80 ||
    !Number.isSafeInteger(user.sessionLimit) ||
    user.sessionLimit < 1 ||
    !["enabled", "disabled", "revoked"].includes(user.status)
  ) {
    throw new Error("Invalid user configuration");
  }
}

export class UserStore {
  private users: ShareUser[];
  private readonly file: string;
  private readonly listeners = new Set<(user: ShareUser) => void>();

  constructor(file = path.join(os.homedir(), ".claude-share", "users.json")) {
    this.file = file;
    let data: string;
    try {
      data = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.users = [];
        return;
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(data);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("users" in parsed) ||
      !Array.isArray(parsed.users)
    ) {
      throw new Error("Invalid user configuration");
    }
    this.users = parsed.users.map((user: ShareUser) => {
      validateUser(user);
      return { ...user };
    });
    if (new Set(this.users.map((user) => user.id)).size !== this.users.length) {
      throw new Error("Duplicate user ID in user configuration");
    }
    fs.chmodSync(file, 0o600);
  }

  list(): ShareUser[] {
    return this.users.map((user) => ({ ...user }));
  }

  get(id: string): ShareUser | undefined {
    const user = this.users.find((entry) => entry.id === id);
    return user ? { ...user } : undefined;
  }

  subscribe(listener: (user: ShareUser) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(name: string, sessionLimit: number): ShareUser {
    if (this.users.some((user) => user.name.toLowerCase() === name.trim().toLowerCase()))
      throw new Error("A user with that name already exists");
    const user: ShareUser = {
      id: crypto.randomUUID(),
      name: name.trim(),
      sessionLimit,
      status: "enabled",
    };
    validateUser(user);
    this.commit([...this.users, user]);
    return { ...user };
  }

  update(id: string, changes: { sessionLimit?: number; status?: ShareUser["status"] }): ShareUser {
    const existing = this.users.find((user) => user.id === id);
    if (!existing) throw new Error("User not found");
    if (existing.status === "revoked" && changes.status && changes.status !== "revoked") {
      throw new Error("A revoked user cannot be re-enabled");
    }
    const updated = { ...existing, ...changes };
    validateUser(updated);
    this.commit(this.users.map((user) => user.id === id ? updated : user));
    for (const listener of this.listeners) listener({ ...updated });
    return { ...updated };
  }

  private commit(users: ShareUser[]): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.users-${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
      const data: UserFile = { version: 1, users };
      const fd = fs.openSync(temporary, "wx", 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      created = false;
    } finally {
      if (created) fs.unlinkSync(temporary);
    }
    this.users = users;
  }
}
