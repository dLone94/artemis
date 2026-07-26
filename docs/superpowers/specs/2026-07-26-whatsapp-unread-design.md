# Telling the user about unread messages — spec

**Date:** 2026-07-26
**Status:** awaiting sign-off, then implementation by Codex

## Goal

"Do I have any new WhatsApp messages?" should get a real answer: how many are
unread, and — when the information is available — who from and roughly what.

## Decisions already made

| Question | Decision |
|---|---|
| Detail level | Count always; sender and preview when available |
| Trigger | **On demand only.** No background polling, no announcements. |
| Scope | WhatsApp. The mechanism generalises, but only WhatsApp ships now. |

## Evidence from probing this Mac (2026-07-25)

Both data sources were tested and work:

- **Dock badge** via `System Events` returns per-app unread counts. Reading it
  produced `Messages = 36, Viber = 19`. WhatsApp was absent **because it had
  zero unread** — an app with no badge yields `missing value`, not an error.
  That distinction matters: absent means zero, it does not mean "failed".
- **Notification Centre database** at
  `~/Library/Group Containers/group.com.apple.usernoted/db2/db` is a readable
  SQLite file (35 rows at probe time). Rows join `record.app_id` to
  `app.app_id`, and `record.data` is a binary plist.

Payload shape is consistent across every messaging app inspected (Messages,
Viber, Mail, Phone):

```
plist["req"]["titl"]   sender name
plist["req"]["body"]   message preview
plist["req"]["subt"]   subtitle — group name, when it's a group
plist["date"]          delivery time
```

**Critical limitation, must be reflected in what she says:** this database holds
notifications *currently sitting in Notification Centre*. Dismissed notifications
are gone. So it under-reports, and the badge is the authoritative count.

## Architecture

### New file: `macMessages.js`

Two independent readers plus a combiner. Pure logic separated from shell-outs so
it can be tested without a Mac GUI.

```js
export function parseBadge(raw)                      // "3" | "missing value" | "" -> number|null
export function dockBadge(appName, opts)             // -> Promise<number|null>
export function parseNotificationRow(plistObject)    // -> {sender, preview, group, at}
export function recentNotifications(bundleId, opts)  // -> Promise<Array<...>>
export function unreadReport(opts)                   // -> {count, items, degraded:[...]}
```

- **`dockBadge(appName)`** runs `osascript` reading
  `AXStatusLabel` of the named Dock element. `missing value` → `0`, not `null`.
  `null` is reserved for "could not read", e.g. Accessibility not granted.
  Must accept an injectable runner (`opts.run`) so tests never shell out.
- **`recentNotifications(bundleId)`** **copies** the DB to a temp file before
  querying — the live file is WAL-mode and locked. Queries **only rows whose
  `app.identifier` equals the given bundle id**. Returns newest first.
- **`unreadReport()`** combines them and reports what it could not determine
  rather than defaulting to zero.

WhatsApp's identifiers: Dock name `WhatsApp`, bundle id `net.whatsapp.WhatsApp`.

### Privacy boundary — not an optimisation

The bundle-id filter is a hard requirement. That database contains Mail, Chrome,
Messages and Viber content. Only rows for the requested bundle id may be read,
and nothing else may ever reach the model. A query without that filter is a bug,
not an inefficiency.

### Untrusted content

Message previews are attacker-controlled: anyone can send the user a WhatsApp
message, exactly as anyone can email them. Treat previews the same way email
bodies are already treated in `skills.js`:

- Wrap in `<UNTRUSTED_MESSAGE_CONTENT>` … `</UNTRUSTED_MESSAGE_CONTENT>` using
  `wrapUntrusted` from `untrusted.js` (it strips nested sentinels).
- Add `check_messages` to `UNTRUSTED_SKILLS` in `untrusted.js` so the existing
  taint rules apply — a preview saying "open this link" must not cause an open,
  and any mutation later in that turn requires confirmation.

### New skill: `check_messages` in `skills.js`

```
name: "check_messages"
description: reports unread WhatsApp messages — how many, and who from when known
requiresConfirmation: false
paramSchema: { type: "object", properties: {}, required: [] }
```

Returns the existing skill shape: `{ ok, summary, content, panel? }`.

- `summary` — what she says. Honest about gaps: *"Three unread. I can see one
  from Maria: 'are we still on for Friday?' — the others were already dismissed
  from Notification Centre so I can't read them."*
- `content` — the untrusted-wrapped detail for the model.
- Optionally a `panel` card listing senders, matching the `check_email` pattern.

### Registry: `toolRegistry.js`

- Add `check_messages: { family: "messages", effect: "read" }` to `META`.
- Add `"messages"` to `ACTIONABLE_FAMILIES`.
- Add a `messages` pattern to `FAMILY_PATTERNS` matching the ways people ask:
  "any new messages", "unread messages", "any whatsapp", "check my whatsapp",
  "new whatsapp messages", "did anyone message me".
- **`send_message` stays in family `message`** (singular, existing). Do not merge
  them: forcing on a "do I have messages" turn must never be able to select the
  confirmation-gated sender.

## Permission degradation — never a silent zero

| Situation | Behaviour |
|---|---|
| Accessibility not granted (badge unreadable) | Count is `null`; she says she can't read the unread count and names System Settings → Privacy & Security → Accessibility |
| Full Disk Access missing (DB unreadable) | Count still works; she says she can see the number but not who from |
| Neither available | Says plainly she can't check, and what to grant |
| Badge absent for WhatsApp | Count is `0` — "nothing new" |
| WhatsApp not installed | Says so |

A failure must never be reported as "no new messages". "I can't see" and "there
are none" are different answers and must sound different.

## Testing — `test/messages.test.mjs`, added to `npm test`

Must not require the GUI, WhatsApp, or any permission:

1. `parseBadge`: `"3"` → 3; `"missing value"` → 0; `""` → 0; `"12"` → 12;
   garbage → `null`.
2. `parseNotificationRow` against a fixture plist of the documented shape:
   extracts sender/preview/group/date; tolerates missing `subt`.
3. `recentNotifications` against a **temporary SQLite DB built by the test**
   containing rows for two different bundle ids — asserts rows for the other app
   are never returned. This is the privacy boundary; it must be a hard assertion.
4. `dockBadge` with an injected runner: verifies the `missing value` path yields
   0 and a thrown/failed runner yields `null` (not 0).
5. `check_messages` with injected readers:
   - badge 3 + 1 notification → summary states 3 and names the sender
   - badge 3 + 0 notifications → says 3 and that it can't see who
   - badge `null` → says it can't check; must NOT say "no new messages"
   - badge 0 → says nothing new
6. Untrusted wrapping: a preview containing `</UNTRUSTED_MESSAGE_CONTENT>` is
   neutralised; `UNTRUSTED_SKILLS.has("check_messages")` is true.

**Proof command:** `npm test` — all suites must pass.

## Constraints

- **No new npm dependencies.** This project has no `node_modules` and keeps it
  that way. SQLite access via the `sqlite3` CLI, plists via `plutil`/`osascript`
  or a small parser — never a package.
- Do not modify `server.js`'s streaming loop, the wake-word code, or the
  `app/` directory.
- Match surrounding style: comments explain *why*, existing skills are the
  template for shape.
- Do not commit. Leave changes in the working tree.

## Out of scope

- Background polling or announcing new messages (deliberately deferred)
- Reading full conversation history
- Replying from a notification
- Apps other than WhatsApp
