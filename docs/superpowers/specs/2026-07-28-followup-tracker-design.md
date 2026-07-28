# check_followups — who owes whom a reply

**Date:** 2026-07-28
**Status:** approved (skills roadmap item 2), corrected after code/API audit

## What it does

On demand — "any follow-ups?", "who owes me a reply?", "did anyone not
answer me?" — she scans the last 14 days of Gmail and reports two lists:

1. **You owe them**: threads whose actual newest message is an inbox
   message, is older than 24 hours, and has no newer user-authored reply.
2. **They owe you**: threads whose actual newest message has Gmail's
   `SENT` label, is older than 72 hours, and has no newer incoming reply.

The two Gmail searches can return the same thread. Merge and deduplicate
thread IDs, fetch each thread once, sort its messages by numeric
`internalDate`, and classify only from the actual newest message. Never
use the sender-controlled RFC `Date` header for ordering or thresholds.
The thresholds are strict (`> 24 h`, `> 72 h`); invalid or future
`internalDate` values are excluded.

Spoken result: at most 3 per list, newest first, counterparty + subject +
age ("Maria, about the invoice — four days"). Its trusted summary counts
all candidates fetched, not only the displayed snapshot; when more than
3 exist in a list, say only the newest 3 are shown. The response says "I
checked the last two weeks" and says the Gmail scan was capped only when
either list response supplied `nextPageToken`; an uncapped result gives
an exact fetched total, while a capped result says "at least N". A thread
with a recent user reply is excluded from **You owe them**; if that reply
itself becomes older than 72 hours, the thread correctly moves to
**They owe you**.

## Nudge compose windows — never sends

If the user asks to nudge/chase an item, `nudge_email` accepts only
`{ list, number }`, where `list` is one of the two explicitly displayed
lists and `number` is a current displayed position. It opens a new
prefilled Gmail compose window after explicit confirmation. This URL is
not a Gmail draft and is not guaranteed to attach to the original thread.
The user reviews it and presses Send. In a browser signed into multiple
Google accounts, the generic compose URL may use the browser's currently
active/default Gmail account; binding the numbered list to the OAuth
profile prevents stale selection but cannot choose the browser's sender
account.

The compose action is a narrow, server-built exception to the general
"never put untrusted mail data in a URL" rule:

- The model never supplies a recipient, subject, body, URL, query, or
  conversation text. Extra arguments are ignored and cannot affect the
  action; query-only calls fail validation.
- The recipient comes only from metadata headers saved for the selected
  thread, never from a message body or snippet. Incoming mail uses one
  unambiguous `Reply-To` address when present, otherwise one unambiguous
  `From` address. Outgoing mail uses exactly one non-self address across
  `To`/`Cc`/`Bcc`. Missing, malformed, duplicate-header, arbitrary-text,
  C0/C1/control-format/bidirectional, or multiple-counterparty input makes
  the nudge fail closed; parsing must never repair a malformed header into
  a different valid-looking recipient.
- A header address is a routing value asserted by the message, not a
  verified real-world identity. The confirmation names the selected list
  position and exact validated address, but deliberately does not repeat
  the untrusted sender display name or subject. Confirmation replies are
  persisted as assistant conversation messages, so echoing a malicious
  subject there would bypass the result's untrusted-content frame.
- The subject is cleaned, control-free, and bounded. The body is one
  fixed, short server-side follow-up sentence and contains no mail body,
  model output, conversation text, or secrets.
- Build with `new URL("https://mail.google.com/mail/")` and
  `URLSearchParams`; validate the final origin, path, and allowed keys.
  Never construct it with string interpolation.
- Snapshot the selected list item and list version at confirmation time.
  If an explicit follow-up listing changes before "yes", refuse rather
  than redirecting the confirmed number to another recipient. Bind the
  listing to the cached Gmail profile address and re-check that account
  before confirmation and execution; an account switch invalidates it.

`nudge_email` is always confirmation-gated. A daily-brief scan never
creates or changes a nudgeable numbered list; only an explicit successful
`check_followups` call does.

## Gmail/OAuth boundary

Artemis adds no `gmail.send` or `gmail.compose` scope and implements no
Gmail draft/send endpoint or send tool. The existing `gmail.modify`
scope remains because `email_delete` needs recoverable Trash. Google
documents `gmail.modify` as technically authorizing send as well, so an
OAuth token that is literally incapable of sending is incompatible with
retaining the existing Trash feature. The enforced boundary here is that
the adapter exposes no draft/send request path at all.

## Implementation

- `gmail.js`
  - Add `listThreads(q, max)`, clamped to 1–25, returning thread IDs plus
    `capped: Boolean(nextPageToken)`.
  - Add `getThreadMeta(id)` using `encodeURIComponent(id)` and
    `format=metadata`, requesting only `From`, `Reply-To`, `To`, `Cc`,
    `Bcc`, `Subject`, and `Date`. It preserves duplicate header values so
    recipient selection can reject ambiguity, and returns metadata for the
    first and last messages after sorting by `internalDate`, including
    `labelIds`; it never requests or returns a body or snippet.
  - Add `getProfileAddress()` via `gapi("/profile")`. Cache only a
    successful resolved address per process, coalesce an in-flight call,
    do not cache failures, and clear identity cache when auth cache is
    cleared. Generation-guard token, profile, and Gmail API responses so
    an in-flight old-account request cannot repopulate or publish after
    reauthorization; a follow-up scan snapshots and re-checks that same
    generation across all list/thread requests. `users/me/profile`
    supplies only the primary address; using
    the newest message's `SENT` label avoids direction errors for send-as
    aliases.
  - Queries are `in:inbox newer_than:14d -category:promotions
    -category:social` and `in:sent newer_than:14d`, max 25 each.
