// ═══════════════════════════════════════════════
//  ABLY CONFIG
// ═══════════════════════════════════════════════
const ABLY_KEY = 'KGookQ.FfjOlQ:ueKRpQKBtSsd0m76BPIX3aRBHSNFW8YaLMlmeN2whSs';

let _ably = null;

function getAbly() {
  if (_ably) return _ably;
  if (typeof Ably === 'undefined') { console.error('Ably yuklanmagan'); return null; }
  const cid = getCurrentKey() || ('g' + Date.now());
  _ably = new Ably.Realtime({ key: ABLY_KEY, clientId: cid });
  return _ably;
}

function getCh(name) {
  const a = getAbly();
  return a ? a.channels.get(name) : null;
}

// ═══════════════════════════════════════════════
//  USER
// ═══════════════════════════════════════════════
function getUsers()   { return JSON.parse(localStorage.getItem('gz_users') || '{}'); }
function saveUsers(u) { localStorage.setItem('gz_users', JSON.stringify(u)); }
function getCurrentKey()  { return localStorage.getItem('gz_current_user'); }
function getCurrentUser() { const k = getCurrentKey(); return k ? getUsers()[k] : null; }

// ═══════════════════════════════════════════════
//  ROOM — Oddiy publish/subscribe
//
//  Kanal: gz-room-{gameType}-{code}
//
//  1. Har ikki o'yinchi kanalga subscribe bo'ladi
//  2. Har biri "ping" yuboradi (men shu erdaman)
//  3. Boshqasining "ping" ini ko'rsa — "pong" qaytaradi
//  4. Kim "pong" olsa — ikkalasi ham ready
// ═══════════════════════════════════════════════
function enterRoom(gameType, code, myKey, onReady) {
  const ch = getCh(`gz-room-${gameType}-${code}`);
  if (!ch) { setTimeout(() => onReady(null, null), 100); return () => {}; }

  let settled = false;
  let pingInterval = null;
  let timeoutId = null;

  function finish(p1, p2) {
    if (settled) return;
    settled = true;
    clearInterval(pingInterval);
    clearTimeout(timeoutId);
    onReady(p1, p2);
  }

  // "ping" kelsa — biz ham bordligimizni aytamiz va o'yinni boshlaymiz
  ch.subscribe('ping', (msg) => {
    if (msg.data.from === myKey) return; // o'zim
    const otherKey = msg.data.from;
    // "pong" yuborish
    ch.publish('pong', { from: myKey, to: otherKey });
    // O'yin boshlash: ikkalasi sorted order da
    const keys = [myKey, otherKey].sort();
    finish(keys[0], keys[1]);
  });

  // "pong" kelsa — biz ping yuborganmiz, u javob berdi
  ch.subscribe('pong', (msg) => {
    if (msg.data.to !== myKey) return;
    const otherKey = msg.data.from;
    const keys = [myKey, otherKey].sort();
    finish(keys[0], keys[1]);
  });

  // Har 1 sekundda ping yuboramiz (raqib subscribe bo'lguncha)
  function sendPing() {
    if (settled) return;
    ch.publish('ping', { from: myKey, ts: Date.now() });
  }

  // Birinchi ping — 500ms kutib
  setTimeout(sendPing, 500);
  // Keyin har 1.5 sekundda
  pingInterval = setInterval(sendPing, 1500);

  // 2 daqiqa timeout
  timeoutId = setTimeout(() => {
    finish(null, null);
  }, 120000);

  return () => {
    settled = true;
    clearInterval(pingInterval);
    clearTimeout(timeoutId);
    try { ch.unsubscribe(); } catch(e) {}
  };
}

// ═══════════════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════════════
function sendState(gameType, code, stateObj) {
  const ch = getCh(`gz-room-${gameType}-${code}`);
  if (ch) ch.publish('state', { ...stateObj, _from: getCurrentKey() });
}

function listenState(gameType, code, callback) {
  const myKey = getCurrentKey();
  const ch = getCh(`gz-room-${gameType}-${code}`);
  if (!ch) return () => {};
  ch.subscribe('state', (msg) => {
    if (msg.data._from === myKey) return;
    callback(msg.data);
  });
  return () => { try { ch.unsubscribe('state'); } catch(e) {} };
}

