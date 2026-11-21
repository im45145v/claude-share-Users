import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { once } from "node:events";
import { test } from "node:test";
import { UserStore } from "../session/users.ts";
import { AccessRegistry } from "../session/access.ts";

class FakeProxy {
  static gunzip = {};
  _onError() {}
  use() {}
  onError() {}
  onRequest() {}
  onResponse() {}
  onConnect(handler) { this.connect = handler; }
  listen(options, callback) {
    fs.mkdirSync(path.join(options.sslCaDir, "certs"));
    fs.mkdirSync(path.join(options.sslCaDir, "keys"));
    fs.writeFileSync(path.join(options.sslCaDir, "certs", "ca.pem"), "ca");
    fs.writeFileSync(path.join(options.sslCaDir, "keys", "ca.private.key"), "key");
    this.httpServer = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      const read = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", read);
        const lines = buffer.subarray(0, end).toString().split("\r\n");
        const authorization = lines.find((line) => /^proxy-authorization:/i.test(line));
        this.connect({
          url: lines[0].split(" ")[1],
          headers: { "proxy-authorization": authorization?.slice(authorization.indexOf(":") + 1).trim() },
        }, socket, buffer.subarray(end + 4), () => socket.destroy());
      };
      socket.on("data", read);
    });
    this.httpServer.listen(0, "127.0.0.1", callback);
  }
  close() { this.httpServer.close(); }
}
globalThis.fakeMitmProxy = FakeProxy;

const mocks = {
  "http-mitm-proxy": "export const Proxy = globalThis.fakeMitmProxy;",
  "../ca/serverCert": "export const generateServerCert = async () => ({ certPem: 'cert', keyPem: 'key' });",
  "../logger": "export const logger = { error() {} };",
  "./requestLog": "export const logRequest = () => 1; export const setResponseStatus = () => {};",
  "./token": "export const getAccessToken = () => 'token';",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/proxy/mitm.ts") && specifier in mocks) {
      return { url: `testmock:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("testmock:")) {
      return { format: "module", source: mocks[url.slice("testmock:".length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

test("revocation closes an established transparent tunnel and rejects reuse", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-share-proxy-test-"));
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const sockets = new Set();
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  let gateway;
  let mitm;
  let client;
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const users = new UserStore(path.join(dir, "users.json"));
    const user = users.create("Alice", 1);
    const registry = new AccessRegistry(users, new Date(Date.now() + 60_000));
    const enrollment = registry.enroll(user.id, "computer");
    const started = registry.start(enrollment.enrollment);
    assert.equal(started.ok, true);
    const auth = "Basic " + Buffer.from(`${started.session.id}:${started.password}`).toString("base64");
    const { createMitmProxy } = await import("./mitm.ts");
    mitm = await createMitmProxy(null, (header) => registry.authenticateProxy(header)?.id ?? null);
    registry.onClose((id) => mitm.closeSession(id));
    gateway = net.createServer((socket) => mitm.handleSocket(socket));
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");

    client = net.connect(gateway.address().port, "127.0.0.1");
    await once(client, "connect");
    client.write(`CONNECT 127.0.0.1:${upstream.address().port} HTTP/1.1\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    assert.match((await once(client, "data"))[0].toString(), /200 Connection established/);
    client.write("hello");
    assert.equal((await once(client, "data"))[0].toString(), "hello");
    const closed = once(client, "close");
    users.update(user.id, { status: "revoked" });
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("tunnel remained open")), 2000))]);
    assert.equal(registry.authenticateProxy(auth), null);
    registry.dispose();
  } finally {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    gateway?.close();
    mitm?.close();
    upstream.close();
    hooks.deregister();
    delete globalThis.fakeMitmProxy;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
