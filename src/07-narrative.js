    function isNpcPresent(contactName, opts = {}) {
        const useNarration = opts.narration !== false;
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return false;
            const nameLower = contactName.toLowerCase();
            // NO is_system filter — in many chats, 80%+ of messages are marked
            // system (world info, summaries, extension injections), leaving too
            // few real messages to detect NPC presence. System messages don't have
            // NPC names anyway, so checking them is harmless.
            const recent = ctx.chat.slice(-80).filter(m => !!m);
            // Pass 1: speaker check — NPC has a speaking line → definitely present.
            // Ensemble cards like "Corey + Jay" write multiple NPCs through a single
            // speaker name. A part match counts as that individual NPC speaking.
            for (const m of recent) {
                const speaker = (m.name || '').toLowerCase();
                if (!speaker) continue;
                if (speaker === nameLower) return true;
                // Check if contact name is a token inside a compound speaker
                // (e.g. "corey" inside "corey + jay" but NOT "jay" inside "jayden")
                if (/[+,&]/.test(speaker)) {
                    const parts = speaker.split(/[+,&]\s*/).map(p => p.trim()).filter(Boolean);
                    if (parts.includes(nameLower)) return true;
                }
            }
            // Pass 2: ensemble card detection — when all NPCs are written through
            // a single character card (e.g. "COD: Task Force RPG"), individual NPCs
            // never appear as speakers. Scan the last 5 AI messages for NPC name
            // mentions — ensemble AI narration often rotates focus between characters,
            // so a single message misses NPCs who are clearly still present on-scene.
            if (useNarration) {
                const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const wordBoundary = new RegExp('\\b' + escaped + '\\b');
                // Last 8 AI messages — covers the full narrative context window.
                // NO is_system filter — matches Pass 1 above. In many chats AI narration
                // messages are flagged is_system, so filtering would miss ensemble NPCs.
                const aiMsgs = [...ctx.chat].reverse().filter(m => !!m && !m.is_user).slice(0, 8);
                for (const m of aiMsgs) {
                    const content = (m.mes || m.text || '').toLowerCase();
                    if (wordBoundary.test(content)) return true;
                }
            }
        } catch (_) {}
        return false;
    }

    
    // ─── Narrative-triggered proactive check ─────────────────────────
    // Scans the last several AI messages for cues that NPCs are trying to
    // contact the user (phone blowing up, texting, calling, "X is calling you").
    // When found, immediately triggers calls/texts from implicated contacts.
    // Also scans user messages for call-answering cues ("I pick up", "I answer").
    function checkNarrativeTriggers() {
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return;
            const contacts = state.contacts;
            if (!contacts.length || !state.settings.autoReplies) return;
            if (state.userDnd) return;

            // ── Scan last 6 messages (both AI and user), newest first ──
            const recentMsgs = [...ctx.chat].reverse().filter(m => !!m).slice(0, 6);
            if (!recentMsgs.length) return;

            // ── Pattern 1: Generic "phone blowing up" cues ──
            const phoneBlowingUp = /\b(blowing\s+up\s+your\s+phone|((your|my|her|his|their|the)\s+)?phone\b[^.]{0,120}\b(lit|lights?|lighted|glowed?|glows?|flashed?)\s+up|((your|my|her|his|their|the)\s+)?phone\b[^.]{0,120}\bnotification|phone\s+(keeps?\s+)?(buzzing|vibrating|ringing|going\s+off)|phone\s+(won'?t\s+stop|hasn'?t\s+stopped)|(missed|ignoring)\s+(a\s+)?(bunch|ton|lots?)\s+of\s+(calls?|texts?|messages?|notifications?)|(your|my|her|his|their)\s+phone\s+(is\s+)?(blowing|exploding))\b/i;

            // ── Pattern 2: Group reference near communication verbs ──
            const groupPhoneRe = /\b(your\s+(family|parents?|siblings?|friends?|crew|squad|team|group|folks?|people)\s+(has|have|is|are|been|keep|keeps)\s+(texting|calling|messaging|trying\s+to\s+reach|blowing\s+up|hitting\s+up|contacting|checking\s+in|reaching\s+out))\b/i;

            // ── Pattern 3: User answering a call ──
            const userAnswerRe = /(I\s+(pick\s+up|answer|grab)\s+(the\s+)?(phone|call)|(pick up|answer|get)\s+(the\s+)?phone|(accept|take)\s+the\s+call)/i;

            // ── UIE-STYLE NARRATION SCAN ─────────────────────────────────
            // Before checking contacts, scan the raw AI narration for phone events.
            // These work WITHOUT pre-existing contacts — the AI's own narration
            // drives everything, just like UIE's scanForPhoneEvents.
            // Scans all 6 recent messages (not just the latest) for phone cues.
            const uieCallRe = /call\s+incoming\s*(?:from)?\s*[:\-]?\s*([A-Za-z0-9 _'".\-]{2,60})/i;
            const uieTextRe = /new\s+message\s*(?:from)?\s*[:\-]?\s*([A-Za-z0-9 _'".\-]{2,60})\s*[:\-]\s*([\s\S]{1,600})/i;
            const uieCallTagRe = /\[\s*UIE_CALL\s*:\s*([^\]]+?)\s*\]/i;
            const uieTextTagRe = /\[\s*UIE_TEXT\s*:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/i;

            // Helper: find or create contact by name
            const findOrCreateContact = (name) => {
                const norm = name.trim().toLowerCase();
                if (!norm || norm.length < 2) return null;
                // Check existing contacts
                let c = contacts.find(x => x.name.toLowerCase() === norm);
                if (c) return c;
                // Check blocked
                const blocked = getBlockedSet();
                if (isBlocked(name, blocked)) return null;
                // Create new contact — reactive, just like UIE
                c = {
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name: name.trim(),
                    number: genNumber(),
                    schedule: null,
                    source: 'narration',
                    starred: false,
                };
                state.contacts.push(c);
                console.log('[PhoneSocial] 📖 UIE-scan: created contact "' + name.trim() + '" from narrative cue');
                return c;
            };

            let triggeredContacts = [];
            const alreadyTriggered = new Set();

            // ── UIE PASS: scan raw AI narration for phone events ──
            for (const msg of recentMsgs) {
                const rawText = (msg.mes || msg.text || '').trim();
                if (!rawText || rawText.length < 15) continue;

                // Tagged call: [UIE_CALL: Name]
                const callTag = rawText.match(uieCallTagRe);
                if (callTag) {
                    const who = callTag[1].trim().slice(0, 80);
                    const c = findOrCreateContact(who);
                    if (c && !alreadyTriggered.has(c.id)) {
                        console.log('[PhoneSocial] 📖 UIE-tag: incoming call from ' + who);
                        triggeredContacts.push(c);
                        alreadyTriggered.add(c.id);
                        c._callTriggered = true;
                    }
                }

                // Tagged text: [UIE_TEXT: Name | body]
                const textTag = rawText.match(uieTextTagRe);
                if (textTag) {
                    const who = textTag[1].trim().slice(0, 80);
                    const body = textTag[2].trim().slice(0, 1200);
                    if (body) {
                        const c = findOrCreateContact(who);
                        if (c && !alreadyTriggered.has(c.id)) {
                            console.log('[PhoneSocial] 📖 UIE-tag: incoming text from ' + who);
                            // Deliver immediately — don't wait for the trigger loop
                            if (!state.threads[c.id]) state.threads[c.id] = [];
                            state.threads[c.id].push({ from: 'them', text: body, ts: Date.now(), seen: false });
                            saveMeta();
                            updateSmsInjection();
                            showIncomingBanner(c, body);
                            phoneNotify('incoming-sms', '📩 ' + c.name, c.name + ': ' + body.slice(0, 120));
                        }
                    }
                }

                // Plain-language call: "call incoming from Corey"
                const callPlain = rawText.match(uieCallRe);
                if (callPlain && !callTag) {
                    const who = callPlain[1].trim().slice(0, 80);
                    const c = findOrCreateContact(who);
                    if (c && !alreadyTriggered.has(c.id)) {
                        console.log('[PhoneSocial] 📖 UIE-plain: incoming call from ' + who);
                        triggeredContacts.push(c);
                        alreadyTriggered.add(c.id);
                        c._callTriggered = true;
                    }
                }

                // Plain-language text: "new message from Corey: Hey what's up"
                const textPlain = rawText.match(uieTextRe);
                if (textPlain && !textTag) {
                    const who = textPlain[1].trim().slice(0, 80);
                    const body = textPlain[2].trim().slice(0, 1200);
                    if (body) {
                        const c = findOrCreateContact(who);
                        if (c && !alreadyTriggered.has(c.id)) {
                            console.log('[PhoneSocial] 📖 UIE-plain: incoming text from ' + who);
                            // Deliver inline — the AI already wrote the message
                            if (!state.threads[c.id]) state.threads[c.id] = [];
                            state.threads[c.id].push({ from: 'them', text: body, ts: Date.now(), seen: false });
                            saveMeta();
                            updateSmsInjection();
                            showIncomingBanner(c, body);
                            phoneNotify('incoming-sms', '📩 ' + c.name, c.name + ': ' + body.slice(0, 120));
                        }
                    }
                }
            }

            // Helper: has this NPC had recent SMS interaction?
            const hasRecent = (c) => {
                const thread = state.threads[c.id];
                if (!Array.isArray(thread) || !thread.length) return false;
                const last = thread[thread.length - 1];
                if (last.from === 'them' && (Date.now() - (last.ts || 0)) < 600000) return true;
                if (last.from === 'me' && (Date.now() - (last.ts || 0)) < 120000) return true;
                return false;
            };

            // ── Scan each recent message ──
            for (const msg of recentMsgs) {
                const text = (msg.mes || msg.text || '').toLowerCase();
                if (!text || text.length < 15) continue;

                // ── Check 1: Specific contact names near communication verbs ──
                // "Mom's been texting you", "Dad keeps calling", "Sarah is calling"
                // "X is on the phone", "X wants to talk to you"
                for (const c of contacts) {
                    if (!c.id || !c.name) continue;
                    if (c.source === 'st-character' || c.source === 'st-group') continue;
                    // For explicit "X is calling/texting" narrative cues, only suppress
                    // contacts who are actual speakers in the scene. The default
                    // narration-aware presence check would see the cue's own name mention
                    // and incorrectly block the intended trigger.
                    if (isNpcPresent(c.name, { narration: false })) continue;
                    if (hasRecent(c)) continue;
                    if (alreadyTriggered.has(c.id)) continue;

                    const nameLower = c.name.toLowerCase();
                    const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                    // Comms verbs close to name
                    const nameCommsRe = new RegExp(
                        '\\b' + escaped + '\\b[^.]{0,80}\\b(texts?|texting|texted|calls?|calling|called|voicemail|messages?|messaging|messaged|trying\\s+to\\s+reach|reach\\s+out|hit\\s+up|DM|DMed|contacting|checking\\s+in|reaching\\s+out|on\\s+the\\s+phone|wants\\s+to\\s+(talk|speak)|left\\s+a\\s+(message|voicemail))\\b|' +
                        '\\b(texts?|texting|texted|calls?|calling|called|voicemail|messages?|messaging|messaged|trying\\s+to\\s+reach|reach\\s+out|hit\\s+up|DM|DMed|contacting|checking\\s+in|reaching\\s+out|on\\s+the\\s+phone|wants\\s+to\\s+(talk|speak)|left\\s+a\\s+(message|voicemail))\\b[^.]{0,80}\\b' + escaped + '\\b',
                        'i'
                    );

                    if (nameCommsRe.test(text)) {
                        triggeredContacts.push(c);
                        alreadyTriggered.add(c.id);
                        console.log('[PhoneSocial] 📖 narrative name-match: ' + c.name + ' mentioned with comm verb');
                    }
                }

                // ── Check 2: Generic phone-blowing-up / group → trigger eligible contacts ──
                if (triggeredContacts.length === 0 && (phoneBlowingUp.test(text) || groupPhoneRe.test(text))) {
                    const genericMatch = text.match(groupPhoneRe);
                    const groupLabel = genericMatch ? genericMatch[2] : 'contacts';
                    console.log('[PhoneSocial] 📖 narrative generic-cue: phone blowing up / ' + groupLabel + ' reaching out');

                    const candidates = [];
                    for (const c of contacts) {
                        if (!c.id || !c.name) continue;
                        if (c.source === 'st-character' || c.source === 'st-group') continue;
                        if (isNpcPresent(c.name)) continue;
                        if (hasRecent(c)) continue;
                        candidates.push(c);
                    }

                    if (candidates.length) {
                        const count = Math.min(candidates.length, Math.random() < 0.5 ? 1 : 2);
                        for (let i = candidates.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
                        }
                        triggeredContacts = candidates.slice(0, count);
                    }
                }

                // ── Check 3: User answered a phone — if there's an incoming call, auto-answer it ──
                if (msg.is_user && userAnswerRe.test(text) && state.activeCall && state.activeCall.status === 'incoming') {
                    console.log('[PhoneSocial] 📖 user answered the phone — auto-answering incoming call');
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
                }

                // Stop scanning once we have triggered contacts
                if (triggeredContacts.length >= 2) break;
            }

            if (!triggeredContacts.length) return;

            // ── Cap: no more than 2 contacts per narrative trigger ──
            if (triggeredContacts.length > 2) triggeredContacts = triggeredContacts.slice(0, 2);

            // ── Execute: trigger calls/texts from matched contacts ──
            for (const c of triggeredContacts) {
                const personality = inferPersonality(c);
                const shouldCall = c._callTriggered || personality.prefersCall || (personality.initiative >= 7 && Math.random() < 0.4);
                delete c._callTriggered; // Clean up transient flag
                c._lastProactiveTime = Date.now();

                console.log('[PhoneSocial] 📖 narrative trigger: ' + c.name + ' → ' + (shouldCall ? 'call' : 'text') + ' (AI mentioned contact activity)');

                if (shouldCall) {
                    simulateIncomingCall(c, { skipPresenceCheck: true });
                } else {
                    simulateProactiveText(c, { type: 'narrative_cue', intensity: 'medium' }, { skipPresenceCheck: true });
                }
            }
        } catch (e) {
            console.warn('[PhoneSocial] checkNarrativeTriggers error:', e);
        }
    }

    // ─── Inline SMS Ingestion ───────────────────────────────────────
    // Scans AI narration for inline SMS content ("Mom: Come home after class.")
    // and ingests them into PhoneSocial threads. Creates contacts if needed.
    function ingestInlineSMS() {
        try {
            const ctx = getCtx();
            if (!ctx?.chat || !Array.isArray(ctx.chat) || !ctx.chat.length) {
                console.log('[PhoneSocial] 🔍 inline SMS: ctx.chat missing/empty');
                return;
            }
            const last = ctx.chat[ctx.chat.length - 1];
            if (!last || last.is_user) {
                console.log('[PhoneSocial] 🔍 inline SMS: last msg is ' + (!last ? 'NULL' : 'USER — skipping'));
                return;
            }
            const text = (last.mes || '').trim();
            if (!text || text.length < 20) {
                console.log('[PhoneSocial] 🔍 inline SMS: msg text too short (' + (text ? text.length : 0) + ' chars)');
                return;
            }

            // Debug: log what we're scanning
            console.log('[PhoneSocial] 🔍 scanning AI msg for inline SMS (' + text.length + ' chars), starts: ' +
                JSON.stringify(text.slice(0, 150)));

            // Match "Name: message content" patterns — flexible about leading whitespace
            // Name must start with uppercase, 1-3 words, followed by colon and plain text (not quoted dialogue)
            const smsRe = /^\s*([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}):\s+(?!["\u201C\u201D\u2018\u2019])(.+)$/gm;
            const matches = [];
            let m;
            while ((m = smsRe.exec(text)) !== null) {
                const sender = m[1].trim();
                const msgText = m[2].trim();
                // Skip very short fragments or lines that look like narration
                if (msgText.length < 3) continue;
                // Skip if the message is in quotes (dialogue, not SMS)
                if (/^["\u201C].*["\u201D]$/.test(msgText)) continue;
                matches.push({ sender, text: msgText });
            }

            if (!matches.length) {
                console.log('[PhoneSocial] 🔍 inline SMS: regex matched 0 lines');
                return;
            }
            console.log('[PhoneSocial] 🔍 inline SMS: regex matched ' + matches.length + ' line(s) — ' +
                matches.map(x => x.sender).join(', '));

            // Only process if multiple SMS lines or an existing contact is involved.
            // BUT: always create a new contact for a single-match with a proper name.
            const involvedNames = [...new Set(matches.map(x => x.sender.toLowerCase()))];
            const hasExistingContact = involvedNames.some(name =>
                state.contacts.some(c => c.name.toLowerCase() === name)
            );
            if (!hasExistingContact && matches.length < 2) {
                // Single match, no existing contact — still ingest if it's a proper name
                const singleSender = matches[0].sender;
                if (singleSender.length < 2 || singleSender[0] !== singleSender[0].toUpperCase()) {
                    console.log('[PhoneSocial] 🔍 inline SMS: single match for non-proper-name "' + singleSender + '" — skipping');
                    return;
                }
                console.log('[PhoneSocial] 🔍 inline SMS: single match for new contact "' + singleSender + '" — will create');
            }

            let ingested = 0;
            for (const { sender, text: msgText } of matches) {
                const nameLower = sender.toLowerCase();
                let contact = state.contacts.find(c => c.name.toLowerCase() === nameLower);

                if (!contact) {
                    // Create contact if the name looks like a proper name (capitalized, 2+ chars)
                    if (sender.length < 2 || sender[0] !== sender[0].toUpperCase()) continue;
                    const blocked = getBlockedSet();
                    if (isBlocked(sender, blocked)) continue;
                    contact = {
                        id: 'npc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                        name: sender,
                        number: '',
                        source: 'narrative-sms',
                        memories: []
                    };
                    state.contacts.push(contact);
                    console.log('[PhoneSocial] 📱 new contact from inline SMS: ' + sender);
                }

                if (!state.threads[contact.id]) state.threads[contact.id] = [];
                // Avoid exact duplicates (same text within last 5 messages)
                const recent = state.threads[contact.id].slice(-5);
                const isDup = recent.some(x => x.from === 'them' && x.text === msgText);
                if (isDup) continue;

                state.threads[contact.id].push({
                    from: 'them',
                    text: msgText,
                    ts: Date.now(),
                    seen: false
                });
                ingested++;
            }

            if (ingested > 0) {
                console.log('[PhoneSocial] 📱 ingested ' + ingested + ' inline SMS from chat narrative');
                saveMeta();
                updateSmsInjection();
            }
        } catch (e) {
            console.warn('[PhoneSocial] ingestInlineSMS error:', e);
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
                    text: m.imageUrl ? '📷 Photo' : (m.text || ''),
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
