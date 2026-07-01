    function renderScheduleSection(contact) {
        if (!contact) return '';
        const hasSchedule = contact.schedule && contact.schedule.days && Object.keys(contact.schedule.days).length > 0;
        if (!hasSchedule) {
            return '<hr style="border:none;border-top:1px solid #e5e5ea;margin:12px 0">' +
                '<h4 style="margin:0 0 8px;font-size:13px;color:#1c1c1e">Schedule</h4>' +
                '<p style="font-size:12px;color:#8e8e93;margin:0 0 8px">No schedule generated yet.</p>' +
                '<button data-act="generate-schedule" data-id="' + escape(contact.id) + '" style="background:#007aff;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer">⚡ Generate Schedule</button>';
        }
        const s = contact.schedule;
        const now = getCurrentScheduleStatus(s);
        const chatNow = getChatTime();
        const todayIdx = (chatNow.getDay() + 6) % 7;
        const statusColors = { online: '#34c759', idle: '#ff9f0a', dnd: '#ff3b30', offline: '#8e8e93' };
        const statusEmoji = { online: '🟢', idle: '🟡', dnd: '🔴', offline: '⚫' };

        // Selected day (default: today)
        const selDay = state.scheduleSelectedDay || DAYS[todayIdx];
        const selBlocks = Array.isArray(s.days[selDay]) ? s.days[selDay] : [];

        // ── Status card ──
        const nowStatus = now ? now.status : 'online';
        const nowActivity = now ? now.activity : 'unknown';
        const talkPct = Math.min(100, Math.max(0, s.talkativeness || 50));
        let html = '<hr style="border:none;border-top:1px solid #e5e5ea;margin:12px 0">' +
            '<h4 style="margin:0 0 8px;font-size:13px;color:#1c1c1e">Schedule</h4>';
        html += '<div class="ps-schedule-status-card">' +
            '<span class="ps-schedule-status-icon">' + (statusEmoji[nowStatus] || '') + '</span>' +
            '<span class="ps-schedule-status-label">' + nowStatus.toUpperCase() + ' — ' + escape(nowActivity) + '</span>' +
            '<div class="ps-schedule-talk-bar"><div class="ps-schedule-talk-fill" style="width:' + talkPct + '%"></div></div>' +
            '</div>';

        // ── Day selector pills ──
        html += '<div class="ps-schedule-pills">';
        for (let i = 0; i < 7; i++) {
            const day = DAYS[i];
            const blocks = Array.isArray(s.days[day]) ? s.days[day] : [];
            const isToday = i === todayIdx;
            const isSelected = day === selDay;
            const dots = blocks.slice(0, 4).map(b =>
                '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + (statusColors[b.status] || '#ccc') + ';margin:1px 0 0 1px"></span>'
            ).join('');
            html += '<button data-act="schedule-day" data-day="' + day + '" class="ps-schedule-pill' +
                (isSelected ? ' ps-schedule-pill-sel' : '') + (isToday ? ' ps-schedule-pill-today' : '') + '">' +
                '<span>' + day.slice(0, 3) + '</span>' +
                '<span class="ps-schedule-pill-dots">' + dots + '</span></button>';
        }
        html += '</div>';

        // ── Block timeline ──
        html += '<div class="ps-schedule-blocks">';
        if (selBlocks.length) {
            // Calculate NOW position for today
            let nowMarker = '';
            if (selDay === DAYS[todayIdx] && selBlocks.length) {
                const firstBlock = selBlocks[0];
                const lastBlock = selBlocks[selBlocks.length - 1];
                const firstMin = timeToMinutes(firstBlock.time.split('-')[0]);
                const lastEndMin = timeToMinutes(lastBlock.time.split('-')[1]);
                const nowMin = chatNow.getHours() * 60 + chatNow.getMinutes();
                if (nowMin >= firstMin && nowMin <= lastEndMin) {
                    const total = lastEndMin - firstMin || 1;
                    const pct = ((nowMin - firstMin) / total) * 100;
                    const timeLabel = chatNow.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    nowMarker = '<div class="ps-schedule-now" style="top:' + pct.toFixed(1) + '%"><span>NOW ' + timeLabel + '</span></div>';
                }
            }
            html += nowMarker;
            for (const block of selBlocks) {
                html += '<div class="ps-schedule-block">' +
                    '<span class="ps-schedule-block-time">' + escape(block.time) + '</span>' +
                    '<span class="ps-schedule-block-dot" style="background:' + (statusColors[block.status] || '#ccc') + '"></span>' +
                    '<span class="ps-schedule-block-activity">' + escape(block.activity) + '</span>' +
                    '<span class="ps-schedule-block-status">' + (block.status || '').toUpperCase() + '</span></div>';
            }
        } else {
            html += '<p class="ps-empty" style="font-size:12px;color:#8e8e93;padding:12px">No blocks for ' + selDay + '.</p>';
        }
        html += '</div>';
        html += '<div style="margin-top:10px"><button data-act="generate-schedule" data-id="' + escape(contact.id) + '" style="background:none;border:1px solid #007aff;color:#007aff;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer">🔄 Regenerate Schedule</button></div>';
        return html;
    }

    function timeToMinutes(t) {
        const parts = (t || '').split(':');
        return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
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

