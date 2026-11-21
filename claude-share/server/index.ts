import { Hono } from "hono";

import {
  getSession,
  checkPairingCode,
  addMachine,
  encryptConnectionFile,
  isSessionExpired,
  type ConnectionFile,
  type SharerAccount,
  type Machine,
} from "../session/manager";
import type { Enrollment } from "../session/access";

interface Urls {
  public: string | null;
  lan: string | null;
}

export function createApiApp(
  urls: Urls,
  caPem: string,
  sharerAccount: SharerAccount | null,
  systemName: string,
) {
  const app = new Hono<{ Variables: { machine: Machine; enrollment: Enrollment } }>();

  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/health" || p === "/pair" || p.startsWith("/connect/")) {
      return next();
    }
    const session = getSession();
    const auth = c.req.header("proxy-authorization");
    const enrollment = auth && session ? session.access.authenticate(auth) : null;
    const machine = enrollment && session ? session.machines.get(enrollment.id) : null;
    if (!session || !machine || !enrollment)
      return c.json({ error: "Unauthorized or revoked; ask for a new invitation" }, 407);
    if (session.users.get(enrollment.userId)?.status !== "enabled")
      return c.json({ error: "User is disabled or revoked" }, 403);
    c.set("machine", machine);
    c.set("enrollment", enrollment);
    return next();
  });

  app.get("/health", (c) => {
    const session = getSession();
    return c.json({
      ok: true,
      sessionActive: !!session && !isSessionExpired(session),
      sessionId: session?.id ?? null,
    });
  });

  /** GET /connect/:code — human-readable hint when someone opens the URL in a browser */
  app.get("/connect/:code", (c) => {
    return c.text(
      "This is a claude-share invitation. Do not open it in a browser; pass it directly to claude-connect --share instead.\n",
      200,
      { "Content-Type": "text/plain; charset=utf-8" },
    );
  });

  /** POST /pair — one-time pairing with a machine */
  app.post("/pair", async (c) => {
    const session = getSession();
    if (!session || isSessionExpired(session))
      return c.json({ error: "No active session" }, 503);

    // Bore does not provide a trustworthy client IP.
    const ip = "unknown";
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid pairing request" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "Invalid pairing request" }, 400);
    const data = body as { code?: unknown; name?: unknown };
    const code = typeof data.code === "string" ? data.code.trim() : "";
    if (data.name !== undefined && (typeof data.name !== "string" ||
        data.name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(data.name))) {
      return c.json({ error: "Invalid device name" }, 400);
    }
    const name = typeof data.name === "string" ? data.name.trim() || "unknown device" : "unknown device";

    if (!checkPairingCode(session, ip, code))
      return c.json({ error: "Invalid pairing code" }, 401);

    const user = session.pairingUserId && session.users.get(session.pairingUserId);
    if (!user || user.status !== "enabled")
      return c.json({ error: "User is disabled or revoked" }, 403);
    const machine = addMachine(session, name);

    const file: ConnectionFile = {
      publicServerUrl: urls.public,
      lanServerUrl: urls.lan,
      sessionId: session.id,
      sharedUntil: session.sharedUntil.toISOString(),
      caPem,
      sharerAccount,
      systemName,
      proxyUser: machine.id,
      proxyPass: machine.proxyPass,
      userName: user.name,
    };

    const blob = encryptConnectionFile(session, file);
    return c.json({ blob, machineId: machine.id });
  });

  /** POST /session/start — receiver opened a Claude session */
  app.post("/session/start", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const result = session.access.start(c.get("enrollment"));
    if (!result.ok) {
      const error = result.reason === "limit"
        ? "Concurrent session limit reached"
        : result.reason === "expired" ? "Sharing expired" : "User is disabled or revoked";
      return c.json({ error }, result.reason === "limit" ? 429 : 403);
    }
    c.get("machine").sessions.set(result.session.id, {
      id: result.session.id,
      startedAt: new Date(result.session.startedAt),
      lastActiveAt: new Date(result.session.lastActiveAt),
      active: true,
    });
    return c.json({
      ok: true,
      sessionId: result.session.id,
      proxyUser: result.session.id,
      proxyPass: result.password,
    });
  });

  /** POST /session/end — receiver closed a Claude session */
  app.post("/session/end", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    if (!session.access.end(c.get("enrollment"), sessionId))
      return c.json({ error: "Session not found" }, 404);
    return c.json({ ok: true });
  });

  /** POST /session/heartbeat — receiver is still alive */
  app.post("/session/heartbeat", async (c) => {
    const session = getSession();
    if (!session) return c.json({ error: "No active session" }, 503);
    const { sessionId } = await c.req.json<{ sessionId: string }>();
    if (!session.access.heartbeat(c.get("enrollment"), sessionId))
      return c.json({ error: "Session not found" }, 404);
    const machineSession = c.get("machine").sessions.get(sessionId);
    if (machineSession) machineSession.lastActiveAt = new Date();
    return c.json({ ok: true });
  });

  /** GET /machines — list machines and their sessions */
  app.get("/machines", (c) => {
    const session = getSession();
    if (!session) return c.json({ machines: [] });
    const machines = [...session.machines.values()].filter((m) => m.userId === c.get("machine").userId).map((m) => ({
      id: m.id,
      name: m.name,
      pairedAt: m.pairedAt.toISOString(),
      sessions: [...m.sessions.values()].map((s) => ({
        id: s.id,
        startedAt: s.startedAt.toISOString(),
        lastActiveAt: s.lastActiveAt.toISOString(),
        active: s.active,
      })),
    }));
    return c.json({ machines, sharedUntil: session.sharedUntil.toISOString() });
  });

  return app;
}
