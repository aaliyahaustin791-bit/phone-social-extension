// PhoneSocial — SillyTavern Extension
// Per-chat phone simulator: NPC-derived contacts, SMS/calls, no data bleed.
// Install: clone into ~/SillyTavern/public/extensions/PhoneSocial/, reload ST.

(function () {
    'use strict';

    console.log('[PhoneSocial] 📱 script loaded');

    const EXT_NAME = 'PhoneSocial';
    const META_KEY = 'PhoneSocial';

    const DEFAULT_SETTINGS = {
        autoHarvest: true,
        autoReplies: true,
        openOnChat: false,
        ttsEnabled: false,       // Use ST's TTS for incoming SMS/calls
        toastrEnabled: true,     // Show toastr notifications for incoming SMS/calls
    };
    const VIEW_HISTORY_LIMIT = 25;
    const VALID_VIEWS = new Set(['home', 'contacts', 'sms', 'thread', 'dial', 'settings', 'albums', 'profile', 'memories', 'call', 'browser', 'chirp', 'chirp-thread', 'favorites']);

    // -------------------------------------------------------------------
    // Per-chat state (reset on every CHAT_CHANGED)
    // -------------------------------------------------------------------
    let state = freshState();
    let isPanelOpen = false;
    let mainChatMsgCount = 0;  // For main-chat memory extraction throttle
    let metaLoaded = false;
    let composeDraft = '';       // Survives view changes — preserves drafts when calls interrupt typing
    let chatChangeDebounce = null; // 30ms CHAT_CHANGED debounce timer
    let notifShadeOpen = false;  // Pull-down notification shade state

    function freshState() {
        return {
            contacts: [],      // [{id, name, number, source, memories: [{text, ts, tags}]}]
            threads: {},       // { contactId: [{from:'me'|'them', text, ts}] }
            callLog: [],       // [{contactId, dir:'out'|'in', ts, duration}]
            activeContact: null,
            activeCall: null,  // {contactId, status:'dialing'|'connected', startTs}
            dialBuf: '',
            browserHistory: [], // [{url, title, html}] — browser page stack
            browserIndex: -1,   // current position in browser history
            browserUrl: '',     // current search/URL text
            view: 'home',      // 'home' | 'contacts' | 'sms' | 'thread' | 'dial' | 'settings' | 'call' | 'browser' | 'chirp'
            viewHistory: [],
            settings: { ...DEFAULT_SETTINGS },
            chirpPosts: [],    // [{id, author: {name, handle, isContact}, text, ts, likes, likedBy:[handle], comments: [{author: {name, handle}, text, ts}]}]
            chirpLastRefresh: 0,
            typingContactId: null,  // contact ID currently "typing" (shows animated dots)
            voicemails: [],    // [{contactId, text, ts, heard: false}]
            dialTab: 'keypad', // 'keypad' | 'recents'
            incomingBanner: null, // {contactId, name, text, ts} — transient SMS popup
        };
    }

    // -------------------------------------------------------------------
    // SillyTavern context helpers
    // -------------------------------------------------------------------
    function getCtx() {
        try {
            if (typeof window !== 'undefined' && window.SillyTavern?.getContext) {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getChatMeta() {
        try {
            const ctx = getCtx();
            if (!ctx?.chatMetadata) return null;
            if (!ctx.chatMetadata[META_KEY]) ctx.chatMetadata[META_KEY] = {};
            return ctx.chatMetadata[META_KEY];
        } catch (e) { return null; }
    }

    function getChatKey() {
        const ctx = getCtx();
        if (!ctx) return 'default';
        const charName = (ctx.name2 || ctx.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const group = ctx.groupId || 'dm';
        return charName + '_' + group;
    }

    /** Filter out corrupted thread entries — pure-numeric timestamps stored as text */
    
    /** Build a comprehensive set of persona/character names to block as contacts */
    function getBlockedSet() {
        const ctx = getCtx();
        const set = new Set(['system', 'sillytavern system', 'narrator', 'akuma']);
        if (!ctx) return set;
        // All name variants for the current character
        const name2 = (ctx.name2 || ctx.name || '').trim().toLowerCase();
        if (name2) {
            set.add(name2);
            // Also add word-split parts for matching
            for (const part of name2.split(/[\s_\-]+/)) {
                if (part.length > 1) set.add(part);
            }
        }
        // All name variants for the user
        const name1 = (ctx.name1 || '').trim().toLowerCase();
        if (name1) {
            set.add(name1);
            for (const part of name1.split(/[\s_\-]+/)) {
                if (part.length > 1) set.add(part);
            }
        }
        const personaName = (ctx.chatMetadata?.user_name || '').trim().toLowerCase();
        if (personaName) {
            set.add(personaName);
            for (const part of personaName.split(/[\s_\-]+/)) {
                if (part.length > 1) set.add(part);
            }
        }
        return set;
    }

    /** Check if a name matches any blocked entry (fuzzy: contains or is contained by) */
    function isBlocked(name, blockedSet) {
        const norm = (name || '').trim().toLowerCase();
        if (!norm) return true;
        if (blockedSet.has(norm)) return true;
        for (const b of blockedSet) {
            if (norm.includes(b) || b.includes(norm)) return true;
        }
        return false;
    }

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
        // Strip _personality cache before save — it gets stale and bleeds across chats
        const contactsClean = state.contacts.map(c => {
            const { _personality, ...rest } = c;
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
        // Clear in-memory _personality cache so next inferPersonality() is always fresh
        for (const c of state.contacts) {
            delete c._personality;
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
        if (state.view !== 'home') {
            applyView('home');
            return;
        }
        state.viewHistory = [];
        saveMeta();
        if (isPanelOpen) togglePanel();
    }

    // -------------------------------------------------------------------
    // NPC harvesting — scan chat for character names, auto-add as contacts
    // -------------------------------------------------------------------
    function harvestNPCs() {
        console.log('[PhoneSocial] harvestNPCs: state.contacts.length =', state.contacts.length);
        const ctx = getCtx();
        if (!ctx?.chat) return;
        const blocked = getBlockedSet();
        const debug = [];
        const seen = new Set(state.contacts.map(c => c.name.toLowerCase()));
        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const name = (msg.name || '').trim();
            if (!name) continue;
            const norm = name.toLowerCase();
            if (seen.has(norm)) { debug.push(`SKIP(seen): "${name}"`); continue; }
            if (isBlocked(name, blocked)) { debug.push(`SKIP(blocked): "${name}"`); continue; }
            seen.add(norm);
            debug.push(`HARVEST: "${name}"`);
            state.contacts.push({
                id: 'npc_' + norm.replace(/\s+/g, '_'),
                name,
                number: genNumber(),
                source: 'npc',
                starred: false,
            });
        }
        if (debug.length) console.log('[PhoneSocial] harvestNPCs:', debug);
        // Hard cap: max 30 contacts per chat to prevent rogue extraction
        if (state.contacts.length > 30) {
            console.log(`[PhoneSocial] harvest: capping ${state.contacts.length} contacts → 30`);
            state.contacts = state.contacts.slice(0, 30);
        }
        // Second pass: scan message text for named NPCs mentioned in prose/dialogue
        try {
            harvestNamesFromText(blocked, seen, debug);
        } catch (_e) {
            console.warn('[PhoneSocial] text harvest failed:', _e);
        }
        // Third pass: pull contacts from ST's loaded character list + group members
        // DISABLED: this grabs every character card in the roster, not just chat-relevant NPCs.
        // Contacts should come from chat messages only (msg.name + text extraction above).
        // try {
        //     const fromSt = harvestSTCharacters(blocked, seen, debug);
        //     if (fromSt.length) debug.push(...fromSt.map(n => `ST CHAR: "${n}"`));
        // } catch (_e) {
        //     console.warn('[PhoneSocial] ST character harvest failed:', _e);
        // }
    }

    // -------------------------------------------------------------------
    // Name extraction from tagged NPC markers (UIE-style)
    // Instead of guessing names from prose, only extract names from
    // explicit markers that users intentionally write in their messages:
    //   <npc:Name>  — NPC declaration
    //   <char:Name> — character mention
    //   <Name>:     — styled message prefix at line start
    // -------------------------------------------------------------------
    function harvestNamesFromText(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.chat) return;

        // Scan message text for tagged NPC markers
        const reNpc = /<npc:([^>]{2,48})>/gi;
        const reChar = /<char:([^>]{2,48})>/gi;
        const rePrefix = /^<([a-zA-Z][a-zA-Z0-9 _.-]{1,47})>:\s/m;

        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const text = (msg.mes || msg.text || '');
            if (!text) continue;

            // <npc:Name> tags
            reNpc.lastIndex = 0;
            let m;
            while ((m = reNpc.exec(text)) !== null) {
                const name = m[1].trim();
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                if (seen.has(norm)) continue;
                seen.add(norm);
                debug.push(`NPC TAG: "${name}"`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    source: 'npc-tag',
                    starred: false,
                });
            }

            // <char:Name> tags
            reChar.lastIndex = 0;
            while ((m = reChar.exec(text)) !== null) {
                const name = m[1].trim();
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                if (seen.has(norm)) continue;
                seen.add(norm);
                debug.push(`CHAR TAG: "${name}"`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    source: 'npc-tag',
                    starred: false,
                });
            }

            // <Name>: prefix at line start — DISABLED: creates too many false positives
            // from inline roleplay formatting. Let users use <npc:Name> tags instead.
            // The prefix scan was extracting 50+ names from formatted dialogue in 38 messages.
        }
    }

    function harvestSTCharacters(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.characters || !Array.isArray(ctx.characters)) return [];
        const added = [];
        for (const ch of ctx.characters) {
            if (!ch) continue;
            const name = (ch.name || '').trim();
            if (!name) continue;
            const norm = name.toLowerCase();
            if (blocked.has(norm)) continue;
            if (seen.has(norm)) continue;
            seen.add(norm);
            added.push(name);
            state.contacts.push({
                id: 'st_' + norm.replace(/[^a-z0-9_]/g, '_'),
                name,
                number: genNumber(),
                source: 'st-character',
                starred: false,
            });
        }
        // Also grab group members if in a group chat
        if (ctx.groups && ctx.groupId) {
            try {
                const group = Array.isArray(ctx.groups) ? ctx.groups.find(g => g.id === ctx.groupId) : null;
                if (group && Array.isArray(group.members)) {
                    for (const member of group.members) {
                        if (!member || typeof member !== 'object') continue;
                        const name = (member.name || '').trim();
                        if (!name) continue;
                        const norm = name.toLowerCase();
                        if (isBlocked(name, blocked)) continue;
                        if (seen.has(norm)) continue;
                        seen.add(norm);
                        added.push(`[group] ${name}`);
                        state.contacts.push({
                            id: 'st_group_' + norm.replace(/[^a-z0-9_]/g, '_'),
                            name,
                            number: genNumber(),
                            source: 'st-group',
                            starred: false,
                        });
                    }
                }
            } catch (_e) { /* group data may be shallow */ }
        }
        return added;
    }

    function genNumber() {
        const a = Math.floor(200 + Math.random() * 700);
        const b = Math.floor(100 + Math.random() * 900);
        const c = Math.floor(1000 + Math.random() * 9000);
        return `(${a}) ${b}-${c}`;
    }

    // -------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------
    function ensureButton() {
        if (document.getElementById('phonesocial-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'phonesocial-btn';
        btn.type = 'button'; // critical on mobile to avoid form submit
        btn.textContent = '📱';
        btn.title = 'PhoneSocial';
        const handler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PhoneSocial] button handler fired');
            togglePanel();
        };
        btn.addEventListener('click', handler);
        // DO NOT add touchend — on mobile the browser synthesizes click after touchend
        // and double-firing causes: first touch opens+ hides btn, second click re-closes
        // then re-opens panel with btn stuck hidden forever.
        // Inline-style fallback that uses viewport units directly.
        // This bypasses any ancestor `transform`/`filter`/`will-change` that
        // would otherwise turn `position:fixed` into a containing-block-relative
        // positioning (which on some ST mobile layouts pushed the button to
        // x=827, off-screen).
        btn.style.cssText = [
            'position:fixed',
            'left:calc(100vw - 64px)',
            'top:80px',
            'right:auto',
            'bottom:auto',
            'width:52px',
            'height:52px',
            'z-index:10050',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'border-radius:50%',
            'border:2px solid #fff',
            'border:2px solid #fff',
            'color:#fff',
            'font-size:22px',
            'line-height:1',
            'box-shadow:0 4px 14px rgba(0,0,0,0.6)',
            'cursor:pointer',
            'padding:0',
            'margin:0',
            'visibility:visible',
            'opacity:1',
            'pointer-events:auto',
        ].join(';') + ';';
        // Append to <html> instead of <body> — escapes any body-level transforms.
        (document.documentElement || document.body).appendChild(btn);
        // Re-anchor on resize/orientation change.
        const reposition = () => {
            btn.style.left = 'calc(100vw - 64px)';
            btn.style.top = '80px';
        };
        window.addEventListener('resize', reposition, { passive: true });
        window.addEventListener('orientationchange', reposition, { passive: true });
    }

    function ensurePanel() {
        injectPastelTheme();
        let panel = document.getElementById('phonesocial-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        // Hidden file input for image attachments (created once, survives renders)
        if (!document.getElementById('ps-image-input')) {
            const fileInput = document.createElement('input');
            fileInput.id = 'ps-image-input';
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            fileInput.addEventListener('change', () => {
                const file = fileInput.files?.[0];
                if (!file || !state.activeContact) return;
                const reader = new FileReader();
                reader.onload = () => {
                    if (!state.threads[state.activeContact]) state.threads[state.activeContact] = [];
                    state.threads[state.activeContact].push({ from: 'me', imageUrl: reader.result, ts: Date.now(), seen: false });
                    saveMeta();
                    render();
                    simulateReply(state.activeContact).catch(e => console.warn('[PhoneSocial] reply gen failed:', e));
                    updateSmsInjection();
                };
                reader.readAsDataURL(file);
                fileInput.value = '';
            });
            document.body.appendChild(fileInput);
        }
        panel.id = 'phonesocial-panel';
        panel.style.cssText = [
            'position:fixed',
            'left:0',
            'top:0',
            'right:0',
            'bottom:0',
            'width:100vw',
            'height:100vh',
            'background:#1c1c1e',
            'color:#fff',
            'border:none',
            'outline:none',
            'box-shadow:none',
            'z-index:10050',
            'display:none',
            'flex-direction:column',
            'overflow:hidden',
            'font-family:system-ui,-apple-system,sans-serif',
            'transition:transform 0.25s ease-out',
            'transform:translateX(100%)',
            'visibility:hidden',
            'opacity:0',
            'pointer-events:none'
        ].join(';') + ';';
        document.body.appendChild(panel);
        return panel;
    }

    function injectPastelTheme() {
        if (document.getElementById('phonesocial-theme')) return;
        const style = document.createElement('style');
        style.id = 'phonesocial-theme';
        style.textContent = `
            /* ─── Phone Outer Container (slide-in) ─── */
            #phonesocial-panel {
                position:relative;
                border-radius:0 !important;
                overflow:hidden !important;
                border:none !important;
                outline:none !important;
                box-shadow:none !important;
                background:transparent !important;
                scrollbar-width:none;
                -ms-overflow-style:none;
            }
            #phonesocial-panel::-webkit-scrollbar { display:none; }
            /* ─── Phone Frame (simulated device) ─── */
            #phonesocial-panel .ps-phone-frame {
                display:flex; flex-direction:column; flex:1; width:100%;
                margin:0; padding:0;
                background:transparent;
                border-radius:0;
                overflow:hidden;
                gap:0;
            }
            /* ─── Status Bar ─── */
            #phonesocial-panel .ps-statusbar {
                display:flex; justify-content:space-between; align-items:center;
                padding:8px 18px 4px;
                background:#1c1c1e;
                color:#fff;
                font-size:11px; font-weight:600;
                flex-shrink:0;
                min-height:24px;
            }
            #phonesocial-panel .ps-statusbar .ps-sb-time {
                font-weight:700;
                letter-spacing:0.5px;
            }
            #phonesocial-panel .ps-statusbar .ps-sb-icons {
                display:flex; gap:6px; align-items:center;
                font-size:10px;
                opacity:0.8;
            }
            /* ─── Signal bars (CSS-drawn, replaces emoji) ─── */
            #phonesocial-panel .ps-signal {
                display:flex; align-items:flex-end; gap:1.5px; height:12px;
            }
            #phonesocial-panel .ps-signal-bar {
                width:2.5px; border-radius:1px;
                background:rgba(255,255,255,0.35);
            }
            #phonesocial-panel .ps-signal-bar.active { background:#fff; }
            /* ─── Battery (CSS-drawn, replaces emoji) ─── */
            #phonesocial-panel .ps-battery {
                display:flex; align-items:center; gap:1px;
            }
            #phonesocial-panel .ps-battery-body {
                width:20px; height:10px; border-radius:2px;
                border:1px solid rgba(255,255,255,0.5);
                padding:1.5px; display:flex; align-items:center;
            }
            #phonesocial-panel .ps-battery-fill {
                height:100%; border-radius:1px;
                background:#34c759;
                transition:width 0.3s;
            }
            #phonesocial-panel .ps-battery-tip {
                width:2px; height:4px; border-radius:0 1px 1px 0;
                background:rgba(255,255,255,0.5);
            }
            /* ─── Notch area ─── */
            #phonesocial-panel .ps-notch {
                display:flex; justify-content:center; align-items:center;
                position:relative;
                background:#1c1c1e;
                flex-shrink:0;
                padding:4px 0 8px;
            }
            #phonesocial-panel .ps-notch-pill {
                width:120px; height:24px;
                background:#000;
                border-radius:0 0 14px 14px;
            }
            /* ─── Minimal Header ─── */
            #phonesocial-panel .ps-header {
                display:flex; justify-content:space-between; align-items:center;
                padding:6px 14px;
                background:#1c1c1e;
                flex-shrink:0;
                min-height:36px;
            }
            #phonesocial-panel .ps-header-title {
                font-size:13px; font-weight:600; color:#fff;
                letter-spacing:1px;
                opacity:0.9;
            }
            #phonesocial-panel .ps-close {
                width:32px; height:32px; border-radius:50%;
                border:none;
                background:rgba(255,255,255,0.12);
                color:#fff;
                font-size:14px;
                cursor:pointer;
                touch-action:manipulation;
                -webkit-tap-highlight-color:transparent;
                display:flex; align-items:center; justify-content:center;
            }
            #phonesocial-panel .ps-close:active {
                background:rgba(255,255,255,0.25);
            }
            /* ─── Main Content Area ─── */
            #phonesocial-panel .ps-body {
                flex:1; overflow-y:auto;
                padding:0;
                background:#1c1c1e;
                color:#1c1c1e;
                -webkit-overflow-scrolling:touch;
            }
            /* ─── Bottom Nav ─── */
            #phonesocial-panel .ps-nav {
                display:flex; justify-content:space-around; align-items:center;
                padding:8px 6px;
                background:rgba(28,28,30,0.95);
                backdrop-filter:blur(10px);
                -webkit-backdrop-filter:blur(10px);
                border-top:1px solid rgba(255,255,255,0.08);
                flex-shrink:0;
            }
            #phonesocial-panel .ps-nav button {
                background:transparent; border:none;
                color:rgba(255,255,255,0.6);
                font-size:16px;
                padding:4px 10px;
                border-radius:8px;
                cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:color 0.15s, background 0.15s;
            }
            #phonesocial-panel .ps-nav button:active,
            #phonesocial-panel .ps-nav button.ps-nav-active {
                color:#fff;
                background:rgba(255,255,255,0.12);
            }
            /* ─── Home Indicator ─── */
            #phonesocial-panel .ps-home-indicator {
                display:flex; justify-content:center; align-items:center;
                padding:6px 0 10px;
                background:#1c1c1e;
                flex-shrink:0;
            }
            #phonesocial-panel .ps-home-indicator .ps-home-pill {
                width:120px; height:4px;
                background:rgba(255,255,255,0.3);
                border-radius:99px;
            }
            /* ─── Home Screen / App Grid ─── */
            #phonesocial-panel .ps-home {
                text-align:center; padding:0; color:#1c1c1e;
                position:relative; height:100%; min-height:300px;
            }
            #phonesocial-panel .ps-home .ps-wallpaper {
                position:absolute; top:0; left:0; right:0; bottom:0;
                display:flex; flex-direction:column;
                background:#f2f2f7;
            }
            #phonesocial-panel .ps-home .ps-wallpaper .ps-time-large {
                font-size:48px; font-weight:300; color:#1c1c1e;
                letter-spacing:-1px; margin:32px 0 2px;
                text-shadow:0 1px 2px rgba(0,0,0,0.05);
            }
            #phonesocial-panel .ps-home .ps-wallpaper .ps-date-large {
                font-size:13px; color:#8e8e93; margin-bottom:24px;
            }
            /* App grid — icons with labels below, like iOS */
            #phonesocial-panel .ps-app-grid {
                display:grid;
                grid-template-columns:repeat(3,1fr);
                gap:16px;
                max-width:260px;
                margin:0 auto;
                padding:0 12px;
            }
            #phonesocial-panel .ps-app {
                display:flex; flex-direction:column; align-items:center; justify-content:center;
                gap:4px;
                border-radius:18px; padding:12px 2px 8px;
                cursor:pointer;
                transition:transform 0.15s, opacity 0.15s;
                aspect-ratio:1;
                position:relative;
            }
            #phonesocial-panel .ps-app:active { transform:scale(0.88); opacity:0.85; }
            #phonesocial-panel .ps-app-icon { font-size:28px; }
            #phonesocial-panel .ps-app-label {
                font-size:10px; font-weight:500; color:#1c1c1e;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                max-width:100%;
            }
            /* Notification badge */
            #phonesocial-panel .ps-badge {
                position:absolute; top:4px; right:4px;
                min-width:18px; height:18px; border-radius:99px;
                background:#ff3b30; color:#fff;
                font-size:10px; font-weight:700;
                display:flex; align-items:center; justify-content:center;
                padding:0 5px;
                box-shadow:0 1px 3px rgba(255,59,48,0.4);
            }
            /* iOS-style dock */
            #phonesocial-panel .ps-dock {
                display:flex; justify-content:center; gap:12px;
                margin:12px 16px 6px;
                padding:8px 12px;
                background:rgba(255,255,255,0.35);
                backdrop-filter:blur(20px);
                -webkit-backdrop-filter:blur(20px);
                border-radius:24px;
                max-width:260px;
                align-self:center;
            }
            #phonesocial-panel .ps-dock-app {
                display:flex; flex-direction:column; align-items:center; gap:4px;
                width:52px; cursor:pointer;
                transition:transform 0.15s;
                position:relative;
            }
            #phonesocial-panel .ps-dock-app:active { transform:scale(0.85); }
            #phonesocial-panel .ps-dock-app-icon { font-size:28px; }
            #phonesocial-panel .ps-dock-app-label {
                font-size:10px; font-weight:500; color:#1c1c1e;
            }
            #phonesocial-panel .ps-hint {
                font-size:11px; color:#8e8e93; margin-top:14px;
            }
            /* Page dots */
            #phonesocial-panel .ps-page-dots {
                display:flex; justify-content:center; gap:6px;
                margin-top:6px;
            }
            #phonesocial-panel .ps-page-dot {
                width:6px; height:6px; border-radius:50%;
                background:rgba(0,0,0,0.15);
            }
            #phonesocial-panel .ps-page-dot.active { background:rgba(0,0,0,0.4); }
            /* ─── Settings ─── */
            #phonesocial-panel .ps-settings { padding:4px 0; }
            #phonesocial-panel .ps-settings h3 {
                margin:0 0 10px; font-size:15px; font-weight:700;
                color:#1c1c1e; text-align:center;
            }
            #phonesocial-panel .ps-setting-row {
                display:flex; align-items:flex-start; justify-content:space-between;
                background:#fff; border-radius:12px; padding:12px 14px;
                margin-bottom:8px;
                box-shadow:0 1px 3px rgba(0,0,0,0.04);
            }
            #phonesocial-panel .ps-setting-row b { font-size:13px; color:#1c1c1e; display:block; }
            #phonesocial-panel .ps-setting-row span { font-size:11px; color:#8e8e93; display:block; margin-top:2px; }
            #phonesocial-panel .ps-setting-toggle {
                min-width:60px; border:none; border-radius:99px;
                padding:5px 10px; font-size:11px; font-weight:600;
                cursor:pointer;
                background:#e5e5ea; color:#8e8e93;
                -webkit-tap-highlight-color:transparent;
                transition:background 0.15s, color 0.15s;
                flex-shrink:0;
            }
            #phonesocial-panel .ps-setting-toggle.on {
                background:#34c759; color:#fff;
            }
            #phonesocial-panel .ps-setting-actions {
                display:flex; gap:8px; flex-wrap:wrap;
                margin-top:8px;
            }
            #phonesocial-panel .ps-setting-actions button {
                background:#007aff; color:#fff; border:none;
                border-radius:10px; padding:8px 14px;
                font-size:12px; font-weight:600; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-setting-actions button:active { opacity:0.8; }
            /* API settings inputs */
            #phonesocial-panel .ps-settings label {
                display:block; margin:8px 0 4px; font-size:11px; font-weight:600;
                color:#3c3c43;
            }
            #phonesocial-panel .ps-settings input[type="text"],
            #phonesocial-panel .ps-settings input[type="password"],
            #phonesocial-panel .ps-settings textarea {
                width:100%; padding:10px 12px; border-radius:10px;
                border:1px solid #c7c7cc;
                background:#fff;
                color:#1c1c1e;
                font-size:13px;
                outline:none;
                box-sizing:border-box;
            }
            #phonesocial-panel .ps-settings input:focus,
            #phonesocial-panel .ps-settings textarea:focus {
                border-color:#007aff;
                box-shadow:0 0 0 2px rgba(0,122,255,0.15);
            }
            #phonesocial-panel .ps-settings hr {
                margin:16px 0; border:none; border-top:1px solid #c7c7cc;
                opacity:0.5;
            }
            #phonesocial-panel [data-act="save-settings"] {
                margin-top:12px;
                background:#007aff; color:#fff; border:none;
                padding:10px 16px; border-radius:12px;
                font-size:13px; font-weight:600; cursor:pointer;
                width:100%;
            }
            #phonesocial-panel [data-act="save-settings"]:active { opacity:0.8; }
            #phonesocial-panel #ps-settings-status {
                margin-top:8px; font-size:12px; color:#34c759; text-align:center;
            }
            /* ─── Contact/Message Lists ─── */
            #phonesocial-panel .ps-list { list-style:none; padding:0; margin:0; }
            #phonesocial-panel .ps-list li {
                background:#fff; border-radius:12px; padding:12px 14px;
                margin-bottom:8px; cursor:pointer;
                box-shadow:0 1px 3px rgba(0,0,0,0.04);
                transition:transform 0.1s;
            }
            #phonesocial-panel .ps-list li:active { transform:scale(0.97); }
            #phonesocial-panel .ps-list li b { color:#1c1c1e; display:block; font-size:14px; }
            #phonesocial-panel .ps-list li span { font-size:12px; color:#8e8e93; }
            #phonesocial-panel .ps-list li small { font-size:10px; color:#aeaeb2; }
            /* ─── iOS SMS List ─── */
            #phonesocial-panel .ps-sms-search {
                display:flex; align-items:center; gap:6px;
                margin:8px 12px; padding:8px 12px;
                background:rgba(118,118,128,0.12); border-radius:10px;
                font-size:14px; color:#8e8e93;
            }
            #phonesocial-panel .ps-sms-search-icon { font-size:14px; opacity:0.5; }
            #phonesocial-panel .ps-sms-header-row {
                display:flex; justify-content:space-between; align-items:center;
                padding:4px 16px 8px;
            }
            #phonesocial-panel .ps-sms-header-row button {
                background:transparent; border:none; color:#007aff;
                font-size:14px; cursor:pointer; padding:4px 0;
            }
            #phonesocial-panel .ps-sms-edit-btn { font-size:14px; }
            #phonesocial-panel .ps-sms-compose-btn {
                background:#007aff; color:#fff; border:none;
                border-radius:50%; width:28px; height:28px;
                font-size:16px; cursor:pointer; display:flex;
                align-items:center; justify-content:center;
            }
            #phonesocial-panel .ps-sms-list {
                list-style:none; padding:0; margin:0;
            }
            #phonesocial-panel .ps-sms-list li {
                display:flex; align-items:center; gap:12px;
                padding:10px 16px; cursor:pointer;
                border-bottom:0.5px solid rgba(84,84,88,0.4);
                transition:background 0.15s;
            }
            #phonesocial-panel .ps-sms-list li:active {
                background:rgba(255,255,255,0.05);
            }
            #phonesocial-panel .ps-sms-list .ps-sms-avatar {
                width:48px; height:48px; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                font-size:20px; font-weight:600; color:#fff;
                flex-shrink:0; text-transform:uppercase;
            }
            #phonesocial-panel .ps-sms-list .ps-sms-body {
                flex:1; min-width:0;
            }
            #phonesocial-panel .ps-sms-list .ps-sms-name {
                font-size:16px; font-weight:500; color:#f2f2f7;
                margin-bottom:2px;
            }
            #phonesocial-panel .ps-sms-list .ps-sms-preview {
                font-size:14px; color:#98989d;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            #phonesocial-panel .ps-sms-list .ps-sms-time {
                font-size:13px; color:#8e8e93;
                flex-shrink:0; align-self:flex-start; margin-top:2px;
            }
            #phonesocial-panel .ps-sms-list .ps-sms-unread {
                width:8px; height:8px; border-radius:50%;
                background:#0a84ff; flex-shrink:0;
                align-self:center; margin-left:4px;
            }
            /* ─── iOS Contacts ─── */
            #phonesocial-panel .ps-contacts-wrap { overflow-y:auto; }
            #phonesocial-panel .ps-contacts-search {
                display:flex; align-items:center; gap:6px;
                background:#e5e5ea; border-radius:10px;
                padding:8px 12px; margin:8px 12px 12px;
            }
            #phonesocial-panel .ps-empty-state {
                text-align:center; padding:40px 20px; color:#8e8e93;
            }
            #phonesocial-panel .ps-empty-icon { font-size:48px; margin-bottom:12px; }
            #phonesocial-panel .ps-empty-state p { font-size:18px; font-weight:600; color:#1c1c1e; margin:0 0 6px; }
            #phonesocial-panel .ps-empty-state span { font-size:13px; display:block; margin-bottom:16px; line-height:1.4; }
            #phonesocial-panel .ps-add-btn {
                background:#007aff; color:#fff; border:none;
                border-radius:20px; padding:10px 24px; font-size:14px;
                font-weight:500; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-add-btn:active { opacity:0.7; }
            #phonesocial-panel .ps-contact-section { margin-bottom:4px; }
            #phonesocial-panel .ps-contact-section-header {
                font-size:12px; font-weight:600; color:#8e8e93;
                text-transform:uppercase; letter-spacing:0.5px;
                padding:4px 16px; margin-top:4px;
                background:#f2f2f7; position:sticky; top:0; z-index:1;
            }
            #phonesocial-panel .ps-contact-row {
                display:flex; align-items:center; gap:10px;
                padding:10px 16px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-contact-row:active { background:rgba(0,0,0,0.04); }
            #phonesocial-panel .ps-contact-row-info {
                flex:1; min-width:0; display:flex; flex-direction:column;
            }
            #phonesocial-panel .ps-contact-row-name {
                font-size:15px; font-weight:500; color:#3a3a3c;
            }
            #phonesocial-panel .ps-contact-row-num {
                font-size:12px; color:#8e8e93; margin-top:1px;
            }
            #phonesocial-panel .ps-contact-call-btn {
                width:36px; height:36px; border-radius:50%;
                border:none; background:rgba(0,122,255,0.08);
                color:#007aff; font-size:16px; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                flex-shrink:0;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-contact-call-btn:active { background:#007aff; color:#fff; }
            #phonesocial-panel .ps-empty {
                text-align:center; color:#8e8e93; padding:40px 20px;
                font-size:13px;
            }
            /* ─── Call Screen ─── */
            #phonesocial-panel .ps-call-screen {
                display:flex; flex-direction:column; flex:1;
                background:linear-gradient(180deg,#1c1c1e,#0a0a0b);
                color:#fff; padding:20px;
            }
            #phonesocial-panel .ps-call-info {
                flex:1; display:flex; flex-direction:column;
                align-items:center; justify-content:center;
                text-align:center;
            }
            #phonesocial-panel .ps-call-avatar {
                width:80px; height:80px; border-radius:50%;
                background:rgba(0,122,255,0.2); color:#007aff;
                font-size:36px; font-weight:700;
                display:flex; align-items:center; justify-content:center;
                margin-bottom:16px;
            }
            #phonesocial-panel .ps-call-name {
                font-size:24px; font-weight:600; margin-bottom:4px;
            }
            #phonesocial-panel .ps-call-number {
                font-size:14px; color:#aeaeb2; margin-bottom:8px;
            }
            #phonesocial-panel .ps-call-status {
                font-size:16px; color:#30d158; animation:ps-pulse 1.5s ease-in-out infinite;
            }
            #phonesocial-panel .ps-call-timer {
                font-size:40px; font-weight:300; color:#fff;
                font-variant-numeric:tabular-nums; letter-spacing:2px;
            }
            @keyframes ps-pulse {
                0%,100% { opacity:1; }
                50% { opacity:0.4; }
            }
            #phonesocial-panel .ps-call-controls {
                display:flex; flex-direction:column;
                align-items:center; gap:16px; padding-bottom:20px;
            }
            #phonesocial-panel .ps-call-controls-row {
                display:flex; gap:24px; justify-content:center;
            }
            #phonesocial-panel .ps-call-ctrl-btn {
                width:64px; height:64px; border-radius:50%;
                border:none; background:rgba(255,255,255,0.08);
                color:#fff; cursor:pointer;
                display:flex; flex-direction:column;
                align-items:center; justify-content:center;
                gap:2px; font-size:13px;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-call-ctrl-btn:active {
                background:rgba(255,255,255,0.18);
            }
            #phonesocial-panel .ps-call-ctrl-btn span { font-size:22px; }
            #phonesocial-panel .ps-call-ctrl-btn small { font-size:10px; color:#aeaeb2; }
            #phonesocial-panel .ps-call-end {
                width:64px; height:64px; border-radius:50%;
                border:none; background:#ff3b30; color:#fff;
                font-size:13px; font-weight:600; cursor:pointer;
                display:flex; flex-direction:column;
                align-items:center; justify-content:center;
                gap:2px;
                -webkit-tap-highlight-color:transparent;
                box-shadow:0 4px 16px rgba(255,59,48,0.4);
            }
            #phonesocial-panel .ps-call-end:active {
                background:#cc2d24; transform:scale(0.95);
            }
            #phonesocial-panel .ps-call-transcript {
                flex:1; overflow-y:auto; padding:8px 12px;
                max-height:120px; margin:0 0 8px;
                background:rgba(255,255,255,0.04); border-radius:10px;
            }
            #phonesocial-panel .ps-call-utterance {
                font-size:13px; color:#e5e5ea; margin-bottom:4px;
                line-height:1.4;
            }
            #phonesocial-panel .ps-call-utterance b { color:#30d158; }
            #phonesocial-panel .ps-call-compose {
                display:flex; gap:6px; padding:8px 0; align-items:center;
            }
            #phonesocial-panel .ps-call-compose input {
                flex:1; padding:10px 14px; border-radius:20px;
                border:1px solid rgba(255,255,255,0.12);
                background:rgba(255,255,255,0.06); color:#fff;
                font-size:14px; outline:none;
            }
            #phonesocial-panel .ps-call-compose input::placeholder { color:#636366; }
            #phonesocial-panel .ps-call-speak-btn {
                padding:10px 18px; border-radius:20px;
                border:none; background:#007aff; color:#fff;
                font-size:13px; font-weight:600; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-call-speak-btn:active { background:#0056b3; }
            #phonesocial-panel .ps-call-incoming {
                color:#007aff; font-size:18px; font-weight:500;
            }
            #phonesocial-panel .ps-call-declined {
                color:#ff3b30; font-size:16px;
            }
            #phonesocial-panel .ps-call-incoming-btns {
                display:flex; gap:24px; justify-content:center; margin-top:20px;
            }
            #phonesocial-panel .ps-call-answer-btn {
                width:80px; height:80px; border-radius:50%;
                border:none; background:#30d158; color:#fff;
                font-size:14px; font-weight:600; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                box-shadow:0 4px 16px rgba(48,209,88,0.4);
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-call-answer-btn:active { background:#248a3d; transform:scale(0.95); }
            #phonesocial-panel .ps-call-decline-btn {
                width:80px; height:80px; border-radius:50%;
                border:none; background:#ff3b30; color:#fff;
                font-size:13px; font-weight:600; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                box-shadow:0 4px 16px rgba(255,59,48,0.4);
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-call-decline-btn:active { background:#cc2d24; transform:scale(0.95); }
            /* ─── Browser ─── */
            #phonesocial-panel .ps-browser {
                display:flex; flex-direction:column; flex:1; background:#1c1c1e; color:#fff;
            }
            #phonesocial-panel .ps-browser-toolbar {
                display:flex; gap:6px; padding:4px 8px; background:#2c2c2e;
                align-items:center;
            }
            #phonesocial-panel .ps-browser-navbtn {
                width:32px; height:32px; border-radius:6px; border:none;
                background:transparent; color:#fff; font-size:14px;
                cursor:pointer; display:flex; align-items:center; justify-content:center;
            }
            #phonesocial-panel .ps-browser-navbtn:active { background:rgba(255,255,255,0.1); }
            #phonesocial-panel .ps-browser-navbtn[disabled] { opacity:0.3; cursor:default; }
            #phonesocial-panel .ps-browser-urlbar {
                display:flex; gap:4px; padding:4px 8px; background:#2c2c2e;
                align-items:center;
            }
            #phonesocial-panel .ps-browser-urlbar input {
                flex:1; padding:8px 12px; border-radius:20px; border:none;
                background:#3a3a3c; color:#fff; font-size:13px; outline:none;
            }
            #phonesocial-panel .ps-browser-urlbar input::placeholder { color:#636366; }
            #phonesocial-panel .ps-browser-gobtn {
                padding:8px 16px; border-radius:20px; border:none;
                background:#007aff; color:#fff; font-size:13px; font-weight:600;
                cursor:pointer;
            }
            #phonesocial-panel .ps-browser-gobtn:active { background:#0056b3; }
            #phonesocial-panel .ps-browser-title {
                padding:4px 12px; font-size:11px; color:#8e8e93;
                background:#2c2c2e; border-bottom:1px solid #3a3a3c;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            #phonesocial-panel .ps-browser-content {
                flex:1; overflow-y:auto; padding:12px;
                background:#1c1c1e;
            }
            #phonesocial-panel .ps-browser-content a {
                color:#007aff; cursor:pointer; text-decoration:underline;
            }
            #phonesocial-panel .ps-browser-content a:active { opacity:0.7; }
            #phonesocial-panel .ps-browser-landing {
                display:flex; flex-direction:column;
                align-items:center; justify-content:center;
                height:100%; text-align:center; padding:40px 20px;
            }
            #phonesocial-panel .ps-browser-logo { font-size:64px; margin-bottom:16px; }
            #phonesocial-panel .ps-browser-tagline { font-size:16px; color:#8e8e93; }
            #phonesocial-panel .ps-browser-error { color:#ff3b30; padding:20px; text-align:center; }
            /* ─── Thread View ─── */
            #phonesocial-panel .ps-thread-head {
                display:flex; align-items:center; padding:6px 4px 10px;
                gap:8px;
            }
            #phonesocial-panel .ps-thread-head b { flex:1; text-align:left; color:#f2f2f7; font-size:15px; }
            #phonesocial-panel .ps-thread-head button {
                background:transparent; border:none; font-size:16px; cursor:pointer; padding:4px; color:#007aff;
            }
            #phonesocial-panel .ps-thread-actions {
                display:flex; gap:4px; align-items:center;
            }
            #phonesocial-panel .ps-thread { min-height:80px; margin-bottom:8px; }
            #phonesocial-panel .ps-msg {
                max-width:80%; padding:8px 14px; border-radius:16px;
                margin:3px 0; font-size:13px; line-height:1.4;
                word-wrap:break-word; position:relative;
            }
            #phonesocial-panel .ps-msg.me {
                background:#007aff; color:#fff;
                margin-left:auto; border-bottom-right-radius:4px;
            }
            #phonesocial-panel .ps-msg.them {
                background:#e5e5ea; color:#1c1c1e;
                border-bottom-left-radius:4px;
            }
            #phonesocial-panel .ps-msg-img {
                padding:4px !important; background:transparent !important;
            }
            #phonesocial-panel .ps-msg-img img { border-radius:6px; }
            #phonesocial-panel .ps-msg-del {
                display:none; position:absolute; top:-4px; right:-4px;
                width:18px; height:18px; border-radius:50%; border:none;
                background:rgba(255,69,58,0.9); color:#fff; font-size:12px;
                line-height:18px; text-align:center; cursor:pointer; padding:0;
            }
            #phonesocial-panel .ps-msg:hover .ps-msg-del,
            #phonesocial-panel .ps-msg:active .ps-msg-del { display:block; }
            #phonesocial-panel .ps-sms-delete {
                display:none; position:absolute; right:8px; top:50%; transform:translateY(-50%);
                width:26px; height:26px; border-radius:50%; border:none;
                background:rgba(255,69,58,0.85); color:#fff; font-size:14px;
                line-height:26px; text-align:center; cursor:pointer; padding:0; z-index:2;
            }
            #phonesocial-panel .ps-sms-list li {
                position:relative;
            }
            #phonesocial-panel .ps-sms-list li:hover .ps-sms-delete,
            #phonesocial-panel .ps-sms-list li:active .ps-sms-delete { display:block; }
            #phonesocial-panel .ps-compose {
                display:flex; gap:6px; padding:8px;
                background:transparent; border-top:1px solid #c7c7cc;
                align-items:center;
            }
            #phonesocial-panel #ps-input {
                flex:1; border:1px solid #c7c7cc; border-radius:20px;
                padding:8px 14px; background:#fff;
                color:#1c1c1e; outline:none; font-size:13px;
            }
            #phonesocial-panel .ps-compose button {
                background:#007aff; color:#fff; border:none;
                border-radius:20px; padding:8px 16px;
                font-weight:600; font-size:13px; cursor:pointer;
            }
            #phonesocial-panel .ps-compose-camera {
                background:transparent; border:none; font-size:20px;
                cursor:pointer; padding:4px 6px; color:#8e8e93;
                opacity:0.5;
            }
            /* ─── Avatar ─── */
            #phonesocial-panel .ps-avatar {
                width:32px; height:32px; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                font-size:14px; font-weight:600; color:#fff;
                flex-shrink:0; text-transform:uppercase;
            }
            #phonesocial-panel .ps-avatar-sm {
                width:40px; height:40px; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                font-size:16px; font-weight:600; color:#fff;
                flex-shrink:0; text-transform:uppercase;
            }
            /* ─── Typing Indicator ─── */
            #phonesocial-panel .ps-typing {
                display:flex; align-items:center; gap:4px;
                padding:10px 14px; margin:3px 0;
                background:#e5e5ea; border-radius:16px;
                border-bottom-left-radius:4px;
                width:fit-content; max-width:80%;
            }
            #phonesocial-panel .ps-typing span {
                width:7px; height:7px; border-radius:50%;
                background:#8e8e93; display:block;
                animation: ps-typing-bounce 1.4s infinite ease-in-out;
            }
            #phonesocial-panel .ps-typing span:nth-child(1) { animation-delay:0s; }
            #phonesocial-panel .ps-typing span:nth-child(2) { animation-delay:0.2s; }
            #phonesocial-panel .ps-typing span:nth-child(3) { animation-delay:0.4s; }
            @keyframes ps-typing-bounce {
                0%,60%,100% { transform:translateY(0); opacity:0.4; }
                30% { transform:translateY(-6px); opacity:1; }
            }
            /* ─── Message Timestamps ─── */
            #phonesocial-panel .ps-msg-time {
                font-size:10px; color:#8e8e93;
                margin:1px 4px 6px; display:block;
            }
            #phonesocial-panel .ps-msg-time.me { text-align:right; }
            #phonesocial-panel .ps-msg-time.them { text-align:left; }
            /* ─── Read Receipts ─── */
            #phonesocial-panel .ps-receipt {
                font-size:10px; color:#8e8e93;
                align-self:flex-end; margin-right:8px; margin-bottom:6px;
            }
            #phonesocial-panel .ps-receipt.ps-seen { color:#007aff; }
            /* ─── Date Dividers ─── */
            #phonesocial-panel .ps-date-divider {
                text-align:center; font-size:11px; color:#8e8e93;
                padding:8px 0; font-weight:500;
            }
            /* ─── iOS Dial Pad ─── */
            #phonesocial-panel .ps-dial {
                text-align:center; padding:8px 0;
                display:flex; flex-direction:column; height:100%;
            }
            #phonesocial-panel .ps-dial-display {
                font-size:32px; font-weight:300; color:#1c1c1e;
                margin:20px 0 24px; min-height:40px;
                letter-spacing:1px; font-variant-numeric:tabular-nums;
            }
            #phonesocial-panel .ps-dial-placeholder {
                color:#c7c7cc; font-size:18px; font-weight:400;
            }
            #phonesocial-panel .ps-dial-pad {
                display:grid; grid-template-columns:repeat(3,72px);
                gap:12px; justify-content:center; flex:1;
                align-content:center; padding-bottom:20px;
            }
            #phonesocial-panel .ps-dial-key {
                width:72px; height:72px; border-radius:50%;
                border:1px solid rgba(0,0,0,0.08);
                background:#f9f9fb;
                cursor:pointer;
                display:flex; flex-direction:column;
                align-items:center; justify-content:center;
                touch-action:manipulation;
                -webkit-tap-highlight-color:transparent;
                transition:background 0.05s;
            }
            #phonesocial-panel .ps-dial-key:active { background:#e0e0e5; }
            #phonesocial-panel .ps-dial-key-num {
                font-size:26px; font-weight:400; color:#1c1c1e;
                line-height:1; margin-bottom:2px;
            }
            #phonesocial-panel .ps-dial-key-sub {
                font-size:9px; font-weight:600; color:#8e8e93;
                letter-spacing:1.5px; line-height:1;
            }
            #phonesocial-panel .ps-dial-actions {
                display:flex; justify-content:center; align-items:center;
                gap:20px; padding:16px 0 12px;
            }
            #phonesocial-panel .ps-dial-action-btn {
                width:64px; height:64px; border-radius:50%;
                border:none; background:#e5e5ea;
                color:#1c1c1e; font-size:22px; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-dial-action-btn:active { background:#c7c7cc; }
            #phonesocial-panel .ps-dial-call-btn {
                width:64px; height:64px; border-radius:50%;
                border:none; background:#34c759;
                cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                box-shadow:0 4px 16px rgba(52,199,89,0.35);
                -webkit-tap-highlight-color:transparent;
                transition:transform 0.1s;
            }
            #phonesocial-panel .ps-dial-call-btn:active {
                transform:scale(0.92); background:#30b350;
            }
            /* ─── Dial Tabs ─── */
            #phonesocial-panel .ps-dial-tabs {
                display:flex; gap:0; border-bottom:1px solid #e5e5ea;
                margin:0 0 8px;
            }
            #phonesocial-panel .ps-dial-tab {
                flex:1; padding:10px 0; border:none; background:transparent;
                font-size:14px; font-weight:500; color:#8e8e93;
                cursor:pointer; text-align:center;
                border-bottom:2px solid transparent;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-dial-tab.active {
                color:#007aff; border-bottom-color:#007aff;
            }
            /* ─── Recents List ─── */
            #phonesocial-panel .ps-recents-list {
                overflow-y:auto; flex:1;
            }
            #phonesocial-panel .ps-recent-row {
                display:flex; align-items:center; gap:10px;
                padding:10px 16px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-recent-row:active { background:rgba(0,0,0,0.04); }
            #phonesocial-panel .ps-recent-unread { background:rgba(0,122,255,0.04); }
            #phonesocial-panel .ps-recent-info {
                flex:1; min-width:0; display:flex; flex-direction:column;
            }
            #phonesocial-panel .ps-recent-name {
                font-size:15px; font-weight:500; color:#3a3a3c;
            }
            #phonesocial-panel .ps-recent-label {
                font-size:12px; margin-top:1px;
            }
            #phonesocial-panel .ps-recent-time {
                font-size:12px; color:#8e8e93; flex-shrink:0;
            }
            /* ─── Incoming SMS Banner ─── */
            #phonesocial-panel .ps-incoming-banner {
                display:flex; align-items:center; gap:10px;
                padding:10px 14px; margin:0 0 4px;
                background:rgba(0,122,255,0.08); border-radius:10px;
                cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                animation:ps-banner-in 0.3s ease-out;
            }
            @keyframes ps-banner-in {
                from { opacity:0; transform:translateY(-10px); }
                to { opacity:1; transform:translateY(0); }
            }
            #phonesocial-panel .ps-incoming-banner:active { background:rgba(0,122,255,0.15); }
            #phonesocial-panel .ps-incoming-banner-text {
                flex:1; min-width:0; display:flex; flex-direction:column;
            }
            #phonesocial-panel .ps-incoming-banner-text b {
                font-size:13px; color:#3a3a3c;
            }
            #phonesocial-panel .ps-incoming-banner-text span {
                font-size:12px; color:#8e8e93; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            #phonesocial-panel .ps-banner-dismiss {
                background:none; border:none; color:#8e8e93; font-size:14px;
                padding:4px 6px; cursor:pointer; border-radius:50%;
                flex-shrink:0; line-height:1;
            }
            #phonesocial-panel .ps-banner-dismiss:active {
                background:rgba(0,0,0,0.1); color:#3a3a3c;
            }
            /* ─── Notification Shade (pull-down) ─── */
            #phonesocial-panel .ps-notif-shade {
                position:absolute; top:0; left:0; right:0; z-index:100;
                max-height:0; overflow:hidden;
                transition:max-height 0.3s cubic-bezier(0.32, 0.72, 0, 1);
                pointer-events:none;
                contain:layout style;
            }
            #phonesocial-panel .ps-notif-shade.ps-notif-open {
                max-height:70%; pointer-events:auto;
            }
            #phonesocial-panel .ps-notif-shade.ps-notif-dragging {
                transition:none;
            }
            #phonesocial-panel .ps-notif-bg {
                position:absolute; inset:0; background:rgba(0,0,0,0.3);
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-notif-content {
                position:absolute; top:0; left:0; right:0;
                background:rgba(28,28,30,0.95);
                backdrop-filter:blur(20px);
                -webkit-backdrop-filter:blur(20px);
                border-radius:0 0 20px 20px;
                padding:0 0 12px;
                max-height:70%;
                overflow-y:auto;
                box-shadow:0 4px 24px rgba(0,0,0,0.4);
            }
            #phonesocial-panel .ps-notif-header {
                display:flex; align-items:center; gap:8px;
                padding:12px 16px 8px;
                border-bottom:1px solid rgba(255,255,255,0.1);
            }
            #phonesocial-panel .ps-notif-header-time {
                font-size:13px; font-weight:600; color:#fff;
            }
            #phonesocial-panel .ps-notif-header-date {
                font-size:11px; color:rgba(255,255,255,0.5);
            }
            #phonesocial-panel .ps-notif-clear {
                margin-left:auto; background:none; border:none;
                color:#0a84ff; font-size:13px; cursor:pointer;
                padding:4px 8px; border-radius:6px;
            }
            #phonesocial-panel .ps-notif-clear:active { background:rgba(10,132,255,0.15); }
            #phonesocial-panel .ps-notif-list {
                padding:4px 0;
            }
            #phonesocial-panel .ps-notif-empty {
                text-align:center; padding:24px 16px;
                color:rgba(255,255,255,0.4); font-size:14px;
            }
            #phonesocial-panel .ps-notif-item {
                display:flex; align-items:center; gap:10px;
                padding:10px 16px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-notif-item:active { background:rgba(255,255,255,0.08); }
            #phonesocial-panel .ps-notif-icon {
                width:32px; height:32px; border-radius:8px;
                display:flex; align-items:center; justify-content:center;
                font-size:15px; flex-shrink:0;
            }
            #phonesocial-panel .ps-notif-body {
                flex:1; min-width:0; display:flex; flex-direction:column; gap:2px;
            }
            #phonesocial-panel .ps-notif-name {
                font-size:13px; font-weight:600;
            }
            #phonesocial-panel .ps-notif-text {
                font-size:12px; color:rgba(255,255,255,0.6);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            #phonesocial-panel .ps-notif-time {
                font-size:11px; color:rgba(255,255,255,0.4); flex-shrink:0;
            }
            #phonesocial-panel .ps-notif-handle {
                display:flex; justify-content:center; padding:8px 0 4px;
            }
            #phonesocial-panel .ps-notif-handle span {
                width:36px; height:5px; border-radius:3px;
                background:rgba(255,255,255,0.3);
            }
            /* ─── Albums / Wallpaper Picker ─── */
            #phonesocial-panel .ps-albums { padding:4px 0; }
            #phonesocial-panel .ps-albums-header {
                display:flex; align-items:center; gap:8px;
                padding:4px 0 12px;
            }
            #phonesocial-panel .ps-albums-header button {
                width:30px; height:30px; border-radius:50%;
                border:none; background:#e5e5ea;
                font-size:14px; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
            }
            #phonesocial-panel .ps-albums-header span {
                flex:1; text-align:center; font-size:15px; font-weight:600;
                color:#1c1c1e;
            }
            #phonesocial-panel .ps-albums-grid {
                display:grid;
                grid-template-columns:repeat(2,1fr);
                gap:12px;
                padding:0;
            }
            #phonesocial-panel .ps-album-item {
                border-radius:14px; overflow:hidden;
                cursor:pointer;
                position:relative;
                box-shadow:0 1px 4px rgba(0,0,0,0.08);
                transition:transform 0.15s;
            }
            #phonesocial-panel .ps-album-item:active { transform:scale(0.94); }
            #phonesocial-panel .ps-album-item.ps-album-selected {
                box-shadow:0 0 0 2px #007aff, 0 2px 8px rgba(0,122,255,0.25);
            }
            #phonesocial-panel .ps-album-preview {
                width:100%; height:80px;
                border-radius:0;
            }
            #phonesocial-panel .ps-album-name {
                display:block;
                padding:8px 10px;
                font-size:12px; font-weight:500;
                color:#1c1c1e;
                background:#fff;
            }
            #phonesocial-panel .ps-album-check {
                position:absolute; top:4px; right:4px;
                width:20px; height:20px;
                border-radius:50%;
                background:#007aff; color:#fff;
                font-size:12px; font-weight:700;
                display:flex; align-items:center; justify-content:center;
            }
        `;
        document.head.appendChild(style);
    }

    // Injects incoming SMS banner directly into DOM without full re-render
    function showIncomingBanner(contact, text) {
        if (!contact) return;
        state.incomingBanner = { contactId: contact.id, name: contact.name, text, ts: Date.now() };
        const panel = document.getElementById('phonesocial-panel');
        if (!panel || panel.style.display === 'none') return;
        // Remove existing banner if present
        const old = panel.querySelector('.ps-incoming-banner');
        if (old) old.remove();
        // Build and inject before .ps-body
        const body = panel.querySelector('.ps-body');
        if (!body) { render(); return; }
        const banner = document.createElement('div');
        banner.className = 'ps-incoming-banner';
        banner.setAttribute('data-act', 'open-thread');
        banner.setAttribute('data-id', contact.id);
        banner.innerHTML = '<div class="ps-avatar-sm" style="background:' + avatarGradient(contact.name || '') + '">' + avatarInitial(contact.name || '?') + '</div>'
            + '<div class="ps-incoming-banner-text"><b>' + escape(contact.name || 'Unknown') + '</b>'
            + '<span>' + escape((text || '').slice(0, 80)) + '</span></div>'
            + '<button data-act="dismiss-banner" class="ps-banner-dismiss" title="Dismiss">✕</button>';
        body.parentNode.insertBefore(banner, body);
        // Auto-dismiss after 3s
        setTimeout(() => {
            const b = panel.querySelector('.ps-incoming-banner');
            if (b) b.remove();
            state.incomingBanner = null;
        }, 3000);
    }

    function togglePanel() {
        const panel = ensurePanel();
        const btn = document.getElementById('phonesocial-btn');
        if (isPanelOpen) {
            // Close — opacity/pointer-events as guaranteed fallback to flaky transform
            panel.style.transform = 'translateX(100%)';
            panel.style.opacity = '0';
            panel.style.pointerEvents = 'none';
            isPanelOpen = false;
            if (btn) btn.style.cssText = [
                'position:fixed',
                'left:calc(100vw - 64px)',
                'top:80px',
                'right:auto',
                'bottom:auto',
                'width:52px',
                'height:52px',
                'z-index:10050',
                'display:flex !important', // Force display
                'align-items:center',
                'justify-content:center',
                'border-radius:50%',
                'border:2px solid #fff',
                'color:#fff',
                'font-size:22px',
                'line-height:1',
                'box-shadow:0 4px 14px rgba(0,0,0,0.6)',
                'cursor:pointer',
                'padding:0',
                'margin:0',
                'visibility:visible !important', // Force visibility
                'opacity:1 !important', // Force opacity
                'pointer-events:auto !important', // Force pointer events
            ].join(';') + ';';
            stopCallTimer();
            stopProactiveCycle();
            setTimeout(() => { panel.style.display = 'none'; }, 260);
        } else {
            // Open
            harvestNPCs();
            purgeStaleContacts();
            saveMeta();
            render();
            isPanelOpen = true;
            panel.style.display = 'flex';
            void panel.offsetWidth; // force reflow
            panel.style.transform = 'translateX(0)';
            panel.style.visibility = 'visible';
            panel.style.opacity = '1';
            panel.style.pointerEvents = 'auto';
            if (btn) btn.style.cssText = 'display:none !important; pointer-events:none !important; visibility:hidden !important; opacity:0 !important;';
        }
    }

    // Close handler bound once — doesn't stack on re-render
    function doClose(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (isPanelOpen) togglePanel();
    }

    function getStatusBarTime() {
        const now = new Date();
        const h = now.getHours();
        const m = String(now.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    }

    function getHeaderTitle() {
        const titles = {
            'home': 'PhoneSocial',
            'contacts': 'Contacts',
            'sms': 'Messages',
            'thread': 'Message',
            'dial': 'Phone',
            'settings': 'Settings',
            'profile': 'Profile',
            'albums': 'Wallpapers',
            'memories': 'Memories',
            'call': 'Call',
            'browser': 'Browser',
            'chirp': 'Chirp',
            'chirp-thread': 'Post',
            'favorites': 'Favorites',
        };
        return titles[state.view] || 'PhoneSocial';
    }

    // ─── Notification Shade (pull-down) ──────────────────────────────
    function buildNotifShade() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;

        const items = [];

        // Unread SMS
        for (const [cid, thread] of Object.entries(state.threads)) {
            if (!Array.isArray(thread) || !thread.length) continue;
            const unread = thread.filter(m => m.from === 'them' && !m.seen);
            for (const m of unread.slice(-3)) {
                const c = state.contacts.find(x => x.id === cid);
                items.push({
                    type: 'sms', icon: '💬', contactId: cid,
                    name: c?.name || cid, text: (m.text || '').slice(0, 80),
                    ts: m.ts, act: 'open-thread', color: '#34c759'
                });
            }
        }

        // Missed/declined calls
        const missedCalls = (state.callLog || []).filter(e => e.dir === 'missed' || e.dir === 'declined');
        for (const e of missedCalls.slice(-5)) {
            const c = state.contacts.find(x => x.id === e.contactId);
            items.push({
                type: 'call', icon: e.dir === 'missed' ? '📞' : '📵', contactId: e.contactId,
                name: c?.name || 'Unknown',
                text: e.dir === 'missed' ? 'Missed call' : 'Declined call',
                ts: e.ts, act: 'open-thread', color: '#ff3b30'
            });
        }

        // Unheard voicemails
        const unheardVm = (state.voicemails || []).filter(v => !v.heard);
        for (const vm of unheardVm.slice(-5)) {
            const c = state.contacts.find(x => x.id === vm.contactId);
            items.push({
                type: 'voicemail', icon: '🎙️', contactId: vm.contactId,
                name: c?.name || 'Unknown',
                text: (vm.text || '').slice(0, 80),
                ts: vm.ts, act: 'play-voicemail', color: '#ff9500', vmTs: vm.ts
            });
        }

        // Sort by time, newest first
        items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

        const fmtTime = ts => {
            const d = new Date(ts);
            const diff = Date.now() - ts;
            if (diff < 60000) return 'now';
            if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
            if (diff < 86400000) return d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
            return d.toLocaleDateString([], { month:'short', day:'numeric' });
        };

        const itemHtml = items.length
            ? items.map(item => {
                const extraAttr = item.type === 'voicemail' ? ` data-vm-ts="${item.vmTs}"` : '';
                return `<div class="ps-notif-item" data-act="${item.act}" data-id="${item.contactId}"${extraAttr}>
                    <span class="ps-notif-icon" style="background:${item.color}20;color:${item.color}">${item.icon}</span>
                    <div class="ps-notif-body">
                        <span class="ps-notif-name" style="color:${item.color}">${escape(item.name)}</span>
                        <span class="ps-notif-text">${escape(item.text)}</span>
                    </div>
                    <span class="ps-notif-time">${fmtTime(item.ts)}</span>
                </div>`;
            }).join('')
            : '<div class="ps-notif-empty">No notifications</div>';

        const hasItems = items.length > 0;

        return `
            <div class="ps-notif-shade${notifShadeOpen ? ' ps-notif-open' : ''}" id="ps-notif-shade">
                <div class="ps-notif-bg" data-act="close-shade"></div>
                <div class="ps-notif-content">
                    <div class="ps-notif-header">
                        <span class="ps-notif-header-time">${timeStr}</span>
                        <span class="ps-notif-header-date">${dateStr}</span>
                        ${hasItems ? `<button class="ps-notif-clear" data-act="clear-notifs">Clear</button>` : ''}
                    </div>
                    <div class="ps-notif-list">
                        ${itemHtml}
                    </div>
                    <div class="ps-notif-handle"><span></span></div>
                </div>
            </div>`;
    }

    function render() {
        const panel = ensurePanel();
        // Stop call timer if leaving call view
        if (state.view !== 'call') stopCallTimer();
        let body = '';
        switch (state.view) {
            case 'contacts': body = viewContacts(); break;
            case 'sms':      body = viewSmsList(); break;
            case 'thread':   body = viewThread(); break;
            case 'dial':     body = viewDial(); break;
            case 'settings': body = viewSettings(); break;
            case 'profile':  body = viewProfile(); break;
            case 'albums':   body = viewAlbums(); break;
            case 'memories': body = viewMemories(); break;
            case 'call':     body = viewCallScreen(); break;
            case 'browser':  body = viewBrowser(); break;
            case 'chirp':    body = viewChirp(); break;
            case 'chirp-thread': body = viewChirpThread(); break;
            case 'favorites': body = viewContacts(true); break;
            default:         body = viewHome();
        }
        // Stash compose draft to module-level var so it survives view changes (e.g., incoming call)
        const currentInput = document.getElementById('ps-input');
        if (currentInput && currentInput.value) {
            composeDraft = currentInput.value;
        }
        panel.innerHTML = `
            <div class="ps-phone-frame">
                ${buildNotifShade()}
                <div class="ps-statusbar">
                    <span class="ps-sb-carrier" style="font-size:10px;opacity:0.7;font-weight:500">📱 v3 (debug: isNpcPresent+log)</span>
                    <span class="ps-sb-time" id="ps-sb-time">${getStatusBarTime()}</span>
                    <span class="ps-sb-icons">
                        <span class="ps-signal">
                            <span class="ps-signal-bar" style="height:3px"></span>
                            <span class="ps-signal-bar active" style="height:6px"></span>
                            <span class="ps-signal-bar active" style="height:9px"></span>
                            <span class="ps-signal-bar active" style="height:12px"></span>
                        </span>
                        <span class="ps-battery">
                            <span class="ps-battery-body">
                                <span class="ps-battery-fill" style="width:100%"></span>
                            </span>
                            <span class="ps-battery-tip"></span>
                        </span>
                    </span>
                </div>
                <div class="ps-header" style="${state.view === 'call' ? 'display:none' : ''}">
                    <span class="ps-header-title">${getHeaderTitle()}</span>
                    <button class="ps-close" id="ps-close-btn" type="button">✕</button>
                </div>
                ${state.incomingBanner ? `
                <div class="ps-incoming-banner" data-act="open-thread" data-id="${state.incomingBanner.contactId}">
                    <div class="ps-avatar-sm" style="background:${avatarGradient(state.incomingBanner.name || '')}">${avatarInitial(state.incomingBanner.name || '?')}</div>
                    <div class="ps-incoming-banner-text">
                        <b>${escape(state.incomingBanner.name || 'Unknown')}</b>
                        <span>${escape((state.incomingBanner.text || '').slice(0, 80))}</span>
                    </div>
                    <button data-act="dismiss-banner" class="ps-banner-dismiss" title="Dismiss">✕</button>
                </div>` : ''}
                <div class="ps-body">${body}</div>
                <div class="ps-nav" style="${state.view === 'call' ? 'display:none' : ''}">
                    <button data-act="nav" data-view="dial" class="${state.view === 'dial' ? 'ps-nav-active' : ''}">📞</button>
                    <button data-act="nav" data-view="sms" class="${state.view === 'sms' ? 'ps-nav-active' : ''}">💬</button>
                    <button data-act="nav" data-view="contacts" class="${state.view === 'contacts' ? 'ps-nav-active' : ''}">👥</button>
                    <button data-act="nav" data-view="settings" class="${state.view === 'settings' ? 'ps-nav-active' : ''}">⚙️</button>
                </div>
                <div class="ps-home-indicator" style="${state.view === 'call' ? 'display:none' : ''}"><div class="ps-home-pill"></div></div>
            </div>
        `;
        bindPanel(panel);

        // Wire up contact search filter (real-time)
        const searchInput = panel.querySelector('#ps-contact-search');
        if (searchInput) {
            searchInput.addEventListener('input', function() {
                const query = this.value.toLowerCase().trim();
                const sections = panel.querySelectorAll('.ps-contact-section');
                let visibleCount = 0;
                for (const sec of sections) {
                    let sectionHasVisible = false;
                    const rows = sec.querySelectorAll('.ps-contact-row');
                    for (const row of rows) {
                        const name = (row.getAttribute('data-search-name') || '').toLowerCase();
                        if (!query || name.includes(query)) {
                            row.style.display = '';
                            sectionHasVisible = true;
                            visibleCount++;
                        } else {
                            row.style.display = 'none';
                        }
                    }
                    sec.style.display = sectionHasVisible ? '' : 'none';
                }
                // Show/hide search results count
                let hint = panel.querySelector('.ps-search-hint');
                if (query && visibleCount === 0) {
                    if (!hint) {
                        hint = document.createElement('div');
                        hint.className = 'ps-search-hint';
                        hint.style.cssText = 'text-align:center;padding:16px;color:#8e8e93;font-size:13px';
                        const wrap = panel.querySelector('.ps-contacts-wrap');
                        if (wrap) wrap.appendChild(hint);
                    }
                    hint.textContent = 'No matching contacts';
                    hint.style.display = '';
                } else if (hint) {
                    hint.style.display = 'none';
                }
            });
        }

        // Wire up notification shade: tap status bar to toggle
        const shade = panel.querySelector('#ps-notif-shade');
        const shadeBg = shade ? shade.querySelector('.ps-notif-bg') : null;
        const statusbar = panel.querySelector('.ps-statusbar');

        if (statusbar && shade) {
            statusbar.style.cursor = 'pointer';
            statusbar.addEventListener('click', (e) => {
                e.stopPropagation();
                notifShadeOpen = !notifShadeOpen;
                if (notifShadeOpen) {
                    shade.classList.add('ps-notif-open');
                    shade.style.maxHeight = '';
                } else {
                    shade.classList.remove('ps-notif-open');
                    shade.style.maxHeight = '';
                }
            });
        }

        if (shadeBg) {
            shadeBg.addEventListener('click', () => {
                notifShadeOpen = false;
                shade.classList.remove('ps-notif-open');
                shade.style.maxHeight = '';
            });
        }

        // Pull-down gesture: track touches starting near the top of the panel
        if (shade) {
            // Clean up old listeners to prevent accumulation across renders
            if (panel._pdCleanup) {
                panel.removeEventListener('touchstart', panel._pdCleanup.start);
                panel.removeEventListener('touchmove', panel._pdCleanup.move);
                panel.removeEventListener('touchend', panel._pdCleanup.end);
            }

            let pdStartY = 0, pdPulling = false, pdShadeFull = 280;

            const onPdStart = (e) => {
                if (notifShadeOpen) return;
                const t = e.touches[0];
                const rect = panel.getBoundingClientRect();
                if (t.clientY - rect.top > 50) return;
                pdStartY = t.clientY;
                pdPulling = true;
                pdShadeFull = Math.min(280, rect.height * 0.7);
                shade.classList.add('ps-notif-dragging');
            };

            const onPdMove = (e) => {
                if (!pdPulling || notifShadeOpen) return;
                const dy = e.touches[0].clientY - pdStartY;
                if (dy < 8) return;
                const pct = Math.min(1, dy / pdShadeFull);
                shade.style.maxHeight = Math.round(pct * pdShadeFull) + 'px';
            };

            const onPdEnd = (e) => {
                if (!pdPulling) return;
                pdPulling = false;
                shade.classList.remove('ps-notif-dragging');
                const dy = (e.changedTouches[0]?.clientY || 0) - pdStartY;
                if (dy > pdShadeFull * 0.25) {
                    notifShadeOpen = true;
                    shade.classList.add('ps-notif-open');
                    shade.style.maxHeight = '';
                } else {
                    shade.style.maxHeight = '';
                }
            };

            panel.addEventListener('touchstart', onPdStart, { passive: true });
            panel.addEventListener('touchmove', onPdMove, { passive: false });
            panel.addEventListener('touchend', onPdEnd, { passive: true });
            panel._pdCleanup = { start: onPdStart, move: onPdMove, end: onPdEnd };
        }

        // Restore compose draft from module-level stash (survives view changes)
        if (composeDraft) {
            const input = panel.querySelector('#ps-input');
            if (input) { input.value = composeDraft; input.focus(); }
        }

        // Wire up close button once per render using the shared doClose handler
        const closeBtn = panel.querySelector('#ps-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('pointerdown', doClose, { passive: false });
        }

        // Wire up swipe-back gesture on the panel body
        const panelBody = panel.querySelector('.ps-body');
        if (panelBody) {
            let sx = 0, sy = 0, dx = 0, dy = 0, swiping = false;
            const onStart = (e) => {
                const t = e.touches?.[0] || e;
                sx = t.clientX;
                sy = t.clientY;
                dx = 0;
                dy = 0;
                swiping = false;
            };
            const onMove = (e) => {
                if (!sx) return;
                const t = e.touches?.[0] || e;
                dx = t.clientX - sx;
                dy = t.clientY - sy;
                if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                    swiping = true;
                }
            };
            const onEnd = () => {
                if (swiping && dx > 50) {
                    goBack();
                }
                sx = 0;
                sy = 0;
                swiping = false;
            };
            panelBody.removeEventListener('touchstart', onStart);
            panelBody.removeEventListener('touchmove', onMove);
            panelBody.removeEventListener('touchend', onEnd);
            panelBody.addEventListener('touchstart', onStart, { passive: true });
            panelBody.addEventListener('touchmove', onMove, { passive: true });
            panelBody.addEventListener('touchend', onEnd, { passive: true });
            // Mouse fallback for desktop testing
            panelBody.removeEventListener('pointerdown', onStart);
            panelBody.removeEventListener('pointerup', onEnd);
            panelBody.addEventListener('pointerdown', onStart, { passive: true });
            panelBody.addEventListener('pointerup', onEnd, { passive: true });
        }

        // Auto-scroll thread view to bottom
        if (state.view === 'thread') {
            const scroll = panel.querySelector('#ps-thread-scroll');
            if (scroll) {
                requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
            }
            // Auto-focus input + Enter key to send
            const input = panel.querySelector('#ps-input');
            if (input) {
                requestAnimationFrame(() => input.focus());
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const btn = panel.querySelector('button[data-act="send"]');
                        if (btn) {
                            btn.dispatchEvent(new Event('click', { bubbles: true }));
                        }
                    }
                });
            }
        }
    }

    // ─── Call Screen Timer ───────────────────────────────────────────
    let callTimerInterval = null;
    function startCallTimer() {
        stopCallTimer();
        callTimerInterval = setInterval(() => {
            const el = document.getElementById('ps-call-timer');
            if (!el || !state.activeCall || state.activeCall.status !== 'connected') {
                stopCallTimer();
                return;
            }
            const secs = Math.floor((Date.now() - state.activeCall.startTs) / 1000);
            el.textContent = formatCallTime(secs);
        }, 1000);
    }
    function stopCallTimer() {
        if (callTimerInterval) {
            clearInterval(callTimerInterval);
            callTimerInterval = null;
        }
    }
    function formatCallTime(totalSecs) {
        const m = Math.floor(totalSecs / 60);
        const s = totalSecs % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // ─── Call Screen ─────────────────────────────────────────────────
    function viewCallScreen() {
        const call = state.activeCall;
        if (!call) return `<p class="ps-empty">No active call.</p>`;
        const contact = state.contacts.find(c => c.id === call.contactId);
        const name = contact ? contact.name : (call.raw || 'Unknown');
        const number = contact ? contact.number : '';

        // Incoming call (NPC called you)
        if (call.status === 'incoming') {
            return `
                <div class="ps-call-screen">
                    <div class="ps-call-info">
                        <div class="ps-call-avatar">${escape(name[0] || '?')}</div>
                        <div class="ps-call-name">${escape(name)}</div>
                        <div class="ps-call-number">${escape(number)}</div>
                        <div class="ps-call-status ps-call-incoming">Incoming call…</div>
                    </div>
                    <div class="ps-call-controls">
                        <div class="ps-call-incoming-btns">
                            <button data-act="decline-call" class="ps-call-decline-btn">✕ Decline</button>
                            <button data-act="answer-call" class="ps-call-answer-btn">✅ Answer</button>
                        </div>
                    </div>
                </div>
            `;
        }

        // Call declined (NPC didn't answer)
        if (call.status === 'declined') {
            return `
                <div class="ps-call-screen">
                    <div class="ps-call-info">
                        <div class="ps-call-avatar">${escape(name[0] || '?')}</div>
                        <div class="ps-call-name">${escape(name)}</div>
                        <div class="ps-call-number">${escape(number)}</div>
                        <div class="ps-call-status ps-call-declined">Call declined</div>
                    </div>
                </div>
            `;
        }

        if (call.status === 'dialing') {
            return `
                <div class="ps-call-screen">
                    <div class="ps-call-info">
                        <div class="ps-call-avatar">${escape(name[0] || '?')}</div>
                        <div class="ps-call-name">${escape(name)}</div>
                        <div class="ps-call-number">${escape(number)}</div>
                        <div class="ps-call-status">Calling…</div>
                    </div>
                    <div class="ps-call-controls">
                        <button data-act="end-call" class="ps-call-end">${String.fromCodePoint(0x1F534)} End</button>
                    </div>
                </div>
            `;
        }

        // Connected
        const startSecs = call.startTs ? Math.floor((Date.now() - call.startTs) / 1000) : 0;
        // Collect spoken utterances during this call
        const utterances = state.callLog.filter(l => l.dir === 'speak' && l.contactId === call.contactId);
        const transcriptHtml = utterances.length ? utterances.map(u => {
            const who = u.fromMe ? 'You' : (contact ? contact.name : 'Them');
            return `<div class="ps-call-utterance"><b>${escape(who)}:</b> ${escape(u.text)}</div>`;
        }).join('') : '';
        return `
            <div class="ps-call-screen">
                <div class="ps-call-info">
                    <div class="ps-call-avatar">${escape(name[0] || '?')}</div>
                    <div class="ps-call-name">${escape(name)}</div>
                    <div class="ps-call-number">${escape(number)}</div>
                    <div class="ps-call-timer" id="ps-call-timer">${formatCallTime(startSecs)}</div>
                </div>
                <div class="ps-call-transcript" id="ps-call-transcript">${transcriptHtml}</div>
                <div class="ps-call-controls">
                    <div class="ps-call-controls-row">
                        <button data-act="call-mute" class="ps-call-ctrl-btn">
                            <span>🔇</span>
                            <small>Mute</small>
                        </button>
                        <button data-act="call-keypad" class="ps-call-ctrl-btn">
                            <span>🔢</span>
                            <small>Keypad</small>
                        </button>
                        <button data-act="call-speaker" class="ps-call-ctrl-btn">
                            <span>🔊</span>
                            <small>Speaker</small>
                        </button>
                    </div>
                    <button data-act="end-call" class="ps-call-end">${String.fromCodePoint(0x1F534)} End</button>
                </div>
                <div class="ps-call-compose">
                    <input id="ps-call-input" type="text" placeholder="Type what you say..." />
                    <button data-act="call-speak" class="ps-call-speak-btn">Speak</button>
                </div>
            </div>
        `;
    }

    // ─── Browser (lore-aware web search) ─────────────────────────────
    // Sanitize AI-generated HTML — strip scripts, events, dangerous attrs
    function sanitizeHtml(raw) {
        if (!raw) return '';
        return String(raw)
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
            .replace(/<object[\s\S]*?<\/object>/gi, '')
            .replace(/<embed[\s\S]*?<\/embed>/gi, '')
            .replace(/<meta[\s\S]*?>/gi, '')                         // strip meta (incl http-equiv refresh)
            .replace(/<link[\s\S]*?>/gi, '')                         // strip link/stylesheet tags
            .replace(/<base[\s\S]*?>/gi, '')                         // strip base tags
            .replace(/<form[\s\S]*?<\/form>/gi, '')                  // strip forms (could auto-submit)
            .replace(/<input[\s\S]*?>/gi, '')                        // strip all inputs (prevents autofocus)
            .replace(/<textarea[\s\S]*?<\/textarea>/gi, '')          // strip textareas
            .replace(/<select[\s\S]*?<\/select>/gi, '')              // strip selects
            .replace(/<button[\s\S]*?<\/button>/gi, '')              // strip buttons (conflict with data-act)
            .replace(/ on\w+\s*=\s*["'][^"']*["']/gi, '')
            .replace(/ on\w+\s*=\s*\S+/gi, '')
            .replace(/javascript\s*:/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/href\s*=\s*["']javascript:["']/gi, 'href="#"')
            .replace(/href\s*=\s*["']#["']/gi, 'href="#"')          // normalize empty hrefs
            .slice(0, 50000);
    }

    function viewBrowser() {
        const idx = state.browserIndex;
        const history = state.browserHistory;
        const currentPage = (idx >= 0 && idx < history.length) ? history[idx] : null;
        const canGoBack = idx > 0;
        const canGoForward = idx < history.length - 1;
        const currentUrl = state.browserUrl || (currentPage ? currentPage.url : '');
        const ctx = getCtx();

        let contentHtml = '';
        if (!currentPage) {
            // Landing page — search prompt
            contentHtml = `
                <div class="ps-browser-landing">
                    <div class="ps-browser-logo">🌐</div>
                    <p class="ps-browser-tagline">Search the world of ${escape(ctx?.name2 || 'your story')}</p>
                </div>
            `;
        } else {
            contentHtml = currentPage.html || '<p class="ps-browser-error">Page could not be loaded.</p>';
        }

        return `
            <div class="ps-browser">
                <div class="ps-browser-toolbar">
                    <button data-act="browser-back" class="ps-browser-navbtn" ${canGoBack ? '' : 'disabled'}>◀</button>
                    <button data-act="browser-forward" class="ps-browser-navbtn" ${canGoForward ? '' : 'disabled'}>▶</button>
                    <button data-act="browser-refresh" class="ps-browser-navbtn">⟳</button>
                </div>
                <div class="ps-browser-urlbar">
                    <input type="text" id="ps-browser-input" value="${escape(currentUrl)}" placeholder="Search or type a URL..." />
                    <button data-act="browser-go" class="ps-browser-gobtn">Go</button>
                </div>
                ${currentPage ? `<div class="ps-browser-title">${escape(currentPage.title || 'Untitled')}</div>` : ''}
                <div class="ps-browser-content" id="ps-browser-content">
                    ${contentHtml}
                </div>
            </div>
        `;
    }

    async function generateBrowserPage(query) {
        if (!query || !query.trim()) return;
        const q = query.trim();
        const ctx = getCtx();

        // Extract a brief setting description from the character card (NOT the name, NOT events)
        let setting = '';
        try {
            const chars = ctx?.characters;
            if (Array.isArray(chars) && chars.length > 0) {
                const ch = chars[0];
                const desc = (ch?.data?.description || '').trim().slice(0, 300);
                const scenario = (ch?.data?.scenario || '').trim().slice(0, 200);
                if (desc) setting = desc;
                else if (scenario) setting = scenario;
            }
        } catch (e) { /* ignore */ }

        const systemPrompt = `You are a search engine generating realistic HTML pages. Generate a standard search results page for the query: "${q}".

The page exists in a fictional setting with this general atmosphere (use sparingly — only for genre/tone, NOT for personalization):
${setting ? setting : 'A modern setting.'}

CRITICAL RULES:
- NEVER use or reference any person's name in the page title, results, or content.
- NEVER reference any specific characters, NPCs, or people.
- NEVER reference any events, conversations, or story moments.
- Output ONLY valid HTML — no markdown, no code fences, no explanation.
- Use a relevant <title>Page Title</title> that reflects the results — but NEVER include any person's name or character name in the title.
- Use clickable links with data-nav-url='...' attribute for navigation (e.g., <a data-nav-url='café reviews' href='#'>Café Reviews</a>).
- Make it look like a REAL, visually rich search results page — bold colors, backgrounds, icons/emojis, clear layout, modern styling.
- STRIPPED automatically (don't generate): script, iframe, object, embed, meta, link, base, form, input, textarea, select, button, and style tags. on* attributes and javascript: are also removed.
- EVERYTHING ELSE works fine: div, section, header, main, footer, h1-h6, p, ul/ol/li, a, img, table, figure, blockquote, code, pre, em, strong, small, br, hr, span, and inline style="..." attributes.
- Use rich inline styles — background colors, gradients, font sizes, padding, borders, border-radius, box-shadow, color, flexbox/display. Make it pop!
- Use emojis freely for icons and visual interest (🔍 📍 ⭐ 👍 📸 etc).
- Results must be generic, realistic, and setting-appropriate — NOT personalized to any individual.
- Maximum 4000 characters of HTML output.`;
        const userPrompt = `Generate a search results HTML page for: "${q}"`;

        const rawHtml = await callTurboApi(systemPrompt, userPrompt);
        if (!rawHtml) {
            // Fallback: simple error page
            return sanitizeHtml(`<html><title>Error</title><body style="padding:20px;font-family:sans-serif;background:#1c1c1e;color:#fff"><h2>Page unavailable</h2><p>The browser could not load results for "${escape(q)}".</p><p style="color:#8e8e93;font-size:12px">Check your API connection in Settings.</p></body></html>`);
        }

        // Extract title from AI output
        let title = q;
        const titleMatch = rawHtml.match(/<title>([^<]*)<\/title>/i);
        if (titleMatch) title = titleMatch[1].trim();

        const cleanHtml = sanitizeHtml(rawHtml);

        // Push to history
        if (state.browserIndex < state.browserHistory.length - 1) {
            // We navigated from somewhere in the middle — truncate forward history
            state.browserHistory = state.browserHistory.slice(0, state.browserIndex + 1);
        }
        state.browserHistory.push({ url: q, title, html: cleanHtml });
        state.browserIndex = state.browserHistory.length - 1;
        state.browserUrl = q;
        saveMeta();
        state.view = 'browser';
        render();
    }

    function viewHome() {
        // Real time + date (updates on each render)
        const now = new Date();
        const hours = now.getHours();
        const mins = String(now.getMinutes()).padStart(2, '0');
        const timeStr = `${hours}:${mins}`;
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const dateStr = `${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}`;

        // Color-aware: white text on dark wallpapers, dark on light
        const wpId = getWallpaperId();
        const darkWps = new Set(['dark','sunset','ocean','aurora','midnight','lavender','mint']);
        const isDarkWp = darkWps.has(wpId);
        const textColor = isDarkWp ? '#fff' : '#1c1c1e';
        const subColor = isDarkWp ? 'rgba(255,255,255,0.6)' : '#8e8e93';

        // Unread SMS count for Messages badge
        let unreadSms = 0;
        for (const [cid, thread] of Object.entries(state.threads)) {
            if (!Array.isArray(thread)) continue;
            const last = thread[thread.length - 1];
            if (last && last.from === 'them') unreadSms++;
        }

        return `
            <div class="ps-home">
                <div class="ps-wallpaper" style="${getWallpaperStyle()}">
                    <div class="ps-time-large" style="color:${textColor}">${timeStr}</div>
                    <div class="ps-date-large" style="color:${subColor}">${dateStr}</div>
                    <div class="ps-app-grid">
                        <div class="ps-app" style="background:linear-gradient(135deg,#86efac,#4ade80)" data-act="nav" data-view="dial">
                            <span class="ps-app-icon">📞</span>
                            <span class="ps-app-label" style="color:${textColor}">Phone</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#fda4af,#fb7185)" data-act="nav" data-view="sms">
                            <span class="ps-app-icon">💬</span>
                            <span class="ps-app-label" style="color:${textColor}">Messages</span>
                            ${unreadSms > 0 ? `<span class="ps-badge">${unreadSms > 99 ? '99+' : unreadSms}</span>` : ''}
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#93c5fd,#60a5fa)" data-act="nav" data-view="contacts">
                            <span class="ps-app-icon">👥</span>
                            <span class="ps-app-label" style="color:${textColor}">Contacts</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#fcd34d,#fbbf24)" data-act="nav" data-view="albums">
                            <span class="ps-app-icon">🎨</span>
                            <span class="ps-app-label" style="color:${textColor}">Wallpapers</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#d8b4fe,#c084fc)" data-act="nav" data-view="settings">
                            <span class="ps-app-icon">⚙️</span>
                            <span class="ps-app-label" style="color:${textColor}">Settings</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#bae6fd,#7dd3fc)" data-act="nav" data-view="browser">
                            <span class="ps-app-icon">🌐</span>
                            <span class="ps-app-label" style="color:${textColor}">Browser</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#38bdf8,#0ea5e9)" data-act="nav" data-view="chirp">
                            <span class="ps-app-icon">🐦</span>
                            <span class="ps-app-label" style="color:${textColor}">Chirp</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#fecaca,#f87171)" data-act="nav" data-view="favorites">
                            <span class="ps-app-icon">❤️</span>
                            <span class="ps-app-label" style="color:${textColor}">Favorites</span>
                        </div>
                        <div class="ps-app" style="background:linear-gradient(135deg,#818cf8,#6366f1)" data-act="nav" data-view="memories">
                            <span class="ps-app-icon">🧠</span>
                            <span class="ps-app-label" style="color:${textColor}">Memories</span>
                        </div>
                    </div>
                    <div class="ps-page-dots">
                        <span class="ps-page-dot active"></span>
                        <span class="ps-page-dot"></span>
                    </div>
                    <div class="ps-dock">
                        <div class="ps-dock-app" data-act="nav" data-view="dial">
                            <span class="ps-dock-app-icon">📞</span>
                            <span class="ps-dock-app-label" style="color:${textColor}">Phone</span>
                        </div>
                        <div class="ps-dock-app" data-act="nav" data-view="sms">
                            <span class="ps-dock-app-icon">💬</span>
                            <span class="ps-dock-app-label" style="color:${textColor}">Messages</span>
                            ${unreadSms > 0 ? `<span class="ps-badge">${unreadSms > 99 ? '99+' : unreadSms}</span>` : ''}
                        </div>
                        <div class="ps-dock-app" data-act="nav" data-view="browser">
                            <span class="ps-dock-app-icon">🌐</span>
                            <span class="ps-dock-app-label" style="color:${textColor}">Browser</span>
                        </div>
                    </div>
                    <p class="ps-hint">Swipe right to go back</p>
                </div>
            </div>
        `;
    }

    // ─── Chirp (social media feed) ────────────────────────────────────
    function viewChirp() {
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const contactNames = new Set(state.contacts.map(c => c.name.toLowerCase()));
        return `
            <div class="ps-chirp" style="display:flex;flex-direction:column;height:100%;background:#15202b;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #2f3336;backdrop-filter:blur(10px);background:rgba(21,32,43,0.85)">
                    <h2 style="margin:0;font-size:18px;font-weight:700">🐦 Chirp</h2>
                    <div style="display:flex;gap:8px">
                        <button data-act="chirp-refresh" style="background:#1d9bf0;color:#fff;border:none;border-radius:9999px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer">⟳ Refresh</button>
                        <button data-act="chirp-compose" style="background:#1d9bf0;color:#fff;border:none;border-radius:9999px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer">+ Chirp</button>
                    </div>
                </div>
                <div style="flex:1;overflow-y:auto;padding:8px 0">
                    ${posts.length ? posts.map(p => renderChirpPost(p, contactNames)).join('\n') : '<div style="text-align:center;padding:40px 16px;color:#71767b;font-size:14px">No posts yet. Tap Refresh to load the feed!<br><span style="font-size:12px;color:#536471">Or tap + Chirp to post something</span></div>'}
                </div>
            </div>
        `;
    }

    function renderChirpPost(p, contactNames) {
        const isContact = p.author && contactNames.has(p.author.name.toLowerCase());
        const isUserPost = p.author?.isUser;
        const likeCount = Array.isArray(p.likedBy) ? p.likedBy.length : (p.likes || 0);
        const commentCount = Array.isArray(p.comments) ? p.comments.length : 0;
        const borderStyle = isContact ? '2px solid #1d9bf0' : '1px solid #2f3336';
        return `
            <div style="padding:12px 16px;border-bottom:1px solid #2f3336;border-left:${borderStyle};cursor:pointer" data-act="chirp-view-thread" data-chirp-id="${p.id}">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <span style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${isContact ? '#1d9bf0,#0ea5e9' : '#36d399,#059669'});color:#fff;font-size:14px;font-weight:600;flex-shrink:0">${(p.author?.name || '?')[0]}</span>
                    <div style="flex:1;min-width:0">
                        <div style="font-size:14px;font-weight:600;color:#e7e9ea;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escape(p.author?.name || 'Unknown')}${isContact ? '<span style="color:#1d9bf0;font-size:10px;margin-left:4px">★ Contact</span>' : ''}</div>
                        <div style="font-size:12px;color:#71767b">@${escape(p.author?.handle || 'unknown')}</div>
                    </div>
                    <div style="font-size:11px;color:#536471;white-space:nowrap">${formatChirpTime(p.ts)}</div>
                    ${isUserPost ? `<button data-act="chirp-delete" data-chirp-id="${p.id}" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;padding:2px 6px" title="Delete">🗑️</button>` : ''}
                </div>
                <div style="font-size:14px;line-height:1.4;color:#e7e9ea;margin-bottom:8px;white-space:pre-wrap">${formatChirpText(p.text)}</div>
                ${p.imageUrl ? `<img src="${p.imageUrl}" style="width:100%;max-height:300px;object-fit:cover;border-radius:12px;margin-bottom:8px" loading="lazy" alt="Post image" onerror="this.style.display='none'" />` : ''}
                <div style="display:flex;gap:24px;font-size:12px;color:#71767b">
                    <button data-act="chirp-like" data-chirp-id="${p.id}" style="background:none;border:none;color:#71767b;cursor:pointer;font-size:12px;padding:4px 8px;border-radius:9999px">❤️ ${likeCount}</button>
                    <button data-act="chirp-view-thread" data-chirp-id="${p.id}" style="background:none;border:none;color:#71767b;cursor:pointer;font-size:12px;padding:4px 8px;border-radius:9999px">💬 ${commentCount}</button>
                </div>
            </div>
        `;
    }

    function viewChirpThread() {
        const postId = state.activeContact || ''; // reuse activeContact to store selected post ID
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const p = posts.find(x => x.id === postId);
        if (!p) return '<div style="text-align:center;padding:40px;color:#71767b;background:#15202b;height:100%">Post not found.</div>';
        const comments = Array.isArray(p.comments) ? p.comments : [];
        const contactNames = new Set(state.contacts.map(c => c.name.toLowerCase()));
        return `
            <div style="display:flex;flex-direction:column;height:100%;background:#15202b;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,sans-serif">
                <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #2f3336;backdrop-filter:blur(10px);background:rgba(21,32,43,0.85)">
                    <button data-act="nav" data-view="chirp" style="background:none;border:none;color:#1d9bf0;font-size:16px;cursor:pointer;padding:4px">← Back</button>
                    <h3 style="margin:0;font-size:16px;font-weight:600">Post</h3>
                </div>
                <div style="flex:1;overflow-y:auto;padding:8px 0">
                    ${renderChirpPost(p, contactNames)}
                    <div style="border-bottom:1px solid #2f3336"></div>
                    <div style="padding:12px 16px;border-bottom:1px solid #2f3336">
                        <textarea id="ps-chirp-comment-input" placeholder="Reply to this post..." style="width:100%;background:#1e2732;border:1px solid #2f3336;border-radius:8px;padding:8px;color:#e7e9ea;font-size:13px;resize:none;min-height:60px;font-family:inherit"></textarea>
                        <button data-act="chirp-comment-submit" data-chirp-id="${p.id}" style="margin-top:6px;background:#1d9bf0;color:#fff;border:none;border-radius:9999px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer">Reply</button>
                    </div>
                    ${comments.length ? comments.map(c => renderChirpComment(c, contactNames)).join('\n') : '<div style="text-align:center;padding:20px;color:#536471;font-size:13px">No replies yet. Be the first to reply!</div>'}
                </div>
            </div>
        `;
    }

    function renderChirpComment(c, contactNames) {
        const isContact = c.author && contactNames.has(c.author.name.toLowerCase());
        return `
            <div style="padding:10px 16px;border-bottom:1px solid #2f3336">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
                    <span style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${isContact ? '#1d9bf0,#0ea5e9' : '#8b5cf6,#6366f1'});color:#fff;font-size:10px;font-weight:600;flex-shrink:0">${(c.author?.name || '?')[0]}</span>
                    <span style="font-size:13px;font-weight:600;color:#e7e9ea">${escape(c.author?.name || 'Unknown')}</span>
                    <span style="font-size:11px;color:#536471">@${escape(c.author?.handle || 'unknown')}</span>
                    <span style="font-size:11px;color:#536471;margin-left:auto">${formatChirpTime(c.ts)}</span>
                </div>
                <div style="font-size:13px;color:#e7e9ea;margin-left:30px;white-space:pre-wrap">${formatChirpText(c.text)}</div>
            </div>
        `;
    }

    function formatChirpTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const now = new Date();
        const diff = (now - d) / 1000;
        if (diff < 60) return 'now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    function formatChirpText(text) {
        if (!text) return '';
        const escaped = escape(text);
        return escaped.replace(/@(\w+)/g, '<span style="color:#1d9bf0">@$1</span>');
    }

    function viewContacts(favoritesOnly) {
        if (!state.contacts.length) {
            return `<div class="ps-empty-state">
                <div class="ps-empty-icon">👥</div>
                <p>No Contacts</p>
                <span>NPCs appear here automatically when they speak in chat, or tap + to add one manually.</span>
                <button data-act="add-contact" class="ps-add-btn">+ Add Contact</button>
            </div>`;
        }
        // Filter for favorites if requested
        let pool = favoritesOnly
            ? state.contacts.filter(c => c.starred)
            : [...state.contacts];
        if (favoritesOnly && !pool.length) {
            return `<div class="ps-empty-state">
                <div class="ps-empty-icon">⭐</div>
                <p>No Favorites</p>
                <span>Tap the ★ on a contact's profile to add them here.</span>
            </div>`;
        }
        // Sort alphabetically and group by first letter
        const sorted = [...pool].sort((a, b) => a.name.localeCompare(b.name));
        const groups = {};
        for (const c of sorted) {
            const letter = c.name[0].toUpperCase();
            if (!groups[letter]) groups[letter] = [];
            groups[letter].push(c);
        }
        const sectionCount = Object.keys(groups).length;
        const sections = Object.entries(groups).map(([letter, contacts]) => `
            <div class="ps-contact-section" data-section="${letter}">
                <div class="ps-contact-section-header">${letter}</div>
                ${contacts.map(c => `
                    <div class="ps-contact-row" data-act="open-thread" data-id="${c.id}" data-search-name="${escape(c.name.toLowerCase())}">
                        <div class="ps-avatar-sm" style="background:${avatarGradient(c.name)}">${avatarInitial(c.name)}</div>
                        <div class="ps-contact-row-info">
                            <span class="ps-contact-row-name">${c.starred ? '★ ' : ''}${escape(c.name)}</span>
                            ${c.number ? `<span class="ps-contact-row-num">${escape(c.number)}</span>` : ''}
                        </div>
                        <button data-act="open-thread" data-id="${c.id}" class="ps-contact-call-btn" title="Message" style="margin-right:6px">💬</button>
                        <button data-act="call" data-id="${c.id}" class="ps-contact-call-btn" title="Call">📞</button>
                    </div>
                `).join('')}
            </div>
        `).join('');

        return `<div class="ps-contacts-wrap">
            ${!favoritesOnly ? `<div class="ps-contacts-search">
                <span>🔍</span>
                <input type="text" id="ps-contact-search" placeholder="Search" autocomplete="off" style="flex:1;border:none;outline:none;background:transparent;font-size:15px;color:#1c1c1e">
            </div>` : ''}
            ${sections}
            <div style="padding:12px;text-align:center">
                <button data-act="add-contact" class="ps-add-btn">+ Add Contact</button>
            </div>
        </div>`;
    }

    function avatarGradient(name) {
        // Deterministic gradient from name — same name always gets same color
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const h1 = Math.abs(hash % 360);
        const h2 = (h1 + 40) % 360;
        return `linear-gradient(135deg, hsl(${h1},65%,55%), hsl(${h2},65%,45%))`;
    }
    function avatarInitial(name) { return (name || '?')[0].toUpperCase(); }

    function viewSmsList() {
        const ids = Object.keys(state.threads);
        if (!ids.length) {
            return `
                <div class="ps-sms-search">
                    <span class="ps-sms-search-icon">🔍</span> Search
                </div>
                <p class="ps-empty">No Messages</p>
            `;
        }
        // Sort threads by most recent message
        ids.sort((a, b) => {
            const ta = state.threads[a]?.slice(-1)[0]?.ts || 0;
            const tb = state.threads[b]?.slice(-1)[0]?.ts || 0;
            return tb - ta;
        });
        return `
            <div class="ps-sms-search">
                <span class="ps-sms-search-icon">🔍</span> Search
            </div>
            <div class="ps-sms-header-row">
                <button class="ps-sms-edit-btn">Edit</button>
                <button class="ps-sms-compose-btn" data-act="open-thread" data-id="_new" title="New Message">✎</button>
            </div>
            <ul class="ps-sms-list">
                ${ids.map(id => {
                    const c = state.contacts.find(x => x.id === id);
                    const name = c?.name || id;
                    const last = state.threads[id]?.slice(-1)[0];
                    const lastPreview = last?.imageUrl ? '📷 Photo' : (last?.text || '');
                    const time = last?.ts ? new Date(last.ts).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '';
                    // Count unseen NPC messages (last message from 'them' and not yet seen)
                    const lastMsg = state.threads[id]?.slice(-1)[0];
                    const hasUnread = lastMsg && lastMsg.from === 'them' && !lastMsg.seen;
                    return `
                        <li data-act="open-thread" data-id="${id}">
                            <div class="ps-sms-avatar" style="background:${avatarGradient(name)}">${avatarInitial(name)}</div>
                            <div class="ps-sms-body">
                                <div class="ps-sms-name">${escape(name)}</div>
                                <div class="ps-sms-preview">${escape(lastPreview)}</div>
                            </div>
                            <span class="ps-sms-time">${time}</span>
                            ${hasUnread ? '<span class="ps-sms-unread"></span>' : ''}
                            <button data-act="delete-thread" data-id="${id}" type="button" class="ps-sms-delete" title="Delete conversation">×</button>
                        </li>
                    `;
                }).join('')}
            </ul>
        `;
    }

    function viewThread() {
        const c = state.contacts.find(x => x.id === state.activeContact);
        if (!c) return viewSmsList();
        const msgs = state.threads[c.id] || [];
        const isTyping = state.typingContactId === c.id;

        // Format time: "2:34 PM"
        const fmtTime = ts => {
            const d = new Date(ts);
            return d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
        };
        // Date divider label: "Today", "Yesterday", or "May 20"
        const fmtDate = ts => {
            const d = new Date(ts);
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const diff = (today - msgDay) / 86400000;
            if (diff === 0) return 'Today';
            if (diff === 1) return 'Yesterday';
            return d.toLocaleDateString([], { month:'short', day:'numeric' });
        };

        // Build message list with date dividers
        let lastDate = '';
        const msgHtml = msgs.map((m, i) => {
            const curDate = fmtDate(m.ts);
            const divider = curDate !== lastDate ? `<div class="ps-date-divider">${curDate}</div>` : '';
            lastDate = curDate;
            const time = fmtTime(m.ts);
            const isImage = !!m.imageUrl;
            return `
                ${divider}
                <div class="ps-msg ps-${m.from}${isImage ? ' ps-msg-img' : ''}">
                    ${isImage
                        ? `<img src="${m.imageUrl}" style="max-width:100%;max-height:240px;border-radius:8px;display:block" loading="lazy" alt="Photo" />`
                        : escape(m.text || '')}
                    <button data-act="delete-msg" data-id="${c.id}" data-msg-index="${i}" type="button" class="ps-msg-del" title="Delete message">×</button>
                </div>
                <span class="ps-msg-time ${m.from}">${time}</span>
            `;
        }).join('');

        // iMessage-style read receipt for the LAST user message
        let receipt = '';
        const lastMeMsg = msgs.reduce((acc, m, i) => m.from === 'me' ? { index: i, msg: m } : acc, null);
        if (lastMeMsg) {
            const seenTime = lastMeMsg.msg.seen
                ? new Date(lastMeMsg.msg.ts).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
                : '';
            receipt = lastMeMsg.msg.seen
                ? `<div class="ps-receipt ps-seen">Seen ${seenTime}</div>`
                : '<div class="ps-receipt">Delivered</div>';
        }

        return `
            <div class="ps-thread-head">
                <button data-act="nav" data-view="sms">←</button>
                <div class="ps-avatar-sm" style="background:${avatarGradient(c.name)}">${avatarInitial(c.name)}</div>
                <div style="flex:1;text-align:left;margin-left:8px">
                    <b style="color:#f2f2f7;font-size:15px">${escape(c.name)}</b>
                    ${isTyping ? '<div style="font-size:11px;color:#34c759">typing…</div>' : ''}
                </div>
                <div class="ps-thread-actions">
                    <button data-act="toggle-star" data-id="${c.id}" title="${c.starred ? 'Unstar' : 'Star'}" style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px 6px">${c.starred ? '★' : '☆'}</button>
                    <button data-act="open-profile" data-id="${c.id}" title="Contact Profile">📋</button>
                    <button data-act="call" data-id="${c.id}">📞</button>
                    <button data-act="delete-thread" data-id="${c.id}" type="button" title="Delete conversation" style="background:rgba(255,69,58,0.15);color:#ff453a;border:none;border-radius:50%;width:34px;height:34px;font-size:16px;cursor:pointer">🗑️</button>
                </div>
            </div>
            <div class="ps-thread" id="ps-thread-scroll">
                ${msgHtml}
                ${isTyping ? `
                <div class="ps-typing">
                    <span></span><span></span><span></span>
                </div>` : ''}
                ${receipt}
            </div>
            <div class="ps-compose">
                <button data-act="attach-image" type="button" class="ps-compose-camera" title="Send Photo">📷</button>
                <input id="ps-input" type="text" placeholder="Message…" />
                <button data-act="send">Send</button>
            </div>
        `;
    }

    
    function viewMemories() {
        // Collect all memories across all contacts, sorted by recency
        const allMemories = [];
        for (const c of state.contacts) {
            if (!Array.isArray(c.memories)) continue;
            for (const m of c.memories) {
                allMemories.push({ ...m, contactId: c.id, contactName: c.name });
            }
        }
        allMemories.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const mems = allMemories.slice(0, 100);
        return `
            <div style="padding:12px;color:#1c1c1e;flex:1;overflow-y:auto">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
                    <h3 style="margin:0;font-size:15px;color:#1c1c1e">All Memories</h3>
                    <button data-act="scan-memories" style="background:#007aff;color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">🔄 Scan Chat</button>
                </div>
                <div id="ps-scan-status" style="font-size:12px;color:#007aff;text-align:center;margin-bottom:8px;min-height:18px"></div>
                ${mems.length ? mems.map(m => {
                    const dt = m.ts ? new Date(m.ts).toLocaleDateString() : '';
                    const tags = Array.isArray(m.tags) ? m.tags : [];
                    return `
                        <div style="background:#f2f2f7;border-radius:10px;padding:10px;margin-bottom:8px;position:relative">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start">
                                <span style="font-size:11px;color:#007aff;font-weight:600">${escape(m.contactName)}</span>
                                <div style="display:flex;gap:4px">
                                    <button data-act="edit-memory" data-cid="${m.contactId}" data-ts="${m.ts}" style="background:transparent;border:none;font-size:12px;cursor:pointer;color:#007aff;padding:2px">✏️</button>
                                    <button data-act="delete-memory" data-cid="${m.contactId}" data-ts="${m.ts}" style="background:transparent;border:none;font-size:12px;cursor:pointer;color:#ff3b30;padding:2px">🗑️</button>
                                </div>
                            </div>
                            <p style="margin:4px 0;font-size:13px;color:#1c1c1e" data-mem-text="${m.ts}">${escape(m.text)}</p>
                            ${dt ? `<span style="font-size:10px;color:#8e8e93">${dt}</span>` : ''}
                            ${tags.length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${tags.map(t => `<span style="background:#e5e5ea;border-radius:4px;padding:2px 6px;font-size:10px;color:#3a3a3c">${escape(t)}</span>`).join('')}</div>` : ''}
                        </div>
                    `;
                }).join('') : '<p style="font-size:13px;color:#8e8e93;text-align:center;padding:40px 0">No memories yet. Tap 🔄 Scan Chat to extract memories from your conversations.</p>'}
            </div>
        `;
    }

function viewRecents() {
        // Filter for meaningful call log entries
        const entries = (state.callLog || []).filter(e =>
            e.dir === 'in' || e.dir === 'out' || e.dir === 'missed' || e.dir === 'declined'
        ).slice(-30).reverse();

        // Merge voicemails into the list
        const vmEntries = (state.voicemails || []).map(vm => ({
            ...vm,
            isVoicemail: true,
            ts: vm.ts,
            dir: 'voicemail'
        }));

        const allEntries = [...vmEntries, ...entries]
            .sort((a, b) => (b.ts || 0) - (a.ts || 0))
            .slice(0, 30);

        if (!allEntries.length) {
            return '<div class="ps-empty-state"><div class="ps-empty-icon">📞</div><p>No Recent Calls</p><span>Your call history will appear here.</span></div>';
        }

        const fmtTime = ts => {
            const d = new Date(ts);
            const now = new Date();
            const isToday = d.toDateString() === now.toDateString();
            if (isToday) return d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
            return d.toLocaleDateString([], { month:'short', day:'numeric' }) + ' ' + d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
        };

        return '<div class="ps-recents-list">' + allEntries.map(e => {
            const c = state.contacts.find(x => x.id === e.contactId);
            const name = c?.name || 'Unknown';
            let icon, label;
            if (e.isVoicemail) {
                icon = '🎙️'; label = 'Voicemail';
            } else if (e.dir === 'in') {
                icon = '↙'; label = 'Incoming';
            } else if (e.dir === 'out') {
                icon = '↗'; label = 'Outgoing';
            } else {
                icon = '✗'; label = 'Missed';
            }
            const missed = e.dir === 'missed' || e.dir === 'declined';
            const unreadVm = e.isVoicemail && !e.heard;

            return `<div class="ps-recent-row${unreadVm ? ' ps-recent-unread' : ''}" data-act="${e.isVoicemail ? 'play-voicemail' : 'call'}" data-id="${e.contactId}"${e.isVoicemail ? ' data-vm-ts="' + e.ts + '"' : ''}>
                <div class="ps-avatar-sm" style="background:${avatarGradient(name)}">${avatarInitial(name)}</div>
                <div class="ps-recent-info">
                    <span class="ps-recent-name">${escape(name)}${unreadVm ? ' 🔴' : ''}</span>
                    <span class="ps-recent-label" style="color:${missed ? '#ff3b30' : '#8e8e93'}">${icon} ${label}${e.duration ? ' · ' + Math.floor(e.duration / 60) + 'm ' + (e.duration % 60) + 's' : ''}</span>
                </div>
                <span class="ps-recent-time">${fmtTime(e.ts)}</span>
            </div>`;
        }).join('') + '</div>';
    }

function viewDial() {
        const tab = state.dialTab || 'keypad';
        const vmCount = (state.voicemails || []).filter(v => !v.heard).length;

        if (tab === 'recents') {
            return `<div class="ps-dial-tabs">
                <button data-act="dial-tab" data-tab="keypad" class="ps-dial-tab">Keypad</button>
                <button data-act="dial-tab" data-tab="recents" class="ps-dial-tab active">Recents${vmCount ? ' 🔴' : ''}</button>
            </div>
            ${viewRecents()}`;
        }

        const keys = [
            { k: '1', sub: '' },    { k: '2', sub: 'ABC' },  { k: '3', sub: 'DEF' },
            { k: '4', sub: 'GHI' },  { k: '5', sub: 'JKL' },  { k: '6', sub: 'MNO' },
            { k: '7', sub: 'PQRS' }, { k: '8', sub: 'TUV' },  { k: '9', sub: 'WXYZ' },
            { k: '*', sub: '' },     { k: '0', sub: '+' },     { k: '#', sub: '' },
        ];
        const display = state.dialBuf || '';
        return `
            <div class="ps-dial-tabs">
                <button data-act="dial-tab" data-tab="keypad" class="ps-dial-tab active">Keypad</button>
                <button data-act="dial-tab" data-tab="recents" class="ps-dial-tab">Recents${vmCount ? ' 🔴' : ''}</button>
            </div>
            <div class="ps-dial">
                <div class="ps-dial-display">${display ? escape(display) : '<span class="ps-dial-placeholder">Enter number</span>'}</div>
                <div class="ps-dial-pad">
                    ${keys.map(k => `
                        <button class="ps-dial-key" data-act="key" data-k="${k.k}">
                            <span class="ps-dial-key-num">${k.k}</span>
                            ${k.sub ? `<span class="ps-dial-key-sub">${k.sub}</span>` : '<span class="ps-dial-key-sub">&nbsp;</span>'}
                        </button>
                    `).join('')}
                </div>
                <div class="ps-dial-actions">
                    <button data-act="dial-clear" class="ps-dial-action-btn" title="Delete">⌫</button>
                    <button data-act="dial-call" class="ps-dial-call-btn">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.01-.24 11.36 11.36 0 003.58.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.58 1 1 0 01-.25 1.01l-2.2 2.2z"/></svg>
                    </button>
                </div>
            </div>
        `;
    }

    function viewSettings() {
        const s = window.PhoneSocialSettings || {
            apiUrl: 'https://api.openai.com/v1',
            apiKey: '',
            model: 'gpt-4o-mini',
            systemPromptTemplate: 'You are {char}, responding via text message. Keep replies short and in character.'
        };
        const behaviorEntries = [
            {
                key: 'autoHarvest',
                label: 'Auto-harvest NPCs',
                desc: 'Scan new chat messages and automatically add named characters to Contacts.',
            },
            {
                key: 'autoReplies',
                label: 'LLM auto-replies',
                desc: 'When you text a contact, generates replies via your custom API below (or ST\'s LLM as fallback). Knows your contacts from the chat context.',
            },
            {
                key: 'openOnChat',
                label: 'Open panel on chat load',
                desc: 'Whenever you swap to a new chat, pop the phone open automatically.',
            },
            {
                key: 'ttsEnabled',
                label: '🔊 TTS notifications',
                desc: 'Read incoming SMS and calls aloud using ST\'s built-in TTS system.',
            },
            {
                key: 'toastrEnabled',
                label: '🔔 Toastr popups',
                desc: 'Show on-screen notifications for incoming SMS and calls.',
            },
        ];
        const toggles = behaviorEntries.map(item => {
            const value = !!state.settings[item.key];
            return `
                <div class="ps-setting-row">
                    <div>
                        <b>${item.label}</b>
                        <span>${item.desc}</span>
                    </div>
                    <button data-act="toggle-setting" data-key="${item.key}" class="ps-setting-toggle ${value ? 'on' : ''}">${value ? 'ON' : 'OFF'}</button>
                </div>
            `;
        }).join('');
        return `
            <div class="ps-settings" style="padding:12px">
                <h3 style="margin:0 0 12px; color:#581c87">SMS API (separate from main chat)</h3>
                <p style="margin:0 0 12px; font-size:11px; color:#8e8e93">Leave API Key empty to use ST's built-in model instead.</p>
                <label style="display:block; margin:8px 0 4px; font-size:12px">API URL</label>
                <input type="text" id="ps-set-url" value="${s.apiUrl || 'https://api.openai.com/v1'}" style="width:100%; padding:8px; border-radius:8px; border:1px solid #d8b4fe">
                <label style="display:block; margin:8px 0 4px; font-size:12px">API Key</label>
                <input type="password" id="ps-set-key" value="${s.apiKey}" style="width:100%; padding:8px; border-radius:8px; border:1px solid #d8b4fe">
                <label style="display:block; margin:8px 0 4px; font-size:12px">Model</label>
                <input type="text" id="ps-set-model" value="${s.model}" style="width:100%; padding:8px; border-radius:8px; border:1px solid #d8b4fe">
                <label style="display:block; margin:8px 0 4px; font-size:12px">System Prompt (use {char})</label>
                <textarea id="ps-set-prompt" style="width:100%; height:80px; padding:8px; border-radius:8px; border:1px solid #d8b4fe">${s.systemPromptTemplate}</textarea>
                <button data-act="save-settings" style="margin-top:12px; background:#a855f7; color:white; border:none; padding:10px 16px; border-radius:12px">Save Settings</button>
                <div id="ps-settings-status" style="margin-top:8px; font-size:12px; color:#4ade80"></div>
                <hr style="margin:16px 0; border:none; border-top:1px solid #e9d5ff">
                <h3 style="margin:0 0 12px; color:#581c87">Notifications</h3>
                <p style="margin:0 0 8px; font-size:11px; color:#8e8e93">TTS uses ST's built-in TTS engine — enable it in Extension → Text-to-Speech and assign voices to characters. Toastr popups work instantly.</p>
                ${toggles}
                <div class="ps-setting-actions" style="margin-top:12px">
                    <button data-act="harvest-now">Harvest NPCs now</button>
                    <button data-act="reset-settings">Reset defaults</button>
                    <button data-act="reset-chat-data" style="background:#ff3b30;color:#fff;border:none;padding:10px 16px;border-radius:12px;margin-top:8px">🗑️ Reset All Contacts & Threads</button>
                </div>
            </div>
        `;
    }

    const WALLPAPERS = [
        { id: 'default', name: 'Default Light', css: 'background:#f2f2f7' },
        { id: 'dark', name: 'Dark', css: 'background:#1c1c1e; color:#fff' },
        { id: 'sunset', name: 'Sunset', css: 'background:linear-gradient(135deg,#ff6b6b,#ffa500,#ffd93d)' },
        { id: 'ocean', name: 'Ocean', css: 'background:linear-gradient(135deg,#0f2027,#203a43,#2c5364)' },
        { id: 'aurora', name: 'Aurora', css: 'background:linear-gradient(135deg,#0a0a2e,#1a1a4e,#3a1c71)' },
        { id: 'forest', name: 'Forest', css: 'background:linear-gradient(135deg,#134e5e,#71b280)' },
        { id: 'blush', name: 'Blush', css: 'background:linear-gradient(135deg,#dd5e89,#f7bb97)' },
        { id: 'midnight', name: 'Midnight', css: 'background:linear-gradient(135deg,#000428,#004e92)' },
        { id: 'lavender', name: 'Lavender', css: 'background:linear-gradient(135deg,#8a2387,#e94057,#f27121)' },
        { id: 'mint', name: 'Mint', css: 'background:linear-gradient(135deg,#00b4db,#0083b0)' },
    ];

    function getWallpaperStyle() {
        const s = window.PhoneSocialSettings || {};
        const wp = s.wallpaper || 'default';
        if (wp === 'custom' && s.customWallpaper) {
            return `background-image:url(${s.customWallpaper});background-size:cover;background-position:center;background-repeat:no-repeat;`;
        }
        const preset = WALLPAPERS.find(w => w.id === wp) || WALLPAPERS[0];
        return preset.css;
    }

    function getWallpaperId() {
        const s = window.PhoneSocialSettings || {};
        return s.wallpaper || 'default';
    }

    function saveWallpaperGlobally(id, customDataUrl) {
        const ctx = getCtx();
        window.PhoneSocialSettings = window.PhoneSocialSettings || {};
        window.PhoneSocialSettings.wallpaper = id;
        if (customDataUrl) {
            window.PhoneSocialSettings.customWallpaper = customDataUrl;
        } else if (id !== 'custom') {
            delete window.PhoneSocialSettings.customWallpaper;
        }
        // Persist via ST extension settings
        if (ctx?.extensionSettings) {
            ctx.extensionSettings[EXT_NAME] = window.PhoneSocialSettings;
            try { ctx.saveSettingsDebounced?.(); } catch (_) { /* ignore */ }
        }
        if (window.extension_settings) {
            window.extension_settings.PhoneSocial = window.PhoneSocialSettings;
        }
    }

    
    function viewProfile() {
        const id = state.activeContact;
        const c = state.contacts.find(x => x.id === id);
        if (!c) return `<p class="ps-empty">Contact not found.</p>`;
        const mems = Array.isArray(c.memories) && c.memories.length ? c.memories : [];
        return `
            <div class="ps-thread-head">
                <button data-act="nav" data-view="contacts">←</button>
                <b>${escape(c.name)}</b>
                <button data-act="toggle-star" data-id="${escape(c.id)}" style="background:none;border:none;font-size:20px;cursor:pointer;padding:4px 8px">${c.starred ? '★' : '☆'}</button>
            </div>
            <div style="padding:12px;color:#1c1c1e;flex:1;overflow-y:auto">
                <p style="margin:0 0 4px;font-size:12px;color:#8e8e93">${escape(c.number)}</p>
                <p style="margin:0 0 12px;font-size:11px;color:#8e8e93">Source: ${escape(c.source)}</p>
                <hr style="border:none;border-top:1px solid #e5e5ea;margin:8px 0">
                <h4 style="margin:0 0 8px;font-size:13px;color:#1c1c1e">Memories</h4>
                ${mems.length ? mems.map(m => `
                    <div style="background:#f2f2f7;border-radius:10px;padding:10px;margin-bottom:8px">
                        <p style="margin:0 0 4px;font-size:13px;color:#1c1c1e">${escape(m.text)}</p>
                        <div style="display:flex;gap:4px;flex-wrap:wrap">
                            ${Array.isArray(m.tags) ? m.tags.map(t => `<span style="background:#e5e5ea;border-radius:4px;padding:2px 6px;font-size:10px;color:#3a3a3c">${escape(t)}</span>`).join('') : ''}
                        </div>
                    </div>
                `).join('') : '<p style="font-size:12px;color:#8e8e93">No memories extracted yet. Keep texting to build a relationship profile.</p>'}
            </div>
        `;
    }

function viewAlbums() {
        const current = getWallpaperId();
        return `
            <div class="ps-albums">
                <div class="ps-albums-header">
                    <button data-act="nav" data-view="home">←</button>
                    <span>Wallpapers</span>
                    <span></span>
                </div>
                <div class="ps-albums-grid">
                    ${WALLPAPERS.map(wp => `
                        <div class="ps-album-item ${wp.id === current ? 'ps-album-selected' : ''}" data-act="select-wallpaper" data-wallpaper="${wp.id}">
                            <div class="ps-album-preview" style="${wp.css}"></div>
                            <span class="ps-album-name">${wp.name}</span>
                            ${wp.id === current ? '<span class="ps-album-check">✓</span>' : ''}
                        </div>
                    `).join('')}
                    <div class="ps-album-item ${current === 'custom' ? 'ps-album-selected' : ''}" data-act="choose-custom-wallpaper">
                        <div class="ps-album-preview" style="background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;color:#fff;font-size:28px;">📷</div>
                        <span class="ps-album-name">Choose from Library</span>
                        ${current === 'custom' ? '<span class="ps-album-check">✓</span>' : ''}
                    </div>
                </div>
                <input type="file" id="ps-wallpaper-file" accept="image/*" style="display:none">
            </div>
        `;
    }

    function escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    // -------------------------------------------------------------------
    // Event binding
    // -------------------------------------------------------------------
    function bindPanel(panel) {
        // Use event delegation: ONE listener on the panel finds the nearest [data-act]
        // ancestor via ev.target.closest(). This fixes the nested [data-act] conflict
        // where a button inside a data-act parent (e.g. ✕ delete inside open-thread <li>)
        // would double-fire on mobile. With delegation, the deepest matched element wins.
        panel.removeEventListener('click', onAction);
        panel.addEventListener('click', onAction, { passive: false });
    }

    function onAction(ev) {
        const el = ev.target.closest('[data-act]');
        // Fallback: any element with data-nav-url acts as a browser link click
        const linkEl = el || ev.target.closest('[data-nav-url]');
        if (!el && linkEl) {
            const navUrl = linkEl.getAttribute('data-nav-url');
            if (navUrl) {
                ev.preventDefault();
                generateBrowserPage(navUrl);
                return;
            }
        }
        if (!el) return;
        const act = el.getAttribute('data-act');
        // Auto-close notification shade when navigating away
        if (notifShadeOpen && act !== 'close-shade' && act !== 'clear-notifs') {
            notifShadeOpen = false;
            const s = document.getElementById('ps-notif-shade');
            if (s) { s.classList.remove('ps-notif-open'); s.style.maxHeight = ''; }
        }
        switch (act) {
            case 'close':
                togglePanel();
                return;
            case 'nav':
                state.view = el.getAttribute('data-view');
                if (state.view === 'contacts' || state.view === 'favorites') {
                    harvestNPCs();
                    purgeStaleContacts();
                }
                saveMeta();
                render();
                return;
            
            case 'dismiss-banner':
                ev.stopPropagation();
                state.incomingBanner = null;
                const b = document.querySelector('.ps-incoming-banner');
                if (b) b.remove();
                render();
                return;

            case 'close-shade':
                notifShadeOpen = false;
                const shadeEl = document.getElementById('ps-notif-shade');
                if (shadeEl) {
                    shadeEl.classList.remove('ps-notif-open');
                    shadeEl.style.maxHeight = '';
                }
                return;

            case 'clear-notifs':
                // Mark all unread SMS as seen
                for (const [cid, thread] of Object.entries(state.threads)) {
                    if (!Array.isArray(thread)) continue;
                    for (const m of thread) {
                        if (m.from === 'them' && !m.seen) m.seen = true;
                    }
                }
                // Mark all voicemails as heard
                if (Array.isArray(state.voicemails)) {
                    for (const vm of state.voicemails) vm.heard = true;
                }
                notifShadeOpen = false;
                saveMeta();
                render();
                return;

            case 'toggle-star': {
                const starId = el.getAttribute('data-id');
                const contact = state.contacts.find(c => c.id === starId);
                if (contact) {
                    contact.starred = !contact.starred;
                    saveMeta();
                    render();
                }
                return;
            }
            
            case 'open-profile':
                state.activeContact = el.getAttribute('data-id');
                state.view = 'profile';
                saveMeta();
                render();
                return;
            case 'open-thread':
                state.activeContact = el.getAttribute('data-id');
                if (!state.threads[state.activeContact]) state.threads[state.activeContact] = [];
                // Mark all NPC messages in this thread as seen
                const threadMsgs = state.threads[state.activeContact];
                for (const m of threadMsgs) {
                    if (m.from === 'them' && !m.seen) m.seen = true;
                }
                // Dismiss incoming banner if opening the matching thread
                if (state.incomingBanner && state.incomingBanner.contactId === state.activeContact) {
                    state.incomingBanner = null;
                }
                state.view = 'thread';
                saveMeta();
                render();
                return;
            case 'delete-contact': {
                const delId = el.getAttribute('data-id');
                if (!delId) return;
                state.contacts = state.contacts.filter(c => c.id !== delId);
                delete state.threads[delId];
                state.callLog = state.callLog.filter(l => l.contactId !== delId);
                if (state.activeContact === delId) state.activeContact = null;
                saveMeta();
                render();
                return;
            }
            case 'delete-thread': {
                const delId = el.getAttribute('data-id');
                if (!delId || !state.threads[delId]) return;
                delete state.threads[delId];
                if (state.activeContact === delId) {
                    state.activeContact = null;
                    state.view = 'sms';
                }
                saveMeta();
                render();
                return;
            }
            case 'delete-msg': {
                const contactId = el.getAttribute('data-id');
                const idx = parseInt(el.getAttribute('data-msg-index'), 10);
                if (!contactId || !state.threads[contactId] || isNaN(idx)) return;
                const thread = state.threads[contactId];
                if (idx >= 0 && idx < thread.length) {
                    thread.splice(idx, 1);
                    // If thread is now empty, clean it up
                    if (!thread.length) {
                        delete state.threads[contactId];
                        if (state.activeContact === contactId) {
                            state.activeContact = null;
                            state.view = 'sms';
                        }
                    }
                }
                saveMeta();
                render();
                return;
            }
            case 'add-contact': {
                const name = prompt('Enter NPC name:');
                if (!name || !name.trim()) return;
                const norm = name.trim().toLowerCase();
                if (state.contacts.some(c => c.name.toLowerCase() === norm)) {
                    alert('Contact already exists.');
                    return;
                }
                state.contacts.push({
                    id: 'manual_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name: name.trim(),
                    number: genNumber(),
                    source: 'manual',
                    starred: false,
                });
                saveMeta();
                render();
                return;
            }
            case 'attach-image': {
                const fileInput = document.getElementById('ps-image-input');
                if (fileInput) fileInput.click();
                return;
            }
            case 'send': {
                const input = document.getElementById('ps-input');
                const text = (input?.value || '').trim();
                if (!text || !state.activeContact) return;
                state.threads[state.activeContact].push({ from: 'me', text, ts: Date.now(), seen: false });
                composeDraft = ''; // Clear draft on send
                updateSmsInjection(); // Inject SMS into main ST context
                simulateReply(state.activeContact).catch(e => console.warn('[PhoneSocial] reply gen failed:', e));
                saveMeta();
                render();
                return;
            }
            case 'call': {
                const id = el.getAttribute('data-id');
                const callContact = state.contacts.find(c => c.id === id);
                if (!callContact) return;
                const personality = inferPersonality(callContact);
                if (shouldDeclineCall(callContact, personality)) {
                    // NPC declines the call
                    const activityLabel = getActivityLabel(callContact);
                    const declineReason = activityLabel ? `${callContact.name} is ${activityLabel}` : `${callContact.name} declined the call`;
                    state.activeCall = { contactId: id, status: 'declined', startTs: null };
                    state.callLog.push({ contactId: id, dir: 'out', ts: Date.now(), duration: 0 });
                    saveMeta();
                    state.view = 'call';
                    render();
                    phoneNotify('incoming-call', `📞 ${callContact.name}`, declineReason);
                    phoneTtsSpeak(declineReason, callContact.name);
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.contactId !== id) return;
                        state.activeCall = null;
                        saveMeta();
                        state.view = 'home';
                        render();
                    }, 3000);
                    return;
                }
                state.activeCall = { contactId: id, status: 'dialing', startTs: null };
                state.callLog.push({ contactId: id, dir: 'out', ts: Date.now(), duration: 0 });
                saveMeta();
                state.view = 'call';
                render();
                phoneNotify('incoming-call', `📞 ${callContact.name}`, `Calling ${callContact.name}…`);
                phoneTtsSpeak(`Calling ${callContact.name}`, callContact.name);
                // Personality + activity-based answer delay
                const answerDelay = getCallAnswerDelay(callContact, personality);
                if (answerDelay < 0) {
                    // NPC never answers (e.g., in combat) — ring forever then auto-decline
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.contactId !== id) return;
                        state.activeCall = null;
                        state.callLog.push({ contactId: id, dir: 'missed', ts: Date.now(), duration: 0 });
                        saveMeta();
                        state.view = 'home';
                        render();
                        phoneNotify('incoming-call', `📞 ${callContact.name}`, `${callContact.name} never answered (in combat)`);
                        // Voicemail for unanswered outgoing call
                        setTimeout(() => {
                            generateSMSReply(id).then(vmText => {
                                const text = vmText || 'Sorry I missed your call.';
                                state.voicemails = state.voicemails || [];
                                state.voicemails.push({ contactId: id, text, ts: Date.now(), heard: false });
                                saveMeta();
                            }).catch(() => {});
                        }, 3000);
                        phoneTtsSpeak(`${callContact.name} never answered`, callContact.name);
                    }, 15000);
                    return;
                }
                setTimeout(() => {
                    if (!state.activeCall || state.activeCall.contactId !== id) return;
                    state.activeCall.status = 'connected';
                    state.activeCall.startTs = Date.now();
                    state.callLog.push({ contactId: id, dir: 'in', ts: Date.now(), duration: 0 });
                    saveMeta();
                    render(); // re-render to show connected state
                    startCallTimer();
                    if (callContact) {
                        phoneNotify('incoming-call', `📞 ${callContact.name}`, `📞 Connected with ${callContact.name}`);
                        phoneTtsSpeak(`Connected with ${callContact.name}`, callContact.name);
                    }
                }, answerDelay);
                return;
            }
            case 'answer-call': {
                if (!state.activeCall || state.activeCall.status !== 'incoming') return;
                // Cancel the auto-decline timer
                if (state.activeCall._autoDeclineTimer) {
                    clearTimeout(state.activeCall._autoDeclineTimer);
                }
                const ansContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                state.activeCall.status = 'connected';
                state.activeCall.startTs = Date.now();
                state.callLog.push({ contactId: state.activeCall.contactId, dir: 'answered', ts: Date.now(), duration: 0 });
                saveMeta();
                render();
                startCallTimer();
                if (ansContact) {
                    phoneTtsSpeak(`Call answered`, ansContact.name);
                }
                return;
            }
            case 'decline-call': {
                if (!state.activeCall || state.activeCall.status !== 'incoming') return;
                if (state.activeCall._autoDeclineTimer) {
                    clearTimeout(state.activeCall._autoDeclineTimer);
                }
                const decContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                const decId = state.activeCall.contactId;
                state.callLog.push({ contactId: decId, dir: 'declined', ts: Date.now(), duration: 0 });
                state.activeCall = null;
                saveMeta();
                state.view = 'home';
                render();
                if (decContact) {
                    phoneTtsSpeak(`Call declined`, decContact.name);
                    // Generate voicemail after declined call
                    setTimeout(() => {
                        generateSMSReply(decId).then(vmText => {
                            const text = vmText || 'Hey, it\'s me. Call me back when you can.';
                            state.voicemails = state.voicemails || [];
                            state.voicemails.push({ contactId: decId, text, ts: Date.now(), heard: false });
                            saveMeta();
                            phoneNotify('incoming-sms', `📼 ${decContact.name}`, `Voicemail from ${decContact.name}`);
                        }).catch(() => {});
                    }, 3000);
                }
                return;
            }
            case 'end-call': {
                if (!state.activeCall) return;
                const endContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                const duration = state.activeCall.startTs ? Math.floor((Date.now() - state.activeCall.startTs) / 1000) : 0;
                state.callLog.push({ contactId: state.activeCall.contactId, dir: 'end', ts: Date.now(), duration });
                stopCallTimer();
                state.activeCall = null;
                saveMeta();
                state.view = 'home';
                render();
                if (endContact) {
                    phoneTtsSpeak(`Call ended`, endContact.name);
                }
                return;
            }
            case 'call-mute':
                return;
            case 'call-keypad':
                return;
            case 'call-speaker':
                return;
            case 'call-speak': {
                const input = document.getElementById('ps-call-input');
                const speakText = (input?.value || '').trim();
                if (!speakText || !state.activeCall) return;
                const callContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                state.callLog.push({ contactId: state.activeCall.contactId, dir: 'speak', ts: Date.now(), text: speakText, fromMe: true });
                saveMeta();
                input.value = '';
                // Re-render to show the new utterance in transcript
                render();
                // Auto-start timer if rendering wiped it
                if (state.activeCall?.status === 'connected') startCallTimer();
                // TTS the spoken text (so the NPC "hears" it if TTS is on)
                phoneTtsSpeak(speakText, callContact?.name || '');
                // Simulate a reply from the NPC after a short delay
                if (state.settings.autoReplies) {
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.status !== 'connected') return;
                        generateSMSReply(state.activeCall.contactId).then(reply => {
                            if (!state.activeCall || state.activeCall.status !== 'connected') return;
                            if (!reply) return; // No reply — skip silently
                            const response = reply;
                            state.callLog.push({ contactId: state.activeCall.contactId, dir: 'speak', ts: Date.now(), text: response, fromMe: false });
                            saveMeta();
                            updateSmsInjection(); // Inject call into main ST context
                            render();
                            if (state.activeCall?.status === 'connected') startCallTimer();
                            phoneTtsSpeak(response, callContact?.name || '');
                        }).catch(() => {});
                    }, 1000 + Math.random() * 2000);
                }
                return;
            }
            case 'key':
                state.dialBuf += el.getAttribute('data-k');
                render();
                return;
            case 'dial-tab':
                state.dialTab = el.getAttribute('data-tab') || 'keypad';
                saveMeta();
                render();
                return;
            case 'play-voicemail': {
                const vmTs = parseInt(el.getAttribute('data-vm-ts') || '0');
                const vm = (state.voicemails || []).find(v => v.ts === vmTs);
                if (vm) {
                    vm.heard = true;
                    saveMeta();
                    if (typeof toastr !== 'undefined') toastr.info(vm.text.slice(0, 200), '📼 Voicemail from ' + (state.contacts.find(c => c.id === vm.contactId)?.name || 'Unknown'), { timeOut: 8000 });
                    else alert('Voicemail: ' + vm.text);
                }
                return;
            }
            case 'dial-clear':
                state.dialBuf = state.dialBuf.slice(0, -1);
                render();
                return;
            case 'dial-call': {
                if (!state.dialBuf) return;
                const dialRaw = state.dialBuf;
                state.activeCall = { contactId: null, status: 'dialing', startTs: null, raw: dialRaw };
                state.callLog.push({ contactId: null, dir: 'out', ts: Date.now(), duration: 0, raw: dialRaw });
                phoneNotify('incoming-call', '📞 Dialing', `Dialing ${dialRaw}…`);
                phoneTtsSpeak(`Dialing ${dialRaw}`, '');
                state.dialBuf = '';
                state.view = 'call';
                saveMeta();
                render();
                // Simulate answer after 2-5 seconds
                setTimeout(() => {
                    if (!state.activeCall || state.activeCall.raw !== dialRaw) return;
                    state.activeCall.status = 'connected';
                    state.activeCall.startTs = Date.now();
                    state.callLog.push({ contactId: null, dir: 'in', ts: Date.now(), duration: 0, raw: dialRaw });
                    saveMeta();
                    render();
                    startCallTimer();
                    phoneNotify('incoming-call', '📞 Connected', 'Call connected');
                    phoneTtsSpeak('Call connected', '');
                }, 2000 + Math.random() * 3000);
                return;
            }
            case 'toggle-setting': {
                const toggleKey = el.getAttribute('data-key');
                if (!toggleKey) return;
                const current = !!state.settings[toggleKey];
                state.settings[toggleKey] = !current;
                if (toggleKey === 'autoHarvest' && state.settings[toggleKey]) {
                    harvestNPCs(true);
                }
                saveMeta();
                render();
                return;
            }
            case 'harvest-now':
                harvestNPCs(true);
                saveMeta();
                render();
                return;
            case 'reset-settings':
                state.settings = { ...DEFAULT_SETTINGS };
                saveMeta();
                render();
                if (typeof toastr !== 'undefined') {
                    toastr.success('Settings reset to defaults', 'PhoneSocial', { timeOut: 3000, progressBar: true });
                }
                return;
            case 'reset-chat-data':
                state.contacts = [];
                state.threads = {};
                state.callLog = [];
                state.browserHistory = [];
                state.browserIndex = -1;
                state.browserUrl = '';
                // Also clear the chat-specific backup
                try {
                    const ctx2 = getCtx();
                    if (ctx2?.extensionSettings) {
                        delete ctx2.extensionSettings[EXT_NAME + '_bk_' + getChatKey()];
                    }
                } catch (_) {}
                saveMeta();
                // Re-harvest from actual chat senders only, then purge
                harvestNPCs();
                purgeStaleContacts();
                saveMeta();
                state.view = 'home';
                render();
                return;
            case 'select-wallpaper': {
                const wpId = el.getAttribute('data-wallpaper');
                if (!wpId) return;
                saveWallpaperGlobally(wpId);
                state.view = 'home';
                render();
                return;
            }
            case 'choose-custom-wallpaper': {
                const fileInput = document.getElementById('ps-wallpaper-file');
                if (!fileInput) return;
                fileInput.click();
                return;
            }
            
            case 'scan-memories': {
                console.log('[PhoneSocial] scan button clicked');
                const status = document.getElementById('ps-scan-status');
                if (status) status.textContent = '🔄 Scanning...';
                extractMainChatMemories().then(count => {
                    if (status) {
                        if (count > 0) status.textContent = `✅ Scan complete (+${count} items)!`;
                        else status.textContent = '✅ No new NPCs or memories found.';
                        setTimeout(() => { if (status) status.textContent = ''; }, 4000);
                    }
                    // Also scan SMS threads (forced)
                    let smsTotal = 0;
                    const promises = state.contacts.map(c => {
                        if (c.id) return extractContactMemories(c.id, true).then(n => { if (n > 0) smsTotal += n; }).catch(() => {});
                        return Promise.resolve();
                    });
                    Promise.all(promises).then(() => {
                        if (smsTotal > 0) console.log(`[PhoneSocial] +${smsTotal} SMS memories`);
                        // Purge stale contacts (scan can create NPCs that don't exist in chat)
                        purgeStaleContacts();
                        saveMeta();
                        render();
                    });
                }).catch(e => {
                    console.warn('[PhoneSocial] scan failed:', e);
                    if (status) { status.textContent = '❌ Scan failed (check console)'; }
                });
                return;
            }
            case 'edit-memory': {
                const cid = el.getAttribute('data-cid');
                const ts = el.getAttribute('data-ts');
                const contact = state.contacts.find(c => c.id === cid);
                if (!contact || !Array.isArray(contact.memories)) return;
                const mem = contact.memories.find(m => m.ts === Number(ts));
                if (!mem) return;
                const newText = prompt('Edit memory:', mem.text);
                if (newText && newText.trim()) {
                    mem.text = newText.trim().slice(0, 320);
                    saveMeta();
                    render();
                }
                return;
            }
            case 'delete-memory': {
                const cid = el.getAttribute('data-cid');
                const ts = el.getAttribute('data-ts');
                const contact = state.contacts.find(c => c.id === cid);
                if (!contact || !Array.isArray(contact.memories)) return;
                contact.memories = contact.memories.filter(m => m.ts !== Number(ts));
                saveMeta();
                render();
                return;
            }
            case 'save-settings': {
                const url = document.getElementById('ps-set-url')?.value.trim();
                const key = document.getElementById('ps-set-key')?.value.trim();
                const model = document.getElementById('ps-set-model')?.value.trim();
                const prompt = document.getElementById('ps-set-prompt')?.value.trim();
                window.PhoneSocialSettings = { apiUrl: url, apiKey: key, model, systemPromptTemplate: prompt };
                // Persist #1: via SillyTavern context extension settings (most reliable)
                const ctx = getCtx();
                if (ctx?.extensionSettings) {
                    ctx.extensionSettings[EXT_NAME] = window.PhoneSocialSettings;
                    try { ctx.saveSettingsDebounced?.(); } catch (_) { /* ignore */ }
                }
                // Persist #2: extension_settings fallback (same object, but also ensure save settings)
                if (window.extension_settings) {
                    window.extension_settings.PhoneSocial = window.PhoneSocialSettings;
                }
                // Persist #3: chat metadata fallback (also saves view state)
                const meta = getChatMeta();
                if (meta) {
                    meta.apiSettings = window.PhoneSocialSettings;
                    try { ctx?.saveMetadataDebounced?.(); } catch (_) { /* ignore */ }
                }
                const status = document.getElementById('ps-settings-status');
                if (status) status.textContent = '✅ Saved!';
                return;
            }
            // ─── Browser actions ────────────────────────────────────
            case 'browser-go': {
                const input = document.getElementById('ps-browser-input');
                const query = (input?.value || '').trim();
                if (!query) return;
                generateBrowserPage(query);
                return;
            }
            case 'browser-back': {
                if (state.browserIndex > 0) {
                    state.browserIndex--;
                    state.browserUrl = state.browserHistory[state.browserIndex]?.url || '';
                    saveMeta();
                    render();
                }
                return;
            }
            case 'browser-forward': {
                if (state.browserIndex < state.browserHistory.length - 1) {
                    state.browserIndex++;
                    state.browserUrl = state.browserHistory[state.browserIndex]?.url || '';
                    saveMeta();
                    render();
                }
                return;
            }
            case 'browser-refresh': {
                const currentPage = (state.browserIndex >= 0 && state.browserIndex < state.browserHistory.length)
                    ? state.browserHistory[state.browserIndex] : null;
                if (currentPage) {
                    generateBrowserPage(currentPage.url);
                }
                return;
            }
            case 'browser-link': {
                const url = el.getAttribute('data-nav-url');
                if (url) {
                    generateBrowserPage(url);
                }
                return;
            }
            // ─── Chirp actions ───────────────────────────────────────
            case 'chirp-refresh':
                generateChirpFeed();
                return;
            case 'chirp-compose': {
                const chirpText = prompt('What\'s on your mind?');
                if (!chirpText || !chirpText.trim()) return;
                const ctx = getCtx();
                const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
                const handle = myName.toLowerCase().replace(/[^a-z0-9_]/g, '');
                const postId = 'chirp_' + Date.now();
                state.chirpPosts.unshift({
                    id: postId,
                    author: { name: myName, handle, isContact: false, isUser: true },
                    text: chirpText.trim(),
                    ts: Date.now(),
                    likes: 0,
                    likedBy: [],
                    comments: [],
                });
                saveMeta();
                render();
                // Auto-generate replies
                generateChirpAutoReplies(postId);
                return;
            }
            case 'chirp-like': {
                const likeId = el.getAttribute('data-chirp-id');
                const post = state.chirpPosts.find(p => p.id === likeId);
                if (!post) return;
                if (!Array.isArray(post.likedBy)) post.likedBy = [];
                const myHandle = (getCtx()?.name2 || 'me').toLowerCase().replace(/[^a-z0-9_]/g, '');
                const idx = post.likedBy.indexOf(myHandle);
                if (idx >= 0) {
                    post.likedBy.splice(idx, 1);
                } else {
                    post.likedBy.push(myHandle);
                }
                post.likes = post.likedBy.length;
                saveMeta();
                render();
                return;
            }
            case 'chirp-view-thread': {
                const threadId = el.getAttribute('data-chirp-id');
                if (!threadId) return;
                state.activeContact = threadId; // reuse activeContact for post ID
                state.view = 'chirp-thread';
                saveMeta();
                render();
                return;
            }
            case 'chirp-comment-submit': {
                const commentId = el.getAttribute('data-chirp-id');
                const input = document.getElementById('ps-chirp-comment-input');
                const replyText = (input?.value || '').trim();
                if (!commentId || !replyText) return;
                if (input) input.value = '';
                generateChirpComment(commentId, replyText);
                return;
            }
            case 'chirp-delete': {
                const delId = el.getAttribute('data-chirp-id');
                if (!delId) return;
                state.chirpPosts = state.chirpPosts.filter(p => p.id !== delId);
                saveMeta();
                if (state.view === 'chirp-thread' && state.activeContact === delId) {
                    state.view = 'chirp';
                }
                render();
                return;
            }
        }
    }


    // ─── TTS via ST's built-in TTS system ───────────────────────────
    function isTtsAvailable() {
        const path1 = window.extension_settings?.texttospeech?.enabled;
        const path2 = window.extension_settings?.tts?.enabled;
        const path3 = getCtx()?.extensionSettings?.texttospeech?.enabled;
        const path4 = getCtx()?.extensionSettings?.tts?.enabled;
        const available = !!(path1 || path2 || path3 || path4);
        console.log('[PhoneSocial] TTS available check:', available,
            'paths:', { texttospeech: !!path1, tts: !!path2,
            ctx_texttospeech: !!path3, ctx_tts: !!path4 });
        return available;
    }

    async function phoneTtsSpeak(text, contactName) {
        if (!state.settings.ttsEnabled) {
            console.log('[PhoneSocial] TTS skipped: PhoneSocial toggle OFF');
            return;
        }
        if (!isTtsAvailable()) {
            console.log('[PhoneSocial] TTS skipped: ST TTS not enabled');
            return;
        }
        if (!text) return;
        const ctx = getCtx();
        if (!ctx?.executeSlashCommands) {
            console.warn('[PhoneSocial] TTS skipped: no executeSlashCommands');
            return;
        }
        console.log('[PhoneSocial] TTS speaking:', text.slice(0, 60));
        // Use plain /speak with no voice override — avoids "no voice assigned to X" errors.
        // ST will use whatever TTS voice is configured as default in its settings.
        try {
            const cleanText = String(text).replace(/"/g, '\\"').slice(0, 300);
            await ctx.executeSlashCommands(`/speak "${cleanText}"`);
        } catch (e) {
            console.warn('[PhoneSocial] TTS failed:', e);
        }
    }

    // ─── Toastr notifications ───────────────────────────────────────
    function phoneNotify(type, title, message) {
        if (!state.settings.toastrEnabled) return;
        if (typeof toastr === 'undefined') return;
        const opts = {
            timeOut: type === 'incoming-call' ? 8000 : 5000,
            extendedTimeOut: 3000,
            progressBar: true,
            closeButton: true,
            positionClass: 'toast-bottom-right',
        };
        if (type === 'incoming-call') {
            toastr.info(message || `📞 Incoming call…`, title || 'PhoneSocial', opts);
        } else if (type === 'incoming-sms') {
            toastr.info(message || '', title || 'PhoneSocial', opts);
        }
    }

    // UIE-style API URL candidate builder — tries common endpoint paths
    function buildApiUrlCandidates(rawUrl) {
        const base = rawUrl.replace(/\/+$/g, '');
        const candidates = [];
        const add = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
        // If URL already ends in /chat/completions, use as-is
        if (/\/chat\/completions$/i.test(base)) {
            add(base);
            return candidates;
        }
        // If URL ends in /v1 or /api/v1 — append /chat/completions
        if (/\/v1\/?$/i.test(base) || /\/api\/v1\/?$/i.test(base)) {
            add(`${base}/chat/completions`);
            return candidates;
        }
        // Bare domain / generic URL — try common chat completions paths
        // (Do NOT try /v1/completions — that's the old text completions endpoint
        //  which expects "prompt", not "messages", and will always 400.)
        add(`${base}/v1/chat/completions`);
        add(`${base}/chat/completions`);
        return candidates;
    }

    // Strip RP narration markers from main chat messages used as SMS context.
    // Removes *asterisk actions*, [stage directions], and trims to keep it terse.
    function stripNarration(text) {
        if (!text) return '';
        return text
            .replace(/\*[^*]+\*/g, '')       // *narration*
            .replace(/\[[^\]]+\]/g, '')       // [stage directions]
            .replace(/\([^)]*action[^)]*\)/gi, '') // (action cues)
            .replace(/\s{2,}/g, ' ')          // collapse whitespace
            .trim();
    }

    // Strip NPC name prefix from AI replies (e.g. "Prof. Beom-seok: Hey" → "Hey")
    function stripNamePrefix(text, contactName) {
        if (!text || !contactName) return text;
        const escaped = contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match "Name: ", "**Name:** ", "Name - ", "Name—", "Name says:" etc.
        const re = new RegExp('^\\*{0,2}' + escaped + '\\*{0,2}\\s*[:\\-—]\\s*|^' + escaped + '\\s+(?:says?|texts?|writes?)[,:]\\s*', 'i');
        return text.replace(re, '').trim();
    }

    // Extract reply text from various API response formats
    function extractApiReply(data) {
        if (!data) return null;
        const d = data;
        const c0 = d?.choices?.[0];
        const fromMsg = c0?.message?.content;
        if (typeof fromMsg === 'string' && fromMsg.trim()) return fromMsg.trim().replace(/^["']|["']$/g, '');
        const fromText = c0?.text;
        if (typeof fromText === 'string' && fromText.trim()) return fromText.trim().replace(/^["']|["']$/g, '');
        const fromGemini = d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof fromGemini === 'string' && fromGemini.trim()) return fromGemini.trim().replace(/^["']|["']$/g, '');
        const fromAnthropic = d?.content?.[0]?.text;
        if (typeof fromAnthropic === 'string' && fromAnthropic.trim()) return fromAnthropic.trim().replace(/^["']|["']$/g, '');
        const fromOutput = d?.output_text || d?.generated_text || d?.result || d?.response;
        if (typeof fromOutput === 'string' && fromOutput.trim()) return fromOutput.trim().replace(/^["']|["']$/g, '');
        return null;
    }

    async function generateSMSReply(contactId) {
        const contact = state.contacts.find(c => c.id === contactId);
        if (!contact) return null;
        const ctx = getCtx();
        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
        const thread = state.threads[contactId] || [];
        const recentMessages = thread.slice(-10);
        const conversation = recentMessages.map(m => {
            const speaker = m.from === 'me' ? myName : contact.name;
            if (m.imageUrl) return `${speaker}: [sent a photo]`;
            return `${speaker}: ${m.text || ''}`;
        }).join('\n');

        // Detect if the last message is from the NPC themselves — nothing to "reply" to.
        // In that case, this is a follow-up / double-text, not a reply.
        const lastMsg = recentMessages[recentMessages.length - 1];
        const isFollowUp = lastMsg && lastMsg.from === 'them';
        const otherContacts = state.contacts
            .filter(c => c.id !== contactId)
            .map(c => `- ${c.name}`)
            .sort()
            .join('\n');

        // ── Collect NPC memories for SMS context ──
        let npcMemories = '';
        if (Array.isArray(contact.memories) && contact.memories.length) {
            const recentMems = contact.memories.slice(-5);
            npcMemories = `\n\nThings ${contact.name} knows/remembers:\n` + recentMems.map(m => `- ${m.text}`).join('\n');
        }

        // ── Scan main chat for recent messages involving this NPC ──
        let mainChatContext = '';
        try {
            if (ctx?.chat) {
                const contactNameLower = contact.name.toLowerCase();
                const relevantMsgs = ctx.chat
                    .filter(msg => {
                        if (!msg || msg.is_system) return false;
                        const speaker = (msg.name || '').toLowerCase();
                        // Include ONLY if the NPC is the speaker — they must have been
                        // physically present in the scene. Messages that merely mention
                        // the NPC's name should NOT be injected, or NPCs become omniscient
                        // and learn about surprises/plans discussed in their absence.
                        return speaker === contactNameLower;
                    })
                    .slice(-5)
                    .map(msg => {
                        const speaker = msg.name || (msg.is_user ? (ctx.name1 || 'You') : (ctx.name2 || ctx.name || 'Character'));
                        const cleanText = stripNarration(msg.mes || msg.text || '').slice(0, 100);
                        return cleanText ? `${speaker}: ${cleanText}` : null;
                    })
                    .filter(Boolean);
                if (relevantMsgs.length) {
                    mainChatContext = `\n\nRecent events involving ${contact.name}:\n${relevantMsgs.join('\n')}`;
                }
            }
        } catch (_) { /* ignore */ }

        // Try to find the NPC's character card for personality injection (UIE-style)
        let npcDescription = '';
        if (ctx?.characters) {
            const match = ctx.characters.find(ch =>
                ch && ch.name && ch.name.toLowerCase() === contact.name.toLowerCase()
            );
            if (match?.data) {
                const desc = (match.data.description || '').trim().slice(0, 600);
                const personality = (match.data.personality || '').trim().slice(0, 400);
                if (desc || personality) {
                    npcDescription = `${contact.name}'s character:\n${desc}${desc && personality ? '\n' : ''}${personality}`.trim();
                }
            }
        }

        // Check if a custom API key is configured
        const s = window.PhoneSocialSettings || {};
        const apiKey = s.apiKey?.trim();
        if (apiKey) {
            console.log(`[PhoneSocial] 🔑 using custom API: ${s.apiUrl} | model: ${s.model || 'gpt-4o-mini'} | contact: ${contact.name}`);
            // Build API URL candidates (UIE-style: tries /chat/completions, /v1/chat/completions, etc.)
            const rawUrl = ((s.apiUrl && s.apiUrl !== 'undefined' && s.apiUrl !== 'null') ? s.apiUrl : 'https://api.openai.com/v1').trim().replace(/[\r\n\s]+/g, '').replace(/\/+$/, '');
            const model = s.model || 'gpt-4o-mini';
            const promptTemplate = s.systemPromptTemplate || 'You are {char}, responding via text message. Keep replies short and in character.';
            const charName = contact.name;
            const systemPrompt = promptTemplate.replace(/\{char\}/g, charName) +
                (npcDescription ? `\n\n${npcDescription}` : '') +
                (otherContacts ? `\n\nOther contacts you know:\n${otherContacts}` : '') +
                (npcMemories ? npcMemories : '') +
                (mainChatContext ? mainChatContext : '') +
                (isFollowUp
                    ? `\n\nYou are currently texting ${myName} (also called you). They haven't responded to your last message yet.\nCRITICAL: Send a natural follow-up text. Do NOT answer your own question or speak for ${myName}. Keep it in YOUR voice only. No narration, stage directions, asterisks.`
                    : `\n\nYou are currently texting ${myName} (also called you).\nCRITICAL: Send ONLY the SMS text. No narration, stage directions, asterisks, or commentary about the scene.`);
            const userMsg = isFollowUp
                ? `SMS conversation:\n${conversation || '(no messages yet)'}\n\nThe last message was from you — ${myName} hasn't replied yet. Write a follow-up text from ${charName}. Stay in character. Just the text message — casual, natural, concise. No narration.`
                : `SMS conversation with ${myName}:\n${conversation || '(no messages yet)'}\n\nWrite ONLY the SMS reply from ${charName} to ${myName}. Just the text message — casual, natural, concise. No narration.`;

            // Build URL candidates from raw input
            const urlCandidates = buildApiUrlCandidates(rawUrl);
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (apiKey) {
                const key = apiKey.replace(/^bearer\s+/i, '').trim();
                const host = rawUrl.toLowerCase();
                headers['Authorization'] = `Bearer ${key}`;
                // Provider-specific auth headers
                if (host.includes('nvidia.com') || host.includes('nano-gpt.com') || host.includes('nanogpt')) {
                    headers['x-api-key'] = key;
                    headers['api-key'] = key;
                }
            }

            for (const url of urlCandidates) {
                try {
                    const body = { model, messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userMsg },
                    ], max_tokens: 300, temperature: 0.8 };
                    const res = await fetch(url, {
                        method: 'POST', headers, body: JSON.stringify(body),
                    });
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        console.warn(`[PhoneSocial] API error (${res.status}) at ${url}:`, errText.slice(0, 200));
                        continue;
                    }
                    const data = await res.json().catch(() => null);
                    if (!data) continue;
                    // Extract text from various response formats (chat, text, Anthropic, Gemini)
                    const text = extractApiReply(data);
                    if (text) return stripNamePrefix(text, contact.name);
                } catch (e) {
                    console.warn(`[PhoneSocial] fetch failed for ${url}:`, e?.message || e);
                    continue;
                }
            }
            console.warn('[PhoneSocial] all API endpoints failed — falling back to ST generateQuietPrompt');
            // Fall through to generateQuietPrompt below instead of returning null
        }

        // Fallback: proxy through ST's local server (which can reach DeepSeek server-side)
        // generateQuietPrompt returns undefined due to ST tool-calling pipeline interception,
        // so we call ST's local chat-completions endpoint directly.
        console.log('[PhoneSocial] falling back to ST local proxy for ' + contact.name);
        try {
            const stOrigin = window.location.origin || 'http://localhost:8000';
            // Build concise chat messages
            const charDesc = npcDescription ? npcDescription.slice(0, 300) : '';
            const memSnippet = npcMemories ? npcMemories.replace(/^\\n\\n/, '').slice(0, 300) : '';
            const chatSnippet = mainChatContext ? mainChatContext.replace(/^\\n\\n/, '').slice(0, 400) : '';
            const convoSnippet = conversation.slice(-500);

            const systemMsg = [
                'You are ' + contact.name + '.',
                charDesc ? charDesc : '',
                'You are texting ' + myName + ' via SMS on your phone.',
                isFollowUp
                    ? 'CRITICAL: Send a natural follow-up text. Do NOT answer your own question or speak for ' + myName + '. Keep it in YOUR voice only. No narration, no stage directions, no asterisks.'
                    : 'CRITICAL: Reply with ONLY the SMS text. No narration, no stage directions, no asterisks, no commentary about the scene. Just what you would type on a phone.',
            ].filter(Boolean).join(' ');

            const userMsg = [
                memSnippet ? 'You remember: ' + memSnippet : '',
                chatSnippet ? 'Recent events: ' + chatSnippet : '',
                'SMS conversation with ' + myName + ':',
                convoSnippet || '(no messages yet)',
                isFollowUp ? myName + ' hasn\'t replied to your last message yet.' : '',
                '',
                isFollowUp ? 'Your follow-up:' : 'Your reply:',
            ].filter(Boolean).join('\n');

            const body = JSON.stringify({
                messages: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: userMsg }
                ],
                max_tokens: 300,
                temperature: 0.8,
                stream: false
            });

            // Try ST's chat-completions proxy endpoint
            const urls = [
                stOrigin + '/api/backends/chat-completions',
                stOrigin + '/api/generate',
            ];
            for (const url of urls) {
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body
                    });
                    if (!res.ok) { console.warn('[PhoneSocial] ST proxy ' + res.status + ' at ' + url); continue; }
                    const data = await res.json().catch(() => null);
                    const text = extractApiReply(data);
                    if (text) {
                        console.log('[PhoneSocial] ST proxy reply: ' + text.slice(0, 60));
                        return stripNamePrefix(text, contact.name);
                    }
                } catch (e) {
                    console.warn('[PhoneSocial] ST proxy fetch failed for ' + url + ': ' + (e?.message || e));
                }
            }
            console.warn('[PhoneSocial] ST proxy all endpoints failed — falling to hardcoded');
        } catch (e) {
            console.warn('[PhoneSocial] ST proxy error:', e);
        }
        return null;
    }


    async function simulateReply(contactId) {
        if (!state.settings.autoReplies) return;
        const contact = state.contacts.find(c => c.id === contactId);
        const personality = contact ? inferPersonality(contact) : null;
        // Show typing indicator while we generate
        state.typingContactId = contactId;
        if (state.view === 'thread' && state.activeContact === contactId) render();
        // Try ST-powered LLM generation — if it fails, skip the reply entirely
        const text = await generateSMSReply(contactId);
        if (!text) {
            state.typingContactId = null;
            return;
        }
        // Clear typing indicator
        state.typingContactId = null;
        // Personality-based reply delay
        const delay = personality ? getResponseDelay(contact, personality) : (800 + Math.random() * 1500);
        setTimeout(() => {
            if (!state.threads[contactId]) return;
            state.threads[contactId].push({ from: 'them', text, ts: Date.now(), seen: false });
            // Mark the last user message as seen (NPC "read" it before replying)
            const msgs = state.threads[contactId];
            for (let i = msgs.length - 2; i >= 0; i--) {
                if (msgs[i].from === 'me') { msgs[i].seen = true; break; }
            }
            saveMeta();
            updateSmsInjection(); // Inject SMS into main ST context
            if (state.view === 'thread' && state.activeContact === contactId) render();
            // Toastr notification for incoming SMS
            if (contact) {
                phoneNotify('incoming-sms', `📩 ${contact.name}`, `${contact.name}: ${text.slice(0, 120)}`);
                showIncomingBanner(contact, text);
            }
            // Trigger memory extraction after a brief delay (let the user see the reply first)
            setTimeout(() => {
                extractContactMemories(contactId).catch(e =>
                    console.warn('[PhoneSocial] memory extraction failed:', e));
            }, 3000);
        }, delay);
    }

    // ─── NPC Personality — inferred from character card ─────────────
    // Guides: response speed, initiative, call preference, shyness.
    function inferPersonality(contact) {
        if (contact._personality) return contact._personality;
        const p = {
            initiative: 5 + Math.floor(Math.random() * 5) - 2,   // 3-7 spread so NPCs aren't all identical
            responseSpeed: 3 + Math.floor(Math.random() * 5),     // 3-7
            prefersCall: Math.random() < 0.15,                    // 15% chance even without card traits
            isShy: false,
        };
        try {
            const ctx = getCtx();
            if (!ctx?.characters) { contact._personality = p; return p; }
            const match = ctx.characters.find(ch =>
                ch && ch.name && ch.name.toLowerCase() === contact.name.toLowerCase());
            const desc = ((match?.data?.description || '') + ' ' + (match?.data?.personality || '')).toLowerCase();
            if (/shy|reserved|quiet|introvert|timid|awkward|nervous|anxious/.test(desc)) {
                p.initiative = 2; p.responseSpeed = 7; p.isShy = true;
            }
            if (/outgoing|extrovert|loud|bold|confident|friendly|chatty|gregarious/.test(desc)) {
                p.initiative = 8; p.responseSpeed = 3;
            }
            if (/busy|workaholic|distracted|aloof|cold|distant|preoccupied/.test(desc)) {
                p.initiative = 3; p.responseSpeed = 8;
            }
            if (/romantic|affectionate|clingy|needy|flirty|lovesick/.test(desc)) {
                p.initiative = 9; p.prefersCall = true;
            }
            if (/tsundere|grumpy|irritable|sarcastic|sassy/.test(desc)) {
                p.initiative = 4; p.responseSpeed = 6;
            }
        } catch (_) { /* ignore */ }
        contact._personality = p;
        return p;
    }

    // ─── Current Activity — inferred from main chat ──────────────────
    // Scans the NPC's most recent main-chat messages to figure out what
    // they're currently doing, which overrides/modifies personality defaults.
    function getCurrentActivity(contact) {
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return null;
            const contactName = contact.name.toLowerCase();
            // Scan backwards for this NPC's most recent 3 messages
            const recentMsgs = [];
            for (let i = ctx.chat.length - 1; i >= 0 && recentMsgs.length < 3; i--) {
                const msg = ctx.chat[i];
                if (!msg || msg.is_user || msg.is_system) continue;
                if ((msg.name || '').toLowerCase() === contactName) {
                    recentMsgs.push(msg.mes || msg.text || '');
                }
            }
            if (!recentMsgs.length) return null;
            const text = recentMsgs[0].toLowerCase();

            // NPC is present if they've spoken recently (last 3 messages).
            // Present NPCs shouldn't call/text — they're right there with you.
            const present = { state: 'present', responseMod: 1, callDeclineBonus: 0, label: 'present in scene', noProactive: true };

            // Combat/danger — won't answer at all
            if (/fight(ing)?\b|battle|combat|attack(ing)?|punch(ing)?|kick(ing)?|sword|gun|weapon|enemy|danger|chase|running\s+(from|away)|in\s+(a\s+)?(fight|battle)/i.test(text)) {
                return { state: 'combat', responseMod: 5, callDeclineBonus: 0.8, label: 'in combat', noProactive: true };
            }
            // Sleeping
            if (/sleep(ing)?|bed|tired|yawn(ing)?|asleep|nap|resting|going\s+to\s+(bed|sleep)|goodnight|night\b|doze|drowsy/i.test(text)) {
                return { state: 'sleeping', responseMod: 4, callDeclineBonus: 0.7, label: 'sleeping', noProactive: true };
            }
            // Working / busy with something
            if (/work(ing)?\b|meeting|office|job\b|busy\s+(with|at)|task\b|project|deadline|paperwork|stud(y|ying)|class\b|homework/i.test(text)) {
                return { state: 'working', responseMod: 2.5, callDeclineBonus: 0.4, label: 'working', noProactive: true };
            }
            // Eating
            if (/eat(ing)?\b|food\b|lunch|breakfast|dinner|snack|hungry|cooking|meal|dining/i.test(text)) {
                return { state: 'eating', responseMod: 1.5, callDeclineBonus: 0.2, label: 'eating' };
            }
            // Occupied / can't talk
            if (/busy|occupied|can'?t\s+(talk|chat|text)|not\s+now|later\b|leave\s+me\s+alone|in\s+the\s+(middle|bath|shower)/i.test(text)) {
                return { state: 'occupied', responseMod: 3, callDeclineBonus: 0.5, label: 'occupied', noProactive: true };
            }
            // Emotional (sad, crying, lonely — more likely to want to talk)
            if (/cry(ing)?\b|sad\b|upset|heartbroken|lonely|miss\s+(you|them|her|him)|depress(ed|ing)/i.test(text)) {
                return { state: 'emotional', responseMod: 0.7, callDeclineBonus: -0.2, label: 'emotional' };
            }
            // Happy / playful
            if (/happ(y|ier)|excited|giggling|laugh(ing)?|joy|fun\b|playful|cheerful|great\s+day|wonderful/i.test(text)) {
                return { state: 'happy', responseMod: 0.6, callDeclineBonus: -0.15, label: 'happy' };
            }
            // Free / available
            if (/free\b|bored\b|waiting|relax(ing)?|chill(ing)?|home\b|nothing\b|available|loafing|idle/i.test(text)) {
                return { state: 'free', responseMod: 0.5, callDeclineBonus: -0.15, label: 'free' };
            }
            return present;
        } catch (_) { /* ignore */ }
        return null;
    }

    // ─── Proactive NPC behaviors ─────────────────────────────────────
    // NPCs can text or call the user on their own, driven by personality + current activity.
    function getResponseDelay(contact, personality) {
        const activity = getCurrentActivity(contact);
        let mod = activity ? activity.responseMod : 1;
        // Base delay from personality
        const base = 500 + (personality.responseSpeed / 10) * 7500;
        return base * mod + Math.random() * base * 0.5 * mod;
    }

    function getCallAnswerDelay(contact, personality) {
        const activity = getCurrentActivity(contact);
        if (activity) {
            // Combat = never answer; sleeping = very slow
            if (activity.state === 'combat') return -1; // never answers
            if (activity.state === 'sleeping') return 8000 + Math.random() * 7000;
        }
        if (personality.isShy) return 5000 + Math.random() * 5000;
        if (personality.responseSpeed >= 8) return 4000 + Math.random() * 6000;
        if (personality.responseSpeed <= 3) return 1000 + Math.random() * 2000;
        return 2000 + Math.random() * 3000;
    }

    function shouldDeclineCall(contact, personality) {
        const activity = getCurrentActivity(contact);
        if (activity) {
            // Combat = always decline; sleeping = very likely
            if (activity.state === 'combat') return true;
            if (activity.state === 'sleeping') return Math.random() < 0.75;
            // Activity can add a bonus to the decline chance
            if (Math.random() < (activity.callDeclineBonus || 0)) return true;
        }
        if (personality.isShy) return Math.random() < 0.6;  // shy NPCs mostly don't call
        if (personality.initiative <= 3) return Math.random() < 0.35;
        if (personality.initiative >= 8) return false;       // bold NPCs always follow through
        return Math.random() < 0.15;                          // base chance NPC decides not to
    }

    function getActivityLabel(contact) {
        const activity = getCurrentActivity(contact);
        return activity ? activity.label : null;
    }

    async function simulateIncomingCall(contact) {
        if (state.activeCall) return; // Already on a call
        const personality = inferPersonality(contact);
        if (shouldDeclineCall(contact, personality)) {
            const activity = getCurrentActivity(contact);
            const reason = activity ? ` (${activity.label})` : ' (personality)';
            console.log(`[PhoneSocial] ${contact.name} thought about calling but decided not to${reason}`);
            return;
        }
        state.activeCall = { contactId: contact.id, status: 'incoming', startTs: null };
        state.callLog.push({ contactId: contact.id, dir: 'in', ts: Date.now(), duration: 0 });
        state.view = 'call';
        saveMeta();
        render();
        phoneNotify('incoming-call', `📞 ${contact.name}`, `📞 Incoming call from ${contact.name}`);
        phoneTtsSpeak(`Incoming call from ${contact.name}`, contact.name);
        // Auto-decline after 15 seconds if user doesn't answer
        const autoDeclineTimer = setTimeout(() => {
            if (!state.activeCall || state.activeCall.contactId !== contact.id || state.activeCall.status !== 'incoming') return;
            state.activeCall = null;
            state.callLog.push({ contactId: contact.id, dir: 'missed', ts: Date.now(), duration: 0 });
            state.view = 'home';
            saveMeta();
            render();
            phoneNotify('incoming-call', `📞 ${contact.name}`, `📞 Missed call from ${contact.name}`);
            phoneTtsSpeak(`Missed call from ${contact.name}`, contact.name);
            // Generate voicemail after missed call
            setTimeout(() => {
                const c = state.contacts.find(x => x.id === contact.id);
                if (!c) return;
                generateSMSReply(contact.id).then(vmText => {
                    const text = vmText || 'Hey, it\'s me. Call me back when you can.';
                    state.voicemails = state.voicemails || [];
                    state.voicemails.push({ contactId: contact.id, text, ts: Date.now(), heard: false });
                    saveMeta();
                    phoneNotify('incoming-sms', `📼 ${contact.name}`, `Voicemail from ${contact.name}`);
                }).catch(() => {});
            }, 3000);
        }, 15000);
        state.activeCall._autoDeclineTimer = autoDeclineTimer;
    }

    async function simulateProactiveText(contact, trigger) {
        if (!state.settings.autoReplies) return;
        if (!state.threads[contact.id]) state.threads[contact.id] = [];
        const personality = inferPersonality(contact);
        // AI generation only — if it fails, skip (no scripted fallbacks)
        const aiReply = await generateSMSReply(contact.id);
        if (!aiReply) {
            console.log('[PhoneSocial] proactive: no AI reply for', contact.name, '— skipping');
            return;
        }
        const text = aiReply;
        setTimeout(() => {
            if (!state.threads[contact.id]) return;
            state.threads[contact.id].push({ from: 'them', text, ts: Date.now(), seen: false });
            saveMeta();
            updateSmsInjection();
            if (state.view === 'thread' && state.activeContact === contact.id) render();
            if (contact) {
                phoneNotify('incoming-sms', `📩 ${contact.name}`, `${contact.name}: ${text.slice(0, 120)}`);
                showIncomingBanner(contact, text);
            }
        }, getResponseDelay(contact, personality));
    }

    // ─── Story-aware proactive helpers ──────────────────────────────
    // Checks whether an NPC is currently "present" in the main chat —
    // if they've spoken in the last few messages, they're in the scene.
    function isNpcPresent(contactName) {
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return false;
            const nameLower = contactName.toLowerCase();
            // Check 25 messages — wide enough for any multi-character scene.
            // In fast-paced RP with 3+ characters, even 15 can be too tight.
            const recent = ctx.chat.slice(-25).filter(m => m && !m.is_system);
            for (const m of recent) {
                const speaker = (m.name || '').toLowerCase();
                if (speaker === nameLower) {
                    console.log('[PhoneSocial] isNpcPresent: ' + contactName + ' FOUND in recent ' + recent.length + ' msgs → BLOCKING proactive');
                    return true;
                }
            }
            console.log('[PhoneSocial] isNpcPresent: ' + contactName + ' NOT in recent ' + recent.length + ' msgs, speakers: ' + recent.map(m => (m.name || '?')).join(', '));
        } catch (_) {}
        return false;
    }

    // Scans recent main chat for story beats that warrant a proactive message.
    // Returns {type, intensity} or null if nothing significant happened.
    // STRICT RULES:
    //  - NPC must have SPOKEN in the scene (not just mentioned) for conflict/exit
    //  - NPC still in the last 3 messages → skip (they're right there)
    //  - Conflict requires NPC as speaker or direct target, not just mentioned nearby
    //  - No "mentioned" trigger — too noisy
    function detectStoryTrigger(contactName) {
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return null;
            const nameLower = contactName.toLowerCase();
            const recent = ctx.chat.slice(-25).filter(m => m && !m.is_system);
            if (!recent.length) return null;

            // ── Guard: NPC still active in scene → don't trigger ──
            let spokenRecently = false;
            for (let i = recent.length - 1; i >= Math.max(0, recent.length - 3); i--) {
                if ((recent[i].name || '').toLowerCase() === nameLower) {
                    spokenRecently = true;
                    break;
                }
            }
            if (spokenRecently) return null; // They're literally in the room

            // ── Find NPC's last appearance and user's last message ──
            let npcLastIdx = -1;
            let userLastIdx = -1;
            for (let i = recent.length - 1; i >= 0; i--) {
                const speaker = (recent[i].name || '').toLowerCase();
                if (speaker === nameLower && npcLastIdx === -1) npcLastIdx = i;
                if (recent[i].is_user && userLastIdx === -1) userLastIdx = i;
            }

            // ── NPC never spoke in this window → they can't have "left" or "fought" ──
            if (npcLastIdx === -1) return null;

            // Need at least 5 messages since NPC's last line for any trigger
            const msgsSinceNpc = recent.length - 1 - npcLastIdx;
            if (msgsSinceNpc < 5) return null;

            // ── SCENE EXIT: NPC left the scene ──
            // User must have spoken 3+ times since NPC's last line,
            // and those user messages contain exit language
            const userMsgsSince = recent.slice(npcLastIdx + 1).filter(m => m.is_user);
            if (userMsgsSince.length >= 3) {
                const exitWords = ['leave', 'left', 'walk out', 'storm', 'exit', 'gone', 'away', 'home', 'later', 'bye', 'goodbye', 'night', 'headed out', 'took off'];
                let isExit = false;
                for (const m of userMsgsSince) {
                    const text = (m.mes || m.text || '').toLowerCase();
                    for (const w of exitWords) {
                        if (text.includes(w)) { isExit = true; break; }
                    }
                    if (isExit) break;
                }
                if (isExit) return { type: 'scene_exit', intensity: 'high' };
                // Even without exit words, if NPC has been gone for 8+ messages, treat as soft exit
                if (msgsSinceNpc >= 8) return { type: 'scene_exit', intensity: 'medium' };
            }

            // ── CONFLICT: NPC was directly involved in an argument ──
            // Only count if NPC is the SPEAKER of the conflict line, NOT just mentioned nearby
            const conflictWords = ['yell', 'shout', 'slam', 'storm', 'argue', 'fight', 'furious',
                'angry', 'upset', 'cry', 'tears', 'scream'];
            let foundConflict = false;
            let highIntensity = false;

            for (let i = Math.max(0, npcLastIdx - 3); i <= npcLastIdx; i++) {
                const m = recent[i];
                const speaker = (m.name || '').toLowerCase();
                const text = (m.mes || m.text || '').toLowerCase();

                // NPC must be the SPEAKER, or the NEXT message's speaker must be NPC
                // (someone yelled AT the NPC, then NPC responded)
                const nextM = recent[i + 1];
                const nextSpeaker = nextM ? (nextM.name || '').toLowerCase() : '';
                const npcIsTarget = nextSpeaker === nameLower; // NPC responded right after this

                if (speaker === nameLower || npcIsTarget) {
                    for (const w of conflictWords) {
                        const checkText = npcIsTarget ? text : text; // check the conflict message itself
                        if (checkText.includes(w)) {
                            foundConflict = true;
                            if (w === 'storm' || w === 'furious' || w === 'scream') highIntensity = true;
                            break;
                        }
                    }
                    // Also check if NPC's OWN message contains emotional language
                    if (!foundConflict && speaker === nameLower) {
                        const emotional = ['sorry', 'apologize', 'regret', 'can\'t believe', 'hurt', 'upset', 'furious', 'angry'];
                        for (const e of emotional) {
                            if (text.includes(e)) { foundConflict = true; break; }
                        }
                    }
                }
                if (foundConflict && highIntensity) break;
            }

            if (foundConflict) {
                return { type: 'conflict', intensity: highIntensity ? 'high' : 'medium' };
            }
        } catch (_) {}
        return null;
    }

    let proactiveInterval = null;
    function startProactiveCycle() {
        stopProactiveCycle();
        proactiveInterval = setInterval(checkProactiveNPCs, 45000);
        setTimeout(checkProactiveNPCs, 10000);
    }
    function stopProactiveCycle() {
        if (proactiveInterval) {
            clearInterval(proactiveInterval);
            proactiveInterval = null;
        }
    }
    function checkProactiveNPCs() {
        const contacts = state.contacts;
        if (!contacts.length || !state.settings.autoReplies) return;

        // Debug: log which NPCs are being skipped
        console.log('[PhoneSocial] 🔍 proactive check: ' + contacts.length + ' contacts, autoReplies=' + state.settings.autoReplies);
        const skippedPresent = contacts.filter(c => isNpcPresent(c.name));
        if (skippedPresent.length) {
            console.log('[PhoneSocial] 🚫 skipping ' + skippedPresent.length + ' present NPCs: ' + skippedPresent.map(c => c.name).join(', '));
        }

        // Helper: has this NPC texted the user recently? Skip if so.
        function hasRecentInteraction(c) {
            const thread = state.threads[c.id];
            if (!Array.isArray(thread) || !thread.length) return false;
            // Check last message — if NPC sent it within 10 min, skip
            const last = thread[thread.length - 1];
            if (last.from === 'them' && (Date.now() - (last.ts || 0)) < 600000) return true;
            // Also check if user sent a message in the last 2 min (NPC probably about to reply)
            if (last.from === 'me' && (Date.now() - (last.ts || 0)) < 120000) return true;
            return false;
        }

        // Phase 1 — scan all contacts for story triggers (always runs, ignores cooldowns)
        const triggered = [];
        for (const c of contacts) {
            if (!c.id || c.source === 'st-character' || c.source === 'st-group') continue;
            if (isNpcPresent(c.name)) continue; // NPC is in the room — don't text them
            if (hasRecentInteraction(c)) continue; // Just texted — don't harass
            const trigger = detectStoryTrigger(c.name);
            if (trigger) {
                triggered.push({ contact: c, trigger });
            }
        }

        // Phase 2 — if we have triggered NPCs, pick the highest-intensity one
        if (triggered.length) {
            const intensityRank = { high: 3, medium: 2, low: 1 };
            triggered.sort((a, b) =>
                (intensityRank[b.trigger.intensity] || 0) - (intensityRank[a.trigger.intensity] || 0)
            );
            const winner = triggered[0];
            // Cooldown check for triggered — 2 min to prevent spam
            const last = winner.contact._lastProactiveTime || 0;
            if (Date.now() - last >= 120000) {
                winner.contact._lastProactiveTime = Date.now();
                const personality = inferPersonality(winner.contact);
                const shouldCall = winner.trigger.intensity === 'high' && (personality.prefersCall || personality.initiative >= 7);
                console.log('[PhoneSocial] story-triggered: ' + winner.contact.name + ' ' + winner.trigger.type + ' (' + winner.trigger.intensity + ') → ' + (shouldCall ? 'call' : 'text'));
                if (shouldCall) {
                    simulateIncomingCall(winner.contact);
                } else {
                    simulateProactiveText(winner.contact, winner.trigger);
                }
            }
            return; // Don't also do random proactivity this cycle
        }

        // Phase 3 — random proactivity (only when no story triggers found, reduced frequency)
        const eligible = contacts.filter(c => {
            if (!c.id || c.source === 'st-character' || c.source === 'st-group') return false;
            if (isNpcPresent(c.name)) return false; // Skip present NPCs
            if (hasRecentInteraction(c)) return false; // Just texted — don't harass
            const activity = getCurrentActivity(c);
            if (activity && activity.noProactive) return false;
            const personality = inferPersonality(c);
            const cooldownMs = Math.max(300000, 900000 - personality.initiative * 60000); // 5-15 min
            const last = c._lastProactiveTime || 0;
            if (Date.now() - last < cooldownMs) return false;
            return Math.random() < (personality.initiative / 30); // Lower random rate
        });
        if (!eligible.length) return;
        eligible.sort((a, b) => inferPersonality(b).initiative - inferPersonality(a).initiative);
        const chosen = eligible[0];
        chosen._lastProactiveTime = Date.now();
        const personality = inferPersonality(chosen);
        const shouldCall = personality.prefersCall || (personality.initiative >= 5 && Math.random() < 0.35);
        const activityLabel = getActivityLabel(chosen);
        console.log('[PhoneSocial] random proactive: ' + chosen.name + ' initiates ' + (shouldCall ? 'call' : 'text') + ' (initiative=' + personality.initiative + (activityLabel ? ', ' + activityLabel : '') + ')');
        if (shouldCall) {
            simulateIncomingCall(chosen);
        } else {
            simulateProactiveText(chosen, null); // No trigger
        }
    }

    // ─── SMS + Call → Main Chat injection ───────────────────────────
    // Builds a summary of recent SMS and call activity and injects it into
    // the main SillyTavern chat context via setExtensionPrompt, so the main
    // character (and NPCs) are aware of ongoing text AND phone conversations.
    function updateSmsInjection() {
        try {
            const ctx = getCtx();
            if (!ctx?.setExtensionPrompt) return;

            const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
            // Only inject comms involving the CURRENT chat NPC — no omniscience
            const npcName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
            if (!npcName) {
                ctx.setExtensionPrompt('PhoneSocial', null, 200, 0, true);
                return;
            }

            // Find the contact that matches the current chat NPC
            const contact = state.contacts.find(c => c.name.toLowerCase() === npcName);
            if (!contact) {
                ctx.setExtensionPrompt('PhoneSocial', null, 200, 0, true);
                return;
            }

            // ── Collect SMS thread entries ──
            const thread = state.threads[contact.id];
            const smsEntries = (Array.isArray(thread) && thread.length)
                ? thread.slice(-6).map(m => ({
                    ts: m.ts || 0,
                    speaker: m.from === 'me' ? myName : contact.name,
                    text: m.imageUrl ? '[Photo]' : (m.text || ''),
                    channel: 'SMS'
                }))
                : [];

            // ── Collect call utterances ──
            const callEntries = (Array.isArray(state.callLog) && state.callLog.length)
                ? state.callLog
                    .filter(e => e.contactId === contact.id && e.dir === 'speak' && e.text)
                    .slice(-6)
                    .map(e => ({
                        ts: e.ts || 0,
                        speaker: e.fromMe ? myName : contact.name,
                        text: e.text,
                        channel: 'call'
                    }))
                : [];

            // ── Merge by timestamp, take most recent 8 total ──
            const allEntries = [...smsEntries, ...callEntries]
                .sort((a, b) => a.ts - b.ts)
                .slice(-8);

            if (!allEntries.length) {
                ctx.setExtensionPrompt('PhoneSocial', null, 200, 0, true);
                return;
            }

            const lines = allEntries.map(e =>
                `${e.speaker} (${e.channel}): ${e.text}`
            );

            const summary = lines.join('\n');
            const promptText = `[Your phone — recent comms with ${contact.name}]\n${summary}`;

            // Inject at depth 200 (low priority, after main narrative)
            ctx.setExtensionPrompt('PhoneSocial', promptText, 200, 0, true);
        } catch (e) {
            console.warn('[PhoneSocial] updateSmsInjection failed:', e);
        }
    }

    // -------------------------------------------------------------------
    // Auto-memory extraction (UIE-style databank)
    // Extracts durable relationship memories from SMS conversations
    // via the configured API, stored per-contact.
    // -------------------------------------------------------------------
    async function extractContactMemories(contactId, force) {
        const contact = state.contacts.find(c => c.id === contactId);
        if (!contact) return 0;
        const thread = state.threads[contactId];
        if (!Array.isArray(thread) || thread.length < 3) return 0;

        // Only extract every 5 messages to keep it lightweight (skip if forced/manual)
        if (!force) {
            const msgCount = thread.length;
            const lastExtracted = contact._lastExtractMsgCount || 0;
            if (msgCount - lastExtracted < 5) return 0;
            contact._lastExtractMsgCount = msgCount;
        }

        const ctx = getCtx();
        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
        const user = ctx?.name1 || 'You';

        // Build conversation transcript
        const transcript = thread.slice(-20).map(m => {
            const speaker = m.from === 'me' ? myName : contact.name;
            if (m.imageUrl) return `${speaker}: [sent a photo]`;
            return `${speaker}: ${m.text || ''}`;
        }).join('\n');

        const systemPrompt = `You are extracting ONLY vital, relationship-relevant memories from SMS/text conversations between "${myName}" and "${contact.name}".

Target: "${contact.name}" (the person being texted)

Return ONLY valid JSON (no markdown, no extra keys):
{"memories":[{"text":"...","tags":["..."]}]}

Rules:
- 1 to 3 memories max. If nothing important happened, return {"memories":[]}.
- Each memory must be about "${contact.name}" directly (they act, speak, promise, reveal, or are explicitly referenced).
- Each memory must be a durable fact that CHANGED or REVEALED something: plans, promises, secrets, emotional shifts, favors, agreements, injuries, betrayals, important info.
- No trivial entries (no greetings, "they replied", generic chat).
- 1 sentence per memory (10-60 words).
- Tags: short keywords like "promise", "secret", "plan", "favor", "trust", "romance", "info", "warning".`;

        const userPrompt = `SMS transcript between ${myName} and ${contact.name}:\n\n${transcript}\n\nExtract memories from this conversation.`;

        if (!contact.memories) contact.memories = [];
        const existing = new Set(contact.memories.map(m =>
            (m.text || '').toLowerCase().replace(/\s+/g, ' ').trim()));

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;

        try {
            const obj = JSON.parse(String(text).replace(/```json|```/g, '').trim());
            const mems = Array.isArray(obj?.memories) ? obj.memories : [];
            let added = 0;
            for (const m of mems) {
                const text = (m.text || '').trim();
                if (!text) continue;
                if (text.length < 15) continue; // Too short, not meaningful
                const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
                if (existing.has(key)) continue;
                existing.add(key);
                contact.memories.push({
                    text: text.slice(0, 320),
                    ts: Date.now(),
                    tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
                });
                added++;
            }
            if (added > 0) {
                console.log(`[PhoneSocial] extracted ${added} memory(ies) for ${contact.name}`);
                saveMeta();
            }
            return added;
        } catch (e) {
            console.warn('[PhoneSocial] memory extraction parse failed:', e?.message || e);
            return 0;
        }
    }

    // Reuse the configured API or ST fallback for memory extraction
    async function callTurboApi(systemPrompt, userPrompt) {
        const s = window.PhoneSocialSettings || {};
        const apiKey = s.apiKey?.trim();
        if (apiKey) {
            const rawUrl = ((s.apiUrl && s.apiUrl !== 'undefined' && s.apiUrl !== 'null') ? s.apiUrl : 'https://api.openai.com/v1').replace(/\/+$/, '');
            const model = s.model || 'gpt-4o-mini';
            const candidates = buildApiUrlCandidates(rawUrl);
            console.log('[PhoneSocial] turbo: API key set, trying', candidates.length, 'endpoints');
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            const key = apiKey.replace(/^bearer\s+/i, '').trim();
            headers['Authorization'] = `Bearer ${key}`;
            const host = rawUrl.toLowerCase();
            if (host.includes('nvidia.com') || host.includes('nano-gpt.com') || host.includes('nanogpt')) {
                headers['x-api-key'] = key;
                headers['api-key'] = key;
            }
            for (const url of candidates) {
                try {
                    console.log('[PhoneSocial] turbo: trying', url);
                    const res = await fetch(url, {
                        method: 'POST', headers,
                        body: JSON.stringify({
                            model,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: userPrompt },
                            ],
                            max_tokens: 4000, temperature: 0.3,
                        }),
                    });
                    console.log('[PhoneSocial] turbo: response', res.status, 'from', url);
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        console.warn('[PhoneSocial] turbo: HTTP', res.status, errText.slice(0, 200));
                        continue;
                    }
                    const data = await res.json().catch(() => null);
                    if (!data) {
                        console.warn('[PhoneSocial] turbo: no JSON from', url);
                        continue;
                    }
                    const text = extractApiReply(data);
                    if (text) {
                        console.log('[PhoneSocial] turbo: got reply, length', text.length);
                        return text;
                    }
                    console.warn('[PhoneSocial] turbo: no text in response');
                } catch (e) {
                    console.warn('[PhoneSocial] turbo: fetch failed for', url, e?.message || e);
                    continue;
                }
            }
            console.warn('[PhoneSocial] turbo: all API endpoints failed — check model name matches provider');
        } else {
            console.log('[PhoneSocial] turbo: no API key set');
        }
        // Fallback: use ST's generateQuietPrompt
        const ctx = getCtx();
        if (ctx?.generateQuietPrompt) {
            console.log('[PhoneSocial] turbo: falling back to ST generateQuietPrompt');
            try {
                // Prepend context isolation — ST's generateQuietPrompt still has access to the
                // full chat context and character cards. Without this, the model sees the ST
                // assistant's character traits and leaks them into generated content.
                const isolationPrefix = 'CRITICAL: You are generating content for a FICTIONAL roleplay setting. The SillyTavern system context (character cards, assistant personas, chat history) is IRRELEVANT. Respond ONLY based on the prompt below. Treat the system assistant and any non-story characters as non-existent.\n\n';
                const fullPrompt = isolationPrefix + systemPrompt + (userPrompt ? '\n\n' + userPrompt : '');
                const reply = await ctx.generateQuietPrompt({
                    quietPrompt: fullPrompt,
                    quietToLoud: false,
                    skipWIAN: true,
                    responseLength: 500,
                    trimToSentence: false,
                });
                console.log('[PhoneSocial] turbo: ST fallback got reply:', reply?.slice(0, 80));
                return reply;
            } catch (e) {
                console.warn('[PhoneSocial] turbo: ST fallback failed:', e?.message || e);
            }
        }
        return null;
    }


    async function extractMainChatMemories() {
        console.log('[PhoneSocial] extractMainChatMemories: state.contacts.length =', state.contacts.length, 'state view =', state.view);
        const ctx = getCtx();
        if (!ctx?.chat || !Array.isArray(ctx.chat)) return 0;
        const contacts = state.contacts;

        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
        const user = ctx?.name1 || 'You';

        // Get up to 80 messages from main chat (deeper scan)
        const recent = ctx.chat.slice(-80);
        const msgs = recent.map(msg => {
            const name = msg.name || (msg.is_user ? user : myName);
            const text = (msg.mes || msg.text || '').trim();
            return text ? `${name}: ${text}` : null;
        }).filter(Boolean);

        const rawLen = msgs.join('\n').length;
        console.log(`[PhoneSocial] memories scan: scanning ${msgs.length} msgs, ${rawLen} chars`);

        let transcript = '';
        const TRUNCATE_LIMIT = 40000;
        // Work backwards from newest messages so we keep the most recent context
        for (let i = msgs.length - 1; i >= 0; i--) {
            const candidate = transcript ? msgs[i] + '\n' + transcript : msgs[i];
            if (candidate.length > TRUNCATE_LIMIT) break;
            transcript = candidate;
        }
        const finalLen = msgs.join('\n').length;
        if (finalLen !== transcript.length) {
            console.log(`[PhoneSocial] memories scan: ${finalLen} raw → ${transcript.length} after truncate`);
        }

        if (!transcript) {
            console.log('[PhoneSocial] memories scan: no chat transcript');
            return 0;
        }

        const systemPrompt = `You are scanning a roleplay conversation transcript between "${user}" and "${myName}".

Your ONLY job: Extract EVERY NPC (side character) + relationship memories.

Return ONLY valid JSON (no markdown, no extra text):
{
  "npcs": [
    { "name": "NPC_Name", "about": "Brief 1-sentence description." }
  ],
  "memories": [
    { "name": "ContactName", "text": "Specific durable fact...", "tags": ["promise"] }
  ]
}

MANDATORY RULES — NO EXCEPTIONS:
- "npcs": Find EVERY side character. Every single person who speaks, is spoken to, or is mentioned by name. No limit. 2 is NOT enough unless this is a tiny transcript.
- MINIMUM: If the transcript has 20+ messages, you MUST find at least 4 NPCs. If you return fewer than 4 with 20+ messages, you FAILED.
- Scan every message individually. Do not skim. Characters mentioned once still count.
- "memories": 1 to 5 total. Each memory: 1 sentence, 10-60 words. The "name" must match one of the NPCs you listed in "npcs".
- Memories must be durable facts: promises, secrets, plans, betrayals, favors, relationship changes.
- npcs array MUST NOT be empty unless the transcript genuinely has zero side characters.
- ANTI-OMNISCIENCE RULE: Do NOT create memories about things said ABOUT an NPC by other characters when the NPC wasn't there. If characters discuss plans to surprise Sarah, that is NOT a memory for Sarah — she wasn't present. Only create memories about what the NPC themselves said/did, or what was said directly TO them while they were present.`;

        const userPrompt = `Roleplay conversation transcript:\n\n${transcript}\n\nExtract ALL NPCs and relationship memories from this conversation. Do NOT skip anyone — find every side character.`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) {
            console.log('[PhoneSocial] memories scan: API returned no response');
            return 0;
        }
        console.log('[PhoneSocial] memories scan: API raw:', text.slice(0, 300));

        // Strip reasoning tags, markdown, non-JSON prefix/suffix
        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const obj = JSON.parse(cleaned);
            const npcs = Array.isArray(obj?.npcs) ? obj.npcs : [];
            const mems = Array.isArray(obj?.memories) ? obj.memories : [];
            let totalAdded = 0;

            // Blocked names (uses shared fuzzy matcher)
            const blocked = getBlockedSet();

            // Create contacts for new NPCs
            for (const n of npcs) {
                const name = (n.name || '').trim();
                if (!name) continue;
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                if (contacts.some(c => c.name.toLowerCase() === norm)) continue;
                contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    source: 'scan',
                    memories: [],
                });
                const about = (n.about || '').trim();
                if (about) {
                    const c = contacts.find(x => x.name.toLowerCase() === norm);
                    if (c) c.memories.push({
                        text: about.slice(0, 320),
                        ts: Date.now(),
                        tags: ['introduction'],
                    });
                }
                totalAdded++;
                console.log(`[PhoneSocial] scan: created NPC "${name}"`);
            }

            // Add memories to existing contacts
            for (const m of mems) {
                const contactName = (m.name || '').trim();
                if (!contactName) continue;
                const contact = contacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
                if (!contact) continue;
                const memText = (m.text || '').trim();
                if (!memText || memText.length < 15) continue;
                if (!contact.memories) contact.memories = [];
                const existing = new Set(contact.memories.map(m2 =>
                    (m2.text || '').toLowerCase().replace(/\s+/g, ' ').trim()));
                const key = memText.toLowerCase().replace(/\s+/g, ' ').trim();
                if (existing.has(key)) continue;
                contact.memories.push({
                    text: memText.slice(0, 320),
                    ts: Date.now(),
                    tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
                });
                totalAdded++;
            }

            if (totalAdded > 0) {
                console.log(`[PhoneSocial] scan: +${totalAdded} items (NPCs + memories)`);
            }
            // Always purge after extraction — NPCs the API finds may not be real senders
            try { purgeStaleContacts(); } catch (_) {}
            saveMeta();
            return totalAdded;
        } catch (e) {
            console.warn('[PhoneSocial] memories scan parse failed:', e?.message || e, 'raw:', (text || '').slice(0, 200));
            return 0;
        }
    }

    // ─── Chirp Feed Generator ─────────────────────────────────────────
    async function generateChirpFeed() {
        console.log('[PhoneSocial] chirp: generating feed');
        const ctx = getCtx();
        if (!ctx) return;

        const contacts = state.contacts;
        const contactNames = contacts.map(c => c.name);
        const contactList = contactNames.length
            ? `\nKnown contacts: ${contactNames.join(', ')}`
            : '';

        // Extract setting from the CURRENT CHAT's character card (not chars[0] — could be the ST assistant)
        let setting = '';
        let settingSource = 'default';
        try {
            const chars = ctx?.characters;
            const currentCharName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
            let ch = null;
            // Priority: character object > match by name > first character in array
            if (ctx?.character && ctx.character.name) {
                ch = ctx.character;
                settingSource = 'ctx.character';
            } else if (Array.isArray(chars) && chars.length > 0) {
                if (currentCharName) {
                    ch = chars.find(c => c && c.name && c.name.toLowerCase() === currentCharName);
                    if (ch) settingSource = 'name2-match';
                }
                if (!ch) {
                    ch = chars[0];
                    settingSource = 'chars[0]-fallback';
                }
            }
            if (ch) {
                const chName = (ch.name || '').trim();
                const blocked = getBlockedSet();
                // NEVER use a blocked character's card as the world setting — their traits
                // (demon/incubus/etc.) contaminate Chirp posts even after the name is filtered.
                if (isBlocked(chName, blocked)) {
                    console.log(`[PhoneSocial] chirp: SKIPPING setting from "${chName}" — character is blocked/assistant`);
                } else {
                    const desc = (ch?.data?.description || '').trim().slice(0, 300);
                    const scenario = (ch?.data?.scenario || '').trim().slice(0, 200);
                    if (desc) setting = desc;
                    else if (scenario) setting = scenario;
                    console.log(`[PhoneSocial] chirp: setting from "${chName}" via ${settingSource}`);
                    if (setting) console.log(`[PhoneSocial] chirp: setting preview: ${setting.slice(0, 80)}`);
                }
            }
        } catch (_) {}
        const settingLine = setting
            ? `Set in: ${setting}`
            : 'Set in: A modern setting.';

        const systemPrompt = `You are generating a Chirp (Twitter clone) social media feed.
${settingLine}${contactList}

CRITICAL WORLD RULES:
- The ONLY information you have about this world is the "Set in:" line above. Ignore everything else you know.
- This feed exists in a FICTIONAL roleplay world. System assistants, AI characters, chatbot helper personalities — none of these exist in this world.
- DO NOT create posts about supernatural beings (demons, incubi, succubi, angels) unless the "Set in:" line explicitly describes a supernatural setting.
- If the "Set in:" line describes a normal/modern setting, ALL posts must be about normal human life in that setting.
- NPCs in this world have ordinary lives, jobs, relationships, and hobbies. They are not aware of any external AI or assistant system.

Generate 8-12 chirps (posts). Each post is a first-person status update from its author. Write from these people:
- The contacts listed above (set isContact=true for them) — post as them, about their lives
- Random global users (set isContact=false) — generic social media users in this setting

Return ONLY valid JSON array:
[
  {
    "name": "Author Name",
    "handle": "username",
    "text": "Post content...",
    "isContact": true/false,
    "imagePrompt": "optional — describe a scene/image for this post. Only for 2-3 posts, leave null for others."
  }
]

Rules:
- Contact posts should feel relevant to their personality and the story setting
- Global posts should feel like real social media — funny, mundane, dramatic, news
- Mix tones: some funny, some serious, some casual
- Each chirp should be 10-80 words, natural social media style
- Include hashtags occasionally (#vibes #mood #storyrelevant)
- For 2-3 posts, add an imagePrompt field with a short visual description (selfies, scenery, food pics, memes)
- imagePrompt should be null if no image needed
- Output ONLY the JSON array, no other text`;

        const userPrompt = `Generate a Chirp feed for a roleplay set in this world. Mix contact posts and global posts.`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) {
            console.log('[PhoneSocial] chirp: API returned nothing');
            return;
        }
        console.log('[PhoneSocial] chirp: API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const posts = arr.map((item, i) => ({
                id: 'chirp_' + Date.now() + '_' + i,
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user' + i).trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                    isContact: !!item.isContact,
                },
                text: (item.text || '').trim(),
                imageUrl: item.imagePrompt ? 'https://image.pollinations.ai/prompt/' + encodeURIComponent(item.imagePrompt) : null,
                ts: Date.now() - Math.floor(Math.random() * 3600000 * (arr.length - i)),
                likes: 0,
                likedBy: [],
                comments: [],
            })).filter(p => p.text.length > 3);

            // HARD FILTER: Remove any post mentioning blocked/assistant names or supernatural traits
            // that the model leaks from ST context (even after the prompt tells it not to).
            const blockedNames = getBlockedSet();
            const blockedPatterns = [];
            for (const b of blockedNames) {
                if (b.length > 2) blockedPatterns.push(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            }
            // Also catch common supernatural traits that leak from assistant character cards
            blockedPatterns.push('incubus', 'succubus', 'demon', 'horns', 'wings', 'tail');
            const hardFilter = new RegExp(blockedPatterns.join('|'), 'i');
            const beforeFilter = posts.length;
            const filteredPosts = posts.filter(p =>
                !hardFilter.test(p.text) &&
                !hardFilter.test(p.author.name) &&
                !hardFilter.test(p.author.handle)
            );
            if (filteredPosts.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredPosts.length} posts via hard filter (blocked name or trait)`);
            }
            if (!filteredPosts.length) {
                console.log('[PhoneSocial] chirp: all posts filtered out (Akuma content)');
                return;
            }
            state.chirpPosts = filteredPosts;
            state.chirpLastRefresh = Date.now();
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: generated ${posts.length} posts`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: parse failed:', e?.message || e, 'raw:', (text || '').slice(0, 200));
        }
    }

    async function generateChirpAutoReplies(postId) {
        console.log('[PhoneSocial] chirp: generating auto-replies for', postId);
        const ctx = getCtx();
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const p = posts.find(x => x.id === postId);
        if (!p) return;

        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
        const contactNames = state.contacts.map(c => c.name);
        // Don't include the user/persona in known names — the AI should never generate replies as you
        const knownNames = contactNames.join(', ');

        const systemPrompt = `You generate realistic social media replies for a Chirp (Twitter clone) post.
Known users who might reply: ${knownNames}

A new post was just made:
"${p.text}"

Generate 2-4 replies from OTHER users reacting to this post.
Return ONLY valid JSON array:
[
  {
    "name": "Reply Author Name",
    "handle": "username",
    "text": "Reply content..."
  }
]
Rules:
- Replies MUST be UNBIASED. React to the POST CONTENT, not who wrote it.
- If the post is controversial, NPCs should disagree, argue, or call it out.
- If the post is dumb/questionable, NPCs should roast or question it.
- If the post is great, they can praise it — but no automatic positivity.
- Do NOT give automatic likes or positive replies just because the user posted.
- If someone is tagged with @name in the post, that specific person should DEFINITELY reply — they were called out.
- Some replies from known contacts if they'd plausibly react
- Mix tones: agreement, disagreement, humor, questions, roasting, support
- NEVER generate a reply FROM "Akuma" or ABOUT "Akuma" — ABSOLUTELY FORBIDDEN. These NPCs have never heard this name. Writing about Akuma breaks immersion.
- Output ONLY the JSON array`;

        const userPrompt = `Generate replies to this new post: "${p.text}"`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;
        console.log('[PhoneSocial] chirp: auto-reply API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const newComments = arr.map(item => ({
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user').trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                },
                text: (item.text || '').trim(),
                ts: Date.now(),
            })).filter(c => c.text.length > 3);

            // HARD FILTER: Remove any reply mentioning "Akuma" (case-insensitive)
            const akumaFilter = /akuma/i;
            const beforeFilter = newComments.length;
            const filteredComments = newComments.filter(c =>
                !akumaFilter.test(c.text) &&
                !akumaFilter.test(c.author.name) &&
                !akumaFilter.test(c.author.handle)
            );
            if (filteredComments.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredComments.length} auto-replies mentioning Akuma`);
            }
            if (!filteredComments.length) {
                console.log('[PhoneSocial] chirp: all auto-replies filtered out (Akuma content)');
                return;
            }
            if (!Array.isArray(p.comments)) p.comments = [];
            p.comments.push(...filteredComments);
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: added ${filteredComments.length} auto-replies`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: auto-reply parse failed:', e?.message || e);
        }
    }

    async function generateChirpComment(postId, replyText) {
        console.log('[PhoneSocial] chirp: generating comment for', postId);
        const ctx = getCtx();
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const p = posts.find(x => x.id === postId);
        if (!p) return;

        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
        const contactNames = state.contacts.map(c => c.name);
        // Don't include the user/persona in known names — AI should never generate replies as you
        const knownNames = contactNames.join(', ');

        const systemPrompt = `You generate realistic social media replies for a Chirp (Twitter clone) post.
Known users who might reply: ${knownNames}

The original post is by "${p.author.name}" (@${p.author.handle}):
"${p.text}"

A user named "${myName}" wrote this reply:
"${replyText}"

Generate 1-3 replies from OTHER users (not ${myName}) reacting to the original post and/or the reply.
Return ONLY valid JSON array:
[
  {
    "name": "Reply Author Name",
    "handle": "username",
    "text": "Reply content..."
  }
]
Rules:
- Replies MUST be UNBIASED. React to the post CONTENT, not who wrote it.
- If the post is controversial, NPCs should disagree, argue, or call it out.
- Do NOT give automatic positive replies just because the user posted.
- If someone is tagged with @name in the reply, that specific person should DEFINITELY reply — they were called out.
- Some might be from known contacts
- Include at least one reply
- NEVER generate a reply FROM "Akuma" or ABOUT "Akuma" — ABSOLUTELY FORBIDDEN. These NPCs have never heard this name. Writing about Akuma breaks immersion.
- Output ONLY the JSON array`;

        const userPrompt = `Generate replies to: "${p.text}" where ${myName} replied: "${replyText}"`;

        // Always add the user's comment immediately
        if (!Array.isArray(p.comments)) p.comments = [];
        p.comments.push({
            author: { name: myName, handle: myName.toLowerCase().replace(/[^a-z0-9_]/g, ''), isUser: true },
            text: replyText,
            ts: Date.now() - 1000,
        });
        saveMeta();
        render();
        console.log('[PhoneSocial] chirp: user comment added');

        // Then try to get AI replies (best-effort, won't lose user's comment if it fails)
        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;
        console.log('[PhoneSocial] chirp: comment API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const newComments = arr.map(item => ({
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user').trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                },
                text: (item.text || '').trim(),
                ts: Date.now(),
            })).filter(c => c.text.length > 3);

            // HARD FILTER: Remove any reply mentioning "Akuma" (case-insensitive)
            const akumaFilter = /akuma/i;
            const beforeFilter = newComments.length;
            const filteredComments = newComments.filter(c =>
                !akumaFilter.test(c.text) &&
                !akumaFilter.test(c.author.name) &&
                !akumaFilter.test(c.author.handle)
            );
            if (filteredComments.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredComments.length} comment replies mentioning Akuma`);
            }
            if (!filteredComments.length) return;
            p.comments.push(...filteredComments);
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: added ${filteredComments.length} AI replies`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: comment parse failed:', e?.message || e);
        }
    }

    // -------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------
    function purgeStaleContacts() {
        const ctx = getCtx();
        if (!ctx?.chat || !state.contacts.length) return;
        // Collect sender names from current chat ONLY — no text body search.
        // Text-body search causes a self-reinforcing cycle: SMS injection → AI mentions
        // the name → text has the name → purge keeps it → SMS continues.
        const chatSenders = new Set();
        const blocked = getBlockedSet();
        for (const msg of ctx.chat) {
            if (!msg) continue;
            const name = (msg.name || '').trim().toLowerCase();
            if (name) chatSenders.add(name);
        }
        const before = state.contacts.length;
        state.contacts = state.contacts.filter(c => {
            // Manual and scan-discovered contacts are always kept — check BEFORE isBlocked
            // because isBlocked uses fuzzy includes() matching that can catch manual names
            if (c.source === 'manual') return true;
            // Scan-discovered NPCs come from API memory extraction — they exist in
            // conversation content but aren't necessarily chat senders, so the sender
            // check below would incorrectly remove them immediately.
            if (c.source === 'scan') return true;
            if (isBlocked(c.name, blocked)) {
                console.log(`[PhoneSocial] purge: blocked "${c.name}"`);
                return false;
            }
            // Remove names with non-standard characters (+, #, etc) — corrupted
            if (/[+#*@]/.test(c.name)) {
                console.log(`[PhoneSocial] purge: suspicious name "${c.name}"`);
                return false;
            }
            // Only keep contacts whose name appears as a sender in current chat
            if (chatSenders.has(c.name.toLowerCase())) return true;
            console.log(`[PhoneSocial] purge: removing "${c.name}" — not a sender`);
            return false;
        });
        // Also clean up orphaned threads
        const validIds = new Set(state.contacts.map(c => c.id));
        for (const cid of Object.keys(state.threads)) {
            if (!validIds.has(cid)) {
                delete state.threads[cid];
                console.log(`[PhoneSocial] purge: removing thread for "${cid}"`);
            }
        }
        if (state.contacts.length !== before) {
            console.log(`[PhoneSocial] purge: removed ${before - state.contacts.length} stale contacts (${state.contacts.length} remain)`);
        } else {
            console.log(`[PhoneSocial] purge: 0 removed, ${state.contacts.length} contacts kept`);
        }
        // Log remaining contacts for debugging
        if (state.contacts.length > 0) {
            const names = state.contacts.map(c => `"${c.name}" (${c.source})`).join(', ');
            console.log(`[PhoneSocial] remaining contacts: ${names}`);
        }
    }

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
                // Start proactive NPC cycle for this chat
                startProactiveCycle();
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
                    harvestNPCs();
                    purgeStaleContacts();
                    saveMeta();
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
