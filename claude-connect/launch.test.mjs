import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";

const mocks = {
  "node:child_process": `
    export const execFile = (_command, _args, callback) => callback(null, { stdout: "" });
    export const spawn = (...args) => globalThis.launchTest.spawn(...args);
  `,
  "@clack/prompts": `
    export const log = { error: (message) => globalThis.launchTest.errors.push(message), info() {}, warn() {}, success() {} };
    export const outro = () => {};
  `,
  "@shared/platforms": "export const platform = () => ({ credentialsExist: async () => true });",
  "./fetch": "export const apiFetch = (...args) => globalThis.launchTest.fetch(...args);",
  "./logger": "export const logger = { error() {}, warn() {} };",
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/claude-connect/launch.ts") && specifier in mocks) {
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
after(() => hooks.deregister());

test("a quota rejection prevents launching Claude and removes temporary files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-connect-launch-test-"));
  const oldTmpdir = process.env.TMPDIR;
  const oldExitCode = process.exitCode;
  process.env.TMPDIR = dir;
  globalThis.launchTest = {
    spawned: false,
    errors: [],
    spawn: () => { globalThis.launchTest.spawned = true; throw new Error("unexpected spawn"); },
    fetch: async () => ({
      ok: false, status: 429,
      json: async () => ({ error: "Concurrent session limit reached" }),
    }),
  };
  try {
    const { launchClaude } = await import("./launch.ts");
    await launchClaude("https://example.test", "certificate", {
      id: "device", systemName: "sharer", proxyUser: "enrollment", proxyPass: "secret",
    }, [], null, false);
    assert.equal(globalThis.launchTest.spawned, false);
    assert.match(globalThis.launchTest.errors[0], /Concurrent session limit reached/);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = oldExitCode;
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    delete globalThis.launchTest;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude receives session-scoped proxy credentials and ends its lease on exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-connect-launch-test-"));
  const oldTmpdir = process.env.TMPDIR;
  const oldExit = process.exit;
  const priorInt = process.listeners("SIGINT");
  const priorTerm = process.listeners("SIGTERM");
  process.env.TMPDIR = dir;
  const child = new EventEmitter();
  child.kill = () => true;
  let env;
  const requests = [];
  globalThis.launchTest = {
    errors: [],
    spawn: (_command, _args, options) => { env = options.env; return child; },
    fetch: async (url, options) => {
      requests.push([url, options]);
      return {
        ok: true, status: 200,
        json: async () => url.endsWith("/session/start")
          ? { sessionId: "lease", proxyUser: "lease-user", proxyPass: "lease-secret" }
          : { ok: true },
      };
    },
  };
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  process.exit = (code) => { resolveExit(code); };
  try {
    const { launchClaude } = await import("./launch.ts");
    await launchClaude("https://example.test", "certificate", {
      id: "device", systemName: "sharer", proxyUser: "enrollment", proxyPass: "enrollment-secret",
    }, [], null, false);
    const proxy = new URL(env.HTTPS_PROXY);
    assert.equal(proxy.username, "lease-user");
    assert.equal(proxy.password, "lease-secret");
    assert.equal(fs.readFileSync(env.NODE_EXTRA_CA_CERTS, "utf8"), "certificate");
    child.emit("exit", 0);
    assert.equal(await exited, 0);
    assert.equal(requests[1][0], "https://example.test/session/end");
    assert.deepEqual(JSON.parse(requests[1][1].body), { sessionId: "lease" });
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    process.exit = oldExit;
    for (const listener of process.listeners("SIGINT")) {
      if (!priorInt.includes(listener)) process.off("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!priorTerm.includes(listener)) process.off("SIGTERM", listener);
    }
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    delete globalThis.launchTest;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
