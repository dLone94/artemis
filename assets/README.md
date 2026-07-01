# Celebration sound

`celebration.mp3` here is the sound played on each revenue celebration. It's generated
by default (Deepgram TTS), but you can replace it with any browser-decodable audio
(`.mp3`, `.wav`, `.ogg`) — just keep the filename `celebration.mp3`, or change
`CELEBRATION_SOUND_URL` in `../public/celebration.js`.

- Fetched and decoded **once**, then reused for every celebration.
- The **visual** is always the primary signal. If the file is missing, or the browser
  blocks autoplay before your first click, the animation still plays — the sound just
  stays silent until audio is allowed.
- The orb reacts to the sound's live amplitude, so a short, punchy clip (~1–2s) works best.

# Demo voice clip

`demo-artemis.mp3` is the short spoken clip behind the **"Hear it spoken"** button in
the landing page's Proof ("See it talk") section, so *spoken out loud* is literally true.
It's **off by default** and plays only when the user taps the button.

- Generated with Deepgram TTS, voice `aura-2-thalia-en`, from Artemis's first demo answer.
- To regenerate (from the repo root, with `DEEPGRAM_API_KEY` in `.env`):

  ```sh
  KEY=$(grep -E '^DEEPGRAM_API_KEY=' .env | cut -d= -f2-)
  curl -X POST "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=48000" \
    -H "Authorization: Token $KEY" -H "Content-Type: application/json" \
    -d '{"text":"Top of Hacker News right now: a Show HN for a local-first sync engine, and a deep dive on WebGPU compute. Want me to open either?"}' \
    -o assets/demo-artemis.mp3
  ```

- Or replace the file with your own recording (keep the filename, or change the `<audio>`
  src in `../public/index.html`). If the file is missing/blocked, the button disables
  itself and the transcript still works — the clip is purely additive.
