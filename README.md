# Artemis — Revenue Celebrations

A tiny, **zero-dependency** assistant that celebrates real Stripe payments: a confetti
burst scaled to the amount, a sound, and an "orb" presence that reacts to that sound —
and it never misses a payment, even one that arrived while the screen was closed.

No framework, no build step, no npm install. Just Node's built-in `http`/`fs`, `fetch`
for Stripe (no SDK), and vanilla JS + Canvas + Web Audio on the front end.

## Run

```sh
node server.js
```

This machine has no `node`/`npm` on PATH; use the standalone Node directly:

```sh
'/Users/todortopalov/Library/Caches/ms-playwright-go/1.57.0/node' server.js
```

Then open **http://localhost:4100** and click **Test 🎉** (cycles small/medium/large).
Click the page once so the browser allows audio, and you'll hear the sound + see the orb react.

## Connect Stripe (optional)

Copy `.env.example` to `.env` and set a **test-mode** key:

```
STRIPE_SECRET_KEY=sk_test_...
```

The server then polls Stripe every 5s (looking back 5 min), filters to real captured
payments, de-dupes by charge id, and writes them to `.data/revenue-events.json`. The
front end polls `/api/payments/recent`, so:

- payments seen while the page is open celebrate within ~5s (live), and
- payments that arrived while the page was closed celebrate on the next open (catch-up),
- never twice (a per-client record in `localStorage` keeps live + catch-up in agreement).

## Tuning

- **Tier thresholds / intensity:** `TIERS` at the top of `public/celebration.js`.
- **Sound:** replace `assets/celebration.mp3` (see `assets/README.md`).
- **Poll interval / lookback / retention:** constants at the top of `server.js`.
- **Burst replay cap:** `MAX_REPLAY` in `public/app.js`.
