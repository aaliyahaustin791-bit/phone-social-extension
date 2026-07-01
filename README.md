# PhoneSocial SillyTavern Extension

A per-chat phone simulator that turns your SillyTavern NPCs into contacts you can call, text, and manage — from a mobile-friendly floating panel with zero data bleed between chats.

## Features

### 📱 Phone UI
- **Floating button** — viewport-anchored, self-healing, survives orientation changes
- **Slide-out panel** — 85vw pastel-themed panel with iOS-style app grid home screen
- **Dial pad** — circular keys with letter sub-labels (ABC/DEF/etc), dial buffer, call action
- **💬 SMS threads** — per-contact threaded messaging with compose input and send
- **👥 Contacts list** — auto-populated from chat NPCs with generated phone numbers
- **📋 Call log** — outgoing/incoming calls, persisted per-chat
- **Message receipts** — read/seen state indicators in SMS threads

### 🧠 Smart NPC Detection
- **Two-pass harvesting** — (1) message author names, (2) text extraction for characters mentioned in prose/dialogue
- **Anti-leak protection** — blocks main character, user persona, chat name, and system noise
- **Dialogue attribution patterns** — regex-powered detection in quoted speech and narrative attribution
- **Auto-refresh** — re-scans on CHAT_CHANGED and MESSAGE_RECEIVED

### 🤖 NPC Autonomy
- **Narrative-reactive triggers** — NPCs text/call based on being mentioned or story events
- **Proactive messaging** — personality-driven autonomous SMS/calls (UEI-style)
- **Schedule system** — per-NPC daily schedules with activity blocks, talk-bar, and now-line indicator
- **Per-contact mute** — suppress specific NPCs from narrative triggers and proactive messages

### 🗣️ TTS (Text-to-Speech)
- **ElevenLabs integration** — provider setting with API key
- **Per-contact voice** — assign different TTS voices to different NPCs
- **Voice list caching** — fetched once and persisted

### 📝 Inline SMS
- **`/text <Contact Name> <message>`** — send SMS directly from the main chat input
- **Longest-name-first matching** — handles multi-word contact names correctly

### 🐦 Chirp (Social Feed)
- **NPC-generated posts** — setting-aware social feed with replies
- **Anti-leak protection** — setting extraction skips blocked characters
- **Refresh/thread views** — browse posts and reply threads

### 🌐 Browser
- **In-character web browsing** — setting-aware search results (city, university, etc.)
- **Never character-aware** — no persona/NPC names, chat events, or memories in results

### 🧩 Ensemble Card Support
- **Single-card multi-NPC** — works with ensemble cards (e.g. "COD: Task Force RPG")
- **Narration scanning** — detects NPC presence from AI narration

### 💾 Data & Isolation
- **Per-chat isolation** — all data in `chatMetadata.PhoneSocial[chatId]`, clean slate per conversation
- **Persistent settings** — API URL, key, model, system prompt, TTS config via ST extension settings
- **Configurable AI replies** — point at any OpenAI-compatible API with `{char}` template substitution

### 📱 Mobile & UX
- **Android/Kiwi Browser ready** — tested on Termux-hosted SillyTavern
- **Touch-friendly** — avoids double-fire on mobile, uses `pointerdown` for close
- **Self-healing button** — polls every 2s, re-attaches if removed
- **Orientation/resize aware** — button repositioning on viewport change

## Install

1. Clone into ST's third-party extensions:
   ```
   git clone https://github.com/aaliyahaustin791-bit/phone-social-extension.git ~/SillyTavern/public/scripts/extensions/third-party/PhoneSocial-v5
   ```
2. Reload ST (Ctrl+R).
3. Console: `[PhoneSocial] 📱 script loaded`
4. Open a chat with NPCs → tap 📱 → Contacts populate, test dial/SMS.

## Settings

Open the panel → ⚙️ Settings to configure:
- **API URL** — any OpenAI-compatible endpoint
- **API Key** — for NPC auto-reply generation
- **Model** — e.g. `gpt-4o-mini`, `grok-3`
- **System Prompt** — use `{char}` as placeholder for the NPC's name
- **TTS Provider** — ElevenLabs (requires API key)
- **Per-contact TTS voice** — set from each contact's profile (⚙️ → fetch voices first)

## Usage Tips

- **`/text` command** — type `/text Alice Hey, meet me at the cafe` in the main chat to send an SMS to Alice
- **Mute a contact** — from their profile, tap mute to stop autonomous messages
- **Schedule** — tap any contact → Schedule to see their daily routine
- **DND mode** — Settings → toggle Do Not Disturb to suppress all autonomous messages

## Dev

- **Golden copy**: `~/phone-social-extension-sync/` — canonical working version
- **Dev repo**: `~/phone-social-extension/` — git-tracked, edit here
- **Module build**: `src/*.js` → `build.sh` → `index.js` — **never edit index.js directly**
- **Sync flow**: build → cp to golden copy → cp to ST → restart node

## Test Isolation

1. Chat A: Send messages to NPCs → Phone populates contacts/SMS.
2. Switch to Chat B (empty): Phone starts fresh.
3. Back to A: Everything restored.
