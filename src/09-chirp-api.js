    async function generateChirpFeed() {
        console.log('[PhoneSocial] chirp: generating feed');
        const ctx = getCtx();
        if (!ctx) return;

        const contacts = state.contacts;
        const contactNames = contacts.map(c => c.name);
        const contactList = contactNames.length
            ? `\nKnown contacts: ${contactNames.join(', ')}`
            : '';

        // Extract setting from the CURRENT CHAT's character card (not chars[0] — could be the ST assistant)
        let setting = '';
        let settingSource = 'default';
        try {
            const chars = ctx?.characters;
            const currentCharName = (ctx.name2 || ctx.name || '').trim().toLowerCase();
            let ch = null;
            // Priority: character object > match by name > first character in array
            if (ctx?.character && ctx.character.name) {
                ch = ctx.character;
                settingSource = 'ctx.character';
            } else if (Array.isArray(chars) && chars.length > 0) {
                if (currentCharName) {
                    ch = chars.find(c => c && c.name && c.name.toLowerCase() === currentCharName);
                    if (ch) settingSource = 'name2-match';
                }
                if (!ch) {
                    ch = chars[0];
                    settingSource = 'chars[0]-fallback';
                }
            }
            if (ch) {
                const chName = (ch.name || '').trim();
                const blocked = getBlockedSet();
                // NEVER use a blocked character's card as the world setting — their traits
                // (demon/incubus/etc.) contaminate Chirp posts even after the name is filtered.
                if (isBlocked(chName, blocked)) {
                    console.log(`[PhoneSocial] chirp: SKIPPING setting from "${chName}" — character is blocked/assistant`);
                } else {
                    const desc = (ch?.data?.description || '').trim().slice(0, 300);
                    const scenario = (ch?.data?.scenario || '').trim().slice(0, 200);
                    if (desc) setting = desc;
                    else if (scenario) setting = scenario;
                    console.log(`[PhoneSocial] chirp: setting from "${chName}" via ${settingSource}`);
                    if (setting) console.log(`[PhoneSocial] chirp: setting preview: ${setting.slice(0, 80)}`);
                }
            }
        } catch (_) {}
        const settingLine = setting
            ? `Set in: ${setting}`
            : 'Set in: A modern setting.';

        const systemPrompt = `You are generating a Chirp (Twitter clone) social media feed.
${settingLine}${contactList}

CRITICAL WORLD RULES:
- The ONLY information you have about this world is the "Set in:" line above. Ignore everything else you know.
- This feed exists in a FICTIONAL roleplay world. System assistants, AI characters, chatbot helper personalities — none of these exist in this world.
- DO NOT create posts about supernatural beings (demons, incubi, succubi, angels) unless the "Set in:" line explicitly describes a supernatural setting.
- If the "Set in:" line describes a normal/modern setting, ALL posts must be about normal human life in that setting.
- NPCs in this world have ordinary lives, jobs, relationships, and hobbies. They are not aware of any external AI or assistant system.

Generate 8-12 chirps (posts). Each post is a first-person status update from its author. Write from these people:
- The contacts listed above (set isContact=true for them) — post as them, about their lives
- Random global users (set isContact=false) — generic social media users in this setting

Return ONLY valid JSON array:
[
  {
    "name": "Author Name",
    "handle": "username",
    "text": "Post content...",
    "isContact": true/false,
    "imagePrompt": "optional — describe a scene/image for this post. Only for 2-3 posts, leave null for others."
  }
]

Rules:
- Contact posts should feel relevant to their personality and the story setting
- Global posts should feel like real social media — funny, mundane, dramatic, news
- Mix tones: some funny, some serious, some casual
- Each chirp should be 10-80 words, natural social media style
- Include hashtags occasionally (#vibes #mood #storyrelevant)
- For 2-3 posts, add an imagePrompt field with a short visual description (selfies, scenery, food pics, memes)
- imagePrompt should be null if no image needed
- Output ONLY the JSON array, no other text`;

        const userPrompt = `Generate a Chirp feed for a roleplay set in this world. Mix contact posts and global posts.`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) {
            console.log('[PhoneSocial] chirp: API returned nothing');
            return;
        }
        console.log('[PhoneSocial] chirp: API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const posts = arr.map((item, i) => ({
                id: 'chirp_' + Date.now() + '_' + i,
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user' + i).trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                    isContact: !!item.isContact,
                },
                text: (item.text || '').trim(),
                imageUrl: item.imagePrompt ? 'https://image.pollinations.ai/prompt/' + encodeURIComponent(item.imagePrompt) : null,
                ts: Date.now() - Math.floor(Math.random() * 3600000 * (arr.length - i)),
                likes: 0,
                likedBy: [],
                comments: [],
            })).filter(p => p.text.length > 3);

            // HARD FILTER: Remove any post mentioning blocked/assistant names or supernatural traits
            // that the model leaks from ST context (even after the prompt tells it not to).
            const blockedNames = getBlockedSet();
            const blockedPatterns = [];
            const blockedEntries = blockedNames instanceof Set ? blockedNames : blockedNames?.set;
            if (blockedEntries) {
                for (const b of blockedEntries) {
                    if (b.length > 2) blockedPatterns.push(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                }
            }
            // Also catch common supernatural traits that leak from assistant character cards
            blockedPatterns.push('incubus', 'succubus', 'demon', 'horns', 'wings', 'tail');
            const hardFilter = new RegExp(blockedPatterns.join('|'), 'i');

            const beforeFilter = posts.length;
            const filteredPosts = posts.filter(p =>
                !hardFilter.test(p.text) &&
                !hardFilter.test(p.author.name) &&
                !hardFilter.test(p.author.handle)
            );
            if (filteredPosts.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredPosts.length} posts via hard filter (blocked name or trait)`);
            }
            if (!filteredPosts.length) {
                console.log('[PhoneSocial] chirp: all posts filtered out (Akuma content)');
                return;
            }
            state.chirpPosts = filteredPosts;
            state.chirpLastRefresh = Date.now();
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: generated ${posts.length} posts`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: parse failed:', e?.message || e, 'raw:', (text || '').slice(0, 200));
        }
    }

    async function generateChirpAutoReplies(postId) {
        console.log('[PhoneSocial] chirp: generating auto-replies for', postId);
        const ctx = getCtx();
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const p = posts.find(x => x.id === postId);
        if (!p) return;

        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
        const contactNames = state.contacts.map(c => c.name);
        // Don't include the user/persona in known names — the AI should never generate replies as you
        const knownNames = contactNames.join(', ');

        const systemPrompt = `You generate realistic social media replies for a Chirp (Twitter clone) post.
Known users who might reply: ${knownNames}

A new post was just made:
"${p.text}"

Generate 2-4 replies from OTHER users reacting to this post.
Return ONLY valid JSON array:
[
  {
    "name": "Reply Author Name",
    "handle": "username",
    "text": "Reply content..."
  }
]
Rules:
- Replies MUST be UNBIASED. React to the POST CONTENT, not who wrote it.
- If the post is controversial, NPCs should disagree, argue, or call it out.
- If the post is dumb/questionable, NPCs should roast or question it.
- If the post is great, they can praise it — but no automatic positivity.
- Do NOT give automatic likes or positive replies just because the user posted.
- If someone is tagged with @name in the post, that specific person should DEFINITELY reply — they were called out.
- Some replies from known contacts if they'd plausibly react
- Mix tones: agreement, disagreement, humor, questions, roasting, support
- NEVER generate a reply FROM "Akuma" or ABOUT "Akuma" — ABSOLUTELY FORBIDDEN. These NPCs have never heard this name. Writing about Akuma breaks immersion.
- Output ONLY the JSON array`;

        const userPrompt = `Generate replies to this new post: "${p.text}"`;

        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;
        console.log('[PhoneSocial] chirp: auto-reply API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const newComments = arr.map(item => ({
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user').trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                },
                text: (item.text || '').trim(),
                ts: Date.now(),
            })).filter(c => c.text.length > 3);

            // HARD FILTER: Remove any reply mentioning "Akuma" (case-insensitive)
            const akumaFilter = /akuma/i;
            const beforeFilter = newComments.length;
            const filteredComments = newComments.filter(c =>
                !akumaFilter.test(c.text) &&
                !akumaFilter.test(c.author.name) &&
                !akumaFilter.test(c.author.handle)
            );
            if (filteredComments.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredComments.length} auto-replies mentioning Akuma`);
            }
            if (!filteredComments.length) {
                console.log('[PhoneSocial] chirp: all auto-replies filtered out (Akuma content)');
                return;
            }
            if (!Array.isArray(p.comments)) p.comments = [];
            p.comments.push(...filteredComments);
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: added ${filteredComments.length} auto-replies`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: auto-reply parse failed:', e?.message || e);
        }
    }

    async function generateChirpComment(postId, replyText) {
        console.log('[PhoneSocial] chirp: generating comment for', postId);
        const ctx = getCtx();
        const posts = Array.isArray(state.chirpPosts) ? state.chirpPosts : [];
        const p = posts.find(x => x.id === postId);
        if (!p) return;

        const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
        const contactNames = state.contacts.map(c => c.name);
        // Don't include the user/persona in known names — AI should never generate replies as you
        const knownNames = contactNames.join(', ');

        const systemPrompt = `You generate realistic social media replies for a Chirp (Twitter clone) post.
Known users who might reply: ${knownNames}

The original post is by "${p.author.name}" (@${p.author.handle}):
"${p.text}"

A user named "${myName}" wrote this reply:
"${replyText}"

Generate 1-3 replies from OTHER users (not ${myName}) reacting to the original post and/or the reply.
Return ONLY valid JSON array:
[
  {
    "name": "Reply Author Name",
    "handle": "username",
    "text": "Reply content..."
  }
]
Rules:
- Replies MUST be UNBIASED. React to the post CONTENT, not who wrote it.
- If the post is controversial, NPCs should disagree, argue, or call it out.
- Do NOT give automatic positive replies just because the user posted.
- If someone is tagged with @name in the reply, that specific person should DEFINITELY reply — they were called out.
- Some might be from known contacts
- Include at least one reply
- NEVER generate a reply FROM "Akuma" or ABOUT "Akuma" — ABSOLUTELY FORBIDDEN. These NPCs have never heard this name. Writing about Akuma breaks immersion.
- Output ONLY the JSON array`;

        const userPrompt = `Generate replies to: "${p.text}" where ${myName} replied: "${replyText}"`;

        // Always add the user's comment immediately
        if (!Array.isArray(p.comments)) p.comments = [];
        p.comments.push({
            author: { name: myName, handle: myName.toLowerCase().replace(/[^a-z0-9_]/g, ''), isUser: true },
            text: replyText,
            ts: Date.now() - 1000,
        });
        saveMeta();
        render();
        console.log('[PhoneSocial] chirp: user comment added');

        // Then try to get AI replies (best-effort, won't lose user's comment if it fails)
        const text = await callTurboApi(systemPrompt, userPrompt);
        if (!text) return;
        console.log('[PhoneSocial] chirp: comment API raw:', (text || '').slice(0, 200));

        const cleaned = String(text)
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/```json\s*|```/g, '')
            .replace(/^[^{[]*/, '')
            .replace(/[^}\]]*$/, '')
            .trim();

        try {
            const arr = JSON.parse(cleaned);
            if (!Array.isArray(arr)) throw new Error('not an array');
            const newComments = arr.map(item => ({
                author: {
                    name: (item.name || 'Unknown').trim(),
                    handle: (item.handle || 'user').trim().replace(/[^a-z0-9_]/gi, '').toLowerCase(),
                },
                text: (item.text || '').trim(),
                ts: Date.now(),
            })).filter(c => c.text.length > 3);

            // HARD FILTER: Remove any reply mentioning "Akuma" (case-insensitive)
            const akumaFilter = /akuma/i;
            const beforeFilter = newComments.length;
            const filteredComments = newComments.filter(c =>
                !akumaFilter.test(c.text) &&
                !akumaFilter.test(c.author.name) &&
                !akumaFilter.test(c.author.handle)
            );
            if (filteredComments.length < beforeFilter) {
                console.log(`[PhoneSocial] chirp: filtered ${beforeFilter - filteredComments.length} comment replies mentioning Akuma`);
            }
            if (!filteredComments.length) return;
            p.comments.push(...filteredComments);
            saveMeta();
            render();
            console.log(`[PhoneSocial] chirp: added ${filteredComments.length} AI replies`);
        } catch (e) {
            console.warn('[PhoneSocial] chirp: comment parse failed:', e?.message || e);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Schedule Infrastructure (port from Marinara Engine)
    // ═══════════════════════════════════════════════════════════════

    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const STATUS_KEYWORDS = {
        sleep:'offline', sleeping:'offline', nap:'offline', napping:'offline', rest:'offline', resting:'offline',
        work:'dnd', working:'dnd', class:'dnd', classes:'dnd', school:'dnd', studying:'dnd', study:'dnd',
        meeting:'dnd', training:'dnd', exercise:'dnd', gym:'dnd', busy:'dnd',
        commute:'idle', commuting:'idle', driving:'idle', travel:'idle', traveling:'idle',
        shower:'idle', showering:'idle', cooking:'idle', eating:'idle', meal:'idle',
    };

