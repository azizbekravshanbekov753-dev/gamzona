// ═══════════════════════════════════════════════
//  ABLY REALTIME CONFIG
// ═══════════════════════════════════════════════
const ABLY_KEY = 'KGookQ.FfjOlQ:ueKRpQKBtSsd0m76BPIX3aRBHSNFW8YaLMlmeN2whSs';

let _ably = null;

function getAbly() {
  if (_ably) return _ably;
  if (typeof Ably === 'undefined') { console.error('Ably SDK yuklanmagan'); return null; }
  const clientId = getCurrentKey() || ('guest_' + Math.random().toString(36).slice(2));
  _ably = new Ably.Realtime({ key: ABLY_KEY, clientId });
  return _ably;
}

// Channel olish
function getCh(name) {
  const a = getAbly();
  if (!a) return null;
  return a.channels.get(name);
}

// ═══════════════════════════════════════════════
//  USER — localStorage
// ═══════════════════════════════════════════════
function getUsers()   { return JSON.parse(localStorage.getItem('gz_users') || '{}'); }
function saveUsers(u) { localStorage.setItem('gz_users', JSON.stringify(u)); }
function getCurrentKey()  { return localStorage.getItem('gz_current_user'); }
function getCurrentUser() {
  const k = getCurrentKey();
  return k ? getUsers()[k] : null;
}

// ═══════════════════════════════════════════════
//  ROOM PROTOCOL
//
//  Kanal: gz-{gameType}-{roomCode}
//
//  Xabarllar:
//   "join"    → { from: playerKey }   (Guest yuboradi)
//   "ready"   → { p1, p2, code }      (Birinchi kirgan yuboradi)
//   "state"   → { ...gameState }      (Har harakat da)
//   "over"    → { winner }
// ═══════════════════════════════════════════════

function roomChannel(gameType, code) {
  return getCh(`gz-${gameType}-${code}`);
}

// Xonaga kirish — ikkala o'yinchi bir xil kodni kiritadi
// Kim birinchi kirsa = p1, ikkinchisi = p2
function enterRoom(gameType, code, myKey, onReady) {
  const ch = roomChannel(gameType, code);
  if (!ch) return () => {};

  let settled = false;

  // "ready" xabari kelsa — o'yin boshlanadi
  ch.subscribe('ready', (msg) => {
    if (settled) return;
    settled = true;
    onReady(msg.data.p1, msg.data.p2);
  });

  // "join" xabari — boshqa odam kirdi, biz p1 miz
  ch.subscribe('join', (msg) => {
    if (settled) return;
    if (msg.data.from === myKey) return;
    settled = true;
    // Biz p1, u p2
    ch.publish('ready', { p1: myKey, p2: msg.data.from, code });
    onReady(myKey, msg.data.from);
  });

  // Biz "join" xabari yuboramiz
  ch.publish('join', { from: myKey });

  // 2 daqiqa timeout
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      ch.unsubscribe();
      onReady(null, null); // timeout signal
    }
  }, 120000);

  return () => {
    clearTimeout(timeout);
    try { ch.unsubscribe(); } catch(e) {}
  };
}

// O'yin holatini yuborish
function sendState(gameType, code, stateObj) {
  const ch = roomChannel(gameType, code);
  if (ch) ch.publish('state', { ...stateObj, ts: Date.now() });
}

// O'yin holatini tinglash
function listenState(gameType, code, callback) {
  const ch = roomChannel(gameType, code);
  if (!ch) return () => {};
  ch.subscribe('state', (msg) => callback(msg.data));
  return () => { try { ch.unsubscribe(); } catch(e) {} };
}

// O'yin tugadi
function sendGameOver(gameType, code, winner) {
  const ch = roomChannel(gameType, code);
  if (ch) ch.publish('over', { winner });
}

