    function onChatChanged() {
        // Debounce: ST fires CHAT_CHANGED multiple times in rapid succession during page load.
        // Only the last call in a 30ms burst actually executes to prevent race conditions.
        if (chatChangeDebounce) { clearTimeout(chatChangeDebounce); chatChangeDebounce = null; }
        chatChangeDebounce = setTimeout(() => {
            chatChangeDebounce = null;
            // Clear SMS injection from previous chat to prevent data bleed
            try {
                const ctx = getCtx();
                if (ctx?.setExtensionPrompt) {
                    ctx.setExtensionPrompt('PhoneSocial', null, 200, 0, true);
                }
            } catch (_) { /* ignore */ }
            try {
                loadMeta();
                harvestNPCs();
                // Remove contacts that don't appear in current chat messages
                // (cleans up cross-chat bleed from corrupted metadata)
                purgeStaleContacts();
                saveMeta();
            } catch (e) {
                console.error('[PhoneSocial] onChatChanged error:', e);
            }
            const panel = document.getElementById('phonesocial-panel');
            if (panel && panel.style.display !== 'none') render();
        }, 30);
    }

    function hookEvents() {
        const ctx = getCtx();
        if (!ctx?.eventSource || !ctx?.eventTypes) return false;
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
            // Defer so message rendering completes first
            setTimeout(() => {
                try {
                    // Track last user message for inactivity-based scheduling
                    const chat = ctx.chat;
                    let lastMsg = null;
                    if (Array.isArray(chat) && chat.length) {
                        lastMsg = chat[chat.length - 1];
                        if (lastMsg && lastMsg.is_user) {
                            state.lastUserMessageAt = Date.now();
                            for (const c of state.contacts) {
                                if (c._autonomousMsgs) c._autonomousMsgs.count = 0;
                            }
                        }
                    }
                    harvestNPCs();
                    purgeStaleContacts();
                    saveMeta();
                    // ── Story time + SMS ingestion from AI narrative ──
                    // Delayed 500ms so ctx.chat has the new message (same as narrative triggers)
                    console.log('[PhoneSocial] 📨 MESSAGE_RECEIVED — lastMsg:',
                        lastMsg ? (lastMsg.is_user ? 'USER' : (lastMsg.is_system ? 'SYSTEM' : 'AI')) : 'NULL',
                        lastMsg ? 'name=' + (lastMsg.name || '?') : '');
                    if (lastMsg && !lastMsg.is_user) {
                        setTimeout(() => {
                            detectAndStoreStoryTime();
                            ingestInlineSMS();
                        }, 500);
                    }
                    // ── Narrative-triggered proactive check ──
                    // Scan latest AI message for cues like "your phone's blowing up"
                    // and immediately fire calls/texts from implicated NPCs.
                    // Fires on 1s delay so the AI message is fully in ctx.chat.
                    setTimeout(() => { checkNarrativeTriggers(); }, 1000);
                } catch (e) {
                    console.error('[PhoneSocial] MESSAGE_RECEIVED error:', e);
                }
            }, 0);
            // Trigger main chat memory extraction every 5 messages
            mainChatMsgCount++;
            if (mainChatMsgCount % 5 === 0) {
                setTimeout(() => {
                    extractMainChatMemories().catch(e =>
                        console.warn('[PhoneSocial] main chat memory extraction failed:', e));
                }, 2000);
            }
        });
        return true;
    }

    function loadSettings() {
        // Restore API settings — try context API first, then legacy extension_settings
        const ctx = getCtx();
        if (ctx?.extensionSettings?.[EXT_NAME]) {
            window.PhoneSocialSettings = ctx.extensionSettings[EXT_NAME];
            console.log('[PhoneSocial] ⚙️ settings loaded from context:', window.PhoneSocialSettings?.apiUrl);
        } else if (window.extension_settings?.PhoneSocial) {
            window.PhoneSocialSettings = window.extension_settings.PhoneSocial;
            console.log('[PhoneSocial] ⚙️ settings loaded from extension_settings:', window.PhoneSocialSettings?.apiUrl);
        } else {
            // Fallback: read from chat metadata
            const meta = getChatMeta();
            if (meta?.apiSettings) {
                window.PhoneSocialSettings = meta.apiSettings;
                console.log('[PhoneSocial] ⚙️ settings loaded from metadata:', window.PhoneSocialSettings?.apiUrl);
            }
        }
    }

    function init() {
        // Defer ALL work to avoid blocking ST startup
        setTimeout(() => {
            loadSettings();
            ensureButton();
            ensurePanel();
            // Don't touch ctx/meta until CHAT_CHANGED fires — just register the listener
            let tries = 0;
            const t = setInterval(() => {
                tries++;
                if (hookEvents() || tries > 40) clearInterval(t);
            }, 500);

            // Self-healing: if ST or another extension removes our button, re-add it
            setInterval(() => {
                if (!document.getElementById('phonesocial-btn')) {
                    console.warn('[PhoneSocial] button missing — re-attaching');
                    ensureButton();
                }
            }, 2000);

            // Listen for custom wallpaper file selection
            document.addEventListener('change', function psWallpaperChange(e) {
                const input = e.target;
                if (input.id !== 'ps-wallpaper-file' || !input.files?.length) return;
                const file = input.files[0];
                if (!file.type.startsWith('image/')) return;
                const reader = new FileReader();
                reader.onload = function (ev) {
                    const dataUrl = ev.target?.result;
                    if (typeof dataUrl === 'string') {
                        saveWallpaperGlobally('custom', dataUrl);
                        if (isPanelOpen) {
                            state.view = 'home';
                            render();
                        }
                    }
                };
                reader.readAsDataURL(file);
                input.value = ''; // reset so same file can be re-picked
            }, { passive: true });

            console.log('[PhoneSocial] ✅ initialized (passive); btn:', !!document.getElementById('phonesocial-btn'));
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
