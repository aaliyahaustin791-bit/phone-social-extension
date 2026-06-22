    function renderScheduleSection(contact) {
        if (!contact) return '';
        const hasSchedule = contact.schedule && contact.schedule.days && Object.keys(contact.schedule.days).length > 0;
        if (!hasSchedule) {
            return '<hr style="border:none;border-top:1px solid #e5e5ea;margin:12px 0">' +
                '<h4 style="margin:0 0 8px;font-size:13px;color:#1c1c1e">Schedule</h4>' +
                '<p style="font-size:12px;color:#8e8e93;margin:0 0 8px">No schedule generated yet. Generate a weekly schedule to control when this NPC can reach out.</p>' +
                '<button data-act="generate-schedule" data-id="' + escape(contact.id) + '" style="background:#007aff;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer">⚡ Generate Schedule</button>';
        }
        const s = contact.schedule;
        const stale = scheduleNeedsRefresh(s);
        const now = getCurrentScheduleStatus(s);
        // ── In-scene override: speaker-only — green banner only for NPCs
        // who actually have speaking lines. Narration mentions from ensemble
        // cards are used for proactive blocking, not the green banner.
        const inScene = isNpcPresent(contact.name, {narration: false});
        const displayStatus = inScene ? 'online' : (now ? now.status : 'online');
        const displayActivity = inScene ? 'with you right now' : (now ? now.activity : 'unknown');
        const statusColors = { online: '#34c759', idle: '#ff9f0a', dnd: '#ff3b30', offline: '#8e8e93' };
        const statusEmoji = { online: '🟢', idle: '🟡', dnd: '🔴', offline: '⚫' };
        const nowStatus = displayStatus;
        const nowActivity = displayActivity;
        let html = '<hr style="border:none;border-top:1px solid #e5e5ea;margin:12px 0">' +
            '<h4 style="margin:0 0 8px;font-size:13px;color:#1c1c1e">Schedule</h4>';
        if (inScene) {
            html += '<div style="background:#e8f5e9;border-radius:8px;padding:6px 10px;margin-bottom:10px;font-size:11px;color:#2e7d32">' +
                '📍 Present in chat — schedule overridden to ONLINE</div>';
        }
        if (stale) {
            html += '<div style="background:#fff3cd;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:11px;color:#856404">' +
                '⚠️ Schedule is from a previous week. <button data-act="generate-schedule" data-id="' + escape(contact.id) + '" style="background:none;border:none;color:#007aff;font-size:11px;cursor:pointer;padding:0;text-decoration:underline">Regenerate</button></div>';
        }
        html += '<div style="background:#f2f2f7;border-radius:10px;padding:10px;margin-bottom:8px">' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
            '<span style="font-size:16px">' + (statusEmoji[nowStatus] || '') + '</span>' +
            '<span style="font-size:13px;font-weight:600;color:#1c1c1e">' + nowStatus.toUpperCase() + '</span>' +
            '<span style="font-size:12px;color:#8e8e93">— ' + escape(nowActivity) + '</span></div>' +
            '<div style="font-size:11px;color:#8e8e93">Talkativeness: ' + (s.talkativeness || 50) + '/100 • Reaches out after ' + (s.inactivityThresholdMinutes || 120) + 'min</div></div>';
        // 7-day compact grid
        const chatNow = getChatTime();
        const todayIdx = (chatNow.getDay() + 6) % 7;
        html += '<div style="display:flex;flex-direction:column;gap:4px;font-size:10px;max-height:200px;overflow-y:auto">';
        for (let i = 0; i < 7; i++) {
            const day = DAYS[i];
            const blocks = Array.isArray(s.days[day]) ? s.days[day] : [];
            const isToday = i === todayIdx;
            const dotColors = blocks.slice(0, 8).map(b => '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + (statusColors[b.status] || '#ccc') + ';margin-right:1px" title="' + escape(b.time + ' ' + b.activity) + '"></span>').join('');
            const timePreview = blocks.slice(0, 3).map(b => '<span style="color:#8e8e93">' + escape(b.time) + '</span>').join(' ');
            html += '<div style="display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px' + (isToday ? ';background:#e8f0fe' : '') + '">' +
                '<span style="width:40px;font-weight:' + (isToday ? '600' : '400') + ';color:#1c1c1e">' + day.slice(0, 3) + '</span>' +
                '<span style="flex:1">' + dotColors + '</span>' +
                '<span style="font-size:9px">' + timePreview + '</span></div>';
        }
        html += '</div>';
        html += '<div style="margin-top:10px"><button data-act="generate-schedule" data-id="' + escape(contact.id) + '" style="background:none;border:1px solid #007aff;color:#007aff;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer">🔄 Regenerate Schedule</button></div>';
        return html;
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
            if (!name) continue;
            chatSenders.add(name);
            // Ensemble card support: split compound names like "corey + jay"
            // so individual NPCs (corey, jay) are recognized as senders
            if (/[+,&]/.test(name)) {
                for (const part of name.split(/[+,&]\s*/)) {
                    const p = part.trim().toLowerCase();
                    if (p.length > 1) chatSenders.add(p);
                }
            }
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
            // Contacts with generated schedules are preserved — their schedule is
            // authoritative and they may not appear as chat senders in every session.
            if (c.schedule && c.schedule.days && Object.keys(c.schedule.days).length > 0) return true;
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

