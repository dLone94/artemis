# Competitive Teardown: VoiceOS (WakoAI) and the macOS Voice-Agent Market — A Builder's Brief for Artemis

> Provided by Theo on 2026-08-02. Preserved verbatim as product-strategy input.
> Directly relevant to Artemis today: confirm-before-act is already our pattern
> (send_message gate), MCP extensibility and local-first are our defaults, and
> the English+Bulgarian code-switching gap matches the household's actual usage.

## TL;DR
- **VoiceOS is a cloud-first, agentic voice layer** (not just dictation) with four modes — Dictate, Agent, Ask, Edit — whose real differentiator is Agent Mode's cross-app actions gated by a mandatory confirmation card; its weaknesses (cloud dependency, no offline mode, a credit-card-required trial, thin integration list) are exactly the gaps a fully local app like Artemis can exploit.
- **The market splits cleanly on one axis: does your audio leave the device?** Cloud tools (VoiceOS, Wispr Flow, Aqua Voice, Typeless) win on AI polish and agentic actions; local tools (superwhisper, Resonant, VoiceInk) win on privacy, offline use, and one-time pricing — and there is a large, vocal segment frustrated by subscription fatigue and usage caps that no cloud incumbent serves.
- **For Artemis, the winning position is "local-first agentic":** copy VoiceOS's confirm-before-act pattern, fn-key hold-to-talk, per-app context formatting, and MCP extensibility, but deliver them fully on-device (WhisperKit + Ollama), with no caps, no subscription, and explicit handling of English+Bulgarian mixed speech — a gap no competitor currently addresses well.

## Key Findings

