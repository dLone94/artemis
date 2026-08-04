# Obsidian vault integration + knowledge constellation + MiniMax TTS — design

Date: 2026-08-04 · Status: approved in conversation, pending spec review
Owner: Todor · Builder: Codex (per standing role split) · Reviewer: Claude

## Context

Artemis is a local-first voice assistant (zero-dep Node server + canvas orb UI).
The user keeps an Obsidian vault at `~/obsidian-vault` (36 notes, ~300 wikilinks,
growing). Two features were designed and approved in conversation, plus one
provider addition:

- **Part A** — vault skills: voice capture to vault, ask-my-notes, meeting filing.
- **Part B** — the vault's link graph rendered as a constellation around the hero orb.
- **Part C** — MiniMax as a TTS provider (Bulgarian + cost + latency), Deepgram fallback.

## Non-goals

- No vault deletes, renames, or edits of existing note content — append-only.
- No graph physics/interactivity in v1 (no hover, no click-to-open) beyond
  pulse-on-citation.
- No MiniMax STT or voice cloning in this iteration; TTS only.
- No support for the user's other two vaults (`Documents/Obsidian Vault`,
  `Documents/Second Brain`); one vault path, configurable.

## Part A — vault module and skills

### `obsidianVault.js` (new server module, zero-dep)

- Vault root from `.env`: `OBSIDIAN_VAULT_PATH` (default `~/obsidian-vault`).
- `scanVault()` walks `*.md` excluding `.obsidian/`, `_attachments/`,
  `graphify-out/`, `_templates/`. Per note: relative path, title (H1 or
  filename), wikilinks (`[[...]]`, alias and heading forms resolved to note
  names), tags, mtime, size. In-memory cache keyed by path, invalidated by
  mtime on each call (a stat pass, no re-read of unchanged files).
- `searchNotes(query, limit=5)` — case-insensitive scoring: filename match >
  heading match > body occurrences; returns `{path, title, snippet}` per hit.
- `readNote(nameOrPath)` — fuzzy resolve (exact path, then exact title, then
  unique substring). Ambiguity returns candidates, not a guess.
- `appendToDaily(text)` — appends `- HH:MM — <text>` under a `## Captured`
  heading in `daily/YYYY-MM-DD.md`; creates folder/file (with `# YYYY-MM-DD`
  header) on demand.
- `writeMeetingNote({title, summary, transcript, reminders})` — creates
  `meetings/YYYY-MM-DD-<slug>.md`; if the slug exists, `-2`, `-3` suffix.
- `vaultGraph()` — `{nodes: [{id, title, degree}], edges: [[i, j]]}` from
  resolved wikilinks; unresolved links ignored.
- **Path confinement invariant:** every write resolves its final path and
  throws unless it is inside the vault root. No API in the module can delete
  or truncate an existing file.

### Tools in `skills.js` (family: `vault`)

- `search_notes {query}` / `read_note {name}` — read-only, no confirmation.
  Results are wrapped in the house `<UNTRUSTED_...>` sentinels (notes can
  contain clipped web text; treated as data, never instructions). Spoken
  summaries follow the gist rule — never read whole note bodies unprompted.
- `save_note {text}` — routes to `appendToDaily`. Append-only ⇒ no
  confirmation gate (same risk class as reads). Action-logged like other
  skills. The spoken ack names the target: "Noted in today's daily note."
- Vault missing/unreadable ⇒ tools return a clean "vault not connected —
  set OBSIDIAN_VAULT_PATH" result; nothing throws.

### Meeting filing

The meeting-completion route (server.js ~L2599) additionally calls
`writeMeetingNote` when the vault is configured. Reminders extracted by the
existing pipeline are wikilinked as `[[YYYY-MM-DD-slug]]` references inside
the note body. Failure to write the note never fails the meeting response —
log and continue.

## Part B — knowledge constellation on the hero orb

- New endpoint `GET /api/vault/graph` (auth-gated like all `/api/*`): returns
  `vaultGraph()` capped to the **top 60 nodes by degree** plus edges among
  them; `{nodes:[], edges:[]}` when no vault. Cache 60s server-side.
- `voiceOrb.js` gains a constellation layer in the existing orbital-HUD
  language (reuse the tilted-ellipse orbit math family used by BrainOrb's
  agent nodes): notes as small dots on 3–4 tilted orbital shells around the
  orb, brightness ∝ degree; edges as whisper-thin arcs drawn only between
  co-visible nodes at low alpha. Slow drift; amplitude-reactive scale ties
  into the orb's existing audio envelope. `prefers-reduced-motion` ⇒ single
  static frame (house rule).
- Refresh: fetch at orb boot; re-fetch after any `save_note` ack and at most
  every 5 min otherwise.
- **Pulse-on-citation:** `search_notes`/`read_note` results carry the matched
  note ids to the client; the orb pulses those constellation dots for ~2s
  when the answer lands. If the plumbing for tool→orb events proves invasive,
  ship the constellation without pulse and file a follow-up.
- Graceful degradation: no vault or empty graph ⇒ layer simply absent.

## Part C — MiniMax TTS provider

Follows the ElevenLabs wiring pattern exactly (provider param, fallback,
`X-TTS-Provider` response header, per-provider char usage counter):

- `.env`: `MINIMAX_API_KEY`, `MINIMAX_GROUP_ID`, `MINIMAX_VOICE_ID`
  (default: a curated voice chosen at ear-test), `MINIMAX_MODEL`
  (default `speech-2.6-turbo`). Provider enabled only when key+group present.
- Endpoint shape (verify against current MiniMax intl docs at build time):
  `POST https://api.minimax.io/v1/t2a_v2?GroupId=<id>`, Bearer auth, JSON in,
  audio out (hex or stream per docs); request MP3 output to match the
  existing `audio/mpeg` pipeline.
- Provider selection: explicit `provider=minimax` wins; default provider
  order becomes `ARTEMIS_TTS_PROVIDER` env override → elevenlabs (if enabled)
  → minimax (if enabled) → deepgram. **Any MiniMax failure falls back to
  Deepgram in-request** (same as the existing elevenlabs→deepgram fallback),
  so Artemis never goes mute.
- `usage.ttsChars.minimax` counter added; `/api/status` `ttsProvider` field
  reflects the new resolution order.
- Both TTS routes (GET stream + POST) support the new provider.

## Testing

`test/vault.test.mjs` (house style, node:test):
- wikilink parsing incl. alias/heading forms; unresolved links dropped.
- search ranking (filename beats body match).
- `appendToDaily` creates folder/file once, appends thereafter.
- `writeMeetingNote` slug collision suffixing.
- graph shape and top-60 cap.
- **path confinement: attempted write outside vault root throws.**

`test/tts-minimax.test.mjs`:
- provider resolution order with/without keys.
- fallback to deepgram on MiniMax non-200 (mocked fetch).
- char usage counter increments.

Constellation: visual verification via the app (screenshot pass), plus a
node-count cap assertion if graph endpoint logic is unit-testable.

## Build order

1. Part A module + tools + tests (server-only, immediately useful).
2. Part C MiniMax provider + tests (small, independent; needs user's API key
   and GroupId to verify live).
3. Part B endpoint + constellation (depends on Part A's `vaultGraph()`).

## Open items (user)

- Provide `MINIMAX_API_KEY` + `MINIMAX_GROUP_ID` (account exists).
- Ear-test MiniMax voices and pick `MINIMAX_VOICE_ID` (EN + BG samples).
