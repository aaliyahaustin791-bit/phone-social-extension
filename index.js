     1|     1|// PhoneSocial SillyTavern Extension v0.1
     2|     2|// Standalone, per-chat isolation, no bleed. Inspired by UIE phone.js.
     3|     3|// Drop folder into ~/SillyTavern/public/extensions/phone-social-extension/
     4|     4|// Reload ST (Ctrl+R), check console "[PhoneSocial] Loaded".
     5|     5|// Test: Chat with NPC msgs → Phone button → contacts from NPCs, dial/call/SMS (auto-reply sim).
     6|     6|
     7|     7|(function() {
     8|     8|    'use strict';
    console.error('[PhoneSocial] 🎉 SCRIPT LOADED - IIFE executing now!');
     9|     9|
    10|    10|    const EXT_NAME = 'PhoneSocial';
    11|    11|
    12|    12|    function safeGetContext() {
    13|    13|        return (typeof window !== 'undefined' && window.SillyTavern?.getContext?.()) || {};
    14|    14|    }
    15|    15|
    16|    16|    let ctx = safeGetContext();
    17|    17|    let unsubscribeChatChanged = null;
    18|    18|
    19|    19|    // Per-chat globals - cleared/loaded on chat switch
    20|    20|    let phoneData = {
    21|    21|        contacts: [],
    22|    22|        smsThreads: [],
    23|    23|        databank: [],
    24|    24|        socialPosts: []
    25|    25|    };
    26|    26|    let activeContact = null;
    27|    27|    let npcs = [];
    28|    28|    let simInterval = null;
    29|    29|
    30|    30|    function parseNPCs() {
    31|    31|        ctx = safeGetContext();
    32|    32|        npcs = [];
    33|    33|        if (ctx.chat?.mes) {
    34|    34|            const names = new Set();
    35|    35|            for (let msg of ctx.chat.mes) {
    36|    36|                if (msg.name && msg.name !== (ctx.character?.name || 'You')) {
    37|    37|                    names.add(msg.name);
    38|    38|                }
    39|    39|            }
    40|    40|            npcs = Array.from(names).sort();
    41|    41|        }
    42|    42|        // Generate fake numbers
    43|    43|        phoneData.contacts = npcs.map(name => ({
    44|    44|            name,
    45|    45|            number: '+1' + (1000000000 + Math.floor(Math.random() * 9000000000)).toString()
    46|    46|        }));
    47|    47|        console.log('[PhoneSocial] Parsed NPCs/contacts:', phoneData.contacts.length);
    48|    48|    }
    49|    49|
    50|    50|    function clearState() {
    51|    51|        phoneData = { contacts: [], smsThreads: [], databank: [], socialPosts: [] };
    52|    52|        activeContact = null;
    53|    53|        npcs = [];
    54|    54|        if (simInterval) {
    55|    55|            clearInterval(simInterval);
    56|    56|            simInterval = null;
    57|    57|        }
    58|    58|        updatePanels();
    59|    59|        console.log('[PhoneSocial] Cleared state');
    60|    60|    }
    61|    61|
    62|    62|    function loadData(chatData) {
    63|    63|        if (chatData) {
    64|    64|            phoneData = { ...phoneData, ...chatData };
    65|    65|        }
    66|    66|        parseNPCs();
    67|    67|        startNPCSim();
    68|    68|        updatePanels();
    69|    69|        console.log('[PhoneSocial] Loaded data, contacts:', phoneData.contacts.length);
    70|    70|    }
    71|    71|
    72|    72|    function saveData() {
    73|    73|        ctx = safeGetContext();
    74|    74|        if (ctx.chatMetadata) {
    75|    75|            const chatId = ctx.chat?.uuid || 'default';
    76|    76|            if (!ctx.chatMetadata[EXT_NAME]) ctx.chatMetadata[EXT_NAME] = {};
    77|    77|            ctx.chatMetadata[EXT_NAME][chatId] = phoneData;
    78|    78|            if (window.saveMetadataDebounced) {
    79|    79|                window.saveMetadataDebounced();
    80|    80|            } else if (window.saveChatDebounced) {
    81|    81|                window.saveChatDebounced();
    82|    82|            }
    83|    83|            console.log('[PhoneSocial] Saved data for chatId:', chatId);
    84|    84|        }
    85|    85|    }
    86|    86|
    87|    87|    function updatePanels() {
    88|    88|        const panel = document.getElementById('ps-panel');
    89|    89|        if (!panel) return;
    90|    90|
    91|    91|        // Contacts
    92|    92|        const contactsEl = document.getElementById('ps-contacts');
    93|    93|        if (contactsEl) {
    94|    94|            contactsEl.innerHTML = phoneData.contacts.map(c => 
    95|    95|                `<div class="ps-contact" onclick="window.PhoneSocial.setActiveContact('${c.number}')">${c.name}<br><small>${c.number}</small></div>`
    96|    96|            ).join('');
    97|    97|        }
    98|    98|
    99|    99|        // Active call
   100|   100|        const activeEl = document.getElementById('ps-active');
   101|   101|        if (activeEl) {
   102|   102|            activeEl.innerHTML = activeContact ? 
   103|   103|                `<div>Calling ${activeContact.name} (${activeContact.number})<br><button onclick="window.PhoneSocial.endCall()">End</button></div>` : 
   104|   104|                '<div>No active call</div>';
   105|   105|        }
   106|   106|
   107|   107|        // SMS threads (last 20, newest first)
   108|   108|        const smsEl = document.getElementById('ps-sms');
   109|   109|        if (smsEl) {
   110|   110|            const recent = phoneData.smsThreads.slice(-20).reverse();
   111|   111|            smsEl.innerHTML = recent.map(msg => 
   112|   112|                `<div class="${msg.from === 'me' ? 'sent' : 'received'}">
   113|   113|                    ${msg.from}: ${msg.text}
   114|   114|                    <small>${new Date(msg.time).toLocaleTimeString()}</small>
   115|   115|                </div>`
   116|   116|            ).join('');
   117|   117|            smsEl.scrollTop = smsEl.scrollHeight;
   118|   118|        }
   119|   119|    }
   120|   120|
   121|   121|    window.PhoneSocial = {
   122|   122|        setActiveContact(number) {
   123|   123|            phoneData.contacts.forEach(c => { if (c.number === number) activeContact = c; });
   124|   124|            updatePanels();
   125|   125|        },
   126|   126|        endCall() {
   127|   127|            activeContact = null;
   128|   128|            updatePanels();
   129|   129|        }
   130|   130|    };
   131|   131|
   132|   132|    function getPanelHTML() {
   133|   133|        return `
   134|   134|<div id="ps-panel" class="ps-panel" style="display:none;">
   135|   135|    <h3>📱 Phone</h3>
   136|   136|    <div id="ps-contacts" class="ps-section">Loading contacts...</div>
   137|   137|    <input id="ps-dial" placeholder="Dial number/name" class="ps-input">
   138|   138|    <button id="ps-call" class="ps-btn">📞 Call</button>
   139|   139|    <div id="ps-active" class="ps-section"></div>
   140|   140|    <div id="ps-sms" class="ps-section" style="height:200px;overflow:auto;"></div>
   141|   141|    <input id="ps-sms-input" placeholder="Type message" class="ps-input">
   142|   142|    <button id="ps-send-sms" class="ps-btn">Send SMS</button>
   143|   143|</div>`;
   144|   144|    }
   145|   145|
   146|   146|    function addListeners() {
   147|   147|        const dialEl = document.getElementById('ps-dial');
   148|   148|        const callEl = document.getElementById('ps-call');
   149|   149|        const sendEl = document.getElementById('ps-send-sms');
   150|   150|        const smsInput = document.getElementById('ps-sms-input');
   151|   151|
   152|   152|        if (dialEl) dialEl.oninput = (e) => {
   153|   153|            // Filter contacts or dial
   154|   154|        };
   155|   155|
   156|   156|        if (callEl) callEl.onclick = () => {
   157|   157|            const dial = document.getElementById('ps-dial').value;
   158|   158|            const contact = phoneData.contacts.find(c => c.name.toLowerCase().includes(dial.toLowerCase()) || c.number.includes(dial)) || 
   159|   159|                            { name: dial, number: dial };
   160|   160|            activeContact = contact;
   161|   161|            updatePanels();
   162|   162|            saveData();
   163|   163|        };
   164|   164|
   165|   165|        if (sendEl) sendEl.onclick = () => {
   166|   166|            const text = smsInput.value.trim();
   167|   167|            if (activeContact && text) {
   168|   168|                const msg = { from: 'me', to: activeContact.number, text, time: Date.now() };
   169|   169|                phoneData.smsThreads.push(msg);
   170|   170|                smsInput.value = '';
   171|   171|                updatePanels();
   172|   172|                saveData();
   173|   173|
   174|   174|                // NPC auto-reply sim
   175|   175|                setTimeout(() => {
   176|   176|                    const reply = { from: activeContact.number, to: 'me', text: `Hey! (${Math.random() > 0.5 ? 'Busy...' : 'What's up?'})`, time: Date.now() + 1000 };
   177|   177|                    phoneData.smsThreads.push(reply);
   178|   178|                    updatePanels();
   179|   179|                    saveData();
   180|   180|                }, 1000 + Math.random() * 3000);
   181|   181|            }
   182|   182|        };
   183|   183|
   184|   184|        if (smsInput) smsInput.onkeypress = (e) => { if (e.key === 'Enter') sendEl.click(); };
   185|   185|    }
   186|   186|
   187|   187|    function startNPCSim() {
   188|   188|        if (simInterval) clearInterval(simInterval);
   189|   189|        simInterval = setInterval(() => {
   190|   190|            if (phoneData.contacts.length && Math.random() < 0.3) {
   191|   191|                const randomContact = phoneData.contacts[Math.floor(Math.random() * phoneData.contacts.length)];
   192|   192|                const msgs = [
   193|   193|                    'Hey, you there?',
   194|   194|                    'Missed call',
   195|   195|                    'Just checking in 📱',
   196|   196|                    '...'
   197|   197|                ];
   198|   198|                const msg = { from: randomContact.number, to: 'me', text: msgs[Math.floor(Math.random() * msgs.length)], time: Date.now() };
   199|   199|                phoneData.smsThreads.push(msg);
   200|   200|                updatePanels();
   201|   201|                saveData();
   202|   202|                console.log('[PhoneSocial] NPC sim SMS from', randomContact.name);
   203|   203|            }
   204|   204|        }, 10000 + Math.random() * 30000); // 10-40s
   205|   205|    }
   206|   206|
   207|   207|    function init() {
   208|   208|        console.log('[PhoneSocial] Initializing...');
   209|   209|
   210|   210|        // Add Phone button to top menu (after DOM ready)
   211|   211|        const checkMenu = () => {
   212|   212|            const menu = document.querySelector('#topmenu button[onclick*="extensions"]')?.parentElement || document.querySelector('#topmenu');
   213|   213|            if (menu && !document.getElementById('ps-toggle')) {
   214|   214|                const btn = document.createElement('button');
   215|   215|                btn.id = 'ps-toggle';
   216|   216|                btn.className = 'dark:bg-gray-800 px-2 py-1 rounded text-xs';
   217|   217|                btn.innerHTML = '📱';
   218|   218|                btn.title = 'PhoneSocial';
   219|   219|                btn.onclick = togglePanel;
   220|   220|                menu.appendChild(btn);
   221|   221|            }
   222|   222|        };
   223|   223|        if (document.readyState === 'loading') {
   224|   224|            document.addEventListener('DOMContentLoaded', checkMenu);
   225|   225|        } else {
   226|   226|            checkMenu();
   227|   227|        }
   228|   228|
   229|   229|        // Chat changed hook (ST event system)
   230|   230|        function attachChatListener() {
   231|   231|            if (window.eventSource && window.event_types?.CHAT_CHANGED) {
   232|   232|                unsubscribeChatChanged = window.eventSource.on(window.event_types.CHAT_CHANGED, (chatId) => {
   233|   233|                    ctx = safeGetContext();
   234|   234|                    const chatData = ctx.chatMetadata?.[EXT_NAME]?.[chatId];
   235|   235|                    clearState();
   236|   236|                    loadData(chatData);
   237|   237|                });
   238|   238|                console.log('[PhoneSocial] Chat listener attached');
   239|   239|            } else {
   240|   240|                setTimeout(attachChatListener, 500); // Retry
   241|   241|            }
   242|   242|        }
   243|   243|        attachChatListener();
   244|   244|
   245|   245|        console.log('[PhoneSocial] Loaded');
   246|   246|    }
   247|   247|
   248|   248|    function togglePanel() {
   249|   249|        let panel = document.getElementById('ps-panel');
   250|   250|        if (!panel) {
   251|   251|            document.body.insertAdjacentHTML('beforeend', getPanelHTML());
   252|   252|            panel = document.getElementById('ps-panel');
   253|   253|            addListeners();
   254|   254|            updatePanels();
   255|   255|        }
   256|   256|        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
   257|   257|    }
   258|   258|
   259|   259|    function unload() {
   260|   260|        if (unsubscribeChatChanged) unsubscribeChatChanged();
   261|   261|        if (simInterval) clearInterval(simInterval);
   262|   262|        const panel = document.getElementById('ps-panel');
   263|   263|        if (panel) panel.remove();
   264|   264|        const btn = document.getElementById('ps-toggle');
   265|   265|        if (btn) btn.remove();
   266|   266|        console.log('[PhoneSocial] Unloaded');
   267|   267|    }
   268|   268|
   269|   269|    // ST module export
   270|   270|    if (typeof module === 'undefined' || !module.exports) {
   271|   271|        init();
   272|   272|    } else {
   273|   273|        module.exports = { init, unload, name: EXT_NAME };
   274|   274|    }
   275|   275|})();
   276|   276|
