import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const mocks = {
  "@clack/prompts": `
    export const intro = () => {};
    export const log = { info() {}, error() {} };
    export const spinner = () => ({ start() {}, stop() {} });
  `,
  "../fetch": `export const apiFetch = (...args) => globalThis.pairTest.fetch(...args);`,
  "../launch": `export const launchClaude = (...args) => globalThis.pairTest.launch(...args);`,
  "../logger": `export const logger = { error() {} };`,
  "../pairing": `
    export const decryptBlob = () => globalThis.pairTest.file;
    export const parseConnectUrl = () => null;
  `,
  "../storage": `
    export const getDeviceName = (...args) => globalThis.pairTest.device(...args);
    export const saveConnection = (...args) => globalThis.pairTest.save(...args);
  `,
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/claude-connect/flows/pair.ts") && specifier in mocks) {
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

test("non-persistent pairing does not save credentials and only sends the code prefix", async () => {
  const calls = [];
  globalThis.pairTest = {
    file: {
      systemName: "sharer", lanServerUrl: null, publicServerUrl: "https://example.test",
      sessionId: "session", sharedUntil: "2099-01-01T00:00:00Z",
      caPem: "certificate", sharerAccount: null, proxyUser: "user", proxyPass: "secret",
    },
    fetch: async (url, options) => {
      calls.push(["fetch", url, JSON.parse(options.body)]);
      return {
        ok: true,
        json: async () => ({ blob: "encrypted", machineId: "75c55db4-af78-43fc-8f66-596a85022e58" }),
      };
    },
    device: (persist) => { calls.push(["device", persist]); return "computer"; },
    save: () => { calls.push(["save"]); },
    launch: (...args) => { calls.push(["launch", ...args]); },
  };
  try {
    const { pairFlow } = await import("./pair.ts");
    await pairFlow({ serverUrl: "https://example.test", pairingCode: "123456789" }, [], false);
    assert.deepEqual(calls[0], ["device", false]);
    assert.deepEqual(calls[1], ["fetch", "https://example.test/pair", { code: "12345", name: "computer" }]);
    assert.equal(calls.some(([kind]) => kind === "save"), false);
    assert.equal(calls.find(([kind]) => kind === "launch").at(-1), false);
  } finally {
    hooks.deregister();
    delete globalThis.pairTest;
  }
});
