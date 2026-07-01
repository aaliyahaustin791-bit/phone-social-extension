function cleanThreads(threads) {
        if (typeof threads !== 'object' || !threads) return {};
        const out = {};
        for (const [cid, msgs] of Object.entries(threads)) {
            if (!Array.isArray(msgs)) continue;
            const clean = msgs.filter(m => {
                if (!m || typeof m !== 'object') return false;
                if (m.from !== 'me' && m.from !== 'them') return false;
                if (typeof m.text !== 'string' || !m.text.trim()) return false;
                // Remove entries that are just numbers (timestamps stored as text)
                if (/^\d+\.?\d*$/.test(m.text.trim())) return false;
                return true;
            });
            if (clean.length) out[cid] = clean;
        }
        return out;
    }

    function saveMeta() {
        const ctx = getCtx();
        const meta = getChatMeta();
        // Strip _personality and _scheduleCache before save — they get stale and bleed across chats
        const contactsClean = state.contacts.map(c => {
            const { _personality, _scheduleCache, ...rest } = c;
            return rest;
        });
        // Pre-compute shared data regardless of save path availability
        const bh = Array.isArray(state.browserHistory) ? state.browserHistory.slice(-10).map(p => ({url: p.url, title: p.title, html: p.html})) : [];
        const chirpClean = Array.isArray(state.chirpPosts) ? state.chirpPosts.map(p => ({
            ...p,
            likedBy: Array.isArray(p.likedBy) ? p.likedBy : [],
            comments: Array.isArray(p.comments) ? p.comments : [],
        })) : [];
        const viewHistClean = Array.isArray(state.viewHistory) ? state.viewHistory.slice(-VIEW_HISTORY_LIMIT) : [];
        const voicemailSave = Array.isArray(state.voicemails) ? state.voicemails.slice(-20) : [];
        // Primary save: chat metadata (may be unavailable on hosted ST)
        if (meta) {
            meta.contacts = contactsClean;
            meta.threads = state.threads;
            meta.callLog = state.callLog;
            meta.voicemails = voicemailSave;
            meta.settings = state.settings;
            meta.view = state.view;
            meta.viewHistory = viewHistClean;
            meta.activeContact = state.activeContact;
            meta.activeCall = state.activeCall;
            meta.dialBuf = state.dialBuf;
            meta.browserHistory = bh;
            meta.browserIndex = state.browserIndex;
            meta.browserUrl = state.browserUrl;
            meta.chirpPosts = chirpClean;
            meta.chirpLastRefresh = state.chirpLastRefresh || 0;
            meta.lastUserMessageAt = state.lastUserMessageAt || 0;
            meta.userDnd = state.userDnd || false;
            meta.mutedContacts = state.mutedContacts || {};
            meta.scheduleSelectedDay = state.scheduleSelectedDay || null;
            meta.ttsVoices = Array.isArray(state.ttsVoices) ? state.ttsVoices : [];
            meta.ttsVoicesFetched = state.ttsVoicesFetched || 0;
            try { ctx?.saveMetadata?.(); } catch (_e1) {
                setTimeout(() => { try { ctx?.saveMetadata?.(); } catch (_e2) {} }, 200);
            }
        }
        // Backup save: extension_settings + localStorage — ALWAYS runs
        const chatKey = getChatKey();
        const backupData = {
            _backup: true,
            _chatKey: chatKey,
            contacts: contactsClean,
            threads: state.threads,
            callLog: state.callLog,
            voicemails: voicemailSave,
            settings: state.settings,
            view: state.view,
            viewHistory: viewHistClean,
            activeContact: state.activeContact,
            activeCall: state.activeCall,
            dialBuf: state.dialBuf,
            browserHistory: bh,
            browserIndex: state.browserIndex,
            browserUrl: state.browserUrl,
            chirpPosts: chirpClean,
            chirpLastRefresh: state.chirpLastRefresh || 0,
            lastUserMessageAt: state.lastUserMessageAt || 0,
            userDnd: state.userDnd || false,
            mutedContacts: state.mutedContacts || {},
            scheduleSelectedDay: state.scheduleSelectedDay || null,
            ttsVoices: Array.isArray(state.ttsVoices) ? state.ttsVoices : [],
            ttsVoicesFetched: state.ttsVoicesFetched || 0,
        };
        // ST extensionSettings path
        if (ctx?.extensionSettings) {
            ctx.extensionSettings[EXT_NAME + '_bk_' + chatKey] = backupData;
            try {
                if (typeof ctx.saveSettings === 'function') {
                    ctx.saveSettings();
                } else {
                    ctx.saveSettingsDebounced?.();
                }
            } catch (_) { /* ignore */ }
        }
        // localStorage + sessionStorage fallback — survives ST web app quirks
        try {
            const lsKey = 'PhoneSocial_bk_' + chatKey;
            const json = JSON.stringify(backupData);
            localStorage.setItem(lsKey, json);
            // Verify the write actually took (some browsers silently fail)
            const verify = localStorage.getItem(lsKey);
            if (!verify) {
                console.warn('[PhoneSocial] localStorage write verification failed — data may not persist');
            }
            // Double-save to sessionStorage (survives tab restore on some mobile browsers)
            try { sessionStorage.setItem(lsKey, json); } catch (_) {}
        } catch (e) {
            console.error('[PhoneSocial] localStorage save error:', e?.message || e);
        }
        // Clear in-memory _personality and _scheduleCache so next calls are always fresh
        for (const c of state.contacts) {
            delete c._personality;
            delete c._scheduleCache;
        }
    }

    function loadMeta() {
        const meta = getChatMeta();
        state = freshState();
        // ── Try localStorage FIRST (synchronous, survives app switches) ──
        let loadedFromLocal = false;
        try {
            const chatKey = getChatKey();
            let raw = localStorage.getItem('PhoneSocial_bk_' + chatKey);
            // Fall back to sessionStorage (some mobile browsers restore from it)
            if (!raw) {
                try { raw = sessionStorage.getItem('PhoneSocial_bk_' + chatKey); } catch (_) {}
            }
            if (raw) {
                const backup = JSON.parse(raw);
                if (backup && backup._backup) {
                    if (Array.isArray(backup.contacts)) {
                        state.contacts = backup.contacts.filter(c => c.source !== 'st-character' && c.source !== 'st-group');
                    }
                    if (backup.threads && typeof backup.threads === 'object') {
                        state.threads = cleanThreads(backup.threads);
                    }
                    if (Array.isArray(backup.callLog)) state.callLog = backup.callLog;
                    if (Array.isArray(backup.voicemails)) state.voicemails = backup.voicemails;
                    if (backup.settings && typeof backup.settings === 'object') {
                        state.settings = { ...DEFAULT_SETTINGS, ...backup.settings };
                    }
                    if (backup.view && VALID_VIEWS.has(backup.view)) state.view = backup.view;
                    if (Array.isArray(backup.viewHistory)) {
                        state.viewHistory = backup.viewHistory.filter(v => VALID_VIEWS.has(v)).slice(-VIEW_HISTORY_LIMIT);
                    }
                    if (typeof backup.activeContact === 'string') state.activeContact = backup.activeContact;
                    state.activeCall = null;
                    if (state.view === 'call') state.view = 'home';
                    if (typeof backup.dialBuf === 'string') state.dialBuf = backup.dialBuf;
                    if (Array.isArray(backup.browserHistory)) {
                        state.browserHistory = backup.browserHistory.slice(-10);
                        state.browserIndex = (typeof backup.browserIndex === 'number') ? backup.browserIndex : -1;
                        state.browserUrl = (typeof backup.browserUrl === 'string') ? backup.browserUrl : '';
                    }
                    if (Array.isArray(backup.chirpPosts)) {
                        state.chirpPosts = backup.chirpPosts.map(p => ({
                            ...p,
                            likedBy: Array.isArray(p.likedBy) ? p.likedBy : [],
                            comments: Array.isArray(p.comments) ? p.comments : [],
                        }));
                        state.chirpLastRefresh = backup.chirpLastRefresh || 0;
                    }
                    if (typeof backup.lastUserMessageAt === 'number') state.lastUserMessageAt = backup.lastUserMessageAt;
                    if (typeof backup.userDnd === 'boolean') state.userDnd = backup.userDnd;
                    if (backup.mutedContacts && typeof backup.mutedContacts === 'object') state.mutedContacts = backup.mutedContacts;
                    if (typeof backup.scheduleSelectedDay === 'string' || backup.scheduleSelectedDay === null) state.scheduleSelectedDay = backup.scheduleSelectedDay;
                    if (Array.isArray(backup.ttsVoices)) state.ttsVoices = backup.ttsVoices;
                    if (typeof backup.ttsVoicesFetched === 'number') state.ttsVoicesFetched = backup.ttsVoicesFetched;
                    loadedFromLocal = true;
                }
            }
        } catch (_) { /* ignore */ }
        // ── Fall back to chatMetadata (server-side) if localStorage was empty ──
        if (!loadedFromLocal && meta) {
            state.contacts = Array.isArray(meta.contacts)
                ? meta.contacts.filter(c => c.source !== 'st-character' && c.source !== 'st-group')
                : [];
            state.threads = cleanThreads(meta.threads);
            state.callLog = Array.isArray(meta.callLog) ? meta.callLog : [];
            state.voicemails = Array.isArray(meta.voicemails) ? meta.voicemails : [];
            state.dialTab = meta.dialTab || 'keypad';
            state.settings = { ...DEFAULT_SETTINGS, ...(meta.settings && typeof meta.settings === 'object' ? meta.settings : {}) };
            const savedView = meta.view;
            if (savedView && VALID_VIEWS.has(savedView)) state.view = savedView;
            if (Array.isArray(meta.viewHistory)) {
                state.viewHistory = meta.viewHistory.filter(v => VALID_VIEWS.has(v)).slice(-VIEW_HISTORY_LIMIT);
            }
            if (typeof meta.activeContact === 'string') state.activeContact = meta.activeContact;
            // Active calls are ephemeral — never restore across page loads
            state.activeCall = null;
            // If the saved view was 'call', bail to home (stale)
            if (state.view === 'call') state.view = 'home';
            if (typeof meta.dialBuf === 'string') state.dialBuf = meta.dialBuf;
            // Restore browser state
            if (Array.isArray(meta.browserHistory)) {
                state.browserHistory = meta.browserHistory.slice(-10);
                state.browserIndex = (typeof meta.browserIndex === 'number') ? meta.browserIndex : -1;
                state.browserUrl = (typeof meta.browserUrl === 'string') ? meta.browserUrl : '';
            }
            // Restore chirp state
            if (Array.isArray(meta.chirpPosts)) {
                state.chirpPosts = meta.chirpPosts.map(p => ({
                    ...p,
                    likedBy: Array.isArray(p.likedBy) ? p.likedBy : [],
                    comments: Array.isArray(p.comments) ? p.comments : [],
                }));
                state.chirpLastRefresh = meta.chirpLastRefresh || 0;
            }
            if (typeof meta.lastUserMessageAt === 'number') state.lastUserMessageAt = meta.lastUserMessageAt;
            if (typeof meta.userDnd === 'boolean') state.userDnd = meta.userDnd;
            if (meta.mutedContacts && typeof meta.mutedContacts === 'object') state.mutedContacts = meta.mutedContacts;
            if (typeof meta.scheduleSelectedDay === 'string' || meta.scheduleSelectedDay === null) state.scheduleSelectedDay = meta.scheduleSelectedDay;
            if (Array.isArray(meta.ttsVoices)) state.ttsVoices = meta.ttsVoices;
            if (typeof meta.ttsVoicesFetched === 'number') state.ttsVoicesFetched = meta.ttsVoicesFetched;
        }
        // If still no contacts, try extensionSettings backup (skip localStorage — already tried)
        if (!loadedFromLocal && (!state.contacts.length || !Object.keys(state.threads).length)) {
            try { tryLoadChatBackup(); } catch (_) {}
        }
        metaLoaded = true;
        console.log('[PhoneSocial] loadMeta done: contacts =', state.contacts.length, 'view =', state.view);
    }

    function tryLoadChatBackup() {
        const ctx = getCtx();
        const chatKey = getChatKey();
        let backup = null;
        // Try ST extensionSettings first
        if (ctx?.extensionSettings) {
            backup = ctx.extensionSettings[EXT_NAME + '_bk_' + chatKey]
                || ctx.extensionSettings[EXT_NAME + '_backup']; // fallback to old global key for migration
            // Clean up old global backup key after migration
            if (backup && backup._chatKey === undefined && ctx.extensionSettings[EXT_NAME + '_backup']) {
                delete ctx.extensionSettings[EXT_NAME + '_backup'];
            }
        }
        // Fall back to localStorage
        if ((!backup || !backup._backup) && typeof localStorage !== 'undefined') {
            try {
                const raw = localStorage.getItem('PhoneSocial_bk_' + chatKey);
                if (raw) backup = JSON.parse(raw);
            } catch (_) { /* ignore parse errors */ }
        }
        if (!backup || !backup._backup) return;
        // Chat-specific check: skip if backup key doesn't match and it's global
        if (backup._chatKey && backup._chatKey !== chatKey) return;
        // Only load contacts/threads if we have none (don't overwrite fresh harvest)
        if (!state.contacts.length && Array.isArray(backup.contacts)) {
            state.contacts = backup.contacts.filter(c => c.source !== 'st-character' && c.source !== 'st-group');
        }
        if (!Object.keys(state.threads).length && backup.threads && typeof backup.threads === 'object') {
            state.threads = cleanThreads(backup.threads);
        }
        if (Array.isArray(backup.callLog)) state.callLog = backup.callLog;
        if (backup.settings && typeof backup.settings === 'object') {
            state.settings = { ...DEFAULT_SETTINGS, ...backup.settings };
        }
        console.log('[PhoneSocial] 📦 loaded from backup:', state.contacts.length, 'contacts,', Object.keys(state.threads).length, 'threads');
    }

    function tryLoadBackup() {
        const ctx = getCtx();
        if (!ctx?.extensionSettings) return;
        const backup = ctx.extensionSettings[EXT_NAME + '_backup'] || ctx.extensionSettings[EXT_NAME];
        if (!backup || !backup._backup) return;
        if (Array.isArray(backup.contacts)) {
            state.contacts = backup.contacts.filter(c => c.source !== 'st-character' && c.source !== 'st-group');
        }
        if (backup.threads && typeof backup.threads === 'object') {
            state.threads = backup.threads;
        }
        if (Array.isArray(backup.callLog)) {
            state.callLog = backup.callLog;
        }
        if (backup.settings && typeof backup.settings === 'object') {
            state.settings = { ...DEFAULT_SETTINGS, ...backup.settings };
        }
        if (backup.view && VALID_VIEWS.has(backup.view)) state.view = backup.view;
        if (Array.isArray(backup.viewHistory)) {
            state.viewHistory = backup.viewHistory.filter(v => VALID_VIEWS.has(v)).slice(-VIEW_HISTORY_LIMIT);
        }
        if (typeof backup.activeContact === 'string') state.activeContact = backup.activeContact;
        // Active calls are ephemeral — never restore across page loads
        state.activeCall = null;
        if (state.view === 'call') state.view = 'home';
        if (typeof backup.dialBuf === 'string') state.dialBuf = backup.dialBuf;
        if (Array.isArray(backup.browserHistory)) {
            state.browserHistory = backup.browserHistory.slice(-10);
            state.browserIndex = (typeof backup.browserIndex === 'number') ? backup.browserIndex : -1;
            state.browserUrl = (typeof backup.browserUrl === 'string') ? backup.browserUrl : '';
        }
        if (Array.isArray(backup.chirpPosts)) {
            state.chirpPosts = backup.chirpPosts.map(p => ({
                ...p,
                likedBy: Array.isArray(p.likedBy) ? p.likedBy : [],
                comments: Array.isArray(p.comments) ? p.comments : [],
            }));
            state.chirpLastRefresh = backup.chirpLastRefresh || 0;
        }
        console.log('[PhoneSocial] 📦 loaded from extension_settings backup:', state.contacts.length, 'contacts');
    }

    function ensureViewHistory() {
        if (!Array.isArray(state.viewHistory)) state.viewHistory = [];
    }

    function pushHistory(view) {
        if (!view) return;
        ensureViewHistory();
        const history = state.viewHistory;
        if (history[history.length - 1] === view) return;
        history.push(view);
        if (history.length > VIEW_HISTORY_LIMIT) history.shift();
    }

    function applyView(view) {
        if (!view || !VALID_VIEWS.has(view)) view = 'home';
        state.view = view;
        if (view === 'contacts') {
            harvestNPCs();
            purgeStaleContacts();
        }
        saveMeta();
        render();
    }

    function navigateTo(view, opts = {}) {
        if (!view) return;
        if (!VALID_VIEWS.has(view)) view = 'home';
        if (state.view === view) {
            if (view === 'contacts') {
                harvestNPCs();
                purgeStaleContacts();
                saveMeta();
            }
            render();
            return;
        }
        const { record = true } = opts;
        if (record && state.view) pushHistory(state.view);
        applyView(view);
    }

    function goBack() {
        ensureViewHistory();
        const history = state.viewHistory;
        if (history.length) {
            const target = history.pop();
            applyView(target);
            return;
        }
        if (state.view && state.view !== 'home') {
            const parent = VIEW_PARENT[state.view];
            if (parent && VALID_VIEWS.has(parent)) {
                applyView(parent);
            } else {
                applyView('home');
            }
            return;
        }
        state.viewHistory = [];
        saveMeta();
        if (isPanelOpen) togglePanel();
    }

    // -------------------------------------------------------------------
    // NPC harvesting — scan chat for character names, auto-add as contacts
    // -------------------------------------------------------------------
