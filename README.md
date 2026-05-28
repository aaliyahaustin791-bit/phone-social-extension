# PhoneSocial SillyTavern Extension

A per-chat phone simulator that turns your SillyTavern NPCs into contacts you can call, text, and manage — all from a mobile-friendly floating panel with zero data bleed between chats.

## Features

### Core Phone
- **📱 Floating button** — viewport-anchored button that survives orientation changes and self-heals if removed
- **Slide-out panel** — 85vw pastel-themed panel with app-grid home screen
- **📞 Dial pad** — circular keys with letter sub-labels (ABC/DEF/etc), dial buffer, call action
- **💬 SMS / threads** — per-contact message threads with compose input and send
- **👥 Contacts list** — auto-populated from chat NPCs with generated phone numbers
- **📋 Call log** — tracks outgoing calls, persisted per-chat
- **🏠 Home screen** — app-grid launcher (Phone, Messages, Contacts, Gallery, Settings, Art, Notes, Favorites)

### Smart NPC Detection
- **Two-pass NPC harvesting** — (1) message author names, (2) text extraction for named characters mentioned in prose/dialogue
- **Anti-leak protection** — blocks main character, user persona, chat name, and system noise from appearing as contacts
- **Dialogue attribution patterns** — regex-powered detection of names in quoted speech and narrative attribution
- **Auto-refresh** — re-scans on CHAT_CHANGED and MESSAGE_RECEIVED events

### Data & Isolation
- **Per-chat isolation** — all data stored in `chatMetadata.PhoneSocial[chatId]`, clean slate per conversation
- **Persistent settings** — API URL, key, model, and system prompt saved via SillyTavern's extension settings
- **Configurable AI replies** — point at any OpenAI-compatible API for NPC auto-replies with `{char}` template substitution

### Mobile & UX
- **Android/Kiwi Browser ready** — tested on Termux-hosted SillyTavern
- **Touch-friendly** — avoids double-fire on mobile, uses `pointerdown` for close action
- **Self-healing button** — polls every 2s, re-attaches if another extension or ST update removes it
- **Orientation/resize aware** — button repositioning on viewport change

## Install
1. Clone into `~/SillyTavern/public/extensions/`:
   ```
   git clone https://github.com/aaliyahaustin791-bit/phone-social-extension.git PhoneSocial
   ```
2. Reload ST (Ctrl+R).
3. Console: `[PhoneSocial] 📱 script loaded`
4. Open a chat with NPCs → Click 📱 button → Contacts populate, test dial/SMS.

## Settings
Open the panel → ⚙️ Settings to configure:
- **API URL** — any OpenAI-compatible endpoint
- **API Key** — for NPC auto-reply generation
- **Model** — e.g. `gpt-4o-mini`, `grok-3`
- **System Prompt** — use `{char}` as placeholder for the NPC's name

## Test Isolation
1. Chat A: Send messages to NPCs → Phone populates contacts/SMS.
2. Switch to Chat B (empty): Phone starts fresh.
3. Back to A: Everything restored.

## Dev
- `cd ~/SillyTavern/public/extensions/PhoneSocial`
- Edit `index.js` / `styles.css` / `README.md`
- `git add . && git commit -m "feat: ..." && git push`

## Next
Databank (lore search), Browser (immersive web), Social (NPC posts).