function sendGameOver(gameType, code, winner) {
  const ch = getCh(`gz-room-${gameType}-${code}`);
  if (ch) ch.publish('over', { winner });
}

// ═══════════════════════════════════════════════
//  QUEUE — Tasodifiy raqib
// ═══════════════════════════════════════════════
function findRandom(gameType, myKey, onMatch) {
  const ch = getCh(`gz-queue-${gameType}`);
  if (!ch) { onMatch(null, null, null); return () => {}; }

  let settled = false;
  let pingInt = null;
  let timeoutId = null;

  function finish(p1, p2, code) {
    if (settled) return;
    settled = true;
    clearInterval(pingInt);
    clearTimeout(timeoutId);
    try { ch.unsubscribe(); } catch(e) {}
    onMatch(p1, p2, code);
  }

  ch.subscribe('ping', (msg) => {
    if (msg.data.from === myKey) return;
    const other = msg.data.from;
    ch.publish('pong', { from: myKey, to: other });
    const keys = [myKey, other].sort();
    const code = 'R' + keys.join('').slice(0,6);
    finish(keys[0], keys[1], code);
  });

  ch.subscribe('pong', (msg) => {
    if (msg.data.to !== myKey) return;
    const other = msg.data.from;
    const keys = [myKey, other].sort();
    const code = 'R' + keys.join('').slice(0,6);
    finish(keys[0], keys[1], code);
  });

  const sendPing = () => { if (!settled) ch.publish('ping', { from: myKey, ts: Date.now() }); };
  setTimeout(sendPing, 500);
  pingInt = setInterval(sendPing, 1500);

  timeoutId = setTimeout(() => finish(null, null, null), 60000);

  return () => {
    settled = true;
    clearInterval(pingInt);
    clearTimeout(timeoutId);
    try { ch.unsubscribe(); } catch(e) {}
  };
}

// ═══════════════════════════════════════════════
//  INVITE
// ═══════════════════════════════════════════════
function sendInvite(toKey, fromKey, gameType, code) {
  const ch = getCh(`gz-invite-${toKey}`);
  if (ch) ch.publish('invite', { from: fromKey, gameType, code, ts: Date.now() });
}

function listenInvites(myKey, callback) {
  const ch = getCh(`gz-invite-${myKey}`);
  if (!ch) return () => {};
  ch.subscribe('invite', (msg) => {
    if (Date.now() - (msg.data.ts || 0) < 120000) callback(msg.data);
  });
  return () => { try { ch.unsubscribe(); } catch(e) {} };
}

// ═══════════════════════════════════════════════
//  COINS & STATS
// ═══════════════════════════════════════════════
function addCoins(amount) {
  const key = getCurrentKey(); if (!key) return;
  const users = getUsers(); if (!users[key]) return;
  users[key].coins = (users[key].coins || 0) + amount;
  saveUsers(users); refreshCoinDisplay();
}

function addResult(win) {
  const key = getCurrentKey(); if (!key) return;
  const users = getUsers(); if (!users[key]) return;
  if (win) users[key].wins   = (users[key].wins   || 0) + 1;
  else     users[key].losses = (users[key].losses || 0) + 1;
  saveUsers(users);
}

function refreshCoinDisplay() {
  const u = getCurrentUser(); if (!u) return;
  document.querySelectorAll('#nav-coins,#shop-coins').forEach(el => {
    if (el) el.textContent = u.coins || 0;
  });
}

async function getLeaderboard(limit = 10) {
  return Object.values(getUsers()).sort((a,b)=>(b.wins||0)-(a.wins||0)).slice(0,limit);
}

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
function showToast(msg, type = 'success') {
  let t = document.getElementById('gz-toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'gz-toast';
    t.style.cssText = `position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
      background:#1e1e3a;border:1px solid rgba(255,255,255,.2);border-radius:12px;
      padding:12px 28px;font-size:15px;font-family:'Rajdhani',sans-serif;font-weight:600;
      color:#fff;z-index:9999;transition:opacity .3s;box-shadow:0 8px 32px rgba(0,0,0,.5);
      white-space:nowrap;`;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderColor = type==='error'?'rgba(239,68,68,.6)':'rgba(99,102,241,.6)';
  t.style.opacity='1'; t.style.display='block';
  clearTimeout(t._t);
  t._t = setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.style.display='none',300); }, 3500);
}
