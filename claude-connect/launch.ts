import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { apiFetch } from "./fetch";
import { logger } from "./logger";
import type { SharerAccount } from "./types";

const execFileAsync = promisify(execFile);

// ── Onboarding ────────────────────────────────────────────────────────────────

export function ensureOnboarding() {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
  } catch {}

  if (config["hasCompletedOnboarding"] !== true) {
    p.log.info(
      "Onboarding not completed — marking it done so Claude launches directly.",
    );
    config["hasCompletedOnboarding"] = true;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────

const PLACEHOLDER_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "1234",
    refreshToken: "",
    expiresAt: 4102444800000,
    scopes: [
      "user:file_upload",
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
};

export async function ensureCredentials(allowSetup = true): Promise<boolean> {
  if (await platform().credentialsExist()) return true;

  if (!allowSetup) {
    p.log.error("Non-persistent mode requires existing Claude credentials; log in under a separate OS account first.");
    return false;
  }

  p.log.warn(
    "No Claude credentials found. Claude needs this to think you're logged in.",
  );
  const confirm = await p.confirm({
    message:
      "Create placeholder credentials so Claude launches without a login prompt?",
    initialValue: true,
  });
  if (p.isCancel(confirm) || !confirm) {
    p.log.warn("Skipping credentials setup. Claude may redirect you to login.");
    return true;
  }

  await platform().writeOAuthCredentials(PLACEHOLDER_CREDENTIALS);
  p.log.success("Placeholder credentials created.");
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function checkClaudeInstalled(): Promise<boolean> {
  const which = process.platform === "win32" ? "where" : "which";
  return execFileAsync(which, ["claude"])
    .then(() => true)
    .catch(() => false);
}

export async function sessionPost(
  serverUrl: string,
  endpoint: string,
  body: Record<string, string>,
  caPem?: string,
  proxyAuth?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (proxyAuth) headers["Proxy-Authorization"] = proxyAuth;
  const r = await apiFetch(`${serverUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: 5_000,
    ca: caPem,
  });
  if (r.ok) return r.json() as Promise<Record<string, unknown>>;
  let message = `HTTP ${r.status}`;
  try {
    const body = await r.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Older servers can return a plain-text error.
  }
  throw new Error(message);
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchClaude(
  proxyUrl: string,
  caPem: string,
  meta: {
    systemName: string;
    id: string;
    proxyUser: string;
    proxyPass: string;
  },
  claudeArgs: string[] = [],
  sharerAccount: SharerAccount | null = null,
  persist = true,
) {
  if (!(await checkClaudeInstalled())) {
    p.log.error("Claude Code is not installed or not in PATH.");
    p.log.info("Install it with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  if (persist) ensureOnboarding();
  if (!(await ensureCredentials(persist))) {
    process.exitCode = 1;
    return;
  }

  if (sharerAccount) {
    p.log.info(
      `Account: ${sharerAccount.displayName} (${sharerAccount.emailAddress})`,
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-connect-"));
  const tmpCert = path.join(tmpDir, "ca.pem");
  fs.writeFileSync(tmpCert, caPem, { mode: 0o600 });

  const proxyAuth =
    "Basic " +
    Buffer.from(`${meta.proxyUser}:${meta.proxyPass}`).toString("base64");

  // Register this Claude session with the sharer
  let sessionId: string;
  let sessionProxyUser: string;
  let sessionProxyPass: string;
  try {
    const res = await sessionPost(
      proxyUrl,
      "/session/start",
      {},
      caPem,
      proxyAuth,
    );
    if (typeof res.sessionId !== "string" ||
        typeof res.proxyUser !== "string" || typeof res.proxyPass !== "string") {
      throw new Error("Server did not return session credentials; re-pair with an updated sharer");
    }
    sessionId = res.sessionId;
    sessionProxyUser = res.proxyUser;
    sessionProxyPass = res.proxyPass;
  } catch (err) {
    logger.error("session/start failed", err);
    p.log.error(`Cannot start session: ${(err as Error).message}`);
    fs.unlinkSync(tmpCert);
    fs.rmdirSync(tmpDir);
    process.exitCode = 1;
    return;
  }

  p.log.success("\x1b[32mLaunching Claude...\x1b[0m");

  p.outro("");

  const startTime = Date.now();

  // Proxy URL keeps https:// — the TLS terminator on the sharer routes CONNECT
  // requests to the MITM proxy after decryption, so the outer connection is
  // encrypted and proxy credentials are never sent in cleartext over the network.
  const parsedProxy = new URL(proxyUrl);
  parsedProxy.username = encodeURIComponent(sessionProxyUser);
  parsedProxy.password = encodeURIComponent(sessionProxyPass);
  const httpProxyUrl = parsedProxy.toString();

  const child = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      HTTPS_PROXY: httpProxyUrl,
      HTTP_PROXY: httpProxyUrl,
      NODE_EXTRA_CA_CERTS: tmpCert,
      SSL_CERT_FILE: tmpCert,
      CURL_CA_BUNDLE: tmpCert,
    },
  });

  let heartbeatFailed = false;
  let cleaningUp = false;
  const heartbeat = setInterval(() => {
    void sessionPost(proxyUrl, "/session/heartbeat", { sessionId }, caPem, proxyAuth)
      .catch((err) => {
        if (heartbeatFailed || cleaningUp) return;
        heartbeatFailed = true;
        logger.error("Session heartbeat failed", err);
        p.log.error(`Session ended: ${(err as Error).message}`);
        child.kill("SIGTERM");
      });
  }, 30_000);

  async function cleanupAndExit(code: number | null) {
    if (cleaningUp) return;
    cleaningUp = true;
    clearInterval(heartbeat);
    await sessionPost(proxyUrl, "/session/end", { sessionId }, caPem, proxyAuth)
      .catch((err) => logger.warn("Could not end session", err));
    try {
      fs.unlinkSync(tmpCert);
      fs.rmdirSync(tmpDir);
    } catch (err) {
      logger.warn("Could not remove temporary CA files", err);
    }
    const duration = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    p.log.info(`Session ended. Duration: ${mins}m ${secs}s`);
    process.exit(heartbeatFailed ? 1 : (code ?? 0));
  }

  child.on("exit", (code) => {
    void cleanupAndExit(code);
  });

  child.on("error", (err) => {
    logger.error("Failed to launch claude process", err);
    p.log.error(`Failed to launch claude: ${err.message}`);
    p.log.warn(
      "Is 'claude' installed? Run: npm install -g @anthropic-ai/claude-code",
    );
    void cleanupAndExit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
