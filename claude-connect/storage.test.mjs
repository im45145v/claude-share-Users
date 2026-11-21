import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("saved connections for the same sharer remain separate and private", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-connect-test-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const storage = await import("./storage.ts");
    assert.equal(storage.getDeviceName(false), os.hostname());
    assert.equal(fs.existsSync(path.join(home, ".claude-share")), false);
    const connection = {
      id: "first",
      systemName: "sharer",
      lanServerUrl: "https://example.test",
      publicServerUrl: null,
      sessionId: "session",
      sharedUntil: "2099-01-01T00:00:00.000Z",
      caPem: "certificate",
      savedAt: "2026-01-01T00:00:00.000Z",
      sharerAccount: null,
      proxyUser: "first",
      proxyPass: "secret",
    };
    storage.saveConnection(connection);
    storage.saveConnection({ ...connection, id: "second", proxyUser: "second" });

    assert.deepEqual(
      storage.loadConnections().map((c) => c.proxyUser).sort(),
      ["first", "second"],
    );
    assert.equal(fs.statSync(storage.connectionPath("first")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(storage.CONNECTIONS_DIR).mode & 0o077, 0);
    assert.throws(() => storage.saveConnection(connection), { code: "EEXIST" });
    assert.equal(storage.loadConnections().length, 2);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
