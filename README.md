# claude-share

Securely share your Claude Code subscription with others.

One machine runs **claude-share** to expose its Claude credentials through a local proxy. Other machines run **claude-connect** to connect and use Claude Code as if they had their own subscription.

---

## How it works

```
Receiver machine                    Sharer machine
─────────────────                   ──────────────────────────────
claude (CLI)                        claude-share
  │                                   │
  │  HTTPS_PROXY=...                  ├─ MITM proxy (intercepts Anthropic API calls)
  └──────────────────────────────────>│    injects sharer's OAuth token
                                      │
                                      ├─ Hono API (pairing, health, CA cert)
                                      │
                                      └─ bore tunnel (public URL via bore.pub)
```

- The sharer's OAuth token is read from the macOS Keychain and injected per-request inside the MITM proxy — it is never written to disk or sent to the receiver.
- The receiver installs a temporary CA cert (valid only for the session) so the MITM can intercept Anthropic traffic. Non-Anthropic domains pass through as an opaque TCP tunnel — never inspected.
- Each invitation enrolls one credential for a specific user and is valid for one pairing.
- Each explicit connect link starts a new pairing, even if another connection to the same sharer is saved.

---

## Install

```bash
npm install -g @0xpv/claude-share
```

This installs both `claude-share` and `claude-connect` binaries.

---

## Quickstart

### Sharer

```bash
claude-share
```

Requires [bore](https://github.com/ekzhang/bore) for internet sharing (`brew install bore-cli`). If bore is not installed you'll be prompted — decline to share on LAN only.

In the TUI, press `a` to create a named user and choose their concurrent-session limit. Select the user and press `n` to create a one-time invitation. Share the **Public** URL with that person over the internet, or the **LAN** URL for local network. Create another invitation for each additional device or enrollment; generating a new invitation invalidates the previous unused one.

The entire invitation is a secret decryption key: share it privately, do not paste it into a browser, and be aware that copying it can leave it in clipboard history.

**Keys:** `a` add user · `n` invite · `l` change limit · `d` disable · `e` enable · `r` revoke permanently · `m` devices · `c` copy invitation · `q` quit. Disabling or revoking a user disconnects their active sessions; a revoked user cannot be re-enabled.

### Receiver

```bash
# First time — use your own invitation from the sharer
claude-connect --share <connect-url>

# Subsequent runs — pick from saved connections
claude-connect

# Do not save the connection credentials to the home directory
claude-connect --no-save --share <connect-url>
```

The receiver configures Claude Code to route through the proxy and installs the session CA cert temporarily.
`--no-save` always pairs again and requires existing Claude credentials; it does not create placeholder credentials or save the connection. Temporary CA files are removed on normal exit, but may remain after a forced termination. This mode does not isolate processes or credentials from other people using the same OS account.

Select your name when reconnecting if several people have saved connections on the same computer. A saved connection is a bearer credential: anyone able to read or copy it can use it. Prefer separate OS accounts, and use `--no-save` on shared accounts. Claude Code itself can still save its own history or other state.

### Upgrading and restarts

User names, status, and concurrent-session limits are stored by the sharer in `~/.claude-share/users.json` with restrictive permissions. The sharer creates a new sharing window and fresh credentials on each restart; receivers must get a new invitation and re-pair. Old device-based connections are not migrated to users and will not authenticate. Remove obsolete saved connections from `~/.claude-share/connections/` when they are no longer needed.

The limit counts live Claude sessions across all of a user's enrollments on one running sharer. Do not run multiple sharer instances against the same user configuration: their session counts are independent. Sessions send a heartbeat every 30 seconds; leases without a heartbeat expire after 90 seconds. Limits apply to session credentials, which are bearer credentials and must not be shared. This is not a token or spending quota.

---

## One-time use (npx)

```bash
# Sharer
npx @0xpv/claude-share

# Receiver
npx -p @0xpv/claude-share claude-connect --share <connect-url>
```

---

## Requirements

- **Node.js 18+** on both machines
- **bore** (`brew install bore-cli`) on the sharer machine for internet sharing
- The sharer must be logged in to Claude Code (`claude login`)
- The receiver must have Claude Code installed

---

## Security model

- The sharer's OAuth token is read from the macOS Keychain and injected into requests in-memory. It is never transmitted to the receiver.
- Only these Anthropic endpoints are proxied: `POST /v1/messages`, `GET /v1/models`, `/api/hello`, and OAuth flows on `platform.anthropic.com` / `platform.claude.com`.
- File upload (`/v1/files`), fine-tuning, and assistants endpoints are blocked.
- All non-Anthropic HTTPS traffic passes through as an opaque TCP tunnel — the proxy never sees the contents.
- Sessions expire after the duration chosen at startup (6h / 24h / 1 week).
- Newly saved receiver credentials use restrictive filesystem permissions; older saved files may have broader permissions. People sharing an OS account cannot be securely isolated from one another; use separate OS accounts.
- Enrollment and session credentials are bearer secrets. A person who copies an active session credential can reuse it; concurrent-session limits are not a defense against deliberately shared credentials.
- Disabling, revoking, ending, or expiring a session closes its proxy tunnels. An upstream request already sent before disconnection cannot be recalled.
- The sharer can see connection metadata and can observe intercepted Anthropic traffic; connect only to a trusted sharer. Other users of the same OS account can inspect your files and processes.
- The receiver sends its device name as optional identifying metadata to the sharer.

---

## Development

```bash
# Sharer
bun run dev:share

# Receiver
bun run dev:connect --share <connect-url>
```

Set `TUNNEL=0` to skip the bore tunnel during local development.

Build: `bun run build` — compiles both binaries into their `dist/` folders.

Focused tests (Node.js 22.18+): `node --test claude-connect/*.test.mjs claude-connect/flows/*.test.mjs claude-share/session/*.test.mjs claude-share/server/*.test.mjs claude-share/proxy/*.test.mjs`. The API and proxy tests use test doubles for external libraries.
