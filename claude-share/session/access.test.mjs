import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AccessRegistry } from "./access.ts";
import { UserStore } from "./users.ts";

const auth = (id, password) =>
  "Basic " + Buffer.from(`${id}:${password}`).toString("base64");

test("user limits span devices, isolate identities, and reclaim stale leases", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-share-access-test-"));
  try {
    let now = 1000;
    const users = new UserStore(path.join(dir, "users.json"));
    const alice = users.create("Alice", 1);
    const bob = users.create("Bob", 1);
    const registry = new AccessRegistry(users, new Date(1_000_000), () => now);
    const a1 = registry.enroll(alice.id, "shared computer");
    const a2 = registry.enroll(alice.id, "laptop");
    const b = registry.enroll(bob.id, "shared computer");
    assert.equal(registry.authenticate(auth(a1.enrollment.id, a1.password)), a1.enrollment);
    assert.equal(registry.authenticate(auth(a1.enrollment.id, a2.password)), null);

    const [first, concurrent] = await Promise.all([
      Promise.resolve().then(() => registry.start(a1.enrollment)),
      Promise.resolve().then(() => registry.start(a2.enrollment)),
    ]);
    assert.equal(first.ok, true);
    assert.deepEqual(concurrent, { ok: false, reason: "limit" });
    const secondUser = registry.start(b.enrollment);
    assert.equal(secondUser.ok, true);
    assert.equal(registry.heartbeat(b.enrollment, first.session.id), false);
    assert.equal(registry.end(b.enrollment, first.session.id), false);
    assert.equal(registry.authenticateProxy(auth(first.session.id, first.password)), first.session);
    assert.equal(registry.authenticateProxy(auth(a1.enrollment.id, a1.password)), null);

    const closed = [];
    registry.onClose((id) => closed.push(id));
    now += 90_000;
    assert.equal(registry.start(a2.enrollment).ok, true);
    assert.deepEqual(closed.sort(), [first.session.id, secondUser.session.id].sort());
    assert.equal(registry.heartbeat(a1.enrollment, first.session.id), false);
    registry.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disable, revoke and expiry terminate sessions and deny credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-share-access-test-"));
  try {
    let now = 1;
    const file = path.join(dir, "users.json");
    const users = new UserStore(file);
    const user = users.create("Alice", 2);
    const registry = new AccessRegistry(users, new Date(1000), () => now);
    const credential = registry.enroll(user.id, "desktop");
    const first = registry.start(credential.enrollment);
    const second = registry.start(credential.enrollment);
    assert.equal(first.ok && second.ok, true);
    const closed = [];
    registry.onClose((id) => closed.push(id));
    users.update(user.id, { sessionLimit: 1 });
    assert.equal(closed.length, 1);
    users.update(user.id, { status: "disabled" });
    assert.equal(closed.length, 2);
    assert.deepEqual(registry.start(credential.enrollment), { ok: false, reason: "disabled" });
    users.update(user.id, { status: "enabled" });
    const reenabled = registry.start(credential.enrollment);
    assert.equal(reenabled.ok, true);
    users.update(user.id, { status: "revoked" });
    assert.equal(registry.authenticate(auth(credential.enrollment.id, credential.password)), null);
    assert.equal(registry.authenticateProxy(auth(reenabled.session.id, reenabled.password)), null);
    assert.equal(new UserStore(file).get(user.id).status, "revoked");

    const other = users.create("Bob", 1);
    const otherCredential = registry.enroll(other.id, "desktop");
    const active = registry.start(otherCredential.enrollment);
    assert.equal(active.ok, true);
    now = 1000;
    assert.equal(registry.authenticateProxy(auth(active.session.id, active.password)), null);
    assert.equal(registry.authenticate(auth(otherCredential.enrollment.id, otherCredential.password)), null);
    registry.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
