    function harvestNPCs() {
        console.log('[PhoneSocial] harvestNPCs: state.contacts.length =', state.contacts.length);
        const ctx = getCtx();
        if (!ctx?.chat) return;
        const blocked = getBlockedSet();
        const debug = [];
        const seen = new Set(state.contacts.map(c => c.name.toLowerCase()));
        // Active character card name — never harvest the card itself
        const activeCardName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const name = (msg.name || '').trim();
            if (!name) continue;
            const norm = name.toLowerCase();
            // Skip the active character card itself — it's not an NPC
            if (activeCardName && (norm === activeCardName || norm.includes(activeCardName) || activeCardName.includes(norm))) {
                debug.push(`SKIP(active card): "${name}"`);
                continue;
            }
            if (seen.has(norm)) { debug.push(`SKIP(seen): "${name}"`); continue; }
            if (isBlocked(name, blocked)) { debug.push(`SKIP(blocked): "${name}"`); continue; }
            seen.add(norm);
            debug.push(`HARVEST: "${name}"`);
            state.contacts.push({
                id: 'npc_' + norm.replace(/\s+/g, '_'),
                name,
                number: genNumber(),
                schedule: null,
                source: 'npc',
                starred: false,
            });
        }
        if (debug.length) console.log('[PhoneSocial] harvestNPCs:', debug);
        // Hard cap: max 30 contacts per chat to prevent rogue extraction
        if (state.contacts.length > 30) {
            console.log(`[PhoneSocial] harvest: capping ${state.contacts.length} contacts → 30`);
            state.contacts = state.contacts.slice(0, 30);
        }
        // ── Ensemble card pass: split compound names like "Corey + Jay" ──
        // Ensemble cards write multiple NPCs through a single character card.
        // msg.name is always "Corey + Jay" — never the individuals. Split on
        // +/,/& to harvest Corey and Jay as separate contacts.
        harvestEnsembleNPCs(blocked, seen, debug);
        // Second pass: scan message text for named NPCs mentioned in prose/dialogue
        try {
            harvestNamesFromText(blocked, seen, debug);
        } catch (_e) {
            console.warn('[PhoneSocial] text harvest failed:', _e);
        }
        // Third pass: pull NPCs from the active character card definition.
        // Only harvest from the card being used in this chat — NOT every
        // loaded character in the roster. For ensemble cards like "Corey + Jay",
        // split on +/,/& to extract individual NPCs from the character definition.
        try {
            harvestFromActiveCard(blocked, seen, debug);
        } catch (_e) {
            console.warn('[PhoneSocial] active card harvest failed:', _e);
        }
        // Diagnostic: show contacts AFTER all harvest passes
        console.log('[PhoneSocial] harvestNPCs DONE: state.contacts.length = ' + state.contacts.length + ', names: ' + state.contacts.map(c => c.name).join(', '));
    }

    // -------------------------------------------------------------------
    // Active character card NPC extraction
    // Reads the character card definition for the CURRENT chat only.
    // For ensemble cards like "Corey + Jay", splits on +/,/& to extract
    // individual NPCs. Also scans the card's description for <npc:Name> tags.
    // This catches NPCs even before any chat messages are exchanged.
    // -------------------------------------------------------------------
    function harvestFromActiveCard(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.characters || !Array.isArray(ctx.characters)) return;
        const activeName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
        if (!activeName) return;
        // Find the active character card
        const card = ctx.characters.find(ch => ch && ch.name && ch.name.toLowerCase() === activeName);
        if (!card) {
            console.log('[PhoneSocial] harvestFromActiveCard: no card found for "' + activeName + '"');
            return;
        }
        console.log('[PhoneSocial] harvestFromActiveCard: found card "' + card.name + '"');
        // Split ensemble card name (e.g. "Corey + Jay" → ["Corey", "Jay"])
        if (/[+,&]/.test(card.name)) {
            const parts = card.name.split(/[+,&]\s*/).map(p => p.trim()).filter(p => p.length > 1);
            console.log('[PhoneSocial] harvestFromActiveCard ensemble: ' + JSON.stringify(parts));
            for (const part of parts) {
                const norm = part.toLowerCase();
                if (seen.has(norm)) { debug.push(`CARD-SKIP(seen): "${part}"`); continue; }
                if (isBlocked(part, blocked)) { debug.push(`CARD-SKIP(blocked): "${part}"`); continue; }
                seen.add(norm);
                debug.push(`CARD-HARVEST: "${part}" (from active card "${card.name}")`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name: part,
                    number: genNumber(),
                    schedule: null,
                    source: 'npc',
                    starred: false,
                });
            }
        }
        // Scan card description for <npc:Name> tags
        if (card.data) {
            const desc = (card.data.description || '') + ' ' + (card.data.personality || '') + ' ' + (card.data.scenario || '');
            const reNpc = /<npc:([^>]{2,48})>/gi;
            let m;
            while ((m = reNpc.exec(desc)) !== null) {
                const name = m[1].trim();
                const norm = name.toLowerCase();
                if (seen.has(norm)) { debug.push(`CARD-TAG-SKIP(seen): "${name}"`); continue; }
                if (isBlocked(name, blocked)) { debug.push(`CARD-TAG-SKIP(blocked): "${name}"`); continue; }
                seen.add(norm);
                debug.push(`CARD-TAG: "${name}" (from active card description)`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    schedule: null,
                    source: 'npc-tag',
                    starred: false,
                });
            }
        }
    }

    // -------------------------------------------------------------------
    // Ensemble card NPC extraction
    // When a chat uses an ensemble character card (e.g. "Corey + Jay"),
    // every message has msg.name = "Corey + Jay". Split compound names
    // on +/,/& to harvest each individual NPC as a separate contact.
    // -------------------------------------------------------------------
    function harvestEnsembleNPCs(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.chat) return;
        const ensembleNames = new Set();
        // Collect all unique compound speaker names
        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const name = (msg.name || '').trim();
            if (!name) continue;
            // Only split names that contain ensemble delimiters
            if (!/[+,&]/.test(name)) continue;
            ensembleNames.add(name);
        }
        // Split each compound name and harvest individuals
        for (const compound of ensembleNames) {
            const parts = compound.split(/[+,&]\s*/).map(p => p.trim()).filter(p => p.length > 1);
            console.log('[PhoneSocial] ensemble split: "' + compound + '" → ' + JSON.stringify(parts));
            for (const part of parts) {
                const norm = part.toLowerCase();
                if (seen.has(norm)) { debug.push(`ENSEMBLE-SKIP(seen): \"${part}\"`); continue; }
                if (isBlocked(part, blocked)) { debug.push(`ENSEMBLE-SKIP(blocked): \"${part}\"`); continue; }
                // Extra guard: skip single-char parts (e.g. "+" or "&" alone after split)
                if (part.length < 2) continue;
                seen.add(norm);
                debug.push(`ENSEMBLE-HARVEST: \"${part}\" (from \"${compound}\")`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name: part,
                    number: genNumber(),
                    schedule: null,
                    source: 'npc',
                    starred: false,
                });
            }
        }
    }

    // -------------------------------------------------------------------
    // Name extraction from tagged NPC markers (UIE-style)
    // Instead of guessing names from prose, only extract names from
    // explicit markers that users intentionally write in their messages:
    //   <npc:Name>  — NPC declaration
    //   <char:Name> — character mention
    //   <Name>:     — styled message prefix at line start
    // -------------------------------------------------------------------
    function harvestNamesFromText(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.chat) return;

        // Scan message text for tagged NPC markers
        const reNpc = /<npc:([^>]{2,48})>/gi;
        const reChar = /<char:([^>]{2,48})>/gi;
        const rePrefix = /^<([a-zA-Z][a-zA-Z0-9 _.-]{1,47})>:\s/m;

        for (const msg of ctx.chat) {
            if (!msg || msg.is_user || msg.is_system) continue;
            const text = (msg.mes || msg.text || '');
            if (!text) continue;

            // <npc:Name> tags
            reNpc.lastIndex = 0;
            let m;
            while ((m = reNpc.exec(text)) !== null) {
                const name = m[1].trim();
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                if (seen.has(norm)) continue;
                seen.add(norm);
                debug.push(`NPC TAG: "${name}"`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    schedule: null,
                    source: 'npc-tag',
                    starred: false,
                });
            }

            // <char:Name> tags
            reChar.lastIndex = 0;
            while ((m = reChar.exec(text)) !== null) {
                const name = m[1].trim();
                const norm = name.toLowerCase();
                if (isBlocked(name, blocked)) continue;
                if (seen.has(norm)) continue;
                seen.add(norm);
                debug.push(`CHAR TAG: "${name}"`);
                state.contacts.push({
                    id: 'npc_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name,
                    number: genNumber(),
                    schedule: null,
                    source: 'npc-tag',
                    starred: false,
                });
            }

            // <Name>: prefix at line start — DISABLED: creates too many false positives
            // from inline roleplay formatting. Let users use <npc:Name> tags instead.
            // The prefix scan was extracting 50+ names from formatted dialogue in 38 messages.
        }
    }

    function harvestSTCharacters(blocked, seen, debug) {
        const ctx = getCtx();
        if (!ctx?.characters || !Array.isArray(ctx.characters)) return [];
        const added = [];
        for (const ch of ctx.characters) {
            if (!ch) continue;
            const name = (ch.name || '').trim();
            if (!name) continue;
            const norm = name.toLowerCase();
            if (blocked.has(norm)) continue;
            if (seen.has(norm)) continue;
            seen.add(norm);
            added.push(name);
            state.contacts.push({
                id: 'st_' + norm.replace(/[^a-z0-9_]/g, '_'),
                name,
                number: genNumber(),
                schedule: null,
                source: 'st-character',
                starred: false,
            });
        }
        // Also grab group members if in a group chat
        if (ctx.groups && ctx.groupId) {
            try {
                const group = Array.isArray(ctx.groups) ? ctx.groups.find(g => g.id === ctx.groupId) : null;
                if (group && Array.isArray(group.members)) {
                    for (const member of group.members) {
                        if (!member || typeof member !== 'object') continue;
                        const name = (member.name || '').trim();
                        if (!name) continue;
                        const norm = name.toLowerCase();
                        if (isBlocked(name, blocked)) continue;
                        if (seen.has(norm)) continue;
                        seen.add(norm);
                        added.push(`[group] ${name}`);
                        state.contacts.push({
                            id: 'st_group_' + norm.replace(/[^a-z0-9_]/g, '_'),
                            name,
                            number: genNumber(),
                            schedule: null,
                            source: 'st-group',
                            starred: false,
                        });
                    }
                }
            } catch (_e) { /* group data may be shallow */ }
        }
        return added;
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
