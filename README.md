# PhoneSocial SillyTavern Extension

## Features
- **Per-chat phone isolation**: No data bleed between chats.
- Auto-parse NPCs from current chat as contacts.
- Dial/call, SMS with auto NPC replies.
- NPC autonomy sim (random incoming SMS/calls).
- Mobile-responsive UI, floating panel.
- Data saved in chatMetadata.PhoneSocial[chatId].

## Install
1. Copy folder to `~/SillyTavern/public/extensions/phone-social-extension/`
2. Reload ST (Ctrl+R).
3. Console: `[PhoneSocial] Loaded`
4. Chat with NPC → Click 📱 button → Contacts appear, test dial/SMS.

## Test Isolation
1. Chat A: Send msgs to NPC → Phone: contacts/SMS.
2. Switch to Chat B (empty): Phone empty.
3. Back to A: Restored.

## Dev
- `cd ~/phone-social-extension`
- Edit index.js/styles.css/README.md
- `git add . &amp;&amp; git commit -m &quot;feat: ...&quot;&amp;&amp; git push`
- GitHub: aaliyahaustin791-bit/phone-social-st-extension (TBD)

## Next: Databank (lore search), Browser (immersive web), Social (NPC posts).