1. **VoiceOS = WakoAI Inc., YC Spring 2025 (X25/P25 batch), founders Kai Brokering and Jonah Daian.** It runs on Mac and Windows (mobile "coming soon"), positions itself as "the Siri for productivity" / "JARVIS for your computer," and launched on Product Hunt twice (April 3, 2026, ranking #4 of the day; June 18, 2026, ranking #8). Per PitchBook, "VoiceOS has raised $500K. Y Combinator, LAUNCH Accelerator (Berkeley), and CITRIS Foundry have invested in VoiceOS."

2. **Four modes:** Dictate (clean voice-to-text with filler removal, per-app tone, custom vocabulary, 100 languages), Agent (multi-step cross-app actions via OAuth integrations + user MCP servers, with a confirmation card before anything sends/books/changes), Ask (screen-aware Q&A — "point anywhere on your screen"), and Edit (rewrite selected text by voice).

3. **Pricing is more aggressive than the "free 100/week, Pro $12/mo" summary suggests.** The live pricing page states there is **no free sign-up option**: every new account starts on a **7-day Pro trial that requires a credit card**, and the "free tier" (100 dictation sessions/week + 25 Agent Mode sessions/week, reset Mondays) is only what you drop to if you cancel. Pro is $11.99/month billed annually (advertised 60% cheaper than monthly); Enterprise is custom (SOC 2 Type II, ISO 27001, SSO/SAML, zero data retention). Students and "builders" get 50% off.

4. **VoiceOS is cloud-dependent despite an "on-device" homepage note.** Independent review (Weesper) confirms audio streams to VoiceOS servers for transcription and the entire agent layer requires connectivity. The claimed ~300–350ms latency is a vendor claim not independently verified; reviewers explicitly call it impressive "on paper."

5. **Recurring criticisms** (from reviews, one real Product Hunt user, and competitor teardowns): thin integration list (no Asana, Linear, or GitHub at launch), cloud/privacy concerns, annual-billing-only Pro, launch-day bugs ("some kinks"), and no offline/Linux/mobile support. Genuine independent user complaints are surprisingly scarce — most "criticism" is analytical, from SEO or competitor blogs.

6. **The competitor set falls into three tiers:** cloud-agentic (VoiceOS), cloud-dictation-plus-cleanup (Wispr Flow, Aqua Voice, Typeless, TalkTastic), and local-first (superwhisper, Resonant, VoiceInk). Only VoiceOS and Wispr Flow offer meaningful action/command capability; only local tools offer true offline privacy.

7. **Mixed English+Bulgarian speech is essentially unaddressed by the incumbents.** All support Bulgarian as one of "100+ languages," but code-switching (mixing languages mid-sentence, especially across scripts like Latin/Cyrillic) is a quantified weak point for Whisper-class models. This is an open opportunity for Artemis if handled deliberately.

## Details

### VoiceOS Product Teardown

**Interaction model / hotkey.** VoiceOS's own pages repeatedly instruct users to "Press **fn** and start speaking," making the fn key the primary push-to-talk activation on Mac. A floating "lens"/orb panel appears near the cursor; long-running agent tasks "keep running at the side of your screen" and return results asynchronously. The exact permission-request sequence (microphone, accessibility, screen recording) is **not documented publicly** and could not be independently confirmed; by category norms all three are required for system-wide typing plus screen awareness.

**Dictate Mode.** Marketed as "4x faster than typing" (claims ~220 wpm speech vs ~45–55 wpm typing). Features: filler-word removal ("um/uh" stripped), spelling/typo correction, learned custom vocabulary ("WakoAI" spelled your way), auto-formatting into lists, and **per-app tone adaptation** — the same thought lands as a formal email in Mail, a terse line in Messages, or bullets in Notion. Supports 100 languages with auto-detection (no manual switching). Weesper's teardown details the app-specific behavior: formal tone with salutations in Gmail/Outlook; conversational, no "Dear," shorter lines in Slack/Teams; camelCase and function-name recognition in VS Code/Cursor/Xcode; academic paragraphs in Docs/Word.

**Agent Mode.** The core differentiator. Connect Slack, Gmail, Notion, Linear, Google Calendar, Google Drive, Finder, Apple Maps, Google Docs, Reminders, Messages, Obsidian — plus **your own MCP server** (`voiceos add mcp`), which is architecturally the single most important feature for a builder to note. It chains multi-step commands ("schedule a meeting with Sarah tomorrow at 2pm and send her a Slack message about it"). **Confirmation step:** "Nothing sends until you say so" — anything that sends, books, or changes shows a card ("Before it sends") with the target recipient and message body and Cancel/Send buttons. Long tasks run in a side panel and report back on their own.

**Ask Mode.** Screen-context Q&A: "VoiceOS sees what your cursor is on and answers instantly. No copy-paste." Used for "find his LinkedIn," "search for last year's tax returns." Reviewers note it is good for quick lookups and clarifications, weaker for complex reasoning.

**Edit Mode.** Select text, speak a change ("make it shorter/more formal/simpler"), and it rewrites in place. No source documented a diff/redline UI; it appears to be an in-place replacement rather than a visible diff — a notable gap.

**Integrations evolution.** The integration set has grown from the launch focus (Gmail/Slack/Calendar/Notion/Drive) to include Linear, Finder, Apple Maps, Obsidian, Reminders, Messages, plus user MCP support — but still lacks Asana, GitHub, and a public API. The homepage advertises a broad icon wall (Cursor, VS Code, ChatGPT, Claude, WhatsApp, Telegram, Outlook, Superhuman, Dia, etc.), some of which are dictation targets rather than true agent integrations.

**Privacy stance.** Marketing: "Your audio is never stored on our servers and never used to train models. You decide what leaves your Mac." Toggles cover saving transcripts on-device, not saving audio to cloud, and never training on dictation. But the architecture is cloud: audio is transmitted for transcription and the agent layer needs servers. Enterprise adds enforced Private Mode plus zero data retention. Weesper flags that granting OAuth to Gmail/Calendar/Slack "adds attack surface" that SOC 2 reduces but does not eliminate.

### Competitor Comparison

**Wispr Flow** — Cloud-only (no offline mode at any tier, confirmed by multiple reviews); Mac, Windows, iOS, Android. Strong AI cleanup, context-aware tone, whisper-mode recognition, and Command Mode (select text → voice instruction to rewrite/translate; it explicitly does *not* read your screen — you must pre-select text). Pricing: Basic free (2,000 words/week desktop, 1,000/week iOS), Pro $15/mo or $144/yr, Teams ($10–12/user/mo), Enterprise (~$24/user/mo). Compliance: SOC 2 Type II, ISO 27001, HIPAA BAA across plans. Praised for polish and accuracy; criticized heavily for cloud-only architecture, privacy (a 2025–26 screenshot/context-capture controversy and a March 2026 compliance-vendor issue), a low Trustpilot score (~2.7/5), and price. No agentic cross-app actions.

**superwhisper** — Local-first on Apple Silicon (Whisper runs on-device; audio never leaves the Mac in local mode), with optional cloud models proxied so providers never see your account. Mac, Windows, iOS. Custom Modes (per-mode hotkey, model, LLM post-processing prompt, auto-activation by app). Pricing: free tier (small local models), Pro $8.49/mo or $84.99/yr, **lifetime $249.99** (note: sources report a controversial lifetime price hike, with one citing a jump toward the mid-hundreds). Won a Product Hunt privacy award. Praised for privacy, flexibility, and the lifetime option; criticized for a steep learning curve, weaker noise robustness than cloud, and paywalling local models behind Pro.

**Aqua Voice** — Cloud-only (YC W24); proprietary "Avalon" model (launched August 22, 2025, replacing its Whisper pipeline) tuned for code/technical vocabulary and prompt-style speech. Mac, Windows, iOS. On its self-created AISpeak-10 benchmark, "Avalon transcribed the key term correctly 97.4% of the time, compared to 51.5% from NVIDIA Canary 1B and 65.1% from Whisper Large v3" — treat this as a vendor benchmark, not independent. Architecture delivers sub-500ms responses (Instant Mode ~450ms, Streaming Mode ~850ms). Per-app tone, screen-context error correction. Pricing: free 1,000 words *one-time* (a "teaser," not per-month — one review hit the cap mid-test), Pro $8/mo or $96/yr, 70% student discount. Founders publicly stated they "can't run ASR and an LLM locally at the speed required." Praised for technical accuracy; criticized for cloud-only, transcripts-stored-by-default (Privacy Mode off by default for individuals), 49-language ceiling, and subscription-only pricing.

**TalkTastic** — macOS-only voice keyboard (from Matt Mireles, pivoted from OASIS; launched on Product Hunt July 2024, #5 of the day, 4.9/5 from 26 reviews). Hybrid: on-device Whisper + multimodal cloud LLMs (ChatGPT/Claude/Gemini). Headline feature is a "snapshot" of the current app's context to match tone/style; the rewrite/context features require internet. Fine-grained privacy controls (snapshot only on command, auto-delete transcript/snapshot after processing). Free tier + paid; macOS 13.1+, direct download (email-gated), not on the App Store; supported-language count not stated. Praised for context-awareness and accuracy; criticized for Mac-only, cloud dependency of its best features, and beta status.

**Typeless** — Cloud AI dictation; Mac, Windows, iOS, Android, Web. Real-time auto-editing, filler/repetition removal, auto-formatting, per-app tone, personal dictionary; quoted ~220 wpm. Pricing: free (sources vary: 2,000–8,000 words/week), Pro ~$12/mo billed annually ($144/yr) or $30/mo monthly. Markets "on-device history" and "your data stays on your device," but its own privacy policy states audio is "processed in real time on our cloud servers and immediately discarded" and shared with third-party LLMs; a November 2025 reverse-engineering analysis reported audio routed to AWS us-east-2. HIPAA announced March 2026 but flagged for lacking a public BAA. Praised for cross-platform reach and editing; criticized for the marketing-vs-policy privacy gap and premium subscription-only pricing.

**Resonant** — Fully local Mac-only voice suite and the closest philosophical sibling to Artemis. Runs **NVIDIA Parakeet TDT v3 (0.6B, 25 languages)** and **Qwen3 ASR (0.6B, 30+ languages)** compiled to CoreML on the Apple Neural Engine (<4% WER on English benchmarks); audio never leaves the Mac. Free local dictation; Pro adds cloud cleanup/rewrites/summaries. Notably exposes **11 MCP tools** so AI agents (Claude, Codex) can query a local "voice workspace" (meetings, dictations, memos, ambient app-usage timeline), plus dual-channel meeting capture with local (NVIDIA Sortformer) diarization and no meeting bots. Praised for structural privacy, no caps, and Apple-native optimization; still early/beta.

**Reference points:** Apple Dictation (free, on-device on Apple Silicon, but 30-second timeout, no custom vocabulary, no cleanup) and VoiceInk (open-source, local Whisper, ~$25–49 one-time, optional cloud enhancement) anchor the free/cheap-local end.

### System-Wide Voice UX: What's Best-in-Class

- **Hold-to-talk on a single modifier (fn) with a floating orb near the cursor** is the converging standard (VoiceOS, Resonant, superwhisper, Wispr Flow all use a system-wide hotkey into the focused text field). Push-to-talk beats always-listening for privacy and false-positive control.
- **Per-app context formatting** (formal in Mail, casual in Slack, code-aware in IDEs) is now table stakes; VoiceOS, Wispr Flow, Aqua, TalkTastic, and Typeless all do it.
- **Confirm-before-act** (VoiceOS's card) is the correct safety pattern for agentic actions and should be non-negotiable in Artemis.
- **MCP as the extensibility layer** (VoiceOS user MCP servers; Resonant's 11 MCP tools) is emerging as the way to make a voice agent open-ended without shipping every integration yourself.
- **Learned corrections** (Wispr Flow auto-adds your typed corrections to its dictionary) is a low-friction personalization win.
- **On-command context capture** (TalkTastic's snapshot-only-on-command; Wispr's opt-in Context Awareness) is the privacy-respecting way to do screen awareness.

### Unaddressed Gaps / User Frustrations

- **Privacy & offline:** The loudest, most repeated frustration in the market is cloud dependence. An entire cottage industry of competitor/review sites exists *solely* to sell "audio never leaves your Mac." Cloud tools cannot serve regulated, NDA-bound, airplane, or air-gapped users.
- **Usage caps:** Free tiers are widely seen as teasers (Aqua's 1,000-word lifetime cap; Wispr's 2,000/week; VoiceOS's card-gated trial). This breeds resentment and churn.
- **Subscription fatigue:** A large segment explicitly wants one-time/lifetime or free-local pricing; superwhisper's lifetime tier and Resonant/VoiceInk's free-local models exist precisely because of this. Reviewers openly resent "charging rent for computation that happens on hardware you already own."
- **Mixed-language / code-switching:** Not handled well anywhere. Per CS-FLEURS, Whisper-Large-v3 character error rate rises from ~7–10 (same-script language pairs) to ~32–41 (distinct-script pairs like Latin/Cyrillic) — directly relevant to English+Bulgarian. Incumbents advise "switch languages intentionally rather than blending them." This is an unserved niche.

### Multilingual (English + Bulgarian) Handling
No competitor markets robust mixed English+Bulgarian dictation; all treat Bulgarian as one of "100+ languages" with single-language auto-detection per utterance. Bulgarian (Cyrillic) is well-covered by cloud ASR (ElevenLabs Scribe reports 3.1% WER on FLEURS Bulgarian; Speechmatics claims up to 96% word accuracy; INSAIT's BgGPT is used to LLM-post-process Whisper-v3-turbo Bulgarian output). But cross-script code-switching is the hard part: research consistently shows Whisper degrades sharply on mid-sentence Latin/Cyrillic mixing. Soniox is the one vendor explicitly claiming real-time mid-sentence language switching for Bulgarian↔English — a useful reference architecture (per-segment language ID) even though it is a cloud API.

## Recommendations

**Stage 1 — Nail local dictation parity first (before any agent features).**
- Implement fn-key hold-to-talk into the focused field via Accessibility APIs, with a small floating orb (reuse the existing React/WKWebView orb). Match the "press fn, speak, release, text lands clean" loop that VoiceOS/Resonant/superwhisper set as the baseline.
- Use WhisperKit with `large-v3` / `large-v3-turbo` on Apple Silicon; do filler-word removal and formatting via a fast local Ollama model (a small Llama/Qwen). This delivers superwhisper/Resonant-class privacy with VoiceOS-class cleanup.
- Ship **per-app context formatting** from day one (detect frontmost app bundle ID → tone profile: formal Mail, terse Messages, code-aware in Xcode/VS Code, bullets in Notion). This is table stakes.
- **Benchmark to beat:** perceived latency comparable to the ~300–350ms cloud claim. If local end-to-end (speak→text lands) exceeds ~700ms on an M-series Mac, drop to a smaller/turbo model or add streaming.

**Stage 2 — Add local Edit + Ask, then Agent with confirm-before-act.**
- Edit Mode: select text → voice instruction → local LLM rewrite. **Improve on VoiceOS by showing a visible diff/redline** in the orb before applying (VoiceOS appears to replace in place with no diff — a concrete trust differentiator).
- Ask Mode: use macOS screen-capture/Accessibility to read on-screen context locally; answer via Ollama. Keep it opt-in and on-command (copy TalkTastic's "snapshot only on command" and auto-delete controls).
- Agent Mode: adopt VoiceOS's **confirmation card in spirit** — nothing sends/books/changes without an explicit review card showing recipient + payload + Cancel/Send. Build on **MCP** as the integration layer (both VoiceOS and Resonant validate this), so Artemis inherits an ecosystem rather than hand-coding every service.

**Stage 3 — Own the gaps the incumbents can't.**
- **No caps, no subscription** (or a one-time license): directly counter the #1 market resentment. Position as "unlimited, private, yours" — the opposite of card-gated trials and weekly word limits.
- **English+Bulgarian mixed speech:** deliberately support code-switching — offer a bilingual mode, segment audio and run per-segment language ID (Soniox's approach), and use a local LLM post-correction pass (the BgGPT/Whisper-v3-turbo post-processing pattern is documented to help Bulgarian). Test against real mixed utterances. Given Whisper's ~32–41 CER on distinct-script switching, also evaluate Parakeet TDT v3 / Qwen3 ASR (as Resonant uses) as alternative on-device engines.
- **Fully offline agent actions** where possible (local file ops via Finder/AppleScript, Reminders, Notes, Calendar) so Artemis does useful agentic work with zero network — something no cloud competitor can match.

**Thresholds that change the plan:**
- If local ASR latency/accuracy can't match cloud on noisy input, add an *optional, explicit* BYOK cloud fallback (superwhisper/Spokenly model) rather than defaulting to cloud.
- If MCP ecosystem adoption stalls, prioritize 3–5 native local integrations (Finder, Reminders, Messages, Calendar, Notes) over breadth.
- If Bulgarian code-switching CER stays high with WhisperKit large-v3, switch the ASR engine to Parakeet/Qwen3 or commit to a per-segment language-ID pipeline before shipping the bilingual mode.

## Caveats
- **VoiceOS's exact permission flow, precise real-world latency, and Edit-mode UI are not independently documented.** The fn-key activation and confirmation-card behavior come from VoiceOS's own site; the ~300–350ms latency is an unverified vendor claim that at least one reviewer treats skeptically ("on paper").
- **Independent VoiceOS user reviews are scarce.** No substantive Reddit or Hacker News discussion was found; most third-party "reviews" are SEO- or competitor-authored and analyze the product page rather than test the app. Treat accuracy percentages (98%+, 97.4%) and productivity multipliers (10x) as marketing.
- **Pricing conflicts across sources** (some say "free, no card required"; the live pricing page says a card-required 7-day Pro trial with the 100-dictation/25-agent weekly caps as the fallback). The primary pricing page is treated as authoritative here.
- **Competitor prices and features change frequently** (e.g., superwhisper's lifetime price hikes, Wispr's compliance events, Aqua's Avalon rollout); verify current numbers before finalizing positioning.
- **Bulgarian/code-switching performance figures are drawn from general ASR research** (CS-FLEURS, BgGPT, Soniox), not from testing any of these specific products in Bulgarian; validate empirically with WhisperKit before committing to the bilingual wedge.