// ═══════════════════════════════════════════════
//  QUEUE — Tasodifiy raqib
//  Kanal: gz-queue-{gameType}
// ═══════════════════════════════════════════════
function findRandom(gameType, myKey, onMatch) {
  const ch = getCh(`gz-queue-${gameType}`);
  if (!ch) return () => {};

  let settled = false;

  // Birov "looking" desa — match qilamiz
  ch.subscribe('looking', (msg) => {
    if (settled) return;
    if (msg.data.from === myKey) return;
    settled = true;
    ch.unsubscribe();
    // Random kod yasaymiz
    const code = 'R' + Date.now();
    // Match kanalida uchrashish
    const mCh = getCh(`gz-match-${code}`);
    mCh.publish('matched', { p1: msg.data.from, p2: myKey, code, game: gameType });
    onMatch(msg.data.from, myKey, code);
  });

  // Match kanalini ham tinglaylik (boshqa odam biz uchun match qilsa)
  ch.subscribe('matched', (msg) => {
    if (settled) return;
    if (msg.data.p1 !== myKey && msg.data.p2 !== myKey) return;
    settled = true;
    ch.unsubscribe();
    onMatch(msg.data.p1, msg.data.p2, msg.data.code);
  });

  // E'lon qilish
  ch.publish('looking', { from: myKey, game: gameType, ts: Date.now() });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { ch.unsubscribe(); } catch(e) {}
      onMatch(null, null, null); // topilmadi
    }
  }, 60000);

  return () => {
    settled = true;
    clearTimeout(timeout);
    try { ch.unsubscribe(); } catch(e) {}
  };
}

// ═══════════════════════════════════════════════
//  INVITE — Do'st chaqirish
//  Kanal: gz-invite-{toKey}
// ═══════════════════════════════════════════════
function sendInvite(toKey, fromKey, gameType, code) {
  const ch = getCh(`gz-invite-${toKey}`);
  if (ch) ch.publish('invite', { from: fromKey, gameType, code, ts: Date.now() });
}

function listenInvites(myKey, callback) {
  const ch = getCh(`gz-invite-${myKey}`);
  if (!ch) return () => {};
  ch.subscribe('invite', (msg) => {
    if (Date.now() - msg.data.ts < 120000) callback(msg.data);
  });
  return () => { try { ch.unsubscribe(); } catch(e) {} };
}

// ═══════════════════════════════════════════════
//  COINS & STATS
// ═══════════════════════════════════════════════
function addCoins(amount) {
  const key = getCurrentKey();
  if (!key) return;
  const users = getUsers();
  if (!users[key]) return;
  users[key].coins = (users[key].coins || 0) + amount;
  saveUsers(users);
  refreshCoinDisplay();
}

function addResult(win) {
  const key = getCurrentKey();
  if (!key) return;
  const users = getUsers();
  if (!users[key]) return;
  if (win) users[key].wins   = (users[key].wins   || 0) + 1;
  else     users[key].losses = (users[key].losses || 0) + 1;
  saveUsers(users);
}

function refreshCoinDisplay() {
  const u = getCurrentUser();
  if (!u) return;
  document.querySelectorAll('#nav-coins, #shop-coins').forEach(el => {
    if (el) el.textContent = u.coins || 0;
  });
}

async function getLeaderboard(limit = 10) {
  return Object.values(getUsers())
    .sort((a, b) => (b.wins || 0) - (a.wins || 0))
    .slice(0, limit);
}

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
function showToast(msg, type = 'success') {
  let t = document.getElementById('gz-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'gz-toast';
    t.style.cssText = `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
      background:#1e1e3a;border:1px solid rgba(255,255,255,.2);
      border-radius:12px;padding:12px 28px;font-size:15px;
      font-family:'Rajdhani',sans-serif;font-weight:600;
      color:#fff;z-index:9999;transition:opacity .3s;
      box-shadow:0 8px 32px rgba(0,0,0,.5);white-space:nowrap;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderColor = type === 'error' ? 'rgba(239,68,68,.6)' : 'rgba(99,102,241,.6)';
  t.style.opacity = '1';
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }, 3000);
}
