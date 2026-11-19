#!/usr/bin/env node
import "@shared/patch-console";
import * as p from "@clack/prompts";

import { platform } from "@shared/platforms";
import { checkForUpdate, forceUpgrade } from "@shared/checkVersion";
import pkg from "../package.json";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

if (process.argv.includes("--upgrade")) {
  await forceUpgrade();
  process.exit(0);
}

import { pairFlow } from "./flows/pair";
import { reconnectFlow } from "./flows/reconnect";
import { listFlow } from "./flows/list";
import { resolveActiveUrl } from "./health";
import { launchClaude } from "./launch";
import { logger } from "./logger";
import { parseConnectUrl } from "./pairing";
import {
  hasAgreedToTerms,
  loadConnections,
  pruneExpiredConnections,
  saveTermsAgreed,
} from "./storage";

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", reason);
  process.exit(1);
});

// Exits with a clear error if the platform is unsupported
platform();

await checkForUpdate();

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noSave = args.includes("--no-save");

// Identify which arg indices belong to claude-connect itself
const ownIdxs = new Set<number>();
args.forEach((a, i) => {
  if (a === "--list" || a === "-l") ownIdxs.add(i);
  if (a === "--cleanup") ownIdxs.add(i);
  if (a === "--no-save") ownIdxs.add(i);
  if (a === "--reconnect" || a === "-r") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
  if (a.startsWith("--share=")) ownIdxs.add(i);
  if (a === "--share") {
    ownIdxs.add(i);
    if (args[i + 1] && !args[i + 1].startsWith("-")) ownIdxs.add(i + 1);
  }
});

const claudeArgs = args.filter((_, i) => !ownIdxs.has(i));
const shareIndex = args.findIndex((a) => a === "--share" || a.startsWith("--share="));
const shareArg = shareIndex === -1
  ? null
  : args[shareIndex] === "--share"
    ? (args[shareIndex + 1] ?? "")
    : args[shareIndex].slice("--share=".length);

if (!noSave) pruneExpiredConnections();

if (noSave && (args.includes("--list") || args.includes("-l") ||
    args.includes("--reconnect") || args.includes("-r"))) {
  p.log.error("--no-save cannot be combined with saved-connection commands.");
  process.exit(1);
}

if (noSave && !(await platform().credentialsExist())) {
  p.log.error("Non-persistent mode requires existing Claude credentials; log in under a separate OS account first.");
  process.exit(1);
}

if (!hasAgreedToTerms()) {
  p.intro("claude-connect");
  p.log.warn(
    "Heads up: you're connecting to someone else's Claude Code at your own discretion.\n" +
      "By design, the sharer's machine could potentially see your Claude Code messages\n" +
      "if they're running a modified, unofficial build of this program. Please connect\n" +
      "only to people you trust.\n\n" +
      "Once connected, you might still see your own email or organization name shown\n" +
      "in Claude Code. That's expected behavior and safe to ignore.",
  );
  const agreed = await p.confirm({
    message: "Do you understand and want to continue?",
    initialValue: false,
  });
  if (p.isCancel(agreed) || !agreed) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  if (!noSave) saveTermsAgreed();
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

if (args[0] === "--list" || args[0] === "-l") {
  await listFlow();
} else if (args[0] === "--reconnect" || args[0] === "-r") {
  await reconnectFlow(args[1], claudeArgs);
} else if (shareArg !== null) {
  const connectUrl = shareArg.trim();
  const parsed = parseConnectUrl(connectUrl);
  if (!parsed) {
    p.log.error(
      "Invalid --share URL. Expected: claudeshare://host:port/connect/CODE",
    );
    process.exit(1);
  }

  // An explicit one-time link belongs to this enrollment, not an earlier user
  // who happened to connect to the same server on this computer.
  await pairFlow(parsed, claudeArgs, !noSave);
} else if (noSave) {
  await pairFlow(undefined, claudeArgs, false);
} else {
  // No --share flag: check for active saved connections first
  const saved = loadConnections();

  if (saved.length > 0) {
    const spin = p.spinner();
    spin.start("Checking active sharers...");

    const results = await Promise.all(
      saved.map(async (c) => {
        const resolved = await resolveActiveUrl(c);
        return {
          conn: c,
          url: resolved.url,
          alive: resolved.alive && resolved.sessionId === c.sessionId,
        };
      }),
    );

    spin.stop();

    const active = results.filter((r) => r.alive);

    if (active.length > 0) {
      p.intro("claude-connect");
      const pick = await p.select({
        message: "Connect to an active sharer or pair with a new one:",
        options: [
          ...active.map((r) => ({
            value: r.conn.id,
            label: `${r.conn.userName ?? "legacy user"} — ${r.conn.systemName}`,
            hint: r.url,
          })),
          {
            value: "__new__",
            label: "Pair with a new sharer…",
            hint: "enter a connect URL",
          },
        ],
      });
      if (p.isCancel(pick)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      if (pick === "__new__") {
        await pairFlow(undefined, claudeArgs);
      } else {
        const chosen = active.find((r) => r.conn.id === pick)!;
        await launchClaude(
          chosen.url,
          chosen.conn.caPem,
          chosen.conn,
          claudeArgs,
          chosen.conn.sharerAccount ?? null,
        );
      }
    } else {
      await pairFlow(undefined, claudeArgs);
    }
  } else {
    await pairFlow(undefined, claudeArgs);
  }
}
