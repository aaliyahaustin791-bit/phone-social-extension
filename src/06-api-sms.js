    function isTtsAvailable() {
        const path1 = window.extension_settings?.texttospeech?.enabled;
        const path2 = window.extension_settings?.tts?.enabled;
        const path3 = getCtx()?.extensionSettings?.texttospeech?.enabled;
        const path4 = getCtx()?.extensionSettings?.tts?.enabled;
        const available = !!(path1 || path2 || path3 || path4);
        console.log('[PhoneSocial] TTS available check:', available,
            'paths:', { texttospeech: !!path1, tts: !!path2,
            ctx_texttospeech: !!path3, ctx_tts: !!path4 });
        return available;
    }

    async function phoneTtsSpeak(text, contactName) {
        if (!state.settings.ttsEnabled) {
            console.log('[PhoneSocial] TTS skipped: PhoneSocial toggle OFF');
            return;
        }
        if (!state.settings.ttsProvider || !state.settings.ttsApiKey) {
            console.log('[PhoneSocial] TTS skipped: no TTS provider or API key configured');
            return;
        }
        if (!text) return;

        // Look up voice ID from contact
        let voiceId = null;
        if (contactName) {
            const contact = state.contacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
            voiceId = contact?.ttsVoice || null;
        }

        console.log('[PhoneSocial] TTS speaking:', text.slice(0, 60), 'voice:', voiceId || '(default)');

        try {
            if (state.settings.ttsProvider === 'elevenlabs') {
                await elevenlabsTts(text, voiceId, state.settings.ttsApiKey);
            }
        } catch (e) {
            console.warn('[PhoneSocial] TTS failed:', e);
        }
    }

    async function elevenlabsTts(text, voiceId, apiKey) {
        const vid = voiceId || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
        const resp = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + vid, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: String(text).slice(0, 5000),
                model_id: 'eleven_flash_v2_5',
                voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error('ElevenLabs API ' + resp.status + ': ' + errText.slice(0, 200));
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.setAttribute('playsinline', '');
        // Attach to DOM so mobile browsers don't block it
        audio.style.display = 'none';
        document.body.appendChild(audio);
        try {
            await audio.play();
        } catch (playErr) {
            console.warn('[PhoneSocial] TTS play blocked (autoplay):', playErr.message);
        }
        audio.onended = () => {
            URL.revokeObjectURL(url);
            audio.remove();
        };
        audio.onerror = () => {
            URL.revokeObjectURL(url);
            audio.remove();
        };
    }

    // ─── Toastr notifications ───────────────────────────────────────
    function phoneNotify(type, title, message) {
        if (!state.settings.toastrEnabled) return;
        if (typeof toastr === 'undefined') return;
        const opts = {
            timeOut: type === 'incoming-call' ? 8000 : 5000,
            extendedTimeOut: 3000,
            progressBar: true,
            closeButton: true,
            positionClass: 'toast-bottom-right',
        };
        if (type === 'incoming-call') {
            toastr.info(message || `📞 Incoming call…`, title || 'PhoneSocial', opts);
        } else if (type === 'incoming-sms') {
            toastr.info(message || '', title || 'PhoneSocial', opts);
        }
    }

    // UIE-style API URL candidate builder — tries common endpoint paths
    function buildApiUrlCandidates(rawUrl) {
        const base = rawUrl.replace(/\/+$/g, '');
        const candidates = [];
        const add = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
        // If URL already ends in /chat/completions, use as-is
        if (/\/chat\/completions$/i.test(base)) {
            add(base);
            return candidates;
        }
        // If URL ends in /v1 or /api/v1 — append /chat/completions
        if (/\/v1\/?$/i.test(base) || /\/api\/v1\/?$/i.test(base)) {
            add(`${base}/chat/completions`);
            return candidates;
        }
        // Bare domain / generic URL — try common chat completions paths
        // (Do NOT try /v1/completions — that's the old text completions endpoint
        //  which expects "prompt", not "messages", and will always 400.)
        add(`${base}/v1/chat/completions`);
        add(`${base}/chat/completions`);
        return candidates;
    }

    // Strip RP narration markers from main chat messages used as SMS context.
    // Removes *asterisk actions*, [stage directions], and trims to keep it terse.
    function stripNarration(text) {
        if (!text) return '';
        return text
            .replace(/\*[^*]+\*/g, '')       // *narration*
            .replace(/\[[^\]]+\]/g, '')       // [stage directions]
            .replace(/\([^)]*action[^)]*\)/gi, '') // (action cues)
            .replace(/\s{2,}/g, ' ')          // collapse whitespace
            .trim();
    }

    // Strip NPC name prefix from AI replies (e.g. "Prof. Beom-seok: Hey" → "Hey")
    function stripNamePrefix(text, contactName) {
        if (!text || !contactName) return text;
        const escaped = contactName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match "Name: ", "**Name:** ", "Name - ", "Name—", "Name says:" etc.
        const re = new RegExp('^\\*{0,2}' + escaped + '\\*{0,2}\\s*[:\\-—]\\s*|^' + escaped + '\\s+(?:says?|texts?|writes?)[,:]\\s*', 'i');
        return text.replace(re, '').trim();
    }

    // Extract reply text from various API response formats
    function extractApiReply(data) {
        if (!data) return null;
        const d = data;
        const c0 = d?.choices?.[0];
        const fromMsg = c0?.message?.content;
        if (typeof fromMsg === 'string' && fromMsg.trim()) return fromMsg.trim().replace(/^["']|["']$/g, '');
        const fromText = c0?.text;
        if (typeof fromText === 'string' && fromText.trim()) return fromText.trim().replace(/^["']|["']$/g, '');
        const fromGemini = d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof fromGemini === 'string' && fromGemini.trim()) return fromGemini.trim().replace(/^["']|["']$/g, '');
        const fromAnthropic = d?.content?.[0]?.text;
        if (typeof fromAnthropic === 'string' && fromAnthropic.trim()) return fromAnthropic.trim().replace(/^["']|["']$/g, '');
        const fromOutput = d?.output_text || d?.generated_text || d?.result || d?.response;
        if (typeof fromOutput === 'string' && fromOutput.trim()) return fromOutput.trim().replace(/^["']|["']$/g, '');
        return null;
    }

    async function generateSMSReply(contactId) {
        const contact = state.contacts.find(c => c.id === contactId);
        if (!contact) return null;
        const ctx = getCtx();
        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
        const thread = state.threads[contactId] || [];
        const recentMessages = thread.slice(-10);
        // ── Build conversation with image tracking for multimodal vision ──
        const convoMsgs = [];  // [{speaker, text? imageUrl?}]
        for (const m of recentMessages) {
            const speaker = m.from === 'me' ? myName : contact.name;
            if (m.imageUrl) {
                convoMsgs.push({ speaker, imageUrl: m.imageUrl });
            } else {
                convoMsgs.push({ speaker, text: m.text || '' });
            }
        }
        // Text-only representation for prompts (images become [photo] placeholder)
        const conversation = convoMsgs.map(m =>
            m.imageUrl ? `${m.speaker}: [sent a photo]` : `${m.speaker}: ${m.text}`
        ).join('\n');
        
        // Check if any messages have images (for multimodal API call)
        const hasImages = convoMsgs.some(m => !!m.imageUrl);
        const imageParts = hasImages
            ? convoMsgs.filter(m => m.imageUrl).map(m => ({
                type: 'image_url',
                image_url: { url: m.imageUrl, detail: 'auto' }
            }))
            : [];

        // Detect if the last message is from the NPC themselves — nothing to "reply" to.
        // In that case, this is a follow-up / double-text, not a reply.
        const lastMsg = recentMessages[recentMessages.length - 1];
        const isFollowUp = lastMsg && lastMsg.from === 'them';
        const otherContacts = state.contacts
            .filter(c => c.id !== contactId)
            .map(c => `- ${c.name}`)
            .sort()
            .join('\n');

        // ── Collect NPC memories for SMS context ──
        let npcMemories = '';
        if (Array.isArray(contact.memories) && contact.memories.length) {
            const recentMems = contact.memories.slice(-5);
            npcMemories = `\n\nThings ${contact.name} knows/remembers:\n` + recentMems.map(m => `- ${m.text}`).join('\n');
        }

        // ── Scan main chat for recent messages involving this NPC ──
        let mainChatContext = '';
        try {
            if (ctx?.chat) {
                const contactNameLower = contact.name.toLowerCase();
                const relevantMsgs = ctx.chat
                    .filter(msg => {
                        if (!msg || msg.is_system) return false;
                        const speaker = (msg.name || '').toLowerCase();
                        // Include ONLY if the NPC is the speaker — they must have been
                        // physically present in the scene. Messages that merely mention
                        // the NPC's name should NOT be injected, or NPCs become omniscient
                        // and learn about surprises/plans discussed in their absence.
                        return speaker === contactNameLower;
                    })
                    .slice(-5)
                    .map(msg => {
                        const speaker = msg.name || (msg.is_user ? (ctx.name1 || 'You') : (ctx.name2 || ctx.name || 'Character'));
                        const cleanText = stripNarration(msg.mes || msg.text || '').slice(0, 100);
                        return cleanText ? `${speaker}: ${cleanText}` : null;
                    })
                    .filter(Boolean);
                if (relevantMsgs.length) {
                    mainChatContext = `\n\nRecent events involving ${contact.name}:\n${relevantMsgs.join('\n')}`;
                }
            }
        } catch (_) { /* ignore */ }

        // Try to find the NPC's character card for personality injection (UIE-style)
        let npcDescription = '';
        if (ctx?.characters) {
            const match = ctx.characters.find(ch =>
                ch && ch.name && ch.name.toLowerCase() === contact.name.toLowerCase()
            );
            if (match?.data) {
                const desc = (match.data.description || '').trim().slice(0, 600);
                const personality = (match.data.personality || '').trim().slice(0, 400);
                if (desc || personality) {
                    npcDescription = `${contact.name}'s character:\n${desc}${desc && personality ? '\n' : ''}${personality}`.trim();
                }
            }
        }

        // Check if a custom API key is configured
        const s = window.PhoneSocialSettings || {};
        const apiKey = s.apiKey?.trim();
        if (apiKey) {
            console.log(`[PhoneSocial] 🔑 using custom API: ${s.apiUrl} | model: ${s.model || 'gpt-4o-mini'} | contact: ${contact.name}`);
            // Build API URL candidates (UIE-style: tries /chat/completions, /v1/chat/completions, etc.)
            const rawUrl = ((s.apiUrl && s.apiUrl !== 'undefined' && s.apiUrl !== 'null') ? s.apiUrl : 'https://api.openai.com/v1').trim().replace(/[\r\n\s]+/g, '').replace(/\/+$/, '');
            const model = s.model || 'gpt-4o-mini';
            const promptTemplate = s.systemPromptTemplate || 'You are {char}, responding via text message. Keep replies short and in character.';
            const charName = contact.name;
            const systemPrompt = promptTemplate.replace(/\{char\}/g, charName) +
                (npcDescription ? `\n\n${npcDescription}` : '') +
                (otherContacts ? `\n\nOther contacts you know:\n${otherContacts}` : '') +
                (npcMemories ? npcMemories : '') +
                (mainChatContext ? mainChatContext : '') +
                (isFollowUp
                    ? `\n\nYou are currently texting ${myName} (also called you). They haven't responded to your last message yet.\nCRITICAL: Send a natural follow-up text. Do NOT answer your own question or speak for ${myName}. Keep it in YOUR voice only. No narration, stage directions, asterisks.`
                    : `\n\nYou are currently texting ${myName} (also called you).\nCRITICAL: Send ONLY the SMS text. No narration, stage directions, asterisks, or commentary about the scene.`);
            const userMsg = isFollowUp
                ? `SMS conversation:\n${conversation || '(no messages yet)'}\n\nThe last message was from you — ${myName} hasn't replied yet. Write a follow-up text from ${charName}. Stay in character. Just the text message — casual, natural, concise. No narration.`
                : `SMS conversation with ${myName}:\n${conversation || '(no messages yet)'}\n\nWrite ONLY the SMS reply from ${charName} to ${myName}. Just the text message — casual, natural, concise. No narration.`;

            // Build URL candidates from raw input
            const urlCandidates = buildApiUrlCandidates(rawUrl);
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            if (apiKey) {
                const key = apiKey.replace(/^bearer\s+/i, '').trim();
                const host = rawUrl.toLowerCase();
                headers['Authorization'] = `Bearer ${key}`;
                // Provider-specific auth headers
                if (host.includes('nvidia.com') || host.includes('nano-gpt.com') || host.includes('nanogpt')) {
                    headers['x-api-key'] = key;
                    headers['api-key'] = key;
                }
            }

            for (const url of urlCandidates) {
                try {
                    const userContent = hasImages
                        ? [{ type: 'text', text: userMsg }, ...imageParts]
                        : userMsg;
                    const body = { model, messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent },
                    ], max_tokens: 300, temperature: 0.8 };
                    const res = await fetch(url, {
                        method: 'POST', headers, body: JSON.stringify(body),
                    });
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        console.warn(`[PhoneSocial] API error (${res.status}) at ${url}:`, errText.slice(0, 200));
                        continue;
                    }
                    const data = await res.json().catch(() => null);
                    if (!data) continue;
                    // Extract text from various response formats (chat, text, Anthropic, Gemini)
                    const text = extractApiReply(data);
                    if (text) return stripNamePrefix(text, contact.name);
                } catch (e) {
                    console.warn(`[PhoneSocial] fetch failed for ${url}:`, e?.message || e);
                    continue;
                }
            }
            console.warn('[PhoneSocial] all API endpoints failed — falling back to ST generateQuietPrompt');
            // Fall through to generateQuietPrompt below instead of returning null
        }

        // Fallback: proxy through ST's local server (which can reach DeepSeek server-side)
        // generateQuietPrompt returns undefined due to ST tool-calling pipeline interception,
        // so we call ST's local chat-completions endpoint directly.
        console.log('[PhoneSocial] falling back to ST local proxy for ' + contact.name);
        try {
            const stOrigin = window.location.origin || 'http://localhost:8000';
            // Build concise chat messages
            const charDesc = npcDescription ? npcDescription.slice(0, 300) : '';
            const memSnippet = npcMemories ? npcMemories.replace(/^\\n\\n/, '').slice(0, 300) : '';
            const chatSnippet = mainChatContext ? mainChatContext.replace(/^\\n\\n/, '').slice(0, 400) : '';
            const convoSnippet = conversation.slice(-500);

            const systemMsg = [
                'You are ' + contact.name + '.',
                charDesc ? charDesc : '',
                'You are texting ' + myName + ' via SMS on your phone.',
                isFollowUp
                    ? 'CRITICAL: Send a natural follow-up text. Do NOT answer your own question or speak for ' + myName + '. Keep it in YOUR voice only. No narration, no stage directions, no asterisks.'
                    : 'CRITICAL: Reply with ONLY the SMS text. No narration, no stage directions, no asterisks, no commentary about the scene. Just what you would type on a phone.',
            ].filter(Boolean).join(' ');

            const userMsg = [
                memSnippet ? 'You remember: ' + memSnippet : '',
                chatSnippet ? 'Recent events: ' + chatSnippet : '',
                'SMS conversation with ' + myName + ':',
                convoSnippet || '(no messages yet)',
                isFollowUp ? myName + ' hasn\'t replied to your last message yet.' : '',
                '',
                isFollowUp ? 'Your follow-up:' : 'Your reply:',
            ].filter(Boolean).join('\n');

            const stUserContent = hasImages
                ? [{ type: 'text', text: userMsg }, ...imageParts]
                : userMsg;

            const body = JSON.stringify({
                messages: [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: stUserContent }
                ],
                max_tokens: 300,
                temperature: 0.8,
                stream: false
            });

            // Try ST's chat-completions proxy endpoint
            const urls = [
                stOrigin + '/api/backends/chat-completions',
                stOrigin + '/api/generate',
            ];
            for (const url of urls) {
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body
                    });
                    if (!res.ok) { console.warn('[PhoneSocial] ST proxy ' + res.status + ' at ' + url); continue; }
                    const data = await res.json().catch(() => null);
                    const text = extractApiReply(data);
                    if (text) {
                        console.log('[PhoneSocial] ST proxy reply: ' + text.slice(0, 60));
                        return stripNamePrefix(text, contact.name);
                    }
                } catch (e) {
                    console.warn('[PhoneSocial] ST proxy fetch failed for ' + url + ': ' + (e?.message || e));
                }
            }
            console.warn('[PhoneSocial] ST proxy all endpoints failed — falling to hardcoded');
        } catch (e) {
            console.warn('[PhoneSocial] ST proxy error:', e);
        }
        return null;
    }


    async function simulateReply(contactId) {
        if (!state.settings.autoReplies) return;
        const contact = state.contacts.find(c => c.id === contactId);
        const personality = contact ? inferPersonality(contact) : null;
        // Show typing indicator while we generate
        state.typingContactId = contactId;
        if (state.view === 'thread' && state.activeContact === contactId) render();
        // Try ST-powered LLM generation — if it fails, skip the reply entirely
        const text = await generateSMSReply(contactId);
        if (!text) {
            state.typingContactId = null;
            return;
        }
        // Clear typing indicator
        state.typingContactId = null;
        // Personality-based reply delay
        const delay = personality ? getResponseDelay(contact, personality) : (800 + Math.random() * 1500);
        setTimeout(() => {
            if (!state.threads[contactId]) return;
            state.threads[contactId].push({ from: 'them', text, ts: Date.now(), seen: false });
            // Mark the last user message as seen (NPC "read" it before replying)
            const msgs = state.threads[contactId];
            for (let i = msgs.length - 2; i >= 0; i--) {
                if (msgs[i].from === 'me') { msgs[i].seen = true; break; }
            }
            saveMeta();
            updateSmsInjection(); // Inject SMS into main ST context
            if (state.view === 'thread' && state.activeContact === contactId) render();
            // Toastr notification for incoming SMS
            if (contact) {
                phoneNotify('incoming-sms', `📩 ${contact.name}`, `${contact.name}: ${text.slice(0, 120)}`);
                showIncomingBanner(contact, text);
            }
            // Trigger memory extraction after a brief delay (let the user see the reply first)
            setTimeout(() => {
                extractContactMemories(contactId).catch(e =>
                    console.warn('[PhoneSocial] memory extraction failed:', e));
            }, 3000);
        }, delay);
    }

    // ─── NPC Personality — inferred from character card ─────────────
    // Guides: response speed, initiative, call preference, shyness.
    function inferPersonality(contact) {
        if (contact._personality) return contact._personality;
        const p = {
            initiative: 5 + Math.floor(Math.random() * 5) - 2,   // 3-7 spread so NPCs aren't all identical
            responseSpeed: 3 + Math.floor(Math.random() * 5),     // 3-7
            prefersCall: Math.random() < 0.15,                    // 15% chance even without card traits
            isShy: false,
        };
        try {
            const ctx = getCtx();
            if (!ctx?.characters) { contact._personality = p; return p; }
            const match = ctx.characters.find(ch =>
                ch && ch.name && ch.name.toLowerCase() === contact.name.toLowerCase());
            const desc = ((match?.data?.description || '') + ' ' + (match?.data?.personality || '')).toLowerCase();
            if (/shy|reserved|quiet|introvert|timid|awkward|nervous|anxious/.test(desc)) {
                p.initiative = 2; p.responseSpeed = 7; p.isShy = true;
            }
            if (/outgoing|extrovert|loud|bold|confident|friendly|chatty|gregarious/.test(desc)) {
                p.initiative = 8; p.responseSpeed = 3;
            }
            if (/busy|workaholic|distracted|aloof|cold|distant|preoccupied/.test(desc)) {
                p.initiative = 3; p.responseSpeed = 8;
            }
            if (/romantic|affectionate|clingy|needy|flirty|lovesick/.test(desc)) {
                p.initiative = 9; p.prefersCall = true;
            }
            if (/tsundere|grumpy|irritable|sarcastic|sassy/.test(desc)) {
                p.initiative = 4; p.responseSpeed = 6;
            }
        } catch (_) { /* ignore */ }
        contact._personality = p;
        return p;
    }

    // ─── Current Activity — inferred from main chat ──────────────────
    // Scans the NPC's most recent main-chat messages to figure out what
    // they're currently doing, which overrides/modifies personality defaults.
    function getCurrentActivity(contact) {
        try {
            const ctx = getCtx();
            if (!ctx?.chat) return null;
            const contactName = contact.name.toLowerCase();
            // Scan backwards for this NPC's most recent 3 messages
            const recentMsgs = [];
            for (let i = ctx.chat.length - 1; i >= 0 && recentMsgs.length < 3; i--) {
                const msg = ctx.chat[i];
                if (!msg || msg.is_user || msg.is_system) continue;
                const speaker = (msg.name || '').toLowerCase();
                const target = contactName.toLowerCase();
                if (speaker === target ||
                    (/[+,&]/.test(speaker) && speaker.split(/[+,&]\s*/).map(p => p.trim()).filter(Boolean).includes(target))) {
                    recentMsgs.push(msg.mes || msg.text || '');
                }
            }
            if (!recentMsgs.length) return null;
            const text = recentMsgs[0].toLowerCase();

            // NPC is present if they've spoken recently (last 3 messages).
            // Present NPCs shouldn't call/text — they're right there with you.
            const present = { state: 'present', responseMod: 1, callDeclineBonus: 0, label: 'present in scene', noProactive: true };

            // Combat/danger — won't answer at all
            if (/fight(ing)?\b|battle|combat|attack(ing)?|punch(ing)?|kick(ing)?|sword|gun|weapon|enemy|danger|chase|running\s+(from|away)|in\s+(a\s+)?(fight|battle)/i.test(text)) {
                return { state: 'combat', responseMod: 5, callDeclineBonus: 0.8, label: 'in combat', noProactive: true };
            }
            // Sleeping
            if (/sleep(ing)?|bed|tired|yawn(ing)?|asleep|nap|resting|going\s+to\s+(bed|sleep)|goodnight|night\b|doze|drowsy/i.test(text)) {
                return { state: 'sleeping', responseMod: 4, callDeclineBonus: 0.7, label: 'sleeping', noProactive: true };
            }
            // Working / busy with something
            if (/work(ing)?\b|meeting|office|job\b|busy\s+(with|at)|task\b|project|deadline|paperwork|stud(y|ying)|class\b|homework/i.test(text)) {
                return { state: 'working', responseMod: 2.5, callDeclineBonus: 0.4, label: 'working', noProactive: true };
            }
            // Eating
            if (/eat(ing)?\b|food\b|lunch|breakfast|dinner|snack|hungry|cooking|meal|dining/i.test(text)) {
                return { state: 'eating', responseMod: 1.5, callDeclineBonus: 0.2, label: 'eating' };
            }
            // Occupied / can't talk
            if (/busy|occupied|can'?t\s+(talk|chat|text)|not\s+now|later\b|leave\s+me\s+alone|in\s+the\s+(middle|bath|shower)/i.test(text)) {
                return { state: 'occupied', responseMod: 3, callDeclineBonus: 0.5, label: 'occupied', noProactive: true };
            }
            // Emotional (sad, crying, lonely — more likely to want to talk)
            if (/cry(ing)?\b|sad\b|upset|heartbroken|lonely|miss\s+(you|them|her|him)|depress(ed|ing)/i.test(text)) {
                return { state: 'emotional', responseMod: 0.7, callDeclineBonus: -0.2, label: 'emotional' };
            }
            // Happy / playful
            if (/happ(y|ier)|excited|giggling|laugh(ing)?|joy|fun\b|playful|cheerful|great\s+day|wonderful/i.test(text)) {
                return { state: 'happy', responseMod: 0.6, callDeclineBonus: -0.15, label: 'happy' };
            }
            // Free / available
            if (/free\b|bored\b|waiting|relax(ing)?|chill(ing)?|home\b|nothing\b|available|loafing|idle/i.test(text)) {
                return { state: 'free', responseMod: 0.5, callDeclineBonus: -0.15, label: 'free' };
            }
            return present;
        } catch (_) { /* ignore */ }
        return null;
    }

    // ─── Proactive NPC behaviors ─────────────────────────────────────
    // NPCs can text or call the user on their own, driven by personality + current activity.
    function getResponseDelay(contact, personality) {
        const activity = getCurrentActivity(contact);
        let mod = activity ? activity.responseMod : 1;
        // Base delay from personality
        const base = 500 + (personality.responseSpeed / 10) * 7500;
        return base * mod + Math.random() * base * 0.5 * mod;
    }

    function getCallAnswerDelay(contact, personality) {
        const activity = getCurrentActivity(contact);
        if (activity) {
            // Combat = never answer; sleeping = very slow
            if (activity.state === 'combat') return -1; // never answers
            if (activity.state === 'sleeping') return 8000 + Math.random() * 7000;
        }
        if (personality.isShy) return 5000 + Math.random() * 5000;
        if (personality.responseSpeed >= 8) return 4000 + Math.random() * 6000;
        if (personality.responseSpeed <= 3) return 1000 + Math.random() * 2000;
        return 2000 + Math.random() * 3000;
    }

    function shouldDeclineCall(contact, personality) {
        const activity = getCurrentActivity(contact);
        if (activity) {
            // Combat = always decline; sleeping = very likely
            if (activity.state === 'combat') return true;
            if (activity.state === 'sleeping') return Math.random() < 0.75;
            // Activity can add a bonus to the decline chance
            if (Math.random() < (activity.callDeclineBonus || 0)) return true;
        }
        if (personality.isShy) return Math.random() < 0.6;  // shy NPCs mostly don't call
        if (personality.initiative <= 3) return Math.random() < 0.35;
        if (personality.initiative >= 8) return false;       // bold NPCs always follow through
        return Math.random() < 0.15;                          // base chance NPC decides not to
    }

    function getActivityLabel(contact) {
        const activity = getCurrentActivity(contact);
        return activity ? activity.label : null;
    }

    async function simulateIncomingCall(contact, opts = {}) {
        console.log('[PhoneSocial] 📞 simulateIncomingCall ENTER: ' + contact.name + ' skipPresence=' + !!opts.skipPresenceCheck + ' activeCall=' + !!state.activeCall);
        if (state.activeCall) {
            console.log('[PhoneSocial] 📞 simulateIncomingCall BLOCKED: already on call with ' + (state.activeCall.contactId || '?'));
            return; // Already on a call
        }
        // Mute check
        if (state.mutedContacts[contact.id]) {
            console.log('[PhoneSocial] 🔕 simulateIncomingCall BLOCKED: ' + contact.name + ' is muted');
            return;
        }
        // LAST-LINE DEFENSE: double-check NPC isn't present in the scene.
        // The scheduler checks this, but chat state can change between
        // scheduling and execution. If they're in the room, abort.
        // Skip when triggered by narrative cues (AI already said they're calling remotely).
        if (!opts.skipPresenceCheck && isNpcPresent(contact.name)) {
            console.log('[PhoneSocial] 🛑 simulateIncomingCall BLOCKED: ' + contact.name + ' is present in scene');
            return;
        }
        const personality = inferPersonality(contact);
        if (shouldDeclineCall(contact, personality)) {
            const activity = getCurrentActivity(contact);
            const reason = activity ? ` (${activity.label})` : ' (personality)';
            console.log(`[PhoneSocial] 📞 ${contact.name} DECLINED call${reason}`);
            return;
        }
        console.log('[PhoneSocial] 📞 simulateIncomingCall SETUP: ' + contact.name + ' — incoming call active');
        state.activeCall = { contactId: contact.id, status: 'incoming', startTs: null };
        state.callLog.push({ contactId: contact.id, dir: 'in', ts: Date.now(), duration: 0 });
        state.view = 'call';
        saveMeta();
        render();
        phoneNotify('incoming-call', `📞 ${contact.name}`, `📞 Incoming call from ${contact.name}`);
        phoneTtsSpeak(`Incoming call from ${contact.name}`, contact.name);
        // Auto-decline after 15 seconds if user doesn't answer
        const autoDeclineTimer = setTimeout(() => {
            if (!state.activeCall || state.activeCall.contactId !== contact.id || state.activeCall.status !== 'incoming') return;
            state.activeCall = null;
            state.callLog.push({ contactId: contact.id, dir: 'missed', ts: Date.now(), duration: 0 });
            state.view = 'home';
            saveMeta();
            render();
            phoneNotify('incoming-call', `📞 ${contact.name}`, `📞 Missed call from ${contact.name}`);
            phoneTtsSpeak(`Missed call from ${contact.name}`, contact.name);
            // Generate voicemail after missed call
            setTimeout(() => {
                const c = state.contacts.find(x => x.id === contact.id);
                if (!c) return;
                generateSMSReply(contact.id).then(vmText => {
                    const text = vmText || 'Hey, it\'s me. Call me back when you can.';
                    state.voicemails = state.voicemails || [];
                    state.voicemails.push({ contactId: contact.id, text, ts: Date.now(), heard: false });
                    saveMeta();
                    phoneNotify('incoming-sms', `📼 ${contact.name}`, `Voicemail from ${contact.name}`);
                }).catch(() => {});
            }, 3000);
        }, 15000);
        state.activeCall._autoDeclineTimer = autoDeclineTimer;
    }

    async function simulateProactiveText(contact, trigger, opts = {}) {
        console.log('[PhoneSocial] 💬 simulateProactiveText ENTER: ' + contact.name + ' skipPresence=' + !!opts.skipPresenceCheck + ' autoReplies=' + state.settings.autoReplies);
        if (!state.settings.autoReplies) {
            console.log('[PhoneSocial] 💬 simulateProactiveText BLOCKED: autoReplies OFF');
            return;
        }
        // Mute check
        if (state.mutedContacts[contact.id]) {
            console.log('[PhoneSocial] 🔕 simulateProactiveText BLOCKED: ' + contact.name + ' is muted');
            return;
        }
        // LAST-LINE DEFENSE: double-check NPC isn't present in the scene.
        // Skip when triggered by narrative cues (AI already said they're texting remotely).
        if (!opts.skipPresenceCheck && isNpcPresent(contact.name)) {
            console.log('[PhoneSocial] 🛑 simulateProactiveText BLOCKED: ' + contact.name + ' is present in scene');
            return;
        }
        if (!state.threads[contact.id]) state.threads[contact.id] = [];
        const personality = inferPersonality(contact);
        // AI generation only — if it fails, skip (no scripted fallbacks)
        console.log('[PhoneSocial] 💬 simulateProactiveText GENERATING for ' + contact.name + '...');
        let aiReply;
        try {
            aiReply = await generateSMSReply(contact.id);
        } catch (err) {
            console.warn('[PhoneSocial] 💬 simulateProactiveText AI ERROR for ' + contact.name + ':', err.message || err);
            return;
        }
        if (!aiReply) {
            console.log('[PhoneSocial] 💬 simulateProactiveText: no AI reply for ' + contact.name + ' — skipping');
            return;
        }
        console.log('[PhoneSocial] 💬 simulateProactiveText SUCCESS: ' + contact.name + ' → "' + aiReply.slice(0, 80) + '..."');
        const text = aiReply;
        setTimeout(() => {
            if (!state.threads[contact.id]) return;
            state.threads[contact.id].push({ from: 'them', text, ts: Date.now(), seen: false });
            saveMeta();
            updateSmsInjection();
            if (state.view === 'thread' && state.activeContact === contact.id) render();
            if (contact) {
                phoneNotify('incoming-sms', `📩 ${contact.name}`, `${contact.name}: ${text.slice(0, 120)}`);
                showIncomingBanner(contact, text);
            }
        }, getResponseDelay(contact, personality));
    }

    // ─── Story-aware proactive helpers ──────────────────────────────
    // Checks whether an NPC is currently "present" in the main chat —
    // if they've spoken in the last few messages, they're in the scene.
    // opts.narration: include AI narration scan for ensemble cards (default true).
    // Set to false when you need speaker-only detection (e.g. green banner).
