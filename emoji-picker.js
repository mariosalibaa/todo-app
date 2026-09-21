// Emoji picker (WhatsApp Web style), Mario 2026-09-21: a panel above the composer with a search box,
// a Recent row (localStorage, per browser) and the eight WhatsApp categories. Inserts at the caret
// of the given textarea and fires `input` so the send/mic toggle follows.
// Usage: EmojiPicker.toggle(anchorButton, textarea) — the panel closes on Escape or an outside click.
// Theme: the host sets --ep-bg / --ep-line / --ep-hover / --ep-dim / --ep-text on :root (light WhatsApp by default).
// Same file serves the hub (/site) and the WhatsApp archive viewers (03 + 70) — keep the two copies identical.
(function () {
  const CATS = [
    ['😀', 'Smileys & People', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 🤥 🫨 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊 💌 💘 💝 💖 💗 💓 💞 💕 💟 ❣️ 💔 ❤️‍🔥 ❤️‍🩹 ❤️ 🩷 🧡 💛 💚 💙 🩵 💜 🤎 🖤 🩶 🤍 💋 💯 💢 💥 💫 💦 💨 🕳️ 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤 👋 🤚 🖐️ ✋ 🖖 🫱 🫲 🫳 🫴 🫷 🫸 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 🫵 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 🥷 👷 🫅 🤴 👸 👳 👲 🧕 🤵 👰 🤰 🫃 🫄 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 🧌 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 🕴️ 👯 🧖 🧗 🤺 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 ⛹️ 🏋️ 🚴 🚵 🤸 🤼 🤽 🤾 🤹 🧘 🛀 🛌 👭 👫 👬 💏 💑 👪 🗣️ 👤 👥 🫂 👣'],
    ['🐻', 'Animals & Nature', '🐵 🐒 🦍 🦧 🐶 🐕 🦮 🐕‍🦺 🐩 🐺 🦊 🦝 🐱 🐈 🐈‍⬛ 🦁 🐯 🐅 🐆 🐴 🫎 🫏 🐎 🦄 🦓 🦌 🦬 🐮 🐂 🐃 🐄 🐷 🐖 🐗 🐽 🐏 🐑 🐐 🐪 🐫 🦙 🦒 🐘 🦣 🦏 🦛 🐭 🐁 🐀 🐹 🐰 🐇 🐿️ 🦫 🦔 🦇 🐻 🐻‍❄️ 🐨 🐼 🦥 🦦 🦨 🦘 🦡 🐾 🦃 🐔 🐓 🐣 🐤 🐥 🐦 🐧 🕊️ 🦅 🦆 🦢 🦉 🦤 🪶 🦩 🦚 🦜 🪽 🐦‍⬛ 🪿 🐸 🐊 🐢 🦎 🐍 🐲 🐉 🦕 🦖 🐳 🐋 🐬 🦭 🐟 🐠 🐡 🦈 🐙 🐚 🪸 🪼 🐌 🦋 🐛 🐜 🐝 🪲 🐞 🦗 🪳 🕷️ 🕸️ 🦂 🦟 🪰 🪱 🦠 💐 🌸 💮 🪷 🏵️ 🌹 🥀 🌺 🌻 🌼 🌷 🪻 🌱 🪴 🌲 🌳 🌴 🌵 🌾 🌿 ☘️ 🍀 🍁 🍂 🍃 🪹 🪺 🍄 🌍 🌎 🌏 🌐 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌙 🌚 🌛 🌜 ☀️ 🌝 🌞 ⭐ 🌟 🌠 🌌 ☁️ ⛅ ⛈️ 🌤️ 🌥️ 🌦️ 🌧️ 🌨️ 🌩️ 🌪️ 🌫️ 🌬️ 🌀 🌈 🌂 ☂️ ☔ ⛱️ ⚡ ❄️ ☃️ ⛄ ☄️ 🔥 💧 🌊'],
    ['🍔', 'Food & Drink', '🍇 🍈 🍉 🍊 🍋 🍌 🍍 🥭 🍎 🍏 🍐 🍑 🍒 🍓 🫐 🥝 🍅 🫒 🥥 🥑 🍆 🥔 🥕 🌽 🌶️ 🫑 🥒 🥬 🥦 🧄 🧅 🍄 🥜 🫘 🌰 🫚 🫛 🍞 🥐 🥖 🫓 🥨 🥯 🥞 🧇 🧀 🍖 🍗 🥩 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🫔 🥙 🧆 🥚 🍳 🥘 🍲 🫕 🥣 🥗 🍿 🧈 🧂 🥫 🍱 🍘 🍙 🍚 🍛 🍜 🍝 🍠 🍢 🍣 🍤 🍥 🥮 🍡 🥟 🥠 🥡 🦀 🦞 🦐 🦑 🦪 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 🍭 🍮 🍯 🍼 🥛 ☕ 🫖 🍵 🍶 🍾 🍷 🍸 🍹 🍺 🍻 🥂 🥃 🫗 🥤 🧋 🧃 🧉 🧊 🥢 🍽️ 🍴 🥄 🔪 🫙 🏺'],
    ['⚽', 'Activities', '🎃 🎄 🎆 🎇 🧨 ✨ 🎈 🎉 🎊 🎋 🎍 🎎 🎏 🎐 🎑 🧧 🎀 🎁 🎗️ 🎟️ 🎫 🎖️ 🏆 🏅 🥇 🥈 🥉 ⚽ ⚾ 🥎 🏀 🏐 🏈 🏉 🎾 🥏 🎳 🏏 🏑 🏒 🥍 🏓 🏸 🥊 🥋 🥅 ⛳ ⛸️ 🎣 🤿 🎽 🎿 🛷 🥌 🎯 🪀 🪁 🔫 🎱 🔮 🪄 🎮 🕹️ 🎰 🎲 🧩 🧸 🪅 🪩 🪆 ♠️ ♥️ ♦️ ♣️ ♟️ 🃏 🀄 🎴 🎭 🖼️ 🎨 🧵 🪡 🧶 🪢'],
    ['🚗', 'Travel & Places', '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🛹 🛼 🦽 🦼 🛺 🚔 🚍 🚘 🚖 🛞 🚁 🛩️ ✈️ 🛫 🛬 🪂 💺 🚀 🛸 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🛟 🚧 ⛽ 🚏 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 ⛩️ 🛤️ 🛣️ 🗾 🏞️ 🌅 🌄 🌇 🌆 🏙️ 🌃 🌉 🌁 🚂 🚃 🚄 🚅 🚆 🚇 🚈 🚉 🚊 🚝 🚞 🚋 🚟 🚠 🚡 🛰️ ⌛ ⏳ ⌚ ⏰ ⏱️ ⏲️ 🕰️'],
    ['💡', 'Objects', '🔇 🔈 🔉 🔊 📢 📣 📯 🔔 🔕 🎼 🎵 🎶 🎙️ 🎚️ 🎛️ 🎤 🎧 📻 🎷 🪗 🎸 🎹 🎺 🎻 🪕 🥁 🪘 🪇 🪈 📱 📲 ☎️ 📞 📟 📠 🔋 🪫 🔌 💻 🖥️ 🖨️ ⌨️ 🖱️ 🖲️ 💽 💾 💿 📀 🧮 🎥 🎞️ 📽️ 🎬 📺 📷 📸 📹 📼 🔍 🔎 🕯️ 💡 🔦 🏮 🪔 📔 📕 📖 📗 📘 📙 📚 📓 📒 📃 📜 📄 📰 🗞️ 📑 🔖 🏷️ 💰 🪙 💴 💵 💶 💷 💸 💳 🧾 💹 ✉️ 📧 📨 📩 📤 📥 📦 📫 📪 📬 📭 📮 🗳️ ✏️ ✒️ 🖋️ 🖊️ 🖌️ 🖍️ 📝 💼 📁 📂 🗂️ 📅 📆 🗒️ 🗓️ 📇 📈 📉 📊 📋 📌 📍 📎 🖇️ 📏 📐 ✂️ 🗃️ 🗄️ 🗑️ 🔒 🔓 🔏 🔐 🔑 🗝️ 🔨 🪓 ⛏️ ⚒️ 🛠️ 🗡️ ⚔️ 💣 🪃 🏹 🛡️ 🪚 🔧 🪛 🔩 ⚙️ 🗜️ ⚖️ 🦯 🔗 ⛓️ 🪝 🧰 🧲 🪜 ⚗️ 🧪 🧫 🧬 🔬 🔭 📡 💉 🩸 💊 🩹 🩼 🩺 🩻 🚪 🛗 🪞 🪟 🛏️ 🛋️ 🪑 🚽 🪠 🚿 🛁 🪤 🪒 🧴 🧷 🧹 🧺 🧻 🪣 🧼 🫧 🪥 🧽 🧯 🛒 🚬 ⚰️ 🪦 ⚱️ 🧿 🪬 🪧 🪪 👓 🕶️ 🥽 🥼 🦺 👔 👕 👖 🧣 🧤 🧥 🧦 👗 👘 🥻 🩱 🩲 🩳 👙 👚 🪭 👛 👜 👝 🛍️ 🎒 🩴 👞 👟 🥾 🥿 👠 👡 🩰 👢 🪮 👑 👒 🎩 🎓 🧢 🪖 ⛑️ 📿 💄 💍 💎'],
    ['🔣', 'Symbols', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 🏧 🚾 ♿ 🅿️ 🛗 🈳 🈂️ 🛂 🛃 🛄 🛅 🚹 🚺 🚼 ⚧️ 🚻 🚮 🎦 📶 🈁 🔣 ℹ️ 🔤 🔡 🔠 🆖 🆗 🆙 🆒 🆕 🆓 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔢 #️⃣ *️⃣ ⏏️ ▶️ ⏸️ ⏯️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ◀️ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↪️ ↩️ ⤴️ ⤵️ 🔀 🔁 🔂 🔄 🔃 🎵 🎶 ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 🔚 🔙 🔛 🔝 🔜 〰️ ➰ ➿ ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🕐 🕑 🕒 🕓 🕔 🕕 🕖 🕗 🕘 🕙 🕚 🕛'],
    ['🏳️', 'Flags', '🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈 🏴‍☠️ 🇱🇧 🇺🇸 🇨🇦 🇫🇷 🇦🇪 🇸🇦 🇶🇦 🇰🇼 🇲🇩 🇩🇪 🇬🇧 🇮🇹 🇪🇸 🇨🇭 🇦🇺 🇧🇷 🇨🇳 🇯🇵 🇰🇷 🇮🇳 🇹🇷 🇪🇬 🇯🇴 🇸🇾 🇮🇶 🇴🇲 🇧🇭 🇨🇾 🇬🇷 🇳🇱 🇧🇪 🇸🇪 🇳🇴 🇩🇰 🇵🇱 🇷🇴 🇺🇦 🇷🇺 🇲🇽 🇦🇷 🇳🇬 🇿🇦 🇬🇭 🇰🇪 🇪🇺 🇺🇳'],
  ].map(([icon, name, list]) => ({ icon, name, list: list.split(' ') }));
  const KEY = 'hub.emoji.recent', MAX_RECENT = 24;
  let panel = null, target = null, anchor = null;

  const recent = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
  const remember = e => { try { localStorage.setItem(KEY, JSON.stringify([e, ...recent().filter(x => x !== e)].slice(0, MAX_RECENT))); } catch { } };

  function css() {
    if (document.getElementById('emoji-picker-css')) return;
    const s = document.createElement('style'); s.id = 'emoji-picker-css';
    s.textContent = `
      .emoji-panel{position:fixed;z-index:940;width:min(420px,calc(100vw - 16px));height:min(380px,60vh);background:var(--ep-bg,#fff);border:1px solid var(--ep-line,#e9edef);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font:inherit;}
      .emoji-panel .tabs{display:flex;justify-content:space-around;border-bottom:1px solid var(--ep-line,#e9edef);}
      .emoji-panel .tabs button{background:transparent;border:0;border-bottom:3px solid transparent;font-size:1.15rem;padding:8px 6px 6px;cursor:pointer;opacity:.6;filter:grayscale(1);width:auto;height:auto;border-radius:0;}
      .emoji-panel .tabs button.on{opacity:1;filter:none;border-bottom-color:#00a884;}
      .emoji-panel .search{margin:8px 12px 4px;display:flex;align-items:center;gap:8px;background:var(--ep-hover,#f0f2f5);border-radius:18px;padding:6px 12px;}
      .emoji-panel .search input{flex:1;border:0;background:transparent;font:inherit;color:var(--ep-text,#111);outline:0;min-width:0;}
      .emoji-panel .body{flex:1;overflow-y:auto;padding:0 8px 8px;}
      .emoji-panel h6{margin:10px 6px 4px;font-size:.78rem;font-weight:600;color:var(--ep-dim,#667781);}
      .emoji-panel .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(36px,1fr));}
      .emoji-panel .grid button{background:transparent;border:0;font-size:1.5rem;line-height:1;padding:5px 0;border-radius:8px;cursor:pointer;width:auto;height:auto;}
      .emoji-panel .grid button:hover{background:var(--ep-hover,#f0f2f5);}
      .emoji-panel .none{color:var(--ep-dim,#667781);font-size:.85rem;padding:20px;text-align:center;}`;
    document.head.appendChild(s);
  }

  function build() {
    css();
    panel = document.createElement('div'); panel.className = 'emoji-panel';
    panel.innerHTML = `<div class="tabs"><button data-cat="-1" title="Recent">🕒</button>${CATS.map((c, i) => `<button data-cat="${i}" title="${c.name}">${c.icon}</button>`).join('')}</div>
      <div class="search">🔍<input placeholder="Search emoji" autocomplete="off"></div><div class="body"></div>`;
    panel.querySelector('.tabs').onclick = e => { const b = e.target.closest('button'); if (!b) return; panel.querySelector('input').value = ''; render(+b.dataset.cat); };
    panel.querySelector('input').oninput = e => render(-1, e.target.value.trim());
    panel.querySelector('.body').onclick = e => { const b = e.target.closest('button'); if (b) insert(b.textContent); };
    // keep the textarea's caret: a mousedown inside the panel must not steal focus
    panel.addEventListener('mousedown', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    document.body.appendChild(panel);
  }

  function render(cat, q) {
    const body = panel.querySelector('.body');
    panel.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', +b.dataset.cat === cat && !q));
    const grid = list => `<div class="grid">${list.map(e => `<button>${e}</button>`).join('')}</div>`;
    if (q) {
      // search by category name only — the list has no per-emoji names; good enough to jump to "flag" or "food"
      const hit = CATS.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
      body.innerHTML = hit.length ? hit.map(c => `<h6>${c.name}</h6>${grid(c.list)}`).join('') : `<div class="none">No emoji found</div>`;
      return;
    }
    if (cat === -1) {
      const r = recent();
      body.innerHTML = (r.length ? `<h6>Recent</h6>${grid(r)}` : '') + CATS.map(c => `<h6>${c.name}</h6>${grid(c.list)}`).join('');
    } else body.innerHTML = `<h6>${CATS[cat].name}</h6>${grid(CATS[cat].list)}`;
    body.scrollTop = 0;
  }

  function insert(e) {
    if (!target) return;
    const s = target.selectionStart ?? target.value.length, t = target.selectionEnd ?? s;
    target.value = target.value.slice(0, s) + e + target.value.slice(t);
    target.selectionStart = target.selectionEnd = s + e.length;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    remember(e);
  }

  function place() {
    const r = anchor.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    panel.style.top = Math.max(8, r.top - h - 8) + 'px';
  }

  function close() { if (panel) panel.style.display = 'none'; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); window.removeEventListener('resize', place); }
  const outside = e => { if (panel && !panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = e => { if (e.key === 'Escape') { close(); target && target.focus(); } };

  function toggle(btn, textarea) {
    if (panel && panel.style.display !== 'none' && anchor === btn) return close();
    anchor = btn; target = textarea;
    if (!panel) build();
    panel.style.display = 'flex';
    panel.querySelector('input').value = ''; render(-1);
    place();
    document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); window.addEventListener('resize', place);
  }

  window.EmojiPicker = { toggle, close, insert };
})();
