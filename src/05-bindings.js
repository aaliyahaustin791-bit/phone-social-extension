    function bindPanel(panel) {
        // Use event delegation: ONE listener on the panel finds the nearest [data-act]
        // ancestor via ev.target.closest(). This fixes the nested [data-act] conflict
        // where a button inside a data-act parent (e.g. ✕ delete inside open-thread <li>)
        // would double-fire on mobile. With delegation, the deepest matched element wins.
        panel.removeEventListener('click', onAction);
        panel.addEventListener('click', onAction, { passive: false });
    }

    function onAction(ev) {
        const el = ev.target.closest('[data-act]');
        // Fallback: any element with data-nav-url acts as a browser link click
        const linkEl = el || ev.target.closest('[data-nav-url]');
        if (!el && linkEl) {
            const navUrl = linkEl.getAttribute('data-nav-url');
            if (navUrl) {
                ev.preventDefault();
                generateBrowserPage(navUrl);
                return;
            }
        }
        if (!el) return;
        const act = el.getAttribute('data-act');
        // Auto-close notification shade when navigating away
        if (notifShadeOpen && act !== 'close-shade' && act !== 'clear-notifs') {
            notifShadeOpen = false;
            const s = document.getElementById('ps-notif-shade');
            if (s) { s.classList.remove('ps-notif-open'); s.style.maxHeight = ''; }
        }
        switch (act) {
            case 'close':
                togglePanel();
                return;
            case 'nav':
                state.viewHistory = [];
                state.view = el.getAttribute('data-view');
                if (state.view === 'contacts' || state.view === 'favorites') {
                    harvestNPCs();
                    purgeStaleContacts();
                }
                saveMeta();
                render();
                return;
            
            case 'dismiss-banner':
                ev.stopPropagation();
                state.incomingBanner = null;
                const b = document.querySelector('.ps-incoming-banner');
                if (b) b.remove();
                render();
                return;

            case 'close-shade':
                notifShadeOpen = false;
                const shadeEl = document.getElementById('ps-notif-shade');
                if (shadeEl) {
                    shadeEl.classList.remove('ps-notif-open');
                    shadeEl.style.maxHeight = '';
                }
                return;

            case 'clear-notifs':
                // Mark all unread SMS as seen
                for (const [cid, thread] of Object.entries(state.threads)) {
                    if (!Array.isArray(thread)) continue;
                    for (const m of thread) {
                        if (m.from === 'them' && !m.seen) m.seen = true;
                    }
                }
                // Mark all voicemails as heard
                if (Array.isArray(state.voicemails)) {
                    for (const vm of state.voicemails) vm.heard = true;
                }
                notifShadeOpen = false;
                saveMeta();
                render();
                return;

            case 'toggle-menu': {
                ev.preventDefault();
                ev.stopPropagation();
                const menuId = el.getAttribute('data-id');
                const dropdown = document.getElementById('ps-menu-' + menuId);
                if (!dropdown) return;
                // Close all other open menus first
                document.querySelectorAll('.ps-menu-dropdown').forEach(d => {
                    if (d !== dropdown) d.style.display = 'none';
                });
                const isOpen = dropdown.style.display === 'block';
                dropdown.style.display = isOpen ? 'none' : 'block';
                return;
            }
            case 'toggle-star': {
                const starId = el.getAttribute('data-id');
                const contact = state.contacts.find(c => c.id === starId);
                if (contact) {
                    contact.starred = !contact.starred;
                    saveMeta();
                    render();
                }
                return;
            }
            case 'set-tts-voice': {
                const voiceId = el.getAttribute('data-id');
                const voiceContact = state.contacts.find(c => c.id === voiceId);
                if (!voiceContact) return;
                const newVoice = (el.value || '').trim();
                voiceContact.ttsVoice = newVoice || undefined;
                saveMeta();
                console.log('[PhoneSocial] 🎤 TTS voice for ' + voiceContact.name + ': ' + (newVoice || '(default)'));
                return;
            }
            case 'toggle-mute': {
                const muteId = el.getAttribute('data-id');
                if (state.mutedContacts[muteId]) {
                    delete state.mutedContacts[muteId];
                } else {
                    state.mutedContacts[muteId] = true;
                }
                saveMeta();
                render();
                return;
            }
            case 'schedule-day': {
                state.scheduleSelectedDay = el.getAttribute('data-day');
                saveMeta();
                render();
                return;
            }
            
            case 'open-profile':
                state.activeContact = el.getAttribute('data-id');
                navigateTo('profile');
                saveMeta();
                render();
                return;
            case 'generate-schedule': {
                const gsId = el.getAttribute('data-id');
                if (!gsId) return;
                const btn = el;
                btn.disabled = true;
                const origText = btn.textContent;
                btn.textContent = '⏳ Generating...';
                generateSchedule(gsId).then(schedule => {
                    if (schedule) {
                        saveMeta();
                        render();
                    }
                }).catch(e => {
                    console.warn('[PhoneSocial] schedule generation failed:', e?.message);
                    alert('Schedule generation failed. Check the API connection and try again.');
                }).finally(() => {
                    btn.disabled = false;
                    btn.textContent = origText;
                });
                return;
            }
            case 'open-thread':
                state.activeContact = el.getAttribute('data-id');
                if (!state.threads[state.activeContact]) state.threads[state.activeContact] = [];
                // Mark all NPC messages in this thread as seen
                const threadMsgs = state.threads[state.activeContact];
                for (const m of threadMsgs) {
                    if (m.from === 'them' && !m.seen) m.seen = true;
                }
                // Dismiss incoming banner if opening the matching thread
                if (state.incomingBanner && state.incomingBanner.contactId === state.activeContact) {
                    state.incomingBanner = null;
                }
                state.view = 'thread';
                saveMeta();
                render();
                return;
            case 'delete-contact': {
                ev.preventDefault();
                ev.stopPropagation();
                const delId = el.getAttribute('data-id');
                if (!delId) return;
                const delContact = state.contacts.find(c => c.id === delId);
                const delName = delContact ? delContact.name : 'this contact';
                const ok = confirm('Delete ' + delName + '? This cannot be undone.');
                if (ok !== true) return;
                console.log('[PhoneSocial] Deleting contact:', delName, delId);
                state.contacts = state.contacts.filter(c => c.id !== delId);
                delete state.threads[delId];
                state.callLog = state.callLog.filter(l => l.contactId !== delId);
                if (state.activeContact === delId) state.activeContact = null;
                state.view = 'contacts';
                saveMeta();
                render();
                return;
            }
            case 'delete-thread': {
                const delId = el.getAttribute('data-id');
                if (!delId || !state.threads[delId]) return;
                delete state.threads[delId];
                if (state.activeContact === delId) {
                    state.activeContact = null;
                    state.view = 'sms';
                }
                saveMeta();
                render();
                return;
            }
            case 'delete-msg': {
                const contactId = el.getAttribute('data-id');
                const idx = parseInt(el.getAttribute('data-msg-index'), 10);
                if (!contactId || !state.threads[contactId] || isNaN(idx)) return;
                const thread = state.threads[contactId];
                if (idx >= 0 && idx < thread.length) {
                    thread.splice(idx, 1);
                    // If thread is now empty, clean it up
                    if (!thread.length) {
                        delete state.threads[contactId];
                        if (state.activeContact === contactId) {
                            state.activeContact = null;
                            state.view = 'sms';
                        }
                    }
                }
                saveMeta();
                render();
                return;
            }
            case 'add-contact': {
                const name = prompt('Enter NPC name:');
                if (!name || !name.trim()) return;
                const norm = name.trim().toLowerCase();
                if (state.contacts.some(c => c.name.toLowerCase() === norm)) {
                    alert('Contact already exists.');
                    return;
                }
                state.contacts.push({
                    id: 'manual_' + norm.replace(/[^a-z0-9_]/g, '_'),
                    name: name.trim(),
                    number: genNumber(),
                    schedule: null,
                    source: 'manual',
                    starred: false,
                });
                saveMeta();
                render();
                return;
            }
            case 'attach-image': {
                const fileInput = document.getElementById('ps-image-input');
                if (fileInput) fileInput.click();
                return;
            }
            case 'send': {
                const input = document.getElementById('ps-input');
                const text = (input?.value || '').trim();
                if (!text || !state.activeContact) return;
                state.threads[state.activeContact].push({ from: 'me', text, ts: Date.now(), seen: false });
                composeDraft = ''; // Clear draft on send
                updateSmsInjection(); // Inject SMS into main ST context
                simulateReply(state.activeContact).catch(e => console.warn('[PhoneSocial] reply gen failed:', e));
                saveMeta();
                render();
                return;
            }
            case 'call': {
                const id = el.getAttribute('data-id');
                const callContact = state.contacts.find(c => c.id === id);
                if (!callContact) return;
                const personality = inferPersonality(callContact);
                if (shouldDeclineCall(callContact, personality)) {
                    // NPC declines the call
                    const activityLabel = getActivityLabel(callContact);
                    const declineReason = activityLabel ? `${callContact.name} is ${activityLabel}` : `${callContact.name} declined the call`;
                    state.activeCall = { contactId: id, status: 'declined', startTs: null };
                    state.callLog.push({ contactId: id, dir: 'out', ts: Date.now(), duration: 0 });
                    saveMeta();
                    state.view = 'call';
                    render();
                    phoneNotify('incoming-call', `📞 ${callContact.name}`, declineReason);
                    phoneTtsSpeak(declineReason, callContact.name);
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.contactId !== id) return;
                        state.activeCall = null;
                        saveMeta();
                        state.view = 'home';
                        render();
                    }, 3000);
                    return;
                }
                state.activeCall = { contactId: id, status: 'dialing', startTs: null };
                state.callLog.push({ contactId: id, dir: 'out', ts: Date.now(), duration: 0 });
                saveMeta();
                state.view = 'call';
                render();
                phoneNotify('incoming-call', `📞 ${callContact.name}`, `Calling ${callContact.name}…`);
                phoneTtsSpeak(`Calling ${callContact.name}`, callContact.name);
                // Personality + activity-based answer delay
                const answerDelay = getCallAnswerDelay(callContact, personality);
                if (answerDelay < 0) {
                    // NPC never answers (e.g., in combat) — ring forever then auto-decline
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.contactId !== id) return;
                        state.activeCall = null;
                        state.callLog.push({ contactId: id, dir: 'missed', ts: Date.now(), duration: 0 });
                        saveMeta();
                        state.view = 'home';
                        render();
                        phoneNotify('incoming-call', `📞 ${callContact.name}`, `${callContact.name} never answered (in combat)`);
                        // Voicemail for unanswered outgoing call
                        setTimeout(() => {
                            generateSMSReply(id).then(vmText => {
                                const text = vmText || 'Sorry I missed your call.';
                                state.voicemails = state.voicemails || [];
                                state.voicemails.push({ contactId: id, text, ts: Date.now(), heard: false });
                                saveMeta();
                            }).catch(() => {});
                        }, 3000);
                        phoneTtsSpeak(`${callContact.name} never answered`, callContact.name);
                    }, 15000);
                    return;
                }
                setTimeout(() => {
                    if (!state.activeCall || state.activeCall.contactId !== id) return;
                    state.activeCall.status = 'connected';
                    state.activeCall.startTs = Date.now();
                    state.callLog.push({ contactId: id, dir: 'in', ts: Date.now(), duration: 0 });
                    saveMeta();
                    render(); // re-render to show connected state
                    startCallTimer();
                    if (callContact) {
                        phoneNotify('incoming-call', `📞 ${callContact.name}`, `📞 Connected with ${callContact.name}`);
                        phoneTtsSpeak(`Connected with ${callContact.name}`, callContact.name);
                    }
                }, answerDelay);
                return;
            }
            case 'answer-call': {
                if (!state.activeCall || state.activeCall.status !== 'incoming') return;
                // Cancel the auto-decline timer
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
                return;
            }
            case 'decline-call': {
                if (!state.activeCall || state.activeCall.status !== 'incoming') return;
                if (state.activeCall._autoDeclineTimer) {
                    clearTimeout(state.activeCall._autoDeclineTimer);
                }
                const decContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                const decId = state.activeCall.contactId;
                state.callLog.push({ contactId: decId, dir: 'declined', ts: Date.now(), duration: 0 });
                state.activeCall = null;
                saveMeta();
                state.view = 'home';
                render();
                if (decContact) {
                    phoneTtsSpeak(`Call declined`, decContact.name);
                    // Generate voicemail after declined call
                    setTimeout(() => {
                        generateSMSReply(decId).then(vmText => {
                            const text = vmText || 'Hey, it\'s me. Call me back when you can.';
                            state.voicemails = state.voicemails || [];
                            state.voicemails.push({ contactId: decId, text, ts: Date.now(), heard: false });
                            saveMeta();
                            phoneNotify('incoming-sms', `📼 ${decContact.name}`, `Voicemail from ${decContact.name}`);
                        }).catch(() => {});
                    }, 3000);
                }
                return;
            }
            case 'end-call': {
                if (!state.activeCall) return;
                const endContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                const duration = state.activeCall.startTs ? Math.floor((Date.now() - state.activeCall.startTs) / 1000) : 0;
                state.callLog.push({ contactId: state.activeCall.contactId, dir: 'end', ts: Date.now(), duration });
                stopCallTimer();
                state.activeCall = null;
                saveMeta();
                state.view = 'home';
                render();
                if (endContact) {
                    phoneTtsSpeak(`Call ended`, endContact.name);
                }
                return;
            }
            case 'call-mute':
                return;
            case 'call-keypad':
                return;
            case 'call-speaker':
                return;
            case 'call-speak': {
                const input = document.getElementById('ps-call-input');
                const speakText = (input?.value || '').trim();
                if (!speakText || !state.activeCall) return;
                const callContact = state.contacts.find(c => c.id === state.activeCall.contactId);
                state.callLog.push({ contactId: state.activeCall.contactId, dir: 'speak', ts: Date.now(), text: speakText, fromMe: true });
                saveMeta();
                input.value = '';
                // Re-render to show the new utterance in transcript
                render();
                // Auto-start timer if rendering wiped it
                if (state.activeCall?.status === 'connected') startCallTimer();
                // TTS the spoken text (so the NPC "hears" it if TTS is on)
                phoneTtsSpeak(speakText, callContact?.name || '');
                // Simulate a reply from the NPC after a short delay
                if (state.settings.autoReplies) {
                    setTimeout(() => {
                        if (!state.activeCall || state.activeCall.status !== 'connected') return;
                        generateSMSReply(state.activeCall.contactId).then(reply => {
                            if (!state.activeCall || state.activeCall.status !== 'connected') return;
                            if (!reply) return; // No reply — skip silently
                            const response = reply;
                            state.callLog.push({ contactId: state.activeCall.contactId, dir: 'speak', ts: Date.now(), text: response, fromMe: false });
                            saveMeta();
                            updateSmsInjection(); // Inject call into main ST context
                            render();
                            if (state.activeCall?.status === 'connected') startCallTimer();
                            phoneTtsSpeak(response, callContact?.name || '');
                        }).catch(() => {});
                    }, 1000 + Math.random() * 2000);
                }
                return;
            }
            case 'key':
                state.dialBuf += el.getAttribute('data-k');
                render();
                return;
            case 'dial-tab':
                state.dialTab = el.getAttribute('data-tab') || 'keypad';
                saveMeta();
                render();
                return;
            case 'play-voicemail': {
                const vmTs = parseInt(el.getAttribute('data-vm-ts') || '0');
                const vm = (state.voicemails || []).find(v => v.ts === vmTs);
                if (vm) {
                    vm.heard = true;
                    saveMeta();
                    if (typeof toastr !== 'undefined') toastr.info(vm.text.slice(0, 200), '📼 Voicemail from ' + (state.contacts.find(c => c.id === vm.contactId)?.name || 'Unknown'), { timeOut: 8000 });
                    else alert('Voicemail: ' + vm.text);
                }
                return;
            }
            case 'dial-clear':
                state.dialBuf = state.dialBuf.slice(0, -1);
                render();
                return;
            case 'dial-call': {
                if (!state.dialBuf) return;
                const dialRaw = state.dialBuf;
                state.activeCall = { contactId: null, status: 'dialing', startTs: null, raw: dialRaw };
                state.callLog.push({ contactId: null, dir: 'out', ts: Date.now(), duration: 0, raw: dialRaw });
                phoneNotify('incoming-call', '📞 Dialing', `Dialing ${dialRaw}…`);
                phoneTtsSpeak(`Dialing ${dialRaw}`, '');
                state.dialBuf = '';
                state.view = 'call';
                saveMeta();
                render();
                // Simulate answer after 2-5 seconds
                setTimeout(() => {
                    if (!state.activeCall || state.activeCall.raw !== dialRaw) return;
                    state.activeCall.status = 'connected';
                    state.activeCall.startTs = Date.now();
                    state.callLog.push({ contactId: null, dir: 'in', ts: Date.now(), duration: 0, raw: dialRaw });
                    saveMeta();
                    render();
                    startCallTimer();
                    phoneNotify('incoming-call', '📞 Connected', 'Call connected');
                    phoneTtsSpeak('Call connected', '');
                }, 2000 + Math.random() * 3000);
                return;
            }
            case 'toggle-setting': {
                const toggleKey = el.getAttribute('data-key');
                if (!toggleKey) return;
                // userDnd lives on state directly, not settings
                if (toggleKey === 'userDnd') {
                    state.userDnd = !state.userDnd;
                } else {
                    const current = !!state.settings[toggleKey];
                    state.settings[toggleKey] = !current;
                }
                if (toggleKey === 'autoHarvest' && state.settings[toggleKey]) {
                    harvestNPCs(true);
                }
                saveMeta();
                render();
                return;
            }
            case 'harvest-now':
                harvestNPCs(true);
                saveMeta();
                render();
                return;
            case 'reset-settings':
                state.settings = { ...DEFAULT_SETTINGS };
                saveMeta();
                render();
                if (typeof toastr !== 'undefined') {
                    toastr.success('Settings reset to defaults', 'PhoneSocial', { timeOut: 3000, progressBar: true });
                }
                return;
            case 'reset-chat-data':
                state.contacts = [];
                state.threads = {};
                state.callLog = [];
                state.browserHistory = [];
                state.browserIndex = -1;
                state.browserUrl = '';
                // Also clear the chat-specific backup
                try {
                    const ctx2 = getCtx();
                    if (ctx2?.extensionSettings) {
                        delete ctx2.extensionSettings[EXT_NAME + '_bk_' + getChatKey()];
                    }
                } catch (_) {}
                saveMeta();
                // Re-harvest from actual chat senders only, then purge
                harvestNPCs();
                purgeStaleContacts();
                saveMeta();
                state.view = 'home';
                render();
                return;
            case 'select-wallpaper': {
                const wpId = el.getAttribute('data-wallpaper');
                if (!wpId) return;
                saveWallpaperGlobally(wpId);
                state.view = 'home';
                render();
                return;
            }
            case 'choose-custom-wallpaper': {
                const fileInput = document.getElementById('ps-wallpaper-file');
                if (!fileInput) return;
                fileInput.click();
                return;
            }
            
            case 'scan-memories': {
                console.log('[PhoneSocial] scan button clicked');
                const status = document.getElementById('ps-scan-status');
                if (status) status.textContent = '🔄 Scanning...';
                extractMainChatMemories().then(count => {
                    if (status) {
                        if (count > 0) status.textContent = `✅ Scan complete (+${count} items)!`;
                        else status.textContent = '✅ No new NPCs or memories found.';
                        setTimeout(() => { if (status) status.textContent = ''; }, 4000);
                    }
                    // Also scan SMS threads (forced)
                    let smsTotal = 0;
                    const promises = state.contacts.map(c => {
                        if (c.id) return extractContactMemories(c.id, true).then(n => { if (n > 0) smsTotal += n; }).catch(() => {});
                        return Promise.resolve();
                    });
                    Promise.all(promises).then(() => {
                        if (smsTotal > 0) console.log(`[PhoneSocial] +${smsTotal} SMS memories`);
                        // Purge stale contacts (scan can create NPCs that don't exist in chat)
                        purgeStaleContacts();
                        saveMeta();
                        render();
                    });
                }).catch(e => {
                    console.warn('[PhoneSocial] scan failed:', e);
                    if (status) { status.textContent = '❌ Scan failed (check console)'; }
                });
                return;
            }
            case 'edit-memory': {
                const cid = el.getAttribute('data-cid');
                const ts = el.getAttribute('data-ts');
                const contact = state.contacts.find(c => c.id === cid);
                if (!contact || !Array.isArray(contact.memories)) return;
                const mem = contact.memories.find(m => m.ts === Number(ts));
                if (!mem) return;
                const newText = prompt('Edit memory:', mem.text);
                if (newText && newText.trim()) {
                    mem.text = newText.trim().slice(0, 320);
                    saveMeta();
                    render();
                }
                return;
            }
            case 'delete-memory': {
                const cid = el.getAttribute('data-cid');
                const ts = el.getAttribute('data-ts');
                const contact = state.contacts.find(c => c.id === cid);
                if (!contact || !Array.isArray(contact.memories)) return;
                contact.memories = contact.memories.filter(m => m.ts !== Number(ts));
                saveMeta();
                render();
                return;
            }
            case 'save-settings': {
                const url = document.getElementById('ps-set-url')?.value.trim();
                const key = document.getElementById('ps-set-key')?.value.trim();
                const model = document.getElementById('ps-set-model')?.value.trim();
                const prompt = document.getElementById('ps-set-prompt')?.value.trim();
                window.PhoneSocialSettings = { apiUrl: url, apiKey: key, model, systemPromptTemplate: prompt };
                // Save TTS fields to state.settings
                const ttsProv = document.getElementById('ps-tts-provider')?.value || '';
                const ttsKey = document.getElementById('ps-tts-apikey')?.value.trim();
                state.settings.ttsProvider = ttsProv;
                state.settings.ttsApiKey = ttsKey;
                saveMeta();
                // Persist PhoneSocialSettings
                const ctx = getCtx();
                if (ctx?.extensionSettings) {
                    ctx.extensionSettings[EXT_NAME] = window.PhoneSocialSettings;
                    try { ctx.saveSettingsDebounced?.(); } catch (_) { /* ignore */ }
                }
                if (window.extension_settings) {
                    window.extension_settings.PhoneSocial = window.PhoneSocialSettings;
                }
                const meta = getChatMeta();
                if (meta) {
                    meta.apiSettings = window.PhoneSocialSettings;
                    try { ctx?.saveMetadataDebounced?.(); } catch (_) { /* ignore */ }
                }
                const status = document.getElementById('ps-settings-status');
                if (status) status.textContent = '✅ Saved!';
                return;
            }
            case 'fetch-tts-voices': {
                const apiKey = state.settings.ttsApiKey || document.getElementById('ps-tts-apikey')?.value.trim();
                if (!apiKey) {
                    if (typeof toastr !== 'undefined') toastr.warning('Enter an API key first.', 'TTS');
                    return;
                }
                const countEl = document.getElementById('ps-tts-voice-count');
                if (countEl) countEl.textContent = 'Fetching…';
                fetch('https://api.elevenlabs.io/v1/voices', {
                    headers: { 'xi-api-key': apiKey },
                }).then(r => r.json()).then(data => {
                    if (data.voices && Array.isArray(data.voices)) {
                        state.ttsVoices = data.voices.map(v => ({ voice_id: v.voice_id, name: v.name }));
                        state.ttsVoicesFetched = Date.now();
                        saveMeta();
                        if (countEl) countEl.textContent = state.ttsVoices.length + ' voices cached';
                        if (typeof toastr !== 'undefined') toastr.success('Fetched ' + state.ttsVoices.length + ' voices', 'TTS');
                        render();
                    } else {
                        throw new Error('Unexpected response');
                    }
                }).catch(e => {
                    console.warn('[PhoneSocial] fetch voices failed:', e);
                    if (countEl) countEl.textContent = 'Error';
                    if (typeof toastr !== 'undefined') toastr.error('Failed to fetch voices. Check API key.', 'TTS');
                });
                return;
            }
            // ─── Browser actions ────────────────────────────────────
            case 'browser-go': {
                const input = document.getElementById('ps-browser-input');
                const query = (input?.value || '').trim();
                if (!query) return;
                generateBrowserPage(query);
                return;
            }
            case 'browser-back': {
                if (state.browserIndex > 0) {
                    state.browserIndex--;
                    state.browserUrl = state.browserHistory[state.browserIndex]?.url || '';
                    saveMeta();
                    render();
                }
                return;
            }
            case 'browser-forward': {
                if (state.browserIndex < state.browserHistory.length - 1) {
                    state.browserIndex++;
                    state.browserUrl = state.browserHistory[state.browserIndex]?.url || '';
                    saveMeta();
                    render();
                }
                return;
            }
            case 'browser-refresh': {
                const currentPage = (state.browserIndex >= 0 && state.browserIndex < state.browserHistory.length)
                    ? state.browserHistory[state.browserIndex] : null;
                if (currentPage) {
                    generateBrowserPage(currentPage.url);
                }
                return;
            }
            case 'browser-link': {
                const url = el.getAttribute('data-nav-url');
                if (url) {
                    generateBrowserPage(url);
                }
                return;
            }
            // ─── Chirp actions ───────────────────────────────────────
            case 'chirp-refresh':
                generateChirpFeed();
                return;
            case 'chirp-compose': {
                const chirpText = prompt('What\'s on your mind?');
                if (!chirpText || !chirpText.trim()) return;
                const ctx = getCtx();
                const myName = ctx?.name1 || ctx?.chatMetadata?.user_name || 'You';
                const handle = myName.toLowerCase().replace(/[^a-z0-9_]/g, '');
                const postId = 'chirp_' + Date.now();
                state.chirpPosts.unshift({
                    id: postId,
                    author: { name: myName, handle, isContact: false, isUser: true },
                    text: chirpText.trim(),
                    ts: Date.now(),
                    likes: 0,
                    likedBy: [],
                    comments: [],
                });
                saveMeta();
                render();
                // Auto-generate replies
                generateChirpAutoReplies(postId);
                return;
            }
            case 'chirp-like': {
                const likeId = el.getAttribute('data-chirp-id');
                const post = state.chirpPosts.find(p => p.id === likeId);
                if (!post) return;
                if (!Array.isArray(post.likedBy)) post.likedBy = [];
                const myHandle = (getCtx()?.name2 || 'me').toLowerCase().replace(/[^a-z0-9_]/g, '');
                const idx = post.likedBy.indexOf(myHandle);
                if (idx >= 0) {
                    post.likedBy.splice(idx, 1);
                } else {
                    post.likedBy.push(myHandle);
                }
                post.likes = post.likedBy.length;
                saveMeta();
                render();
                return;
            }
            case 'chirp-view-thread': {
                const threadId = el.getAttribute('data-chirp-id');
                if (!threadId) return;
                state.activeContact = threadId; // reuse activeContact for post ID
                navigateTo('chirp-thread');
                saveMeta();
                render();
                return;
            }
            case 'chirp-comment-submit': {
                const commentId = el.getAttribute('data-chirp-id');
                const input = document.getElementById('ps-chirp-comment-input');
                const replyText = (input?.value || '').trim();
                if (!commentId || !replyText) return;
                if (input) input.value = '';
                generateChirpComment(commentId, replyText);
                return;
            }
            case 'chirp-delete': {
                const delId = el.getAttribute('data-chirp-id');
                if (!delId) return;
                state.chirpPosts = state.chirpPosts.filter(p => p.id !== delId);
                saveMeta();
                if (state.view === 'chirp-thread' && state.activeContact === delId) {
                    state.view = 'chirp';
                }
                render();
                return;
            }
        }
    }


    // ─── TTS via ST's built-in TTS system ───────────────────────────
