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
        commsProfile: 'modern',     // World comms profile / diegetic device theme (per-chat via worldCommsProfile)
    };

    // ───────────────────────────────────────────────────────────────────
    // WORLD COMMS PROFILES — Diegetic Device Mode (Phase 1: chrome + labels)
    // Each profile ONLY provides labels + a themeClass. The themeClass maps to
    // a CSS-variable-only block in injectPastelTheme() — themes redefine colors,
    // never layout. This makes themes regression-proof: switching a theme cannot
    // break base UI because base rules read from var(--ps-*) and themes only
    // reassign those variables.
    // ───────────────────────────────────────────────────────────────────
    const WORLD_COMMS_PROFILES = {
        modern: {
            era: 'modern',
            deviceName: 'PhoneSocial',
            messagesLabel: 'Messages',
            callsLabel: 'Phone',
            contactsLabel: 'Contacts',
            browserLabel: 'Browser',
            feedLabel: 'Chirp',
            feedSystemName: 'Chirp',
            searchEngineName: 'the web',
            themeClass: 'ps-theme-modern',
            tone: 'modern, casual, texting slang and emoji',
            statusbarCarrier: '📱 PhoneSocial',
            incomingMessageText: '{name} sent you a message.',
            incomingCallText: '{name} is calling…',
            icons: {
                dial: '📞', sms: '💬', contacts: '👥', albums: '🎨',
                settings: '⚙️', browser: '🌐', chirp: '🐦',
                favorites: '❤️', memories: '🧠',
            },
        },
        fantasy: {
            era: 'fantasy',
            deviceName: 'MirrorNet',
            messagesLabel: 'Whispers',
            callsLabel: 'Scrying',
            contactsLabel: 'Acquaintances',
            browserLabel: 'Great Archive',
            feedLabel: 'Town Crier',
            feedSystemName: 'Town Crier',
            searchEngineName: 'the Great Archive',
            themeClass: 'ps-theme-fantasy',
            tone: 'medieval high-fantasy, formal and archaic, no modern slang',
            statusbarCarrier: '🔮 MirrorNet',
            incomingMessageText: 'The mirror flickers — {name} is reaching out.',
            incomingCallText: 'A scrying call arrives from {name}.',
            icons: {
                // Illuminated-manuscript emblems — filled gold heraldic glyphs.
                // 24x24 viewBox, fill=currentColor so they inherit the gold theme.
                dial: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a1 1 0 0 1 .9.56l1.9 3.9 4.3.6a1 1 0 0 1 .56 1.7l-3.1 3 .74 4.28a1 1 0 0 1-1.45 1.05L12 15.9V2z" opacity=".55"/><path d="M12 2v13.9l-3.9 2.05a1 1 0 0 1-1.45-1.05l.74-4.28-3.1-3a1 1 0 0 1 .56-1.7l4.3-.6 1.9-3.9A1 1 0 0 1 12 2z"/></svg>', // scrying — a heraldic star/compass
                sms: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5l-4 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M6 8h12M6 11h8" stroke="#1a0f28" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>', // whispers — a sealed scroll-speech
                contacts: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/><circle cx="12" cy="8" r="1.6" fill="#1a0f28"/></svg>', // acquaintances — a portrait medallion
                albums: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v14H4z" opacity=".5"/><path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 15l3-4 3 3 2-2 2 3z" fill="#1a0f28"/><circle cx="8.5" cy="8.5" r="1.5" fill="#1a0f28"/></svg>', // tapestries — a framed illumination
                settings: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2 3 3.5-.8-.8 3.5L20 12l-3.3 1.3.8 3.5-3.5-.8L12 22l-2-3-3.5.8.8-3.5L4 12l3.3-1.3L6.5 4.2 10 5z"/><circle cx="12" cy="12" r="3" fill="#1a0f28"/></svg>', // enchantments — an alchemical seal
                browser: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" fill="none" stroke="#1a0f28" stroke-width="1.2"/></svg>', // great archive — an armillary orb
                chirp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 14c4 3 10 3 15-3-1 4-4 7-8 7-3 0-5-1.5-6-4z"/><path d="M9 4c3-1 6 1 7 4l4 1-3 2 .5 3-3-2c-3 1-6-1-6-4z"/><circle cx="15" cy="8" r=".9" fill="#1a0f28"/></svg>', // town crier — a raven/messenger
                favorites: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21C5 15 3 11 3 8a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 3-2 7-9 13z"/></svg>', // cherished — a heraldic heart
                memories: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h9l3 3v15l-6-3-6 3z"/><path d="M9 8h6M9 11h4" stroke="#1a0f28" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>', // remembrances — a bound tome
            },
        },
        scifi: {
            era: 'scifi',
            deviceName: 'CommLink',
            messagesLabel: 'Transmissions',
            callsLabel: 'Holo-Call',
            contactsLabel: 'Crew Roster',
            browserLabel: 'Galactic Index',
            feedLabel: 'Relay Feed',
            feedSystemName: 'Relay Feed',
            searchEngineName: 'the Galactic Index',
            themeClass: 'ps-theme-scifi',
            tone: 'futuristic sci-fi, clipped and technical, references to systems/relays/ships',
            statusbarCarrier: '🛰️ CommLink',
            incomingMessageText: 'Incoming transmission from {name}.',
            incomingCallText: '{name} is opening a holo-channel…',
            icons: {
                dial: '📡', sms: '📨', contacts: '🧑‍🚀', albums: '🖼️',
                settings: '🛠️', browser: '🌌', chirp: '📶',
                favorites: '⭐', memories: '💾',
            },
        },
    };
    // 'auto' aliases to modern
    WORLD_COMMS_PROFILES.auto = WORLD_COMMS_PROFILES.modern;

    const COMMS_PROFILE_OPTIONS = [
        { value: 'modern', label: '📱 Modern (Smartphone)' },
        { value: 'fantasy', label: '🔮 Fantasy (MirrorNet)' },
        { value: 'scifi', label: '🛰️ Sci-Fi (CommLink)' },
    ];
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
            worldCommsProfile: null, // per-chat comms profile key override (null → use global settings.commsProfile)
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
        // Use the ST chat ID for per-session isolation — a new chat = new PhoneSocial data
        if (ctx.chatId) return 'chat_' + String(ctx.chatId).replace(/[^a-z0-9_-]/g, '_');
        // Fallback for edge cases where chatId isn't available
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

