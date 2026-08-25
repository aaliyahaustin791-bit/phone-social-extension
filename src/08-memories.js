    async function extractContactMemories(contactId, force) {
        const contact = state.contacts.find(c => c.id === contactId);
        if (!contact) return 0;
        const thread = state.threads[contactId];
        if (!Array.isArray(thread) || thread.length < 3) return 0;

        // Only extract every 5 messages to keep it lightweight (skip if forced/manual)
        if (!force) {
            const msgCount = thread.length;
            const lastExtracted = contact._lastExtractMsgCount || 0;
            if (msgCount - lastExtracted < 5) return 0;
            contact._lastExtractMsgCount = msgCount;
        }

        const ctx = getCtx();
        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || ctx?.name || 'You';
        const user = ctx?.name1 || 'You';

        // Build conversation transcript
        const transcript = thread.slice(-20).map(m => {
            const speaker = m.from === 'me' ? myName : contact.name;
            if (m.imageUrl) return `${speaker}: [sent a photo]`;
            return `${speaker}: ${m.text || ''}`;
        }).join('\n');

        const systemPrompt = `You are extracting ONLY vital, relationship-relevant memories from SMS/text conversations between "${myName}" and "${contact.name}".

Target: "${contact.name}" (the person being texted)

Return ONLY valid JSON (no markdown, no extra keys):
{"memories":[{"text":"...","tags":["..."]}]}

Rules:
- 1 to 3 memories max. If nothing important happened, return {"memories":[]}.
- Each memory must be about "${contact.name}" directly (they act, speak, promise, reveal, or are explicitly referenced).
- Each memory must be a durable fact that CHANGED or REVEALED something: plans, promises, secrets, emotional shifts, favors, agreements, injuries, betrayals, important info.
- No trivial entries (no greetings, "they replied", generic chat).
- 1 sentence per memory (10-60 words).
- Tags: short keywords like "promise", "secret", "plan", "favor", "trust", "romance", "info", "warning".`;

        const userPrompt = `SMS transcript between ${myName} and ${contact.name}:\n\n${transcript}\n\nExtract memories from this conversation.`;

        if (!contact.memories) contact.memories = [];
        const existing = new Set(contact.memories.map(m =>
            (m.text || '').toLowerCase().replace(/\s+/g, ' ').trim()));

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;

        try {
            const obj = JSON.parse(String(text).replace(/```json|```/g, '').trim());
            const mems = Array.isArray(obj?.memories) ? obj.memories : [];
            let added = 0;
            for (const m of mems) {
                const text = (m.text || '').trim();
                if (!text) continue;
                if (text.length < 15) continue; // Too short, not meaningful
                const key = text.toLowerCase().replace(/\s+/g, ' ').trim();
                if (existing.has(key)) continue;
                existing.add(key);
                contact.memories.push({
                    text: text.slice(0, 320),
                    ts: Date.now(),
                    tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
                });
                added++;
            }
            if (added > 0) {
                console.log(`[PhoneSocial] extracted ${added} memory(ies) for ${contact.name}`);
                saveMeta();
            }
            return added;
        } catch (e) {
            console.warn('[PhoneSocial] memory extraction parse failed:', e?.message || e);
            return 0;
        }
    }

    // Reuse the configured API or ST fallback for memory extraction
    async function callTurboApi(systemPrompt, userPrompt) {
        const s = window.PhoneSocialSettings || {};
        const apiKey = s.apiKey?.trim();
        if (apiKey) {
            const rawUrl = ((s.apiUrl && s.apiUrl !== 'undefined' && s.apiUrl !== 'null') ? s.apiUrl : 'https://api.openai.com/v1').replace(/\/+$/, '');
            const model = s.model || 'gpt-4o-mini';
            const candidates = buildApiUrlCandidates(rawUrl);
            console.log('[PhoneSocial] turbo: API key set, trying', candidates.length, 'endpoints');
            const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
            const key = apiKey.replace(/^bearer\s+/i, '').trim();
            headers['Authorization'] = `Bearer ${key}`;
            const host = rawUrl.toLowerCase();
            if (host.includes('nvidia.com') || host.includes('nano-gpt.com') || host.includes('nanogpt')) {
                headers['x-api-key'] = key;
                headers['api-key'] = key;
            }
            for (const url of candidates) {
                try {
                    console.log('[PhoneSocial] turbo: trying', url);
                    const res = await fetch(url, {
                        method: 'POST', headers,
                        body: JSON.stringify({
                            model,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: userPrompt },
                            ],
                            max_tokens: 4000, temperature: 0.3,
                        }),
                    });
                    console.log('[PhoneSocial] turbo: response', res.status, 'from', url);
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        console.warn('[PhoneSocial] turbo: HTTP', res.status, errText.slice(0, 200));
                        continue;
                    }
                    const data = await res.json().catch(() => null);
                    if (!data) {
                        console.warn('[PhoneSocial] turbo: no JSON from', url);
                        continue;
                    }
                    const text = extractApiReply(data);
                    if (text) {
                        console.log('[PhoneSocial] turbo: got reply, length', text.length);
                        return text;
                    }
                    console.warn('[PhoneSocial] turbo: no text in response');
                } catch (e) {
                    console.warn('[PhoneSocial] turbo: fetch failed for', url, e?.message || e);
                    continue;
                }
            }
            console.warn('[PhoneSocial] turbo: all API endpoints failed — check model name matches provider');
        } else {
            console.log('[PhoneSocial] turbo: no API key set');
        }
        // Fallback: use ST's generateQuietPrompt
        const ctx = getCtx();
        if (ctx?.generateQuietPrompt) {
            console.log('[PhoneSocial] turbo: falling back to ST generateQuietPrompt');
            try {
                // Prepend context isolation — ST's generateQuietPrompt still has access to the
                // full chat context and character cards. Without this, the model sees the ST
                // assistant's character traits and leaks them into generated content.
                const isolationPrefix = 'CRITICAL: You are generating content for a FICTIONAL roleplay setting. The SillyTavern system context (character cards, assistant personas, chat history) is IRRELEVANT. Respond ONLY based on the prompt below. Treat the system assistant and any non-story characters as non-existent.\n\n';
                const fullPrompt = isolationPrefix + systemPrompt + (userPrompt ? '\n\n' + userPrompt : '');
                const reply = await ctx.generateQuietPrompt({
                    quietPrompt: fullPrompt,
                    quietToLoud: false,
                    skipWIAN: true,
                });
                console.log('[PhoneSocial] turbo: ST fallback got reply:', reply?.slice(0, 80));
                return reply;
            } catch (e) {
                console.warn('[PhoneSocial] turbo: ST fallback failed:', e?.message || e);
            }
        }
        return null;
    }


    async function extractMainChatMemories() {
        console.log('[PhoneSocial] extractMainChatMemories: state.contacts.length =', state.contacts.length, 'state view =', state.view);
        const ctx = getCtx();
        if (!ctx?.chat || !Array.isArray(ctx.chat)) return 0;
        const contacts = state.contacts;

        const myName = ctx?.name2 || ctx?.name || 'Character';
        const user = ctx?.name1 || 'You';

        // Get up to 80 messages from main chat (deeper scan)
        const recent = ctx.chat.slice(-80);
        // Strip reasoning/thinking blocks. Some models dump a huge visible
        // <think>…</think>, <thinking>…</thinking>, or <plan>…</plan> block
        // into msg.mes, which can balloon a single message to hundreds of
        // thousands of chars and blow past the truncate limit — leaving the
        // scan with nothing usable.
        const stripReasoning = (t) => t
            .replace(/<(think|thinking|plan|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '')
            .replace(/<details[^>]*type=["']?(reasoning|thinking)[^>]*>[\s\S]*?<\/details>/gi, '')
            .trim();
        const msgs = recent.map(msg => {
            const name = msg.name || (msg.is_user ? user : myName);
            const text = stripReasoning((msg.mes || msg.text || '').trim());
            return text ? `${name}: ${text}` : null;
        }).filter(Boolean);

        const rawLen = msgs.join('\n').length;
        console.log(`[PhoneSocial] memories scan: scanning ${msgs.length} msgs, ${rawLen} chars`);

        let transcript = '';
        const TRUNCATE_LIMIT = 40000;
        // Work backwards from newest messages so we keep the most recent context
        for (let i = msgs.length - 1; i >= 0; i--) {
            const candidate = transcript ? msgs[i] + '\n' + transcript : msgs[i];
            if (candidate.length > TRUNCATE_LIMIT) break;
            transcript = candidate;
        }
        // Fallback: if even the single newest message exceeds the limit, the loop
        // leaves transcript empty. Slice that message (head+tail) so we always
        // have something to scan instead of aborting with "no chat transcript".
        if (!transcript && msgs.length) {
            const newest = msgs[msgs.length - 1];
            if (newest.length > TRUNCATE_LIMIT) {
                const half = Math.floor(TRUNCATE_LIMIT / 2);
                transcript = newest.slice(0, half) + '\n[...]\n' + newest.slice(-half);
                console.log(`[PhoneSocial] memories scan: newest msg ${newest.length} chars > limit, sliced to ${transcript.length}`);
            } else {
                transcript = newest;
            }
        }
        const finalLen = msgs.join('\n').length;
        if (finalLen !== transcript.length) {
            console.log(`[PhoneSocial] memories scan: ${finalLen} raw → ${transcript.length} after truncate`);
        }

        if (!transcript) {
            console.log('[PhoneSocial] memories scan: no chat transcript');
            return 0;
        }

        const systemPrompt = `You are scanning a roleplay conversation transcript between "${user}" and "${myName}".

Your ONLY job: Extract EVERY NPC (side character) + relationship memories.

Return ONLY valid JSON (no markdown, no extra text):
{
  "npcs": [
    { "name": "NPC_Name", "about": "Brief 1-sentence description." }
  ],
  "memories": [
    { "name": "ContactName", "text": "Specific durable fact...", "quote": "verbatim excerpt from transcript", "tags": ["promise"] }
  ]
}

MANDATORY RULES — NO EXCEPTIONS:
- "npcs": Find EVERY side character — those who speak AND those mentioned by name. Parents, distant relatives, off-screen characters who matter to the story should be included even if they don't appear in person.
- "memories": 3 to 10 total. Each memory: 1 sentence, 10-60 words. The "name" must match one of the NPCs you listed in "npcs".
- Memories must be durable facts: promises, secrets, plans, betrayals, favors, relationship changes.
- ANTI-OMNISCIENCE RULE: Do NOT create memories about things said ABOUT an NPC by other characters when the NPC wasn't there. If characters discuss plans to surprise Sarah, that is NOT a memory for Sarah — she wasn't present. Only create memories about what the NPC themselves said/did, or what was said directly TO them while they were present.
- 🚫 ANTI-HALLUCINATION: NEVER invent dialogue, events, or details. Every memory MUST be directly traceable to something that actually happened in the transcript. If you're unsure, skip it. A blank memory is better than a fake one.
- 📎 Include a "quote" field with each memory: a SHORT verbatim excerpt (5-15 words) from the transcript that PROVES this fact. The quote MUST appear EXACTLY in the transcript above — copy-paste it, do not paraphrase.

⚠️ ENSEMBLE CARD WARNING: The conversation partner "${myName}" may represent MULTIPLE distinct characters writing through a single card. If you see individual names like "Corey" or "Jay" acting independently in the narrative, they ARE separate NPCs — extract each as its own NPC with their own memories. Do NOT treat "${myName}" as one person.`;

        const contactNames = contacts.map(c => c.name).join(', ');
        const userPrompt = `Roleplay conversation transcript:\n\n${transcript}\n\nExtract ALL NPCs and relationship memories from this conversation. Do NOT skip anyone — find every side character.\n\nExisting contacts: ${contactNames || 'none'}\n\nCreate memories for EACH of these contacts that appears in the transcript above.`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) {
            console.log('[PhoneSocial] memories scan: API returned no response');
            return 0;
        }
        console.log('[PhoneSocial] memories scan: API raw:', text.slice(0, 300));

        // Strip reasoning tags, markdown, non-JSON prefix/suffix
        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const obj = JSON.parse(cleaned);
            const npcs = Array.isArray(obj?.npcs) ? obj.npcs : [];
            const mems = Array.isArray(obj?.memories) ? obj.memories : [];
            let totalAdded = 0;

            // Blocked names (uses shared fuzzy matcher)
            const blocked = getBlockedSet();

            // Create contacts for new NPCs, add about-memories for ALL
            for (const n of npcs) {
                const name = (n.name || '').trim();
                if (!name) continue;
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                const existing = contacts.find(c => c.name.toLowerCase() === norm);
                if (existing) {
                    // Already a contact — still capture about description if new
                    const about = (n.about || '').trim();
                    if (about && !(existing.memories || []).some(m => m.text === about.slice(0, 320))) {
                        if (!existing.memories) existing.memories = [];
                        existing.memories.push({
                            text: about.slice(0, 320),
                            ts: Date.now(),
                            tags: ['introduction'],
                        });
                        totalAdded++;
                        console.log(`[PhoneSocial] scan: added about-memory for existing contact "${name}"`);
                    }
                    continue;
                }
                contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    schedule: null,
                    source: 'scan',
                    memories: [],
                });
                const about = (n.about || '').trim();
                if (about) {
                    const c = contacts.find(x => x.name.toLowerCase() === norm);
                    if (c) c.memories.push({
                        text: about.slice(0, 320),
                        ts: Date.now(),
                        tags: ['introduction'],
                    });
                }
                totalAdded++;
                console.log(`[PhoneSocial] scan: created NPC "${name}"`);
            }

            // ── Build set of speakers from the scanned transcript ──
            // Hard filter: only accept memories about NPCs who actually SPOKE
            // in the scanned window. Reject memories about NPCs who were only
            // mentioned — those are things said behind their back (omniscience).
            const transcriptSpeakers = new Set();
            const speakerRe = /^([^:]+):/gm;
            let m2;
            while ((m2 = speakerRe.exec(transcript)) !== null) {
                transcriptSpeakers.add(m2[1].trim().toLowerCase());
            }
            // Ensemble card detection: if the chat uses a single character card
            // to write ALL NPCs (e.g. "Corey + Jay"), the Name: prefix is always
            // the ensemble card — individual NPCs never appear as speakers.
            // In this mode, accept memories for any NPC whose name appears in
            // the transcript CONTENT (they're "spoken about" by the ensemble narrator).
            const uniqueAiSpeakers = new Set();
            if (ctx?.chat) {
                for (const msg of ctx.chat) {
                    if (!msg || msg.is_user || msg.is_system) continue;
                    const spkr = (msg.name || '').trim().toLowerCase();
                    if (spkr) uniqueAiSpeakers.add(spkr);
                }
            }
            const isEnsembleCard = uniqueAiSpeakers.size === 1;
            if (isEnsembleCard) {
                console.log('[PhoneSocial] memories scan: ensemble card detected (' + [...uniqueAiSpeakers][0] + ') — relaxing speaker filter');
            }

            // Add memories to existing contacts
            for (const m of mems) {
                const contactName = (m.name || '').trim();
                if (!contactName) continue;
                const contact = contacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
                if (!contact) continue;
                // Hard omniscience filter: reject if NPC wasn't a speaker
                const nameLower = contactName.toLowerCase();
                const isSpeaker = transcriptSpeakers.has(nameLower);
                // Ensemble fallback: NPC name appears in transcript content
                const isEnsembleMention = isEnsembleCard && transcript.toLowerCase().includes(nameLower);
                if (!isSpeaker && !isEnsembleMention) {
                    console.log(`[PhoneSocial] scan: REJECTED memory for "${contactName}" — not a speaker in transcript (said behind their back)`);
                    continue;
                }
                // ── Quote verification: hallucination guard ──
                const quote = (m.quote || '').trim();
                if (quote.length >= 10) {
                    // Check if the quote appears verbatim in the transcript
                    const transcriptLower = transcript.toLowerCase();
                    const quoteLower = quote.toLowerCase();
                    if (!transcriptLower.includes(quoteLower)) {
                        console.log(`[PhoneSocial] scan: REJECTED memory for "${contactName}" — quote not found in transcript (hallucination?): "${quote.slice(0, 80)}"`);
                        continue;
                    }
                }
                const memText = (m.text || '').trim();
                if (!memText || memText.length < 15) continue;
                if (!contact.memories) contact.memories = [];
                const existing = new Set(contact.memories.map(m2 =>
                    (m2.text || '').toLowerCase().replace(/\s+/g, ' ').trim()));
                const key = memText.toLowerCase().replace(/\s+/g, ' ').trim();
                if (existing.has(key)) continue;
                contact.memories.push({
                    text: memText.slice(0, 320),
                    ts: Date.now(),
                    tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
                });
                totalAdded++;
            }

            if (totalAdded > 0) {
                console.log(`[PhoneSocial] scan: +${totalAdded} items (NPCs + memories)`);
            }
            // Per-contact breakdown: which contacts got memories?
            const contactsWithMems = contacts.filter(c => Array.isArray(c.memories) && c.memories.length > 0);
            console.log('[PhoneSocial] scan: contacts with memories: ' + (contactsWithMems.length ? contactsWithMems.map(c => c.name + '(' + c.memories.length + ')').join(', ') : 'NONE'));
            // ── Ensemble card targeted post-scan ──
            // When the chat uses an ensemble card like "Corey + Jay", the main
            // scan treats them as the narrator and barely extracts memories.
            // Run dedicated follow-up API calls for each ensemble part with
            // low memory count, asking specifically about THAT character.
            if (isEnsembleCard) {
                const ensembleParts = (ctx.name2 || ctx.name || '').split(/[+,&]\s*/).map(p => p.trim().toLowerCase()).filter(p => p.length > 1);
                const starvedParts = ensembleParts.filter(p => {
                    const c = contacts.find(x => x.name.toLowerCase() === p);
                    return c && (!Array.isArray(c.memories) || c.memories.length < 3);
                });
                if (starvedParts.length) {
                    console.log('[PhoneSocial] scan: ensemble post-scan needed for: ' + starvedParts.join(', '));
                    // Fire and forget — don't block the current scan
                    setTimeout(() => targetedEnsembleScan(starvedParts, contacts, transcript, user, myName), 2000);
                }
            }
            // Always purge after extraction — NPCs the API finds may not be real senders
            try { purgeStaleContacts(); } catch (_) {}
            saveMeta();
            return totalAdded;
        } catch (e) {
            console.warn('[PhoneSocial] memories scan parse failed:', e?.message || e, 'raw:', (text || '').slice(0, 200));
            return 0;
        }
    }

    // ─── Targeted ensemble post-scan ──────────────────────────────
    // When the main scan barely finds memories for ensemble card NPCs
    // (because "Corey + Jay" is treated as one narrator), this runs
    // dedicated follow-up calls asking specifically about each NPC.
    async function targetedEnsembleScan(starvedParts, contacts, transcript, user, myName) {
        console.log('[PhoneSocial] targeted ensemble scan: starting for ' + starvedParts.join(', '));
        for (const partName of starvedParts) {
            try {
                const contact = contacts.find(c => c.name.toLowerCase() === partName);
                if (!contact) continue;
                // Build a focused prompt — ask ONLY about this one character
                const systemPrompt = `You are extracting memories about a specific character from a roleplay transcript.

Character: ${partName}
Source transcript: conversation between "${user}" and "${myName}" (an ensemble narrator card).

Your ONLY job: Extract 2-4 specific, durable facts about ${partName} from the transcript below.

Return ONLY valid JSON:
{
  "memories": [
    { "text": "Specific fact about ${partName}...", "quote": "verbatim excerpt from transcript", "tags": ["personality"] }
  ]
}

RULES:
- Each memory: 1 sentence, 10-60 words, about ${partName} specifically.
- Extract PERSONALITY traits, recent actions, relationships, or stated facts.
- 🚫 ANTI-HALLUCINATION: NEVER invent dialogue, events, or details. Every memory MUST be traceable to the transcript. A blank memory is better than a fake one.
- 📎 Include a "quote" field: a SHORT verbatim excerpt (5-15 words) from the transcript that PROVES this fact. Copy-paste it exactly.`;

                const userPrompt = `Transcript:\n\n${transcript}\n\nExtract 2-4 memories about ${partName}.`;
                
                const text = await callTurboApi(systemPrompt, userPrompt);
                if (!text) {
                    console.log('[PhoneSocial] targeted scan for ' + partName + ': API returned empty');
                    continue;
                }
                
                // Parse response
                const cleaned = String(text)
                    .replace(/<think>[\s\S]*?<\/think>/gi, '')
                    .replace(/```json\s*|```/g, '')
                    .replace(/^[^{[]*/, '')
                    .replace(/[^}\]]*$/, '')
                    .trim();
                
                try {
                    const obj = JSON.parse(cleaned);
                    const mems = Array.isArray(obj?.memories) ? obj.memories : [];
                    let added = 0;
                    for (const m of mems) {
                        const memText = (m.text || '').trim();
                        if (!memText || memText.length < 15) continue;
                        // Quote verification
                        const quote = (m.quote || '').trim();
                        if (quote.length >= 10) {
                            const transcriptLower = transcript.toLowerCase();
                            const quoteLower = quote.toLowerCase();
                            if (!transcriptLower.includes(quoteLower)) {
                                console.log(`[PhoneSocial] targeted scan: REJECTED memory for ${partName} — quote not in transcript: "${quote.slice(0, 80)}"`);
                                continue;
                            }
                        }
                        if (!contact.memories) contact.memories = [];
                        const existing = new Set(contact.memories.map(x =>
                            (x.text || '').toLowerCase().replace(/\s+/g, ' ').trim()));
                        const key = memText.toLowerCase().replace(/\s+/g, ' ').trim();
                        if (existing.has(key)) continue;
                        contact.memories.push({
                            text: memText.slice(0, 320),
                            ts: Date.now(),
                            tags: Array.isArray(m.tags) ? m.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6) : [],
                        });
                        added++;
                    }
                    if (added > 0) {
                        console.log(`[PhoneSocial] targeted scan for ${partName}: +${added} memories`);
                    } else {
                        console.log(`[PhoneSocial] targeted scan for ${partName}: 0 memories returned`);
                    }
                } catch (e) {
                    console.warn('[PhoneSocial] targeted scan parse failed for ' + partName + ':', e?.message || e);
                }
            } catch (e) {
                console.warn('[PhoneSocial] targeted scan failed for ' + partName + ':', e?.message || e);
            }
        }
        saveMeta();
        console.log('[PhoneSocial] targeted ensemble scan: complete');
    }

    // ─── Chirp Feed Generator ─────────────────────────────────────────
