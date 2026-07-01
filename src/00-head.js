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
        ttsProvider: 'elevenlabs',  // TTS provider: 'elevenlabs' or ''
        ttsApiKey: '',              // API key for TTS provider
    };
    const VIEW_HISTORY_LIMIT = 25;
    const VALID_VIEWS = new Set(['home', 'contacts', 'sms', 'thread', 'dial', 'settings', 'albums', 'profile', 'memories', 'call', 'browser', 'chirp', 'chirp-thread', 'favorites']);
    const VIEW_PARENT = {
        'thread': 'sms', 'profile': 'contacts', 'chirp-thread': 'chirp',
        'call': 'home', 'browser': 'home', 'memories': 'home', 'albums': 'home',
    };

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
            lastUserMessageAt: 0,  // timestamp of last user message (for inactivity tracking)
            userDnd: false,        // do-not-disturb: suppress all autonomous messages
            mutedContacts: {},     // {contactId: true} — per-contact mute
            scheduleSelectedDay: null, // selected day for schedule pill display
            ttsVoices: [],             // cached TTS voice list [{voice_id, name}]
            ttsVoicesFetched: 0,       // timestamp of last voice fetch
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
        if (!ctx) {
            return {
                set,
                activeName: '',
                blockedCards: new Set(),
            };
        }
        const activeName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
        if (activeName) set.add(activeName);
        const name1 = (ctx.name1 || '').trim().toLowerCase();
        if (name1) set.add(name1);
        const personaName = (ctx.chatMetadata?.user_name || '').trim().toLowerCase();
        if (personaName) set.add(personaName);
        const blockedCards = new Set();
        if (Array.isArray(ctx.characters)) {
            for (const ch of ctx.characters) {
                const n = (ch?.name || '').trim().toLowerCase();
                if (!n || n === activeName) continue;
                blockedCards.add(n);
            }
        }
        return { set, activeName, blockedCards };
    }

    /** Check if a name matches any blocked entry (contains a blocked substring) */
    function isBlocked(name, blockedSet) {
        const norm = (name || '').trim().toLowerCase();
        if (!norm) return true;
        const entries = blockedSet instanceof Set ? blockedSet : blockedSet?.set;
        if (!entries) return true;
        if (entries.has(norm)) return true;
        for (const b of entries) {
            // Only check if the name CONTAINS a blocked substring.
            // Do NOT check the reverse (b.includes(norm)) — that would
            // incorrectly block "Corey" because "Corey + Jay" contains it.
            if (norm.includes(b)) return true;
        }
        return false;
    }

