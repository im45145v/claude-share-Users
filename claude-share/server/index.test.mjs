import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fakeHono = `
  export class Hono {
    constructor() { this.routes = new Map(); }
    use(_path, handler) { this.middleware = handler; }
    get(path, handler) { this.routes.set("GET " + path, handler); }
    post(path, handler) { this.routes.set("POST " + path, handler); }
    async request(path, options = {}) {
      const request = new Request("https://example.test" + path, options);
      const values = new Map();
      const context = {
        req: {
          path, url: request.url,
          header: (name) => request.headers.get(name) ?? undefined,
          json: () => request.json(),
        },
        get: (name) => values.get(name),
        set: (name, value) => values.set(name, value),
        json: (body, status = 200) => Response.json(body, { status }),
        text: (body, status = 200) => new Response(body, { status }),
      };
      return this.middleware(context, () => this.routes.get(request.method + " " + path)(context));
    }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "hono") return { url: "testmock:hono", shortCircuit: true };
    if (specifier === "@noble/ciphers/chacha.js") return { url: "testmock:cipher", shortCircuit: true };
    if (specifier === "@shared/base58") return { url: "testmock:base58", shortCircuit: true };
    if (specifier === "../session/manager" && context.parentURL?.endsWith("/server/index.ts")) {
      return { url: new URL("../session/manager.ts", context.parentURL).href, shortCircuit: true };
    }
    if ((specifier === "./access" || specifier === "./users") && context.parentURL?.endsWith("/session/manager.ts")) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "testmock:hono") return { format: "module", source: fakeHono, shortCircuit: true };
    if (url === "testmock:cipher") return { format: "module", source: "export const xchacha20poly1305 = () => ({ encrypt: value => value });", shortCircuit: true };
    if (url === "testmock:base58") return { format: "module", source: "export const toBase58 = () => '12345';", shortCircuit: true };
    return nextLoad(url, context);
  },
});

test("session operations use authenticated machine, not a supplied machine ID", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-share-api-test-"));
  try {
    const manager = await import("../session/manager.ts");
    const { UserStore } = await import("../session/users.ts");
    const { createApiApp } = await import("./index.ts");
    const users = new UserStore(path.join(dir, "users.json"));
    const aliceUser = users.create("Alice", 1);
    const bobUser = users.create("Bob", 1);
    const session = manager.createSession(60_000, users);
    manager.regeneratePairingCode(session, aliceUser.id);
    const alice = manager.addMachine(session, "shared computer");
    manager.regeneratePairingCode(session, aliceUser.id);
    const aliceLaptop = manager.addMachine(session, "laptop");
    manager.regeneratePairingCode(session, bobUser.id);
    const bob = manager.addMachine(session, "shared computer");
    const auth = (machine) => "Basic " + Buffer.from(`${machine.id}:${machine.proxyPass}`).toString("base64");
    const app = createApiApp({ public: null, lan: null }, "cert", null, "sharer");
    const post = (machine, endpoint, body) => app.request(endpoint, {
      method: "POST",
      headers: { "proxy-authorization": auth(machine), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const start = await post(alice, "/session/start", { machineId: bob.id });
    const { sessionId, proxyUser, proxyPass } = await start.json();
    assert.equal(start.status, 200);
    assert.equal(alice.sessions.has(sessionId), true);
    assert.equal(bob.sessions.has(sessionId), false);
    assert.equal((await post(aliceLaptop, "/session/start", {})).status, 429);
    assert.equal((await post(bob, "/session/start", {})).status, 200);
    assert.equal(session.access.authenticateProxy(auth(alice)), null);
    const proxyHeader = "Basic " + Buffer.from(`${proxyUser}:${proxyPass}`).toString("base64");
    assert.equal(session.access.authenticateProxy(proxyHeader)?.userId, aliceUser.id);
    assert.equal((await post(bob, "/session/heartbeat", { machineId: alice.id, sessionId })).status, 404);
    assert.equal((await post(bob, "/session/end", { machineId: alice.id, sessionId })).status, 404);
    assert.equal(alice.sessions.get(sessionId).active, true);
    assert.equal((await post(alice, "/session/end", { machineId: bob.id, sessionId })).status, 200);
    assert.equal(alice.sessions.get(sessionId).active, false);
    const another = await post(aliceLaptop, "/session/start", {});
    assert.equal(another.status, 200);
    const anotherBody = await another.json();
    users.update(aliceUser.id, { status: "disabled" });
    assert.equal((await post(alice, "/session/start", {})).status, 403);
    assert.equal(session.access.authenticateProxy("Basic " + Buffer.from(`${anotherBody.proxyUser}:${anotherBody.proxyPass}`).toString("base64")), null);
    users.update(aliceUser.id, { status: "revoked" });
    assert.equal((await post(alice, "/session/start", {})).status, 407);

    manager.regeneratePairingCode(session, bobUser.id);
    const pair = () => app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "12345", name: "shared computer" }),
    });
    const pairs = await Promise.all([pair(), pair()]);
    assert.deepEqual(pairs.map((response) => response.status).sort(), [200, 401]);
    const result = await pairs.find((response) => response.status === 200).json();
    const connection = JSON.parse(Buffer.from(result.blob, "hex").subarray(24).toString());
    assert.equal(connection.userName, "Bob");
    assert.equal(session.machines.get(connection.proxyUser).userId, bobUser.id);

    manager.regeneratePairingCode(session, bobUser.id);
    users.update(bobUser.id, { status: "disabled" });
    users.update(bobUser.id, { status: "enabled" });
    assert.equal(manager.checkPairingCode(session, "unknown", "12345"), false);
    manager.regeneratePairingCode(session, bobUser.id);
    for (let i = 0; i < 20; i++) assert.equal(manager.checkPairingCode(session, "unknown", "bad"), false);
    assert.equal(manager.checkPairingCode(session, "unknown", "12345"), false);
    session.sharedUntil.setTime(0);
    assert.equal((await post(bob, "/session/start", {})).status, 407);
    manager.destroySession();
  } finally {
    hooks.deregister();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
