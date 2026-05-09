// PhoneSocial — SillyTavern Extension
// Per-chat phone simulator: NPC-derived contacts, SMS/calls, no data bleed.
// Install: clone into ~/SillyTavern/public/extensions/PhoneSocial/, reload ST.

(function () {
    'use strict';

    console.log('[PhoneSocial] 📱 script loaded');

    const EXT_NAME = 'PhoneSocial';
    const META_KEY = 'PhoneSocial';

    // -------------------------------------------------------------------
    // Per-chat state (reset on every CHAT_CHANGED)
    // -------------------------------------------------------------------
    let state = freshState();

    function freshState() {
        return {
            contacts: [],      // [{id, name, number, source: 'npc'|'manual'}]
            threads: {},       // { contactId: [{from:'me'|'them', text, ts}] }
            callLog: [],       // [{contactId, dir:'out'|'in', ts, duration}]
            activeContact: null,
            dialBuf: '',
            view: 'home',      // 'home' | 'contacts' | 'sms' | 'thread' | 'dial'
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
        const ctx = getCtx();
        if (!ctx) return null;
        if (!ctx.chatMetadata) ctx.chatMetadata = {};
        if (!ctx.chatMetadata[META_KEY]) ctx.chatMetadata[META_KEY] = {};
        return ctx.chatMetadata[META_KEY];
    }

    function saveMeta() {
        const ctx = getCtx();
        const meta = getChatMeta();
        if (!meta) return;
        meta.contacts = state.contacts;
        meta.threads = state.threads;
        meta.callLog = state.callLog;
        try { ctx?.saveMetadata?.(); } catch (e) { /* ignore */ }
    }

    function loadMeta() {
        const meta = getChatMeta();
        state = freshState();
        if (!meta) return;
        state.contacts = Array.isArray(meta.contacts) ? meta.contacts : [];
        state.threads = (meta.threads && typeof meta.threads === 'object') ? meta.threads : {};
        state.callLog = Array.isArray(meta.callLog) ? meta.callLog : [];
    }

    // -------------------------------------------------------------------
    // NPC harvesting — scan chat for character names, auto-add as contacts
    // -------------------------------------------------------------------
    function harvestNPCs() {
        const ctx = getCtx();
        if (!ctx?.chat) return;
        const seen = new Set(state.contacts.map(c => c.name.toLowerCase()));
        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const name = (msg.name || '').trim();
            if (!name || seen.has(name.toLowerCase())) continue;
            seen.add(name.toLowerCase());
            state.contacts.push({
                id: 'npc_' + name.toLowerCase().replace(/\s+/g, '_'),
                name,
                number: genNumber(),
                source: 'npc',
            });
        }
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
        btn.type = 'button';
        btn.textContent = '📱';
        btn.title = 'PhoneSocial';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PhoneSocial] 🔘 button clicked');
            togglePanel();
        });
        btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PhoneSocial] 👆 button touched');
            togglePanel();
        });
        document.body.appendChild(btn);
    }

    function ensurePanel() {
        let panel = document.getElementById('phonesocial-panel');
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'phonesocial-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);
        return panel;
    }

    function togglePanel() {
        const panel = ensurePanel();
        if (panel.style.display === 'none') {
            harvestNPCs();
            saveMeta();
            render();
            panel.style.display = 'flex';
        } else {
            panel.style.display = 'none';
        }
    }

    function render() {
        const panel = ensurePanel();
        let body = '';
        switch (state.view) {
            case 'contacts': body = viewContacts(); break;
            case 'sms':      body = viewSmsList(); break;
            case 'thread':   body = viewThread(); break;
            case 'dial':     body = viewDial(); break;
            default:         body = viewHome();
        }
        panel.innerHTML = `
            <div class="ps-header">
                <span class="ps-title">📱 PhoneSocial</span>
                <button class="ps-close" data-act="close">✕</button>
            </div>
            <div class="ps-body">${body}</div>
            <div class="ps-nav">
                <button data-act="nav" data-view="home">Home</button>
                <button data-act="nav" data-view="contacts">Contacts</button>
                <button data-act="nav" data-view="sms">SMS</button>
                <button data-act="nav" data-view="dial">Dial</button>
            </div>
        `;
        bindPanel(panel);
    }

    function viewHome() {
        return `
            <div class="ps-home">
                <p>Contacts: <b>${state.contacts.length}</b></p>
                <p>Threads: <b>${Object.keys(state.threads).length}</b></p>
                <p>Calls: <b>${state.callLog.length}</b></p>
                <p class="ps-hint">Tap a tab below to start.</p>
            </div>
        `;
    }

    function viewContacts() {
        if (!state.contacts.length) {
            return `<p class="ps-empty">No contacts yet. NPCs from this chat will show up here.</p>`;
        }
        return `
            <ul class="ps-list">
                ${state.contacts.map(c => `
                    <li data-act="open-thread" data-id="${c.id}">
                        <b>${escape(c.name)}</b>
                        <span>${escape(c.number)}</span>
                        <small>${c.source}</small>
                    </li>
                `).join('')}
            </ul>
        `;
    }

    function viewSmsList() {
        const ids = Object.keys(state.threads);
        if (!ids.length) return `<p class="ps-empty">No conversations yet.</p>`;
        return `
            <ul class="ps-list">
                ${ids.map(id => {
                    const c = state.contacts.find(x => x.id === id);
                    const last = state.threads[id]?.slice(-1)[0];
                    return `
                        <li data-act="open-thread" data-id="${id}">
                            <b>${escape(c?.name || id)}</b>
                            <span>${escape(last?.text || '')}</span>
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
        return `
            <div class="ps-thread-head">
                <button data-act="nav" data-view="sms">←</button>
                <b>${escape(c.name)}</b>
                <button data-act="call" data-id="${c.id}">📞</button>
            </div>
            <div class="ps-thread">
                ${msgs.map(m => `
                    <div class="ps-msg ps-${m.from}">${escape(m.text)}</div>
                `).join('')}
            </div>
            <div class="ps-compose">
                <input id="ps-input" type="text" placeholder="Message…" />
                <button data-act="send">Send</button>
            </div>
        `;
    }

    function viewDial() {
        return `
            <div class="ps-dial">
                <div class="ps-dial-display">${escape(state.dialBuf || '—')}</div>
                <div class="ps-dial-pad">
                    ${'123456789*0#'.split('').map(k => `
                        <button data-act="key" data-k="${k}">${k}</button>
                    `).join('')}
                </div>
                <div class="ps-dial-actions">
                    <button data-act="dial-clear">⌫</button>
                    <button data-act="dial-call" class="ps-call">Call</button>
                </div>
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
        panel.querySelectorAll('[data-act]').forEach(el => {
            el.addEventListener('click', onAction);
        });
    }

    function onAction(ev) {
        const el = ev.currentTarget;
        const act = el.getAttribute('data-act');
        switch (act) {
            case 'close':
                document.getElementById('phonesocial-panel').style.display = 'none';
                return;
            case 'nav':
                state.view = el.getAttribute('data-view');
                if (state.view === 'contacts') harvestNPCs();
                saveMeta();
                render();
                return;
            case 'open-thread':
                state.activeContact = el.getAttribute('data-id');
                if (!state.threads[state.activeContact]) state.threads[state.activeContact] = [];
                state.view = 'thread';
                saveMeta();
                render();
                return;
            case 'send': {
                const input = document.getElementById('ps-input');
                const text = (input?.value || '').trim();
                if (!text || !state.activeContact) return;
                state.threads[state.activeContact].push({ from: 'me', text, ts: Date.now() });
                simulateReply(state.activeContact);
                saveMeta();
                render();
                return;
            }
            case 'call': {
                const id = el.getAttribute('data-id');
                state.callLog.push({ contactId: id, dir: 'out', ts: Date.now(), duration: 0 });
                saveMeta();
                alert('Calling ' + (state.contacts.find(c => c.id === id)?.name || id) + '…');
                return;
            }
            case 'key':
                state.dialBuf += el.getAttribute('data-k');
                render();
                return;
            case 'dial-clear':
                state.dialBuf = state.dialBuf.slice(0, -1);
                render();
                return;
            case 'dial-call':
                if (!state.dialBuf) return;
                alert('Dialing ' + state.dialBuf + '…');
                state.callLog.push({ contactId: null, dir: 'out', ts: Date.now(), duration: 0, raw: state.dialBuf });
                state.dialBuf = '';
                saveMeta();
                render();
                return;
        }
    }

    function simulateReply(contactId) {
        const replies = ['k', 'lol', 'oh?', 'tell me more', 'hmm', 'sure', 'wyd', 'omw'];
        const text = replies[Math.floor(Math.random() * replies.length)];
        setTimeout(() => {
            if (!state.threads[contactId]) return;
            state.threads[contactId].push({ from: 'them', text, ts: Date.now() });
            saveMeta();
            if (state.view === 'thread' && state.activeContact === contactId) render();
        }, 800 + Math.random() * 1500);
    }

    // -------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------
    function onChatChanged() {
        loadMeta();
        harvestNPCs();
        saveMeta();
        const panel = document.getElementById('phonesocial-panel');
        if (panel && panel.style.display !== 'none') render();
    }

    function hookEvents() {
        const ctx = getCtx();
        if (!ctx?.eventSource || !ctx?.eventTypes) return false;
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
            harvestNPCs();
            saveMeta();
        });
        return true;
    }

    function init() {
        ensureButton();
        ensurePanel();
        loadMeta();
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

        console.log('[PhoneSocial] ✅ initialized; button in DOM:', !!document.getElementById('phonesocial-btn'));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
