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
        try {
            const ctx = getCtx();
            if (!ctx?.chatMetadata) return null;
            if (!ctx.chatMetadata[META_KEY]) ctx.chatMetadata[META_KEY] = {};
            return ctx.chatMetadata[META_KEY];
        } catch (e) { return null; }
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
        // Block the main character, user, chat name, and system noise
        const charName = (ctx.name || '').trim().toLowerCase();
        const chatName = (ctx.name1 || '').trim().toLowerCase();
        const personaName = (ctx.chatMetadata?.user_name || '').trim().toLowerCase();
        const blocked = new Set([charName, chatName, personaName, 'system', 'sillytavern system', 'narrator'].filter(Boolean));
        const debug = [];
        const seen = new Set(state.contacts.map(c => c.name.toLowerCase()));
        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const name = (msg.name || '').trim();
            if (!name) continue;
            const norm = name.toLowerCase();
            if (blocked.has(norm)) { debug.push(`SKIP(blocked): "${name}"`); continue; }
            if (seen.has(norm)) { debug.push(`SKIP(seen): "${name}"`); continue; }
            seen.add(norm);
            debug.push(`HARVEST: "${name}"`);
            state.contacts.push({
                id: 'npc_' + norm.replace(/\s+/g, '_'),
                name,
                number: genNumber(),
                source: 'npc',
            });
        }
        if (debug.length) console.log('[PhoneSocial] harvestNPCs:', debug);
        // Second pass: scan message text for named NPCs mentioned in prose/dialogue
        try {
            harvestNamesFromText(blocked, seen, debug);
        } catch (_e) {
            console.warn('[PhoneSocial] text harvest failed:', _e);
        }
    }

    // -------------------------------------------------------------------
    // Name extraction from message prose (single-character chats)
    // -------------------------------------------------------------------
    function harvestNamesFromText(blocked, seen, debug) {
        // Common English words that are capitalized but NOT names — filter aggressively
        const commonWords = new Set([
            'i','a','the','and','but','for','not','you','all','any','can','her','his','had',
            'has','how','its','let','may','was','our','out','new','own','say','she','too',
            'use','get','got','him','one','two','did','could','will','just','been','from',
            'they','then','there','these','their','this','that','what','when','where','which',
            'who','why','would','with','about','after','before','into','over','some',
            // Narrative/narration words often capitalized in RP
            'the','he','she','they','we','it','as','at','by','in','is','no','so','up',
            'if','me','do','go','be','have','make','take','come','know','think','look',
            'want','give','show','seem','help','through','many','much','more','most','very',
            'back','down','still','even','each','also','well','only','very','just','like',
            'time','year','people','way','day','man','world','life','hand','part','child',
            'eye','woman','place','work','week','case','point','company','group','problem',
            'fact','good','now','here','right','left','never','always','always','never',
        ]);

        // Patterns indicating a name follows (dialogue attribution, relationships)
        const namePatterns = [
            /(?:said|told|asked|replied|answered|muttered|whispered|shouted|called|yelled|sighed|laughed|smiled|glared|stared|watched)\s+(?:that\s+)?(?:a\s+)?(?:very\s+)?(?:the\s+)?([A-Z][a-z]{1,15})/g,
            /(?:named|called|knows?|know|met|sees?|saw|found|followed|hugged|kissed|grabbed|pulled|pushed|hit|slapped)\s+(?:me|him|her|them|you)\s+(?:named\s+)?([A-Z][a-z]{1,15})/g,
            /(?:his|her|their)\s+(?:girlfriend|boyfriend|sister|brother|mother|father|mom|dad|friend|partner|lover|roommate|classmate|enemy)\s+(?:is\s+|was\s+|named\s+)?([A-Z][a-z]{1,15})/g,
            /(?:oh|hey|hello|hi)\s+,\s*([A-Z][a-z]{1,15})/g,
            /(?:^|\s)[\""]([A-Z][a-z]{1,15})[\""]\s*(?:,?\s*(?:he|she|they)\s+(?:said|replied|asked|laughed|said|muttered|whispered))/g,
        ];

        const ctx = getCtx();
        if (!ctx?.chat) return;

        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const text = (msg.mes || msg.text || '');
            if (!text) continue;

            // Find all capitalized words (potential names)
            const capWords = text.match(/\b[A-Z][a-z]{1,20}\b/g) || [];
            for (const word of capWords) {
                const norm = word.toLowerCase();
                if (blocked.has(norm)) continue;
                if (seen.has(norm)) continue;
                if (commonWords.has(norm)) continue;
                // Names should be 2+ chars and not too long
                if (norm.length < 2) continue;

                // Bonus confidence: check if word appears near name-indicating patterns
                let confidence = 0;
                for (const pat of namePatterns) {
                    pat.lastIndex = 0;
                    let m;
                    while ((m = pat.exec(text)) !== null) {
                        if (m[1] && m[1].toLowerCase() === norm) {
                            confidence += 2;
                        }
                    }
                }
                // Also check if name appears in quotes (dialogue)
                if (text.includes(`"${word}"`) || text.includes(`'${word}'`)) confidence += 1;

                if (confidence >= 1) {
                    seen.add(norm);
                    debug.push(`TEXT harvest(💬${confidence}): "${word}"`);
                    state.contacts.push({
                        id: 'npc_' + norm.replace(/\s+/g, '_'),
                        name: word,
                        number: genNumber(),
                        source: 'npc-text',
                    });
                }
            }
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
        btn.addEventListener('touchend', handler);
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
            'z-index:2147483647',
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
        panel.id = 'phonesocial-panel';
        panel.style.cssText = [
            'position:fixed',
            'top:0',
            'right:0',
            'bottom:0',
            'width:85vw',
            'max-width:380px',
            'background:linear-gradient(to bottom, #ede9fe, #fdf4ff)',
            'color:#581c87',
            'border:none',
            'box-shadow:-4px 0 24px rgba(124, 58, 237, 0.15)',
            'z-index:2147483647',
            'display:none',
            'flex-direction:column',
            'overflow:hidden',
            'font-family:system-ui,-apple-system,sans-serif',
            'transition:transform 0.25s ease-out',
            'transform:translateX(100%)'
        ].join(';') + ';';
        document.body.appendChild(panel);
        return panel;
    }

    function injectPastelTheme() {
        if (document.getElementById('phonesocial-theme')) return;
        const style = document.createElement('style');
        style.id = 'phonesocial-theme';
        style.textContent = `
            /* Phone panel container - simulated phone look */
            #phonesocial-panel { border-radius:28px !important; overflow:hidden !important; border:none !important; }
            #phonesocial-panel .ps-header { display:flex; justify-content:center; align-items:center; padding:8px 18px; background:linear-gradient(135deg,#ede9fe,#fdf4ff); }
            #phonesocial-panel .ps-title { font-size:12px; font-weight:600; color:#a855f7; letter-spacing:1px; opacity:0.7; }
            #phonesocial-panel .ps-close { width:28px; height:28px; border-radius:50%; border:none; background:rgba(255,255,255,0.8); color:#7c3aed; font-size:16px; cursor:pointer; }
            #phonesocial-panel .ps-body { flex:1; overflow-y:auto; padding:16px 12px; background:linear-gradient(to bottom, #f5f3ff, #fdf2f8); }
            #phonesocial-panel .ps-home { text-align:center; padding:20px 10px; color:#6b21a8; }
            #phonesocial-panel .ps-hint { font-size:12px; color:#c084fc; margin-top:16px; font-style:italic; }
            #phonesocial-panel .ps-app-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; max-width:240px; margin:0 auto; }
            #phonesocial-panel .ps-app { display:flex; flex-direction:column; align-items:center; justify-content:center; border-radius:16px; padding:14px 8px; cursor:pointer; box-shadow:0 2px 8px rgba(0,0,0,0.08); transition:transform 0.15s; min-height:72px; }
            #phonesocial-panel .ps-app:active { transform:scale(0.92); }
            #phonesocial-panel .ps-app-icon { font-size:24px; }
            #phonesocial-panel .ps-app-label { font-size:10px; font-weight:600; color:#fff; margin-top:4px; text-shadow:0 1px 2px rgba(0,0,0,0.15); }
            #phonesocial-panel .ps-list { list-style:none; padding:0; margin:0; }
            #phonesocial-panel .ps-list li { background:rgba(255,255,255,0.85); border-radius:14px; padding:12px 16px; margin-bottom:10px; cursor:pointer; border:1px solid #f3e8ff; box-shadow:0 1px 4px rgba(0,0,0,0.04); transition:transform 0.15s; }
            #phonesocial-panel .ps-list li:active { transform:scale(0.98); }
            #phonesocial-panel .ps-list li b { color:#581c87; display:block; margin-bottom:2px; }
            #phonesocial-panel .ps-list li span { font-size:12px; color:#a855f7; }
            #phonesocial-panel .ps-list li small { font-size:11px; color:#d8b4fe; }
            #phonesocial-panel .ps-empty { text-align:center; color:#c084fc; padding:30px; font-style:italic; }
            #phonesocial-panel .ps-thread-head { display:flex; align-items:center; padding:10px 12px; background:#f3e8ff; border-radius:14px; margin-bottom:12px; }
            #phonesocial-panel .ps-thread-head b { flex:1; text-align:center; color:#581c87; }
            #phonesocial-panel .ps-thread-head button { background:#f3e8ff; border:none; width:32px; height:32px; border-radius:50%; font-size:16px; cursor:pointer; }
            #phonesocial-panel .ps-thread { min-height:120px; margin-bottom:10px; }
            #phonesocial-panel .ps-msg { max-width:80%; padding:8px 14px; border-radius:16px; margin:4px 0; font-size:14px; line-height:1.4; }
            #phonesocial-panel .ps-msg.me { background:linear-gradient(135deg,#c084fc,#e879f9); color:#fff; margin-left:auto; border-bottom-right-radius:4px; }
            #phonesocial-panel .ps-msg.them { background:rgba(255,255,255,0.9); color:#581c87; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
            #phonesocial-panel .ps-compose { display:flex; gap:8px; padding:10px; background:#f3e8ff; border-radius:20px; }
            #phonesocial-panel #ps-input { flex:1; border:1px solid #e9d5ff; border-radius:20px; padding:8px 14px; background:rgba(255,255,255,0.9); color:#581c87; outline:none; }
            #phonesocial-panel .ps-compose button { background:#a855f7; color:#fff; border:none; border-radius:20px; padding:8px 16px; font-weight:600; cursor:pointer; }
            #phonesocial-panel .ps-dial { text-align:center; padding:12px; }
            #phonesocial-panel .ps-dial-display { font-size:28px; font-weight:700; color:#581c87; padding:20px 0; min-height:40px; letter-spacing:2px; }
            #phonesocial-panel .ps-dial-pad { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
            #phonesocial-panel .ps-dial-pad button { height:58px; border-radius:50%; border:none; background:rgba(255,255,255,0.8); font-size:22px; font-weight:600; color:#6b21a8; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.06); }
            #phonesocial-panel .ps-dial-pad button:active { background:#f3e8ff; }
            #phonesocial-panel .ps-dial-actions { display:flex; justify-content:center; gap:12px; padding:16px; }
            #phonesocial-panel .ps-call { background:linear-gradient(135deg,#4ade80,#22c55e); color:#fff; border:none; border-radius:20px; padding:10px 24px; font-size:16px; font-weight:700; cursor:pointer; }
            #phonesocial-panel [data-act="dial-clear"] { background:#f3e8ff; color:#581c87; border:none; border-radius:20px; padding:10px 20px; font-size:18px; cursor:pointer; }
            #phonesocial-panel .ps-nav { display:flex; justify-content:space-around; padding:10px 6px; background:#fdf4ff; border-top:1px solid #f3e8ff; }
            #phonesocial-panel .ps-nav button { background:transparent; border:none; color:#a855f7; font-size:13px; font-weight:600; padding:6px 10px; border-radius:12px; cursor:pointer; }
            #phonesocial-panel .ps-nav button:active { background:rgba(168,85,247,0.15); }
        `;
        document.head.appendChild(style);
    }

    function togglePanel() {
        const panel = ensurePanel();
        const btn = document.getElementById('phonesocial-btn');
        if (panel.style.display === 'none' || !panel.style.display) {
            harvestNPCs();
            saveMeta();
            render();
            panel.style.display = 'flex';
            void panel.offsetWidth; // force reflow
            panel.style.transform = 'translateX(0)';
            if (btn) btn.setAttribute('data-hidden', 'true'); // hide button while panel open
        } else {
            panel.style.transform = 'translateX(100%)';
            setTimeout(() => {
                panel.style.display = 'none';
                panel.style.transform = 'translateX(100%)'; // reset for next open
                if (btn) btn.removeAttribute('data-hidden'); // show button again
            }, 260);
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
                <button data-act="nav" data-view="dial">📞</button>
                <button data-act="nav" data-view="sms">💬</button>
                <button data-act="nav" data-view="contacts">👥</button>
                <button data-act="nav" data-view="home">⚙️</button>
            </div>
        `;
        bindPanel(panel);
    }

    function viewHome() {
        return `
            <div class="ps-home">
                <div class="ps-app-grid">
                    <div class="ps-app" style="background:linear-gradient(135deg,#86efac,#4ade80)" data-act="nav" data-view="dial">
                        <span class="ps-app-icon">📞</span>
                        <span class="ps-app-label">Phone</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#fda4af,#fb7185)" data-act="nav" data-view="sms">
                        <span class="ps-app-icon">💬</span>
                        <span class="ps-app-label">Messages</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#93c5fd,#60a5fa)" data-act="nav" data-view="contacts">
                        <span class="ps-app-icon">👥</span>
                        <span class="ps-app-label">Contacts</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#fcd34d,#fbbf24)">
                        <span class="ps-app-icon">🖼️</span>
                        <span class="ps-app-label">Gallery</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#d8b4fe,#c084fc)">
                        <span class="ps-app-icon">📋</span>
                        <span class="ps-app-label">Tasks</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#fecdd3,#fda4af)">
                        <span class="ps-app-icon">⚙️</span>
                        <span class="ps-app-label">Settings</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#bae6fd,#7dd3fc)">
                        <span class="ps-app-icon">🎨</span>
                        <span class="ps-app-label">Art</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#fef08a,#fde047)">
                        <span class="ps-app-icon">📝</span>
                        <span class="ps-app-label">Notes</span>
                    </div>
                    <div class="ps-app" style="background:linear-gradient(135deg,#fecaca,#f87171)">
                        <span class="ps-app-icon">❤️</span>
                        <span class="ps-app-label">Favorites</span>
                    </div>
                </div>
                <p class="ps-hint">Tap an icon to open</p>
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
            el.removeEventListener('click', onAction);
            el.removeEventListener('touchend', onAction);
            el.addEventListener('click', onAction, { passive: false });
            el.addEventListener('touchend', onAction, { passive: false });
        });
    }

    function onAction(ev) {
        const el = ev.currentTarget;
        const act = el.getAttribute('data-act');
        switch (act) {
            case 'close':
                togglePanel();
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
        // Defer to next frame so ST's chat loading pipeline isn't blocked
        requestAnimationFrame(() => {
            try {
                loadMeta();
                harvestNPCs();
                saveMeta();
            } catch (e) {
                console.error('[PhoneSocial] onChatChanged error:', e);
            }
            const panel = document.getElementById('phonesocial-panel');
            if (panel && panel.style.display !== 'none') render();
        });
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
                    saveMeta();
                } catch (e) {
                    console.error('[PhoneSocial] MESSAGE_RECEIVED error:', e);
                }
            }, 0);
        });
        return true;
    }

    function init() {
        // Defer ALL work to avoid blocking ST startup
        setTimeout(() => {
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

            console.log('[PhoneSocial] ✅ initialized (passive); btn:', !!document.getElementById('phonesocial-btn'));
        }, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