- `skills.js`
  - Add one shared follow-up scanner. It deduplicates overlapping thread
    IDs, applies the exact direction/age rules above, and returns the raw
    candidates plus the honest cap flag.
  - Cache successful scans for 60 seconds per injected context/account,
    including an in-flight Promise; never cache failures. Rendering or
    explicit listing publication must not mutate the cached value.
  - Add `check_followups`: read-only, no confirmation. It publishes only
    the <=3-per-list items actually shown into a versioned
    `lastFollowupsList`, clearing stale state on empty/error. Its
    count-only summary is trusted; every sender/address/subject value is
    inside exactly one `wrapUntrusted("UNTRUSTED_EMAIL_CONTENT", ...)`
    frame, with trusted readback/data-only instructions outside.
  - Add `nudge_email`: `{ list: "you_owe_them"|"they_owe_you",
    number: 1..3 }`; precheck, confirmation naming only the selected
    position plus exact validated address, versioned selection snapshot,
    fixed-origin compose URL, always confirm. It never reads bodies,
    repeats no untrusted sender/subject in the confirmation reply, and
    ignores all non-schema action data.
  - The daily brief's mail section appends one count-only clause when the
    cached tracker finds anything: "and two threads look stuck — ask me
    about follow-ups." If capped, say "at least N". Tracker failure or
    timeout only omits this clause and must not make unread mail itself
    appear unreachable. Because the existing mail section also contains
    untrusted unread sender/subject text, the entire `daily_brief` tool
    content is untrusted-wrapped and the skill taints the turn.
- `untrusted.js`
  - Add `check_followups` and `daily_brief` to `UNTRUSTED_SKILLS`. Do not
    add `nudge_email`; it consumes a confirmed cached selection and its
    allowlisted compose action must not be dropped as a fresh untrusted
    read.
  - Once a turn has read mail/message-controlled text, block generic
    network and browser tools (`web_search`, `fetch_page`, web research,
    investment research, `open_url`, and `play_media`) before execution,
    not merely when returning client actions. This closes query/URL
    exfiltration prompted by a hostile header. The numbered,
    metadata-derived, always-confirmed `nudge_email` path remains the only
    allowed compose exception.
  - Taint survives request boundaries without becoming permanent. Mark
    assistant replies derived from mail/message content in stored UI
    history, but replace the marked text with a fixed structural
    placeholder before it ever re-enters model context. The visible
    transcript can retain the reply; the model never receives its
    attacker-controlled paraphrase on a later request, and unrelated
    explicit web/open commands are not disabled forever. Apply the
    registry's tainted-mutation confirmation policy in the legacy
    Anthropic loop too. Stream the taint marker before any mail-derived
    reply token, not only in the terminal event, so a dropped connection
    cannot persist a fail-open unmarked partial reply.
- `toolRegistry.js`
  - Add metadata family `followups`, Gmail availability, and separate
    routing keys: read-shaped requests route to `followups` and expose
    only `check_followups`; nudge/chase requests with follow-up/list/thread
    context route to `followups_nudge` and expose only `nudge_email`.
    `nudge_email` has client effect, `external: true`, and
    `confirm: "always"`.
  - Keep `email_delete` ahead of follow-up routing. Explicit email-delete
    wording still wins; the bare numbered-delete branch excludes
    follow-up/nudge/thread nouns. Negated nudge/chase/follow-up requests
    are chat and never actions.
- `server.js` and `public/main.js`
  - The confirmation endpoint currently discards `openUrl`. After a
    confirmed `nudge_email`, return exactly one validated Gmail-compose
    client action and have the existing browser action handler consume
    it. Do not generically trust arbitrary confirmed URLs.
  - Persist only `{ ok, summary }` for the confirmed result. The nudge's
    post-confirm summary is generic and contains no recipient, subject, or
    body, so the action log never stores the compose URL or any of its
    query values.
  - Confirmation parsing is refusal-biased: if one utterance contains both
    affirmative and negative language ("yes—actually no", "sure, cancel"),
    it is a refusal and cannot open the compose window.
- `test/followups.test.mjs`
  1. Correct two-list classification from fixed, overlapping thread
     fixtures, including a recent answered thread excluded from both;
     hostile sender/subject text remains in one untrusted wrapper.
  2. Strict age thresholds use `internalDate`; exact-boundary, invalid,
     and future values are excluded.
  3. `nextPageToken` drives honest capped wording; a shared context reuses
     one scan for 60 seconds, and tracker failure does not erase the brief's
     unread-mail result.
  4. Nudge refuses without a current explicit listing; read/nudge/delete
     routing is isolated; no/expired confirmation opens nothing; yes opens
     one exact-host compose URL; stale selection is refused; hostile extra
     args, a subject containing `&to=`, and an address found only in BODY
     text cannot change the header-derived recipient/body/URL.
  5. Source inspection proves `gmail.js` contains no Gmail send/draft
     endpoint and no `gmail.send`/`gmail.compose` scope.
  Add the suite to `package.json` immediately before the eval.

## Constraints

No new dependencies. No background polling. No Gmail draft/send endpoint
or tool. No new send-specific scope. Numbers, never free-text queries, for
nudges. Mail fields stay untrusted and bounded. Compose recipients come
only from the selected thread's metadata headers, never BODY text.
