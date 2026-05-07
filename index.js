     1|     1|     1|// PhoneSocial SillyTavern Extension v0.1
     2|     2|     2|// Standalone, per-chat isolation, no bleed. Inspired by UIE phone.js.
     3|     3|     3|// Drop folder into ~/SillyTavern/public/extensions/phone-social-extension/
     4|     4|     4|// Reload ST (Ctrl+R), check console "[PhoneSocial] Loaded".
     5|     5|     5|// Test: Chat with NPC msgs → Phone button → contacts from NPCs, dial/call/SMS (auto-reply sim).
     6|     6|     6|
     7|     7|     7|(function() {
     8|     8|     8|    'use strict';
     9|    console.error('[PhoneSocial] 🎉 SCRIPT LOADED - IIFE executing now!');
    10|     9|     9|
    11|    10|    10|    const EXT_NAME = 'PhoneSocial';
    12|    11|    11|
    13|    12|    12|    function safeGetContext() {
    14|    13|    13|        return (typeof window !== 'undefined' && window.SillyTavern?.getContext?.()) || {};
    15|    14|    14|    }
    16|    15|    15|
    17|    16|    16|    let ctx = safeGetContext();
    18|    17|    17|    let unsubscribeChatChanged = null;
    19|    18|    18|
    20|    19|    19|    // Per-chat globals - cleared/loaded on chat switch
    21|    20|    20|    let phoneData = {
    22|    21|    21|        contacts: [],
    23|    22|    22|        smsThreads: [],
    24|    23|    23|        databank: [],
    25|    24|    24|        socialPosts: []
    26|    25|    25|    };
    27|    26|    26|    let activeContact = null;
    28|    27|    27|    let npcs = [];
    29|    28|    28|    let simInterval = null;
    30|    29|    29|
    31|    30|    30|    function parseNPCs() {
    32|    31|    31|        ctx = safeGetContext();
    33|    32|    32|        npcs = [];
    34|    33|    33|        if (ctx.chat?.mes) {
    35|    34|    34|            const names = new Set();
    36|    35|    35|            for (let msg of ctx.chat.mes) {
    37|    36|    36|                if (msg.name && msg.name !== (ctx.character?.name || 'You')) {
    38|    37|    37|                    names.add(msg.name);
    39|    38|    38|                }
    40|    39|    39|            }
    41|    40|    40|            npcs = Array.from(names).sort();
    42|    41|    41|        }
    43|    42|    42|        // Generate fake numbers
    44|    43|    43|        phoneData.contacts = npcs.map(name => ({
    45|    44|    44|            name,
    46|    45|    45|            number: '+1' + (1000000000 + Math.floor(Math.random() * 9000000000)).toString()
    47|    46|    46|        }));
    48|    47|    47|        console.log('[PhoneSocial] Parsed NPCs/contacts:', phoneData.contacts.length);
    49|    48|    48|    }
    50|    49|    49|
    51|    50|    50|    function clearState() {
    52|    51|    51|        phoneData = { contacts: [], smsThreads: [], databank: [], socialPosts: [] };
    53|    52|    52|        activeContact = null;
    54|    53|    53|        npcs = [];
    55|    54|    54|        if (simInterval) {
    56|    55|    55|            clearInterval(simInterval);
    57|    56|    56|            simInterval = null;
    58|    57|    57|        }
    59|    58|    58|        updatePanels();
    60|    59|    59|        console.log('[PhoneSocial] Cleared state');
    61|    60|    60|    }
    62|    61|    61|
    63|    62|    62|    function loadData(chatData) {
    64|    63|    63|        if (chatData) {
    65|    64|    64|            phoneData = { ...phoneData, ...chatData };
    66|    65|    65|        }
    67|    66|    66|        parseNPCs();
    68|    67|    67|        startNPCSim();
    69|    68|    68|        updatePanels();
    70|    69|    69|        console.log('[PhoneSocial] Loaded data, contacts:', phoneData.contacts.length);
    71|    70|    70|    }
    72|    71|    71|
    73|    72|    72|    function saveData() {
    74|    73|    73|        ctx = safeGetContext();
    75|    74|    74|        if (ctx.chatMetadata) {
    76|    75|    75|            const chatId = ctx.chat?.uuid || 'default';
    77|    76|    76|            if (!ctx.chatMetadata[EXT_NAME]) ctx.chatMetadata[EXT_NAME] = {};
    78|    77|    77|            ctx.chatMetadata[EXT_NAME][chatId] = phoneData;
    79|    78|    78|            if (window.saveMetadataDebounced) {
    80|    79|    79|                window.saveMetadataDebounced();
    81|    80|    80|            } else if (window.saveChatDebounced) {
    82|    81|    81|                window.saveChatDebounced();
    83|    82|    82|            }
    84|    83|    83|            console.log('[PhoneSocial] Saved data for chatId:', chatId);
    85|    84|    84|        }
    86|    85|    85|    }
    87|    86|    86|
    88|    87|    87|    function updatePanels() {
    89|    88|    88|        const panel = document.getElementById('ps-panel');
    90|    89|    89|        if (!panel) return;
    91|    90|    90|
    92|    91|    91|        // Contacts
    93|    92|    92|        const contactsEl = document.getElementById('ps-contacts');
    94|    93|    93|        if (contactsEl) {
    95|    94|    94|            contactsEl.innerHTML = phoneData.contacts.map(c => 
    96|    95|    95|                `<div class="ps-contact" onclick="window.PhoneSocial.setActiveContact('${c.number}')">${c.name}<br><small>${c.number}</small></div>`
    97|    96|    96|            ).join('');
    98|    97|    97|        }
    99|    98|    98|
   100|    99|    99|        // Active call
   101|   100|   100|        const activeEl = document.getElementById('ps-active');
   102|   101|   101|        if (activeEl) {
   103|   102|   102|            activeEl.innerHTML = activeContact ? 
   104|   103|   103|                `<div>Calling ${activeContact.name} (${activeContact.number})<br><button onclick="window.PhoneSocial.endCall()">End</button></div>` : 
   105|   104|   104|                '<div>No active call</div>';
   106|   105|   105|        }
   107|   106|   106|
   108|   107|   107|        // SMS threads (last 20, newest first)
   109|   108|   108|        const smsEl = document.getElementById('ps-sms');
   110|   109|   109|        if (smsEl) {
   111|   110|   110|            const recent = phoneData.smsThreads.slice(-20).reverse();
   112|   111|   111|            smsEl.innerHTML = recent.map(msg => 
   113|   112|   112|                `<div class="${msg.from === 'me' ? 'sent' : 'received'}">
   114|   113|   113|                    ${msg.from}: ${msg.text}
   115|   114|   114|                    <small>${new Date(msg.time).toLocaleTimeString()}</small>
   116|   115|   115|                </div>`
   117|   116|   116|            ).join('');
   118|   117|   117|            smsEl.scrollTop = smsEl.scrollHeight;
   119|   118|   118|        }
   120|   119|   119|    }
   121|   120|   120|
   122|   121|   121|    window.PhoneSocial = {
   123|   122|   122|        setActiveContact(number) {
   124|   123|   123|            phoneData.contacts.forEach(c => { if (c.number === number) activeContact = c; });
   125|   124|   124|            updatePanels();
   126|   125|   125|        },
   127|   126|   126|        endCall() {
   128|   127|   127|            activeContact = null;
   129|   128|   128|            updatePanels();
   130|   129|   129|        }
   131|   130|   130|    };
   132|   131|   131|
   133|   132|   132|    function getPanelHTML() {
   134|   133|   133|        return `
   135|   134|   134|<div id="ps-panel" class="ps-panel" style="display:none;">
   136|   135|   135|    <h3>📱 Phone</h3>
   137|   136|   136|    <div id="ps-contacts" class="ps-section">Loading contacts...</div>
   138|   137|   137|    <input id="ps-dial" placeholder="Dial number/name" class="ps-input">
   139|   138|   138|    <button id="ps-call" class="ps-btn">📞 Call</button>
   140|   139|   139|    <div id="ps-active" class="ps-section"></div>
   141|   140|   140|    <div id="ps-sms" class="ps-section" style="height:200px;overflow:auto;"></div>
   142|   141|   141|    <input id="ps-sms-input" placeholder="Type message" class="ps-input">
   143|   142|   142|    <button id="ps-send-sms" class="ps-btn">Send SMS</button>
   144|   143|   143|</div>`;
   145|   144|   144|    }
   146|   145|   145|
   147|   146|   146|    function addListeners() {
   148|   147|   147|        const dialEl = document.getElementById('ps-dial');
   149|   148|   148|        const callEl = document.getElementById('ps-call');
   150|   149|   149|        const sendEl = document.getElementById('ps-send-sms');
   151|   150|   150|        const smsInput = document.getElementById('ps-sms-input');
   152|   151|   151|
   153|   152|   152|        if (dialEl) dialEl.oninput = (e) => {
   154|   153|   153|            // Filter contacts or dial
   155|   154|   154|        };
   156|   155|   155|
   157|   156|   156|        if (callEl) callEl.onclick = () => {
   158|   157|   157|            const dial = document.getElementById('ps-dial').value;
   159|   158|   158|            const contact = phoneData.contacts.find(c => c.name.toLowerCase().includes(dial.toLowerCase()) || c.number.includes(dial)) || 
   160|   159|   159|                            { name: dial, number: dial };
   161|   160|   160|            activeContact = contact;
   162|   161|   161|            updatePanels();
   163|   162|   162|            saveData();
   164|   163|   163|        };
   165|   164|   164|
   166|   165|   165|        if (sendEl) sendEl.onclick = () => {
   167|   166|   166|            const text = smsInput.value.trim();
   168|   167|   167|            if (activeContact && text) {
   169|   168|   168|                const msg = { from: 'me', to: activeContact.number, text, time: Date.now() };
   170|   169|   169|                phoneData.smsThreads.push(msg);
   171|   170|   170|                smsInput.value = '';
   172|   171|   171|                updatePanels();
   173|   172|   172|                saveData();
   174|   173|   173|
   175|   174|   174|                // NPC auto-reply sim
   176|   175|   175|                setTimeout(() => {
   177|   176|   176|                    const reply = { from: activeContact.number, to: 'me', text: `Hey! (${Math.random() > 0.5 ? 'Busy...' : 'What's up?'})`, time: Date.now() + 1000 };
   178|   177|   177|                    phoneData.smsThreads.push(reply);
   179|   178|   178|                    updatePanels();
   180|   179|   179|                    saveData();
   181|   180|   180|                }, 1000 + Math.random() * 3000);
   182|   181|   181|            }
   183|   182|   182|        };
   184|   183|   183|
   185|   184|   184|        if (smsInput) smsInput.onkeypress = (e) => { if (e.key === 'Enter') sendEl.click(); };
   186|   185|   185|    }
   187|   186|   186|
   188|   187|   187|    function startNPCSim() {
   189|   188|   188|        if (simInterval) clearInterval(simInterval);
   190|   189|   189|        simInterval = setInterval(() => {
   191|   190|   190|            if (phoneData.contacts.length && Math.random() < 0.3) {
   192|   191|   191|                const randomContact = phoneData.contacts[Math.floor(Math.random() * phoneData.contacts.length)];
   193|   192|   192|                const msgs = [
   194|   193|   193|                    'Hey, you there?',
   195|   194|   194|                    'Missed call',
   196|   195|   195|                    'Just checking in 📱',
   197|   196|   196|                    '...'
   198|   197|   197|                ];
   199|   198|   198|                const msg = { from: randomContact.number, to: 'me', text: msgs[Math.floor(Math.random() * msgs.length)], time: Date.now() };
   200|   199|   199|                phoneData.smsThreads.push(msg);
   201|   200|   200|                updatePanels();
   202|   201|   201|                saveData();
   203|   202|   202|                console.log('[PhoneSocial] NPC sim SMS from', randomContact.name);
   204|   203|   203|            }
   205|   204|   204|        }, 10000 + Math.random() * 30000); // 10-40s
   206|   205|   205|    }
   207|   206|   206|
   208|   207|   207|    function init() {
   209|   208|   208|        console.log('[PhoneSocial] Initializing...');
   210|   209|   209|
   211|   210|   210|        // Add Phone button to top menu (after DOM ready)
   212|   211|   211|        const checkMenu = () => {
   213|   212|   212|            const menu = document.querySelector('#topmenu button[onclick*="extensions"]')?.parentElement || document.querySelector('#topmenu');
   214|   213|   213|            if (menu && !document.getElementById('ps-toggle')) {
   215|   214|   214|                const btn = document.createElement('button');
   216|   215|   215|                btn.id = 'ps-toggle';
   217|   216|   216|                btn.className = 'dark:bg-gray-800 px-2 py-1 rounded text-xs';
   218|   217|   217|                btn.innerHTML = '📱';
   219|   218|   218|                btn.title = 'PhoneSocial';
   220|   219|   219|                btn.onclick = togglePanel;
   221|   220|   220|                menu.appendChild(btn);
   222|   221|   221|            }
   223|   222|   222|        };
   224|   223|   223|        if (document.readyState === 'loading') {
   225|   224|   224|            document.addEventListener('DOMContentLoaded', checkMenu);
   226|   225|   225|        } else {
   227|   226|   226|            checkMenu();
   228|   227|   227|        }
   229|   228|   228|
   230|   229|   229|        // Chat changed hook (ST event system)
   231|   230|   230|        function attachChatListener() {
   232|   231|   231|            if (window.eventSource && window.event_types?.CHAT_CHANGED) {
   233|   232|   232|                unsubscribeChatChanged = window.eventSource.on(window.event_types.CHAT_CHANGED, (chatId) => {
   234|   233|   233|                    ctx = safeGetContext();
   235|   234|   234|                    const chatData = ctx.chatMetadata?.[EXT_NAME]?.[chatId];
   236|   235|   235|                    clearState();
   237|   236|   236|                    loadData(chatData);
   238|   237|   237|                });
   239|   238|   238|                console.log('[PhoneSocial] Chat listener attached');
   240|   239|   239|            } else {
   241|   240|   240|                setTimeout(attachChatListener, 500); // Retry
   242|   241|   241|            }
   243|   242|   242|        }
   244|   243|   243|        attachChatListener();
   245|   244|   244|
   246|   245|   245|        console.log('[PhoneSocial] Loaded');
   247|   246|   246|    }
   248|   247|   247|
   249|   248|   248|    function togglePanel() {
   250|   249|   249|        let panel = document.getElementById('ps-panel');
   251|   250|   250|        if (!panel) {
   252|   251|   251|            document.body.insertAdjacentHTML('beforeend', getPanelHTML());
   253|   252|   252|            panel = document.getElementById('ps-panel');
   254|   253|   253|            addListeners();
   255|   254|   254|            updatePanels();
   256|   255|   255|        }
   257|   256|   256|        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
   258|   257|   257|    }
   259|   258|   258|
   260|   259|   259|    function unload() {
   261|   260|   260|        if (unsubscribeChatChanged) unsubscribeChatChanged();
   262|   261|   261|        if (simInterval) clearInterval(simInterval);
   263|   262|   262|        const panel = document.getElementById('ps-panel');
   264|   263|   263|        if (panel) panel.remove();
   265|   264|   264|        const btn = document.getElementById('ps-toggle');
   266|   265|   265|        if (btn) btn.remove();
   267|   266|   266|        console.log('[PhoneSocial] Unloaded');
   268|   267|   267|    }
   269|   268|   268|
   270|   269|   269|    // ST module export
   271|   270|   270|    if (typeof module === 'undefined' || !module.exports) {
   272|   271|   271|        init();
   273|   272|   272|    } else {
   274|   273|   273|        module.exports = { init, unload, name: EXT_NAME };
   275|   274|   274|    }
   276|   275|   275|})();
   277|   276|   276|
   278|