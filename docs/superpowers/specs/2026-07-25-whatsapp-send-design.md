# Sending WhatsApp messages — design

**Date:** 2026-07-25
**Status:** approved, not yet implemented

## Goal

"Text my wife I'll be twenty minutes late" should open WhatsApp with that message
typed into her chat, ready to send.

## Decisions

| Question | Decision |
|---|---|
| Send, or pre-fill? | **Pre-fill.** WhatsApp opens with the text in the box; the user presses Enter. |
| Transport | Apple's `whatsapp://send` URL scheme |
| Who is "my wife"? | Artemis's own contact store, populated once via the existing `add_contact` skill |
| Group chats | Out of scope — the URL scheme addresses phone numbers only |

## Why pre-fill

The message goes to a real person and originates from speech, so a transcription
error is a message you cannot unsend. The confirmation gate already reads the
text back before anything happens, and pre-fill adds a second look at the actual
words in WhatsApp's own window.

It is also the durable choice. The URL scheme is a public API; UI automation
would need Accessibility permission and would break the next time WhatsApp
moves a button.

The cost is honest: one keypress, so this is not fully hands-free.

## Why not the unofficial libraries

`whatsapp-web.js` and Baileys can genuinely send, by logging in as the user's
account. They pull in a Puppeteer-sized dependency tree — this project has no
`node_modules` at all — and they violate WhatsApp's terms, with account bans a
documented outcome. Not worth it for one feature.

## Architecture

One new module. Everything else already exists.

### `whatsapp.js`

```
normalizePhone(raw) -> string | null
composeUrl(phone, text) -> string
openLocally(url) -> Promise<void>
```

- **`normalizePhone`** strips `+`, spaces, dashes and parentheses, then requires
  8–15 digits (the E.164 range). WhatsApp wants bare digits: `+359 88 123 4567`
  becomes `359881234567`. Returns `null` rather than guessing.
- **`composeUrl`** percent-encodes the body so ampersands, newlines and emoji
  survive.
- **`openLocally`** hands the URL to macOS via `execFile("/usr/bin/open", [url])`
  — an argument array, never a shell string — and **refuses any URL whose scheme
  is not `whatsapp:`**. The server gaining the ability to launch local
  applications is a new capability, and that check is its boundary.

### `skills.js` — `send_message`

Stops being simulated. Resolves the contact, normalizes the number, opens
WhatsApp, and reports what actually happened:

> "WhatsApp is open with your message to Maria — press Enter to send."

Never "sent", because it wasn't. Same rule as the rest of the reliability work:
a spoken claim has to be true.

The confirmation prompt changes from "Should I send it?" to "Want me to open
WhatsApp with that ready?", which is what will actually occur.

## Safety

`send_message` is already `requiresConfirmation: true` and carries `external:
true` in the tool registry, so it always requires an explicit spoken yes, and
`needsConfirmation` additionally forces confirmation on any turn that has read
attacker-influenced text. A poisoned email cannot cause a message to the user's
wife: it would have to survive the untrusted-content framing, then get the user
to say "yes" to a prompt that reads the message aloud.

## Error handling

Each case says which thing went wrong, out loud:

| Case | Response |
|---|---|
| No contact by that name | "I don't have a number for your wife — tell me her number and I'll save it." |
| Contact exists, no phone | "I have Maria saved but without a number." |
| Number won't normalize | "That number doesn't look right — it should include the country code." |
| WhatsApp not installed | "WhatsApp isn't installed on this Mac." |
| `open` fails | Reports the failure rather than claiming success. |

## Testing

- `normalizePhone` across the formats people actually type: `+359 88 123 4567`,
  `00359881234567`, `(359) 88-123-4567`, too short, too long, letters.
- `composeUrl` encoding for `&`, newlines, emoji, quotes.
- `openLocally` refuses `http://`, `file://`, `javascript:` — the injection
  boundary.
- `send_message` with a stubbed opener: asserts the exact URL, and asserts the
  summary never claims the message was sent.
- The existing `confirm-gate` test already covers that no send happens without a
  spoken yes.

## Out of scope

- Group chats
- Reading incoming WhatsApp messages
- Actually pressing send (UI automation)
- macOS Contacts.app lookup — the existing store plus one setup sentence per
  person is enough
