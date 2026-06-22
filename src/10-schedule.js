    function getMonday(date) {
        const d = new Date(date || Date.now());
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff); d.setHours(0, 0, 0, 0);
        return d;
    }

    // Returns the in-chat time from the last message's send_date, falling
    // back to real system time. Prevents schedules from showing "lunch break"
    // when the story is at midnight.
    // ─── Story Time Inference ────────────────────────────────────────
    // Scans AI-generated messages for narrative time cues ("the next morning",
    // "two hours later", etc.) and tracks story time independently of RPG Companion.
    // Only updates on NEW AI messages, and only when time has actually changed.
    function detectAndStoreStoryTime() {
        try {
            const ctx = getCtx();
            if (!ctx?.chat || !Array.isArray(ctx.chat) || !ctx.chat.length) return;
            const last = ctx.chat[ctx.chat.length - 1];
            if (!last || last.is_user) return;
            const text = (last.mes || '').trim();
            if (!text) return;
            const msgIndex = ctx.chat.length - 1;
            const meta = getChatMeta();
            if (!meta) return;
            const prev = meta.storyTime;
            if (prev && prev.lastMsgIndex === msgIndex) return;

            const currentTime = prev && prev.timestamp
                ? new Date(prev.timestamp)
                : getChatTime();
            const inferred = inferTimeFromText(text, currentTime);
            if (inferred) {
                meta.storyTime = {
                    timestamp: inferred.toISOString(),
                    source: 'inferred',
                    lastMsgIndex: msgIndex
                };
                console.log('[PhoneSocial] 🕐 story time: ' +
                    inferred.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                    ' (' + inferred.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ')');
                saveMeta();
            }
        } catch (e) {
            console.warn('[PhoneSocial] detectAndStoreStoryTime error:', e);
        }
    }

    // Pattern-based time inference from narrative text. Returns a Date if a time
    // change is detected, null if no time cue found (time hasn't moved).
    function inferTimeFromText(text, currentTime) {
        const t = text.slice(0, 1500).toLowerCase();
        const d = new Date(currentTime);

        // Absolute time of day: "at 3:00 PM", "around 11:30 am"
        const absTime = t.match(/\b(at|around|by|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
        if (absTime) {
            let h = parseInt(absTime[2]);
            const m = absTime[3] ? parseInt(absTime[3]) : 0;
            const ampm = (absTime[4] || '').toLowerCase();
            if (ampm.startsWith('p') && h < 12) h += 12;
            if (ampm.startsWith('a') && h === 12) h = 0;
            d.setHours(h, m, 0, 0);
            if (d <= currentTime) d.setDate(d.getDate() + 1);
            return d;
        }

        // "the next morning" / "the following morning"
        if (/\bthe\s+(next|following)\s+morning\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            d.setHours(8, 0, 0, 0);
            return d;
        }

        // "the next day" / "the following day"
        if (/\bthe\s+(next|following)\s+day\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            return d;
        }

        // "X hours later"
        const hoursLater = t.match(/\b(\d+)\s+hours?\s+later\b/i);
        if (hoursLater) {
            d.setHours(d.getHours() + parseInt(hoursLater[1]));
            return d;
        }

        // "X minutes later"
        const minsLater = t.match(/\b(\d+)\s+minutes?\s+later\b/i);
        if (minsLater) {
            d.setMinutes(d.getMinutes() + parseInt(minsLater[1]));
            return d;
        }

        // "later that evening" / "later that night"
        if (/\blater\s+that\s+evening\b/i.test(t)) { d.setHours(20, 0, 0, 0); return d; }
        if (/\blater\s+that\s+night\b/i.test(t)) { d.setHours(22, 0, 0, 0); return d; }

        // "that evening" / "that night" / "that afternoon"
        if (/\bthat\s+evening\b/i.test(t)) { d.setHours(19, 0, 0, 0); return d; }
        if (/\bthat\s+night\b/i.test(t)) { d.setHours(22, 0, 0, 0); return d; }
        if (/\bthat\s+afternoon\b/i.test(t)) { d.setHours(14, 0, 0, 0); return d; }

        // "the following afternoon"
        if (/\bthe\s+following\s+afternoon\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            d.setHours(14, 0, 0, 0);
            return d;
        }

        // "at midnight"
        if (/\bat\s+midnight\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0, 0, 0);
            return d;
        }

        // "at dawn" / "at sunrise" / "first light"
        if (/\bat\s+(dawn|sunrise|first\s+light)\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            d.setHours(6, 0, 0, 0);
            return d;
        }

        // "the sun had set" / "darkness fell"
        if (/\bthe\s+sun\s+(had|was)\s+set/i.test(t) || /\bdarkness\s+fell\b/i.test(t)) {
            d.setHours(20, 0, 0, 0);
            return d;
        }

        // "hours passed" / "several hours"
        if (/\bhours\s+passed\b/i.test(t) || /\bseveral\s+hours\b/i.test(t)) {
            d.setHours(d.getHours() + 3);
            return d;
        }

        // "a few minutes later" / "moments later"
        if (/\ba\s+few\s+minutes\s+later\b/i.test(t) || /\bmoments?\s+later\b/i.test(t)) {
            d.setMinutes(d.getMinutes() + 15);
            return d;
        }

        // "a while later" / "some time later"
        if (/\b(a\s+while|some\s+time)\s+later\b/i.test(t)) {
            d.setHours(d.getHours() + 1);
            return d;
        }

        // "morning came" / "morning arrived" / "morning broke"
        if (/\bmorning\s+(came|arrived|broke)\b/i.test(t)) {
            d.setDate(d.getDate() + 1);
            d.setHours(7, 0, 0, 0);
            return d;
        }

        return null;
    }

    function getChatTime() {
        try {
            const ctx = getCtx();
            const meta = getChatMeta();
            if (meta?.storyTime?.timestamp) {
                const ts = new Date(meta.storyTime.timestamp);
                if (!isNaN(ts.getTime())) return ts;
            }
            // ── Priority 1: RPG Companion in-game time ──
            const rpgData = ctx?.chatMetadata?.rpg_companion;
            if (rpgData) {
                const infoBoxRaw = rpgData.committedTrackerData?.infoBox || rpgData.lastGeneratedData?.infoBox;
                if (infoBoxRaw) {
                    const parsed = parseRpgTime(infoBoxRaw);
                    if (parsed) return parsed;
                }
            }
            // ── Priority 2: Last message send_date ──
            if (ctx?.chat && Array.isArray(ctx.chat) && ctx.chat.length) {
                const last = ctx.chat[ctx.chat.length - 1];
                if (last?.send_date) {
                    const ts = typeof last.send_date === 'number' ? last.send_date * 1000 : Date.parse(last.send_date);
                    if (!isNaN(ts)) return new Date(ts);
                }
            }
        } catch (_) {}
        // ── Fallback: real system time ──
        return new Date();
    }

    // Parse RPG Companion's infoBox time format into a Date.
    // Handles both JSON {time:{start,end},date,weekday,month,year} and text "Time: HH:MM → HH:MM" formats.
    function parseRpgTime(raw) {
        try {
            const str = String(raw).trim();
            // Try JSON first
            if (str.startsWith('{')) {
                const obj = JSON.parse(str);
                const time = obj.time?.end || obj.time?.start || obj.time;
                const timeStr = typeof time === 'string' ? time : (time?.end || time?.start || '');
                const dateStr = obj.date || '';
                const monthStr = obj.month || '';
                const yearStr = obj.year || '';
                return buildDateFromParts(timeStr, dateStr, monthStr, yearStr);
            }
            // Try text format: "Time: 14:30 → 15:00"
            const timeMatch = str.match(/Time:\s*(\d{1,2}:\d{2})(?:\s*[→-]\s*(\d{1,2}:\d{2}))?/i);
            if (timeMatch) {
                const endTime = timeMatch[2] || timeMatch[1];
                const dateMatch = str.match(/Date:\s*(.+)/i);
                return buildDateFromParts(endTime, dateMatch?.[1] || '', '', '');
            }
        } catch (_) {}
        return null;
    }

    function buildDateFromParts(timeStr, dateStr, monthStr, yearStr) {
        const timeMatch = (timeStr || '').match(/(\d{1,2}):(\d{2})/);
        if (!timeMatch) return null;
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const now = new Date();
        now.setHours(hours, minutes, 0, 0);
        // If we have a date, try to set day/month/year
        if (dateStr) {
            const dayNum = parseInt(dateStr);
            if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) now.setDate(dayNum);
        }
        if (monthStr) {
            const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
            const m = months[monthStr.toLowerCase()] ?? (parseInt(monthStr) - 1);
            if (!isNaN(m) && m >= 0) now.setMonth(m);
        }
        if (yearStr) {
            const y = parseInt(yearStr);
            if (!isNaN(y) && y > 0) now.setFullYear(y);
        }
        return now;
    }

    function inferStatusFromActivity(activity) {
        const lower = (activity || '').toLowerCase();
        for (const [kw, st] of Object.entries(STATUS_KEYWORDS)) {
            if (lower.includes(kw)) return st;
        }
        return 'online';
    }

    function getCurrentScheduleStatus(schedule, now) {
        if (!schedule || !schedule.days) return null;
        const d = now ? new Date(now) : getChatTime();
        const dayName = DAYS[(d.getDay() + 6) % 7];
        const daySchedule = schedule.days[dayName];
        if (!Array.isArray(daySchedule) || !daySchedule.length) return null;
        const curMin = d.getHours() * 60 + d.getMinutes();
        for (const block of daySchedule) {
            if (!block || !block.time) continue;
            const [start, end] = block.time.split('-');
            if (!start || !end) continue;
            const [sh, sm] = start.split(':').map(Number);
            const [eh, em] = end.split(':').map(Number);
            const sMin = (sh || 0) * 60 + (sm || 0);
            const eMin = (eh || 0) * 60 + (em || 0);
            if (sMin <= curMin && curMin < eMin) return { status: block.status, activity: block.activity };
            if (sMin > eMin && (curMin >= sMin || curMin < eMin)) return { status: block.status, activity: block.activity };
        }
        return null;
    }

    function scheduleNeedsRefresh(schedule) {
        if (!schedule || !schedule.weekStart) return true;
        return getMonday().getTime() > new Date(schedule.weekStart).getTime();
    }

    function parseScheduleResponse(content) {
        let jsonStr = String(content || '').trim();
        const mdMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (mdMatch) jsonStr = mdMatch[1].trim();
        const braceStart = jsonStr.indexOf('{');
        const braceEnd = jsonStr.lastIndexOf('}');
        if (braceStart !== -1 && braceEnd !== -1) jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
        jsonStr = jsonStr
            .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/,\s*([\]\}])/g, '$1')
            .replace(/\.{3,}[^"}\]\n]*/g, '')
            .replace(/\n\s*\n/g, '\n');
        let data;
        try { data = JSON.parse(jsonStr); } catch (_) {
            const lines = jsonStr.split('\n').filter(l => {
                const t = l.trim();
                if (!t) return false;
                if (/^[{}\[\],]/.test(t) || /^"/.test(t) || /^\d/.test(t) || /^[}\]]/.test(t)) return true;
                return false;
            });
            const repaired = lines.join('\n').replace(/,\s*([\]\}])/g, '$1');
            try { data = JSON.parse(repaired); } catch (e) {
                console.warn('[PhoneSocial] schedule parse failed:', e?.message, 'raw:', content.slice(0, 200));
                return null;
            }
        }
        const days = {};
        for (const day of DAYS) {
            const blocks = Array.isArray(data.days?.[day]) ? data.days[day] : [];
            days[day] = blocks.map(b => ({
                time: b.time || '00:00-00:00',
                activity: b.activity || 'free time',
                status: (b.status && ['online','idle','dnd','offline'].includes(b.status)) ? b.status : inferStatusFromActivity(b.activity),
            }));
        }
        return {
            weekStart: getMonday().toISOString(),
            talkativeness: Math.max(0, Math.min(100, data.talkativeness ?? 50)),
            inactivityThresholdMinutes: Math.max(15, Math.min(360, data.inactivityThresholdMinutes ?? 120)),
            days,
        };
    }

    async function generateSchedule(contactId) {
        const contact = state.contacts.find(c => c.id === contactId);
        if (!contact) return null;
        const ctx = getCtx();
        let charName = contact.name;
        let charDesc = '';
        let charPersonality = '';
        if (ctx?.characters) {
            let match = ctx.characters.find(ch => ch && ch.name && ch.name.toLowerCase() === charName.toLowerCase());
            // ── Ensemble card fallback: when NPCs don't have individual cards,
            // pull from the main character (the ensemble card that writes
            // everyone's dialogue). Extract only the lines mentioning this NPC.
            if (!match) {
                const mainChar = ctx.characters.find(ch => ch && ch.name && !ch.name.toLowerCase().includes('user'));
                if (mainChar?.data) {
                    const fullDesc = (mainChar.data.description || '').trim();
                    const fullPersonality = (mainChar.data.personality || '').trim();
                    const nameEscaped = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const nameRe = new RegExp('[^.]*\\b' + nameEscaped + '\\b[^.]*\\.', 'gi');
                    // Extract sentences mentioning this NPC from description
                    const descMatches = fullDesc.match(nameRe) || [];
                    if (descMatches.length) {
                        charDesc = descMatches.join(' ').slice(0, 800);
                    } else if (fullDesc) {
                        // No specific mention — use first 800 chars of full description
                        charDesc = fullDesc.slice(0, 800);
                    }
                    // Same for personality
                    const personalityMatches = fullPersonality.match(nameRe) || [];
                    if (personalityMatches.length) {
                        charPersonality = personalityMatches.join(' ').slice(0, 500);
                    } else if (fullPersonality) {
                        charPersonality = fullPersonality.slice(0, 500);
                    }
                }
            } else if (match?.data) {
                charDesc = (match.data.description || '').trim().slice(0, 800);
                charPersonality = (match.data.personality || '').trim().slice(0, 500);
            }
        }
        let continuity = '';
        if (contact.schedule && contact.schedule.days) {
            const prevBlocks = [];
            for (const day of DAYS) {
                const b = contact.schedule.days[day];
                if (Array.isArray(b)) prevBlocks.push(day + ': ' + b.map(x => x.time + ' ' + x.activity).join(', '));
            }
            continuity = '\n\nRecent continuity:\nThis character had the following schedule last week. Use it to maintain consistency:\n' +
                prevBlocks.join('\n') + '\nIf recent events changed their job, school, health, relationships, or obligations, reflect those changes. Otherwise preserve their established routine.';
        }
        // ── Cross-reference: other NPCs' schedules (compact — only relevant blocks) ──
        let crossRef = '';
        const otherContacts = state.contacts.filter(c => c.id !== contactId && c.schedule && c.schedule.days);
        if (otherContacts.length) {
            const conflicts = [];
            const nameEscaped = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const nameRe = new RegExp('\\b' + nameEscaped + '\\b', 'i');
            for (const oc of otherContacts) {
                const mentions = [];
                for (const day of DAYS) {
                    const b = oc.schedule.days[day];
                    if (!Array.isArray(b)) continue;
                    for (const block of b) {
                        if (nameRe.test(block.activity || '')) {
                            mentions.push(day + ' ' + block.time + ': ' + block.activity + ' [' + block.status + ']');
                        }
                    }
                }
                if (mentions.length) {
                    conflicts.push(oc.name + ' expects to be with ' + charName + ' at:\n  ' + mentions.join('\n  '));
                }
            }
            if (conflicts.length) {
                crossRef = '\n\n⚠️ CROSS-REFERENCE — other characters expect to interact with ' + charName + ':\n' +
                    conflicts.join('\n\n') + '\n\n' +
                    '⛔ MANDATORY: ' + charName + ' MUST be available and online during EVERY time block listed above. ' +
                    'These are specific commitments other characters have already made. ' +
                    'Your schedule MUST align — same time, same activity, compatible status (online or dnd, NOT offline).';
                console.log('[PhoneSocial] generateSchedule crossRef for ' + charName + ': ' + conflicts.length + ' other NPC(s) expect interaction');
            } else {
                console.log('[PhoneSocial] generateSchedule crossRef for ' + charName + ': no other NPCs mention them');
            }
        }
        // ── Build rich story evidence: NPC's own lines + surrounding scene context ──
        let storyContext = '';
        if (ctx?.chat) {
            const nameLower = charName.toLowerCase();
            // NO is_system filter — in many chats, character messages are
            // marked system (world info, summaries, extension injections).
            // This would silently discard all NPC dialogue, making the AI
            // think the NPC hasn't spoken at all.
            const recentMsgs = ctx.chat.slice(-60).filter(m => !!m);
            // Collect NPC's own messages AND the lines immediately around them for scene context
            const sceneSnapshots = [];
            let sceneCollectDebug = [];
            for (let i = 0; i < recentMsgs.length; i++) {
                const m = recentMsgs[i];
                const speaker = (m.name || '').toLowerCase();
                sceneCollectDebug.push(speaker || '?');
                if (speaker === nameLower) {
                    const before = recentMsgs[i - 1];
                    const after = recentMsgs[i + 1];
                    let snapshot = (m.mes || m.text || '').trim().slice(0, 250);
                    if (before) {
                        const ctxLine = (before.mes || before.text || '').trim().slice(0, 150);
                        snapshot = '[' + (before.name || 'Someone') + ': ' + ctxLine + ']\n' + charName + ': ' + snapshot;
                    }
                    sceneSnapshots.push(snapshot);
                }
            }
            console.log('[PhoneSocial] generateSchedule scene evidence for ' + charName + ': ' + sceneSnapshots.length + ' snapshots from ' + recentMsgs.length + ' msgs. Speakers: ' + [...new Set(sceneCollectDebug)].join(', '));
            // ── Ensemble card support: when NPCs are written through a single
            // character card (e.g. "COD: Task Force RPG"), individual NPC names
            // never appear as speakers. Scan the AI's narration messages for
            // lines that mention this NPC by name — treat them as pseudo-dialogue.
            if (!sceneSnapshots.length) {
                const nameRegex = new RegExp('\\b' + nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
                const aiMsgs = ctx.chat.slice(-40).filter(m => !!m && !m.is_user);
                for (const m of aiMsgs) {
                    const content = (m.mes || m.text || '');
                    if (nameRegex.test(content)) {
                        // Extract the sentences around the name mention for focused context
                        const sentences = content.split(/(?<=[.!?])\s+/);
                        const relevant = sentences.filter(s => nameRegex.test(s)).join(' ').slice(0, 400);
                        if (relevant) {
                            sceneSnapshots.push('[AI Narration mentioning ' + charName + ']\n' + relevant);
                        }
                    }
                }
                console.log('[PhoneSocial] generateSchedule ensemble fallback for ' + charName + ': ' + sceneSnapshots.length + ' narration snapshots from ' + aiMsgs.length + ' AI msgs');
            }
            // Collect NPC memories as additional evidence
            let memoryContext = '';
            if (Array.isArray(contact.memories) && contact.memories.length) {
                const recentMems = contact.memories.slice(-10);
                memoryContext = '\n\nKnown facts about ' + charName + ':\n' +
                    recentMems.map(m => '- ' + (m.text || '')).join('\n');
            }
            if (sceneSnapshots.length) {
                storyContext = '\n\nScene evidence — recent appearances in the story (includes surrounding context):\n' +
                    sceneSnapshots.slice(-10).map((txt, i) => `--- Scene ${i + 1} ---\n${txt}`).join('\n\n') +
                    memoryContext +
                    '\n\n⛔ CRITICAL INSTRUCTIONS FOR SCHEDULE CREATION ⛔\n' +
                    '1. BUILD A COMPLETE WEEKLY LIFE. This character has their OWN independent life, routines, job, hobbies, and responsibilities. They are NOT always with the user.\n' +
                    '2. Chat evidence is ANCHOR material — if the character mentions working night shifts, lock those in. But fill ALL 24 hours of every day, not just what was observed.\n' +
                    '3. Use SPECIFIC activities tailored to this character. Never use generic "work" or "sleeping" alone — use "patrolling the east ward", "barista shift at The Daily Grind", "studying for the bar exam", "feeding the horses at dawn".\n' +
                    '4. INFER from personality, backstory, and the character card. A musician practices. A student has classes. A parent has childcare. A werewolf transforms at night. Fill in what the chat doesn\'t show.\n' +
                    '5. Make it BELIEVABLE — the schedule should feel like a real person\'s weekly routine, with variety across days, realistic downtime, and activities that match who they are.';
            } else {
                // Fallback: NPC hasn't spoken recently, but give the AI the recent
                // scene to prove the scene IS active at the current hour. Without
                // this the AI defaults to "midnight = sleep" for every NPC.
                const fallbackMsgs = recentMsgs.slice(-8);
                if (fallbackMsgs.length) {
                    storyContext = '\n\nCurrent scene (character is present in this scene right now, even though they haven\'t spoken yet — they are ACTIVE and AWAKE):\n' +
                        fallbackMsgs.map(m => '[' + (m.name || 'Someone') + '] ' + ((m.mes || m.text || '').trim().slice(0, 200))).join('\n\n') +
                        memoryContext +
                        '\n\nThis character IS in this scene. They are AWAKE and participating. Build their schedule to reflect that they are active at this hour.';
                } else if (memoryContext) {
                    storyContext = memoryContext +
                        '\n\nBuild a complete weekly schedule for this character based on their personality and known facts. They have their own independent life.';
                }
            }
        }
        const systemPrompt = [
            'You are a schedule generator. Create a realistic weekly schedule for a character based on their personality and description.',
            '',
            'Character: ' + charName,
            'Description: ' + (charDesc || '(no description available)'),
            'Personality: ' + (charPersonality || '(no personality info)'),
            '',
            (() => { try { const t = getChatTime(); const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']; const h = t.getHours(); const m = String(t.getMinutes()).padStart(2,'0'); const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12; const day = days[t.getDay()]; return '📅 Current story time: ' + day + ' ' + h12 + ':' + m + ' ' + ampm + ' (use as reference for the schedule).'; } catch(_) { return ''; }})(),
            continuity,
            crossRef,
            storyContext,
            '',
            '⛔ CORE PRINCIPLE: Build this character\'s INDEPENDENT weekly life.',
            'They have their own job, hobbies, routines, friends, and responsibilities that exist regardless of the user.',
            'The schedule should reflect who they ARE — a soldier trains, a student studies, a parent has childcare.',
            'Use their personality, backstory, and description to infer their daily routines.',
            '',
            'Generate a complete schedule for each day (Monday through Sunday). Every day must cover the full 24 hours.',
            'Use SPECIFIC, CHARACTER-TAILORED activities. Examples:',
            '- "morning patrol of the east ward" (not just "work")',
            '- "barista shift at The Daily Grind" (not just "work")',
            '- "studying for the bar exam at the library" (not just "studying")',
            '- "feeding the horses and mucking stalls" (not just "chores")',
            '',
            'Each time block must include a "status" field:',
            '- "online": awake and available (free time, socializing, casual activities)',
            '- "idle": semi-available (eating, commuting, showering, cooking)',
            '- "dnd": busy / do not disturb (working, studying, training, in a meeting)',
            '- "offline": unavailable (sleeping, passed out, unconscious)',
            '',
            'Also assess talkativeness (0-100):',
            '0-20: Very introverted, rarely initiates  |  21-40: Quiet  |  41-60: Average',
            '61-80: Social, chats frequently  |  81-100: Very chatty',
            '',
            'Estimate inactivityThresholdMinutes (how long they wait before reaching out):',
            'Patient: 180-360 min  |  Average: 60-180 min  |  Chatty: 15-60 min',
            '',
            'Respond in EXACTLY this JSON format (no markdown, no code blocks, just raw JSON):',
            '{',
            '  "talkativeness": 65,',
            '  "inactivityThresholdMinutes": 45,',
            '  "days": {',
            '    "Monday": [',
            '      {"time":"06:00-08:00","activity":"waking up and morning routine","status":"idle"},',
            '      {"time":"08:00-12:00","activity":"at work","status":"dnd"},',
            '      ...',
            '    ],',
            '    "Tuesday": [...],',
            '    ...through Sunday...',
            '  }',
            '}',
            'Include ALL 7 days. No ellipsis, comments, or placeholders in the actual output.',
        ].filter(Boolean).join('\n');

        const text = await callTurboApi(systemPrompt, 'Generate the schedule now.');
        if (!text) return null;
        const schedule = parseScheduleResponse(text);
        if (!schedule) return null;
        contact.schedule = schedule;
        contact._scheduleCache = undefined;
        const chatKeyAtStart = getChatKey();
        // Small delay to let any pending chat switches settle
        await new Promise(r => setTimeout(r, 50));
        if (getChatKey() !== chatKeyAtStart) {
            console.warn('[PhoneSocial] chat changed during schedule generation — discarding');
            return null;
        }
        saveMeta();
        console.log('[PhoneSocial] schedule generated for ' + contact.name + ' (talk=' + schedule.talkativeness + ', threshold=' + schedule.inactivityThresholdMinutes + 'min)');
        // ── Cascade: auto-regenerate NPCs mentioned in this new schedule ──
        // When Horangi says "hanging out with Ghost at 10 PM," Ghost's schedule
        // must be updated so Ghost knows he's with Horangi, not on recon.
        scheduleCascade(contact, schedule);
        return schedule;
    }

    // ── Cascade regeneration ──
    // When Horangi's new schedule says "hanging out with Ghost at 10 PM,"
    // auto-regenerate Ghost so Ghost sees Horangi's updated schedule and
    // stops thinking he's on a stealth recon mission at that time.
    // Depth limit: 2 levels (A→B→C, but C won't cascade further).
    // Cycle guard: tracks visited NPCs to avoid A→B→A ping-pong.
    let _cascadeVisited = new Set();
    function scheduleCascade(sourceContact, sourceSchedule, depth = 0) {
        if (depth >= 2) return;
        const srcName = sourceContact.name;
        _cascadeVisited.add(srcName);
        // Scan all time blocks for mentions of other NPCs
        const mentioned = new Set();
        const allActivities = [];
        const days = sourceSchedule.days;
        if (!days) return;
        for (const day of Object.keys(days)) {
            const blocks = days[day];
            if (!Array.isArray(blocks)) continue;
            for (const b of blocks) {
                allActivities.push((b.activity || '').toLowerCase());
            }
        }
        // Check each other contact's name against the accumulated activities
        for (const c of state.contacts) {
            if (c.id === sourceContact.id) continue;
            if (_cascadeVisited.has(c.name)) continue;
            if (c.source === 'st-character' || c.source === 'st-group') continue;
            // Only cascade if the other NPC has an existing schedule (to update)
            if (!c.schedule || !c.schedule.days) continue;
            const nameLower = c.name.toLowerCase();
            const fullText = allActivities.join(' ');
            if (fullText.includes(nameLower)) {
                mentioned.add(c);
            }
        }
        if (!mentioned.size) return;
        console.log('[PhoneSocial] 🔄 cascade: ' + srcName + ' mentions ' + [...mentioned].map(c => c.name).join(', ') + ' — regenerating them (depth ' + depth + ')');
        // Regenerate each mentioned NPC after a short delay
        let delay = 2000;
        for (const c of mentioned) {
            setTimeout(() => {
                _cascadeVisited.add(c.name);
                generateSchedule(c.id);
            }, delay);
            delay += 3000; // stagger to avoid rate limits
        }
        // Clean up visited set after cascade completes
        setTimeout(() => {
            for (const c of mentioned) {
                _cascadeVisited.delete(c.name);
            }
            _cascadeVisited.delete(srcName);
        }, delay + 5000);
    }

