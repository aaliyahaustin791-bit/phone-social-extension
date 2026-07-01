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
                    <span class="ps-sb-carrier" style="font-size:10px;opacity:0.7;font-weight:500">📱 v8</span>
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

        // Wire up TTS voice input in profile — save on change
        const ttsInput = panel.querySelector('#ps-tts-voice');
        if (ttsInput && !ttsInput._wired) {
            ttsInput._wired = true;
            ttsInput.addEventListener('change', () => {
                const id = ttsInput.getAttribute('data-id');
                const contact = state.contacts.find(c => c.id === id);
                if (!contact) return;
                const newVoice = (ttsInput.value || '').trim();
                contact.ttsVoice = newVoice || undefined;
                saveMeta();
                console.log('[PhoneSocial] 🎤 TTS voice for ' + contact.name + ': ' + (newVoice || '(default)'));
            });
        }

        // Click-outside-to-close for ⋮ menus (wire once)
        if (!panel._menuOutsideWired) {
            panel._menuOutsideWired = true;
            document.addEventListener('click', (e) => {
                const target = e.target;
                if (target.closest('.ps-menu-dropdown') || target.closest('[data-act="toggle-menu"]')) return;
                document.querySelectorAll('.ps-menu-dropdown').forEach(d => d.style.display = 'none');
            });
        }

        // Unlock audio autoplay on first user interaction (mobile browsers)
        if (!panel._audioUnlocked) {
            panel._audioUnlocked = true;
            const unlock = () => {
                const tmp = new Audio();
                tmp.play().catch(() => {});
                document.removeEventListener('pointerdown', unlock);
                document.removeEventListener('touchstart', unlock);
            };
            document.addEventListener('pointerdown', unlock, { once: true });
            document.addEventListener('touchstart', unlock, { once: true });
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
        navigateTo('browser');
        render();
    }

    function viewHome() {
        // Story time from AI narrative (falls back to real time)
        const now = getChatTime();
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

        // Build message list with date dividers + per-message read receipts
        let lastDate = '';
        const msgHtml = msgs.map((m, i) => {
            const curDate = fmtDate(m.ts);
            const divider = curDate !== lastDate ? `<div class="ps-date-divider">${curDate}</div>` : '';
            lastDate = curDate;
            const time = fmtTime(m.ts);
            const isImage = !!m.imageUrl;
            // Per-message delivery receipt for user messages
            const receipt = m.from === 'me'
                ? (m.seen
                    ? '<span class="ps-msg-receipt ps-read">Read</span>'
                    : '<span class="ps-msg-receipt">Delivered</span>')
                : '';
            return `
                ${divider}
                <div class="ps-msg ps-${m.from}${isImage ? ' ps-msg-img' : ''}">
                    ${isImage
                        ? `<img src="${m.imageUrl}" style="max-width:100%;max-height:240px;border-radius:8px;display:block" loading="lazy" alt="Photo" />`
                        : escape(m.text || '')}
                    <button data-act="delete-msg" data-id="${c.id}" data-msg-index="${i}" type="button" class="ps-msg-del" title="Delete message">×</button>
                </div>
                <span class="ps-msg-time ${m.from}">${time}</span>
                ${receipt}
            `;
        }).join('');

        return `
            <div class="ps-thread-head">
                <button data-act="nav" data-view="sms">←</button>
                <div class="ps-avatar-sm" style="background:${avatarGradient(c.name)}">${avatarInitial(c.name)}</div>
                <div style="flex:1;text-align:left;margin-left:8px">
                    <b style="color:#f2f2f7;font-size:15px">${escape(c.name)}</b>
                    ${isTyping ? '<div style="font-size:11px;color:#34c759">typing…</div>' : ''}
                </div>
                <div class="ps-thread-actions" style="position:relative">
                    <button data-act="toggle-menu" data-id="${c.id}" data-context="thread" style="background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;color:#8e8e93;line-height:1">⋮</button>
                    <div class="ps-menu-dropdown" id="ps-menu-${c.id}" style="display:none;position:absolute;right:0;top:100%;background:#2c2c2e;border-radius:10px;padding:4px 0;min-width:160px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,0.4)">
                        <button data-act="toggle-mute" data-id="${c.id}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">${state.mutedContacts[c.id] ? '🔔' : '🔕'} ${state.mutedContacts[c.id] ? 'Unmute' : 'Mute'}</button>
                        <button data-act="toggle-star" data-id="${c.id}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">${c.starred ? '★' : '☆'} ${c.starred ? 'Unstar' : 'Star'}</button>
                        <button data-act="open-profile" data-id="${c.id}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">📋 Profile</button>
                        <button data-act="call" data-id="${c.id}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">📞 Call</button>
                        <button data-act="delete-thread" data-id="${c.id}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#ff453a;font-size:14px;text-align:left;cursor:pointer">🗑️ Delete</button>
                    </div>
                </div>
            </div>
            <div class="ps-thread" id="ps-thread-scroll">
                ${msgHtml}
                ${isTyping ? `
                <div class="ps-typing">
                    <span></span><span></span><span></span>
                </div>` : ''}
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
                desc: 'Read incoming SMS and calls aloud using the TTS provider configured below.',
            },
            {
                key: 'toastrEnabled',
                label: '🔔 Toastr popups',
                desc: 'Show on-screen notifications for incoming SMS and calls.',
            },
            {
                key: 'userDnd',
                label: '🚫 Do Not Disturb',
                desc: 'Suppress ALL autonomous NPC texts and calls. NPCs will only reply when you message them first.',
            },
        ];
        const toggles = behaviorEntries.map(item => {
            // userDnd lives on state directly, not settings
            const value = item.key === 'userDnd' ? !!state.userDnd : !!state.settings[item.key];
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
                <h3 style="margin:0 0 8px; color:#581c87">🔈 TTS Provider</h3>
                <p style="margin:0 0 8px; font-size:11px; color:#8e8e93">Direct API call — no dependency on ST's TTS extension. Voice ID goes in each contact's profile.</p>
                <label style="display:block; margin:8px 0 4px; font-size:12px">Provider</label>
                <select id="ps-tts-provider" style="width:100%; padding:8px; border-radius:8px; border:1px solid #d8b4fe">
                    <option value="elevenlabs"${state.settings.ttsProvider === 'elevenlabs' ? ' selected' : ''}>ElevenLabs</option>
                    <option value=""${!state.settings.ttsProvider ? ' selected' : ''}>None (disabled)</option>
                </select>
                <label style="display:block; margin:8px 0 4px; font-size:12px">API Key</label>
                <input type="password" id="ps-tts-apikey" value="${escape(state.settings.ttsApiKey || '')}" style="width:100%; padding:8px; border-radius:8px; border:1px solid #d8b4fe" placeholder="sk_...">
                <button data-act="fetch-tts-voices" style="margin-top:8px; background:#007aff; color:#fff; border:none; padding:8px 14px; border-radius:8px; font-size:12px; cursor:pointer">🔈 Fetch Voices</button>
                <span id="ps-tts-voice-count" style="margin-left:8px; font-size:12px; color:#8e8e93">${state.ttsVoices.length ? state.ttsVoices.length + ' voices cached' : ''}</span>
                <hr style="margin:16px 0; border:none; border-top:1px solid #e9d5ff">
                <h3 style="margin:0 0 8px; color:#581c87">Notifications</h3>
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
                <div style="position:relative">
                    <button data-act="toggle-menu" data-id="${escape(c.id)}" data-context="profile" style="background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;color:#8e8e93;line-height:1">⋮</button>
                    <div class="ps-menu-dropdown" id="ps-menu-${c.id}" style="display:none;position:absolute;right:0;top:100%;background:#2c2c2e;border-radius:10px;padding:4px 0;min-width:160px;z-index:100;box-shadow:0 4px 16px rgba(0,0,0,0.4)">
                        <button data-act="toggle-mute" data-id="${escape(c.id)}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">${state.mutedContacts[c.id] ? '🔔' : '🔕'} ${state.mutedContacts[c.id] ? 'Unmute' : 'Mute'}</button>
                        <button data-act="toggle-star" data-id="${escape(c.id)}" style="display:block;width:100%;padding:10px 16px;background:none;border:none;color:#f2f2f7;font-size:14px;text-align:left;cursor:pointer">${c.starred ? '★' : '☆'} ${c.starred ? 'Unstar' : 'Star'}</button>
                    </div>
                </div>
            </div>
            <div style="padding:12px;color:#1c1c1e;flex:1;overflow-y:auto">
                <p style="margin:0 0 4px;font-size:12px;color:#8e8e93">${escape(c.number)}</p>
                <p style="margin:0 0 12px;font-size:11px;color:#8e8e93">Source: ${escape(c.source)}</p>
                <div style="margin:0 0 8px">
                    <label style="font-size:11px;color:#8e8e93">TTS Voice<br></label>
                    ${state.ttsVoices.length ? `
                    <select id="ps-tts-voice" data-act="set-tts-voice" data-id="${escape(c.id)}"
                        style="width:100%;padding:8px;border:1px solid #d1d1d6;border-radius:8px;font-size:13px;color:#1c1c1e;background:#fff;box-sizing:border-box">
                        <option value="">— Default voice —</option>
                        ${state.ttsVoices.map(v => `<option value="${escape(v.voice_id)}"${c.ttsVoice === v.voice_id ? ' selected' : ''}>${escape(v.name)}</option>`).join('')}
                    </select>
                    ` : `
                    <input id="ps-tts-voice" type="text" placeholder="ElevenLabs voice ID (fetch voices in Settings first)"
                        value="${escape(c.ttsVoice || '')}"
                        style="width:100%;padding:8px;border:1px solid #d1d1d6;border-radius:8px;font-size:13px;color:#1c1c1e;background:#fff;box-sizing:border-box"
                        data-act="set-tts-voice" data-id="${escape(c.id)}">
                    `}
                </div>
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
                ${renderScheduleSection(c)}
                <div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e5ea">
                    <button data-act="delete-contact" data-id="${escape(c.id)}"
                        style="width:100%;padding:12px;background:#fee2e2;color:#dc2626;border:1px solid #fecaca;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer">
                        🗑 Delete Contact
                    </button>
                </div>
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
