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
