import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReceiverConfig, SavedConnection } from "./types";

// ── Paths ────────────────────────────────────────────────────────────────────

export const CLAUDE_SHARE_DIR = path.join(os.homedir(), ".claude-share");
export const CONNECTIONS_DIR = path.join(CLAUDE_SHARE_DIR, "connections");
const CONFIG_FILE = path.join(CLAUDE_SHARE_DIR, "config.json");

export function ensureConnectionsDir() {
  fs.mkdirSync(CONNECTIONS_DIR, { recursive: true, mode: 0o700 });
}
export function connectionPath(id: string) {
  const resolved = path.resolve(CONNECTIONS_DIR, `${id}.json`);
  if (!resolved.startsWith(CONNECTIONS_DIR + path.sep)) {
    throw new Error(`Invalid connection ID: ${id}`);
  }
  return resolved;
}

// ── Device config ─────────────────────────────────────────────────────────────

function readConfig(): ReceiverConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as ReceiverConfig;
  } catch {
    return null;
  }
}

function writeConfig(config: ReceiverConfig): void {
  fs.mkdirSync(CLAUDE_SHARE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function getDeviceName(persist = true): string {
  const saved = readConfig();
  if (saved?.deviceName) return saved.deviceName;
  const name = os.hostname();
  if (persist) writeConfig({ deviceName: name });
  return name;
}

export function hasAgreedToTerms(): boolean {
  return readConfig()?.hasConnectTermsAgreed === true;
}

export function saveTermsAgreed(): void {
  const cfg = readConfig() ?? { deviceName: os.hostname() };
  writeConfig({ ...cfg, hasConnectTermsAgreed: true });
}

// ── Connection persistence ────────────────────────────────────────────────────

export function saveConnection(connection: SavedConnection): void {
  ensureConnectionsDir();
  fs.writeFileSync(
    connectionPath(connection.id),
    JSON.stringify(connection, null, 2),
    { mode: 0o600, flag: "wx" },
  );
}

export function loadConnections(): SavedConnection[] {
  ensureConnectionsDir();
  return fs
    .readdirSync(CONNECTIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(CONNECTIONS_DIR, f), "utf8"),
        ) as SavedConnection;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SavedConnection[];
}

export function pruneExpiredConnections(): void {
  ensureConnectionsDir();
  const now = Date.now();
  for (const file of fs
    .readdirSync(CONNECTIONS_DIR)
    .filter((f) => f.endsWith(".json"))) {
    const filePath = path.join(CONNECTIONS_DIR, file);
    try {
      const c = JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Partial<SavedConnection>;
      // Remove if sharedUntil is present and in the past; leave legacy entries without it alone
      if (c.sharedUntil && new Date(c.sharedUntil).getTime() < now) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Corrupt file — remove it too
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }
  }
}
