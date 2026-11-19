import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UserStore } from "./users.ts";

test("user settings persist, are private, and revocation is irreversible", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-share-users-test-"));
  const file = path.join(dir, "users.json");
  try {
    const store = new UserStore(file);
    const alice = store.create("Alice", 2);
    const bob = store.create("Bob", 1);
    store.update(alice.id, { status: "disabled", sessionLimit: 3 });
    store.update(bob.id, { status: "revoked" });

    const restarted = new UserStore(file);
    assert.deepEqual(restarted.list().map(({ name, status, sessionLimit }) => ({
      name, status, sessionLimit,
    })), [
      { name: "Alice", status: "disabled", sessionLimit: 3 },
      { name: "Bob", status: "revoked", sessionLimit: 1 },
    ]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => restarted.update(bob.id, { status: "enabled" }));
    assert.throws(() => restarted.create("Invalid", 0));
    assert.equal(new UserStore(file).list().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
