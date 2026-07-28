# check_followups — who owes whom a reply

**Date:** 2026-07-28
**Status:** approved (skills roadmap item 2)

## What it does

On demand — "any follow-ups?", "who owes me a reply?", "did anyone not
answer me?" — she scans the last 14 days of Gmail and reports two lists:

1. **You owe them**: inbox threads where the newest message is addressed
   to the user, is older than 24 h, and the user never replied after it.
2. **They owe you**: threads whose newest message is FROM the user (sent),
   older than 3 days, with no reply after it.

Spoken result: at most 3 per list, newest first, sender + subject + age
("Maria, about the invoice — four days"). Honest bounds: "I checked the
last two weeks" and, when the scan was capped, say so.

## Nudge drafts — never sends

If the user asks to "nudge" / "remind" one of them: compose a SHORT polite
follow-up and open a **prefilled Gmail compose window** in the browser
(`https://mail.google.com/mail/?view=cm&to=<addr>&su=Re:%20<subject>&body=<draft>`)
via the existing open-url client action. The user presses Send themselves.
This is effect: external → existing confirm gate applies. Artemis has no
send capability anywhere; this must stay true (test asserts no
gmail.googleapis.com/…/send call exists).

## Implementation

- gmail.js: `listThreads(q, max)` + `getThreadMeta(id)` (From/To/Subject/
  Date of first + last message only, format=metadata) using the existing
  token plumbing. Queries: `in:inbox newer_than:14d -category:promotions
  -category:social` and `in:sent newer_than:14d`. Max 25 threads per list.
  The user's own address comes from the existing profile fetch or
  `users/me/profile` (one call, cached per process).
- skills.js: `check_followups` (read-only, no confirm, family email;
  content instructs the model to read the result verbatim-ish, short) and
  `nudge_email` (params: which list + number from the last followups
  listing, same numbered-list discipline as delete_email; effect external;
  confirm always; opens the compose URL via clientActions like open_url
  does). lastFollowupsList module state mirrors lastEmailList.
- toolRegistry.js: patterns — followups family:
  /follow-?ups?|owes? me a repl|didn'?t (answer|reply)|waiting on (a )?repl|chase|nudge/i
  routed like other read families; nudge_email confirm "always".
- Brief integration: daily_brief's mail section appends one clause when
  the tracker finds anything: "and two threads look stuck — ask me about
  follow-ups." Reuse the same scan with a 60 s cache; omit on failure.
- test/followups.test.mjs: fake gmail ctx; cases: (1) correct two-list
  classification from fixed thread fixtures (incl. a thread the user DID
  answer → excluded); (2) age thresholds respected; (3) caps + honest
  "capped" flag; (4) nudge_email refuses without a current listing, needs
  confirmation, and produces a compose URL — never a send API call;
  (5) grep: no /send endpoint string in gmail.js. Add to npm test.

## Constraints

No new deps. No background polling — on-demand only (+ the cached brief
clause). Untrusted mail text stays wrapped per UNTRUSTED_SKILLS rules;
sender names/subjects in spoken output pass through the existing
cleanEmailField. Numbers-not-queries for nudges. No send scope, ever.
