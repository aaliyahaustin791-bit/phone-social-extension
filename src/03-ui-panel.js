    // -------------------------------------------------------------------
    // Draggable launcher (📱) — position persisted to localStorage so the
    // button stays where the user put it across reloads and panel toggles.
    // -------------------------------------------------------------------
    const PS_BTN_SIZE = 52;
    let psBtnPos = null; // last known {x,y} in px

    function psBtnClamp(x, y) {
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const maxX = Math.max(4, vw - PS_BTN_SIZE - 4);
        const maxY = Math.max(4, vh - PS_BTN_SIZE - 4);
        return { x: Math.max(4, Math.min(Math.round(x), maxX)), y: Math.max(4, Math.min(Math.round(y), maxY)) };
    }

    function psBtnDefaultPos() {
        return psBtnClamp((window.innerWidth || document.documentElement.clientWidth) - PS_BTN_SIZE - 12, 80);
    }

    function psBtnLoadPos() {
        try {
            const raw = localStorage.getItem('PhoneSocial_btnPos');
            if (raw) {
                const p = JSON.parse(raw);
                if (p && typeof p.x === 'number' && typeof p.y === 'number') return psBtnClamp(p.x, p.y);
            }
        } catch (_e) { /* ignore */ }
        return null;
    }

    function psBtnSavePos(x, y) {
        try { localStorage.setItem('PhoneSocial_btnPos', JSON.stringify({ x, y })); } catch (_e) { /* ignore */ }
    }

    function psBtnApply(el, x, y) {
        const p = psBtnClamp(x, y);
        el.style.left = p.x + 'px';
        el.style.top = p.y + 'px';
        return p;
    }

    function psBtnRemember(el) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) {
            const p = psBtnClamp(r.left, r.top);
            psBtnPos = p;
            psBtnSavePos(p.x, p.y);
        }
    }

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
            const now = Date.now();
            // Forensics toast: WHY is this click running? dragged flag, guard
            // window, time since the last suppression.
            try {
                if (typeof window.toastr !== 'undefined') {
                    window.toastr.info('📱 click: dragged=' + (btn.__psDragged ? 1 : 0)
                        + ' guard=' + (now < (btn.__psClickGuardUntil || 0) ? 1 : 0));
                }
            } catch (_e) { /* ignore */ }
            // A completed drag fires (possibly multiple) clicks on release —
            // suppress them, plus a 500ms guard window so Kiwi's touch→mouse
            // compat double-click can't slip in AFTER the first suppression
            // clears the flag.
            if (btn.__psDragged || now < (btn.__psClickGuardUntil || 0)) {
                btn.__psDragged = false;
                btn.__psClickGuardUntil = now + 500;
                return;
            }
            console.log('[PhoneSocial] button handler fired');
            togglePanel();
        };
        btn.addEventListener('click', handler);
        // Draggable launcher v2 — pointer events with DOCUMENT-level move/up
        // listeners so the drag survives the finger leaving the small button,
        // plus a touch-event fallback for browsers without PointerEvent.
        // touch-action:none stops the browser hijacking the drag for scroll.
        btn.dataset.psDrag = 'v2';
        if (!btn.__psToastShown) {
            btn.__psToastShown = true;
            if (typeof window.toastr !== 'undefined') {
                try { window.toastr.info('📱 launcher v2 — drag me anywhere'); } catch (_e) { /* ignore */ }
            }
            console.log('[PhoneSocial] launcher v2 (draggable) active');
        }
        // TEMP telemetry (remove once drag is confirmed): toasts every gesture
        // stage so the user can read back exactly what the browser fires.
        let psTelLast = 0;
        const psTel = (msg) => {
            const now = Date.now();
            if (now - psTelLast < 250) return;
            psTelLast = now;
            console.log('[PhoneSocial]', msg);
            try { if (typeof window.toastr !== 'undefined') window.toastr.info('📱 ' + msg); } catch (_e) { /* ignore */ }
        };
        const psBtnRectTxt = () => {
            const r = btn.getBoundingClientRect();
            return 'rect=' + Math.round(r.left) + ',' + Math.round(r.top);
        };
        const psStartDrag = (clientX, clientY) => {
            psTel('down @' + Math.round(clientX) + ',' + Math.round(clientY) + ' ' + psBtnRectTxt());
            btn.__psDragged = false;
            const startX = clientX;
            const startY = clientY;
            const rect = btn.getBoundingClientRect();
            const baseX = rect.left;
            const baseY = rect.top;
            let moved = false;
            let lastTel = 0;
            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved) {
                    if (Math.hypot(dx, dy) < 6) return; // still a tap
                    moved = true;
                    btn.__psDragged = true;
                    btn.__psClickGuardUntil = Date.now() + 500;
                    btn.style.transition = 'none';
                    btn.style.borderColor = '#ff00ff'; // drag engaged marker
                    btn.style.outline = '3px solid #ff00ff';
                    psTel('drag started (moving now)');
                }
                psBtnApply(btn, baseX + dx, baseY + dy);
                const now = Date.now();
                if (now - lastTel > 900) {
                    lastTel = now;
                    psTel('moving ' + Math.round(dx) + ',' + Math.round(dy)
                        + ' style.left=' + btn.style.left + ' ' + psBtnRectTxt());
                }
                if (ev.cancelable) ev.preventDefault();
            };
            const onMoveTouch = (ev) => {
                const t = ev.touches && ev.touches[0];
                if (t) onMove(t);
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onCancel);
                document.removeEventListener('touchmove', onMoveTouch);
                document.removeEventListener('touchend', onUp);
                document.removeEventListener('touchcancel', onCancel);
                if (moved) {
                    const p = psBtnApply(btn, btn.getBoundingClientRect().left, btn.getBoundingClientRect().top);
                    psBtnPos = p;
                    psBtnSavePos(p.x, p.y);
                    psTel('UP moved ✓ saved ' + p.x + ',' + p.y);
                    setTimeout(() => {
                        btn.style.borderColor = '#fff';
                        btn.style.outline = 'none';
                    }, 350);
                } else {
                    psTel('UP no-move (tap) ' + psBtnRectTxt());
                }
            };
            const onCancel = () => {
                psTel('gesture CANCELED by browser');
                onUp();
            };
            // Register BOTH pointer and touch: browsers fire both for a touch;
            // double application is idempotent and the first onUp cleans up.
            document.addEventListener('pointermove', onMove, { passive: false });
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onCancel);
            document.addEventListener('touchmove', onMoveTouch, { passive: false });
            document.addEventListener('touchend', onUp);
            document.addEventListener('touchcancel', onCancel);
        };
        if (window.PointerEvent) {
            btn.addEventListener('pointerdown', (e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                psStartDrag(e.clientX, e.clientY);
            });
        } else {
            btn.addEventListener('touchstart', (e) => {
                const t = e.touches && e.touches[0];
                if (!t) return;
                psStartDrag(t.clientX, t.clientY);
            }, { passive: false });
        }
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
            'color:#fff',
            'font-size:22px',
            'line-height:1',
            'box-shadow:0 4px 14px rgba(0,0,0,0.6)',
            'cursor:pointer',
            'touch-action:none',
            'user-select:none',
            '-webkit-user-select:none',
            'padding:0',
            'margin:0',
            'visibility:visible',
            'opacity:1',
            'pointer-events:auto',
        ].join(';') + ';';
        // Apply saved position (or the top-right default), clamped on-screen.
        const p0 = psBtnLoadPos() || psBtnDefaultPos();
        psBtnPos = psBtnApply(btn, p0.x, p0.y);
        // Append to <html> instead of <body> — escapes any body-level transforms.
        (document.documentElement || document.body).appendChild(btn);
        // Keep the button on-screen (and where the user left it) on resize /
        // orientation change — no snap-back to the default corner.
        const reposition = () => {
            const p = psBtnPos || psBtnLoadPos() || psBtnDefaultPos();
            psBtnPos = psBtnApply(btn, p.x, p.y);
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
            /* ─── Theme variables (Diegetic Device Mode — Phase 1) ───
               Base UI reads chrome colors from these vars. Theme classes
               (.ps-theme-*) ONLY reassign these vars — never layout — so a
               theme switch can never regress the base UI. Defaults = modern. */
            #phonesocial-panel {
                --ps-chrome-bg:#1c1c1e;      /* statusbar / header / nav / body backdrop */
                --ps-chrome-fg:#ffffff;      /* text on chrome */
                --ps-accent:#34c759;         /* signal/battery/active accents */
                --ps-header-fg:#ffffff;      /* header title */
                --ps-nav-bg:rgba(28,28,30,0.95);
                --ps-nav-active:rgba(255,255,255,0.12);
            }
            /* ─── Theme: Modern (explicit — same as defaults) ─── */
            #phonesocial-panel.ps-theme-modern {
                --ps-chrome-bg:#1c1c1e;
                --ps-chrome-fg:#ffffff;
                --ps-accent:#34c759;
                --ps-header-fg:#ffffff;
                --ps-nav-bg:rgba(28,28,30,0.95);
                --ps-nav-active:rgba(255,255,255,0.12);
            }
            /* ─── Theme: Fantasy (MirrorNet — deep arcane purple + gold) ─── */
            #phonesocial-panel.ps-theme-fantasy {
                --ps-chrome-bg:#2a1a3e;
                --ps-chrome-fg:#f3e8ff;
                --ps-accent:#f5c542;
                --ps-header-fg:#f5c542;
                --ps-nav-bg:rgba(42,26,62,0.96);
                --ps-nav-active:rgba(245,197,66,0.22);
            }
            #phonesocial-panel.ps-theme-fantasy .ps-app-icon,
            #phonesocial-panel.ps-theme-fantasy .ps-dock-app-icon {
                color:var(--ps-accent);
            }
            /* ─── Theme: Sci-Fi (CommLink — deep space navy + cyan) ─── */
            #phonesocial-panel.ps-theme-scifi {
                --ps-chrome-bg:#0a1628;
                --ps-chrome-fg:#d6f5ff;
                --ps-accent:#22d3ee;
                --ps-header-fg:#22d3ee;
                --ps-nav-bg:rgba(10,22,40,0.96);
                --ps-nav-active:rgba(34,211,238,0.22);
            }
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
                background:var(--ps-chrome-bg);
                color:var(--ps-chrome-fg);
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
            #phonesocial-panel .ps-signal-bar.active { background:var(--ps-accent); }
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
                background:var(--ps-accent);
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
                background:var(--ps-chrome-bg);
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
                background:var(--ps-chrome-bg);
                flex-shrink:0;
                min-height:36px;
            }
            #phonesocial-panel .ps-header-title {
                font-size:13px; font-weight:600; color:var(--ps-header-fg);
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
                background:var(--ps-chrome-bg);
                color:#1c1c1e;
                -webkit-overflow-scrolling:touch;
            }
            /* ─── Bottom Nav ─── */
            #phonesocial-panel .ps-nav {
                display:flex; justify-content:space-around; align-items:center;
                padding:8px 6px;
                background:var(--ps-nav-bg);
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
                background:var(--ps-nav-active);
            }
            /* ─── Home Indicator ─── */
            #phonesocial-panel .ps-home-indicator {
                display:flex; justify-content:center; align-items:center;
                padding:6px 0 10px;
                background:var(--ps-chrome-bg);
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
                padding-bottom:70px;
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
            #phonesocial-panel .ps-app-icon svg,
            #phonesocial-panel .ps-dock-app-icon svg {
                width:28px; height:28px; display:inline-block; vertical-align:middle;
            }
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
                margin:12px 16px 60px;
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
            #phonesocial-panel .ps-msg-receipt {
                font-size:10px; color:#8e8e93;
                display:block; text-align:right;
                margin:0 8px 6px 0;
            }
            #phonesocial-panel .ps-msg-receipt.ps-read { color:#007aff; }
            /* ─── Schedule Display ─── */
            #phonesocial-panel .ps-schedule-status-card {
                display:flex; align-items:center; gap:8px; flex-wrap:wrap;
                background:#f2f2f7; border-radius:10px; padding:10px; margin-bottom:10px;
            }
            #phonesocial-panel .ps-schedule-status-icon { font-size:18px; }
            #phonesocial-panel .ps-schedule-status-label { font-size:12px; font-weight:600; color:#1c1c1e; }
            #phonesocial-panel .ps-schedule-talk-bar {
                flex-basis:100%; height:4px; background:#e5e5ea; border-radius:2px; overflow:hidden;
            }
            #phonesocial-panel .ps-schedule-talk-fill {
                height:100%; background:#007aff; border-radius:2px; transition:width 0.3s;
            }
            #phonesocial-panel .ps-schedule-pills {
                display:flex; gap:4px; overflow-x:auto; padding:4px 0 8px;
                -webkit-overflow-scrolling:touch; scrollbar-width:none;
            }
            #phonesocial-panel .ps-schedule-pills::-webkit-scrollbar { display:none; }
            #phonesocial-panel .ps-schedule-pill {
                flex-shrink:0; display:flex; flex-direction:column; align-items:center; gap:2px;
                padding:6px 10px; border-radius:10px; border:1.5px solid #d1d1d6;
                background:#fff; cursor:pointer; font-size:12px; color:#1c1c1e; min-width:44px;
            }
            #phonesocial-panel .ps-schedule-pill-sel {
                background:#007aff; color:#fff; border-color:#007aff;
            }
            #phonesocial-panel .ps-schedule-pill-today:not(.ps-schedule-pill-sel) {
                border-color:#007aff; border-width:2px;
            }
            #phonesocial-panel .ps-schedule-pill-dots {
                display:flex; gap:1px; flex-wrap:wrap; justify-content:center; max-width:32px;
            }
            #phonesocial-panel .ps-schedule-blocks {
                position:relative; display:flex; flex-direction:column; gap:2px;
                max-height:240px; overflow-y:auto;
            }
            #phonesocial-panel .ps-schedule-block {
                display:flex; align-items:center; gap:8px; padding:6px 8px;
                background:#f9f9fb; border-radius:8px; font-size:12px;
            }
            #phonesocial-panel .ps-schedule-block-time {
                font-family:monospace; font-size:11px; color:#8e8e93; min-width:88px;
            }
            #phonesocial-panel .ps-schedule-block-dot {
                width:8px; height:8px; border-radius:50%; flex-shrink:0;
            }
            #phonesocial-panel .ps-schedule-block-activity {
                flex:1; color:#1c1c1e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            }
            #phonesocial-panel .ps-schedule-block-status {
                font-size:10px; padding:2px 6px; border-radius:4px; background:#e5e5ea; color:#3a3a3c;
                text-transform:uppercase; font-weight:600;
            }
            #phonesocial-panel .ps-schedule-now {
                position:absolute; left:0; right:0; z-index:2; pointer-events:none;
            }
            #phonesocial-panel .ps-schedule-now::before {
                content:''; display:block; height:2px; background:#007aff;
            }
            #phonesocial-panel .ps-schedule-now span {
                position:absolute; right:4px; top:-10px;
                font-size:10px; color:#007aff; font-weight:600; white-space:nowrap;
            }
            /* ─── Date Dividers ─── */
            #phonesocial-panel .ps-date-divider {
                text-align:center; font-size:11px; color:#8e8e93;
                padding:8px 0; font-weight:500;
            }
            /* ─── iOS Dial Pad ─── */
            #phonesocial-panel .ps-dial {
                text-align:center; padding:4px 0;
                display:flex; flex-direction:column; height:100%;
            }
            #phonesocial-panel .ps-dial-display {
                font-size:26px; font-weight:300; color:#1c1c1e;
                margin:10px 0 14px; min-height:30px;
                letter-spacing:1px; font-variant-numeric:tabular-nums;
            }
            #phonesocial-panel .ps-dial-placeholder {
                color:#c7c7cc; font-size:16px; font-weight:400;
            }
            #phonesocial-panel .ps-dial-pad {
                display:grid; grid-template-columns:repeat(3,52px);
                gap:8px; justify-content:center; flex:1;
                align-content:center; padding-bottom:10px;
            }
            #phonesocial-panel .ps-dial-key {
                width:52px; height:52px; border-radius:50%;
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
                font-size:22px; font-weight:400; color:#1c1c1e;
                line-height:1; margin-bottom:2px;
            }
            #phonesocial-panel .ps-dial-key-sub {
                font-size:9px; font-weight:600; color:#8e8e93;
                letter-spacing:1.5px; line-height:1;
            }
            #phonesocial-panel .ps-dial-actions {
                display:grid; grid-template-columns:repeat(3,52px);
                gap:8px; justify-content:center;
                padding:10px 0 8px;
            }
            #phonesocial-panel .ps-dial-actions .ps-dial-action-btn {
                grid-column:1;
            }
            #phonesocial-panel .ps-dial-actions .ps-dial-call-btn {
                grid-column:3;
            }
            #phonesocial-panel .ps-dial-action-btn {
                width:50px; height:50px; border-radius:50%;
                border:none; background:#e5e5ea;
                color:#1c1c1e; font-size:20px; cursor:pointer;
                display:flex; align-items:center; justify-content:center;
                -webkit-tap-highlight-color:transparent;
            }
            #phonesocial-panel .ps-dial-action-btn:active { background:#c7c7cc; }
            #phonesocial-panel .ps-dial-call-btn {
                width:50px; height:50px; border-radius:50%;
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
                margin:0 0 4px;
            }
            #phonesocial-panel .ps-dial-tab {
                flex:1; padding:6px 0; border:none; background:transparent;
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
            if (btn) {
                btn.style.cssText = [
                    'position:fixed',
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
                // Keep the dragged position — never snap back to the corner.
                const p = psBtnPos || psBtnLoadPos() || psBtnDefaultPos();
                psBtnPos = psBtnApply(btn, p.x, p.y);
            }
            stopCallTimer();
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
            if (btn) {
                psBtnRemember(btn); // stash position BEFORE hiding (rect is 0 when display:none)
                btn.style.cssText = 'display:none !important; pointer-events:none !important; visibility:hidden !important; opacity:0 !important;';
            }
        }
    }

    // Close handler bound once — doesn't stack on re-render
    function doClose(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (isPanelOpen) togglePanel();
    }

    function getStatusBarTime() {
        const now = getChatTime();
        const h = now.getHours();
        const m = String(now.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    }

    function getHeaderTitle() {
        // Profile-aware labels for themeable views; static labels for the rest.
        const p = (typeof getWorldCommsProfile === 'function') ? getWorldCommsProfile() : null;
        const titles = {
            'home': (p && p.deviceName) || 'PhoneSocial',
            'contacts': (p && p.contactsLabel) || 'Contacts',
            'sms': (p && p.messagesLabel) || 'Messages',
            'thread': 'Message',
            'dial': (p && p.callsLabel) || 'Phone',
            'settings': 'Settings',
            'profile': 'Profile',
            'albums': 'Wallpapers',
            'memories': 'Memories',
            'call': 'Call',
            'browser': (p && p.browserLabel) || 'Browser',
            'chirp': (p && p.feedLabel) || 'Chirp',
            'chirp-thread': 'Post',
            'favorites': 'Favorites',
        };
        return titles[state.view] || ((p && p.deviceName) || 'PhoneSocial');
    }

    // ─── Notification Shade (pull-down) ──────────────────────────────
    function buildNotifShade() {
        const now = getChatTime();
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

