// ═══════════════════════════════════════════════
//  ABLY REALTIME CONFIG
// ═══════════════════════════════════════════════
const ABLY_KEY = 'KGookQ.FfjOlQ:ueKRpQKBtSsd0m76BPIX3aRBHSNFW8YaLMlmeN2whSs';

let _ably = null;

function getAbly() {
  if (_ably) return _ably;
  if (typeof Ably === 'undefined') { console.error('Ably SDK yuklanmagan'); return null; }
  const clientId = getCurrentKey() || ('guest_' + Math.random().toString(36).slice(2, 8));
  _ably = new Ably.Realtime({
    key: ABLY_KEY,
    clientId,
    echoMessages: false   // o'ziga qaytmaslik
  });
  return _ably;
}

function getCh(name) {
  const a = getAbly();
  return a ? a.channels.get(name) : null;
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
//  ROOM — Presence asosida (ishonchli!)
//
//  Qanday ishlaydi:
//  1. Ikki o'yinchi bir xil kanal nomiga kiradi
//  2. Presence orqali kim bor ekanini ko'radi
//  3. Agar 2 kishi bo'lsa — o'yin boshlanadi
//  4. Kanal nomi: gz-{gameType}-{code}
// ═══════════════════════════════════════════════

function enterRoom(gameType, code, myKey, onReady) {
  const chName = `gz-${gameType}-${code}`;
  const ch = getCh(chName);
  if (!ch) { onReady(null, null); return () => {}; }

  let settled = false;
  let timeoutId;

  function tryMatch(members) {
    if (settled) return;
    // clientId lar ro'yxati
    const keys = members.map(m => m.clientId).filter(Boolean);
    const unique = [...new Set(keys)];
    if (unique.length >= 2) {
      settled = true;
      clearTimeout(timeoutId);
      // Tartib: alfavit bo'yicha - kichigi p1, kattasi p2
      unique.sort();
      const p1 = unique[0];
      const p2 = unique[1];
      onReady(p1, p2);
    }
  }

  // Presence ga kirish
  ch.presence.enter({ key: myKey, ts: Date.now() });

  // Mavjud presence ni tekshir
  ch.presence.get((err, members) => {
    if (!err && members) tryMatch(members);
  });

  // Yangi odam kirsa
  ch.presence.subscribe('enter', () => {
    ch.presence.get((err, members) => {
      if (!err && members) tryMatch(members);
    });
  });

  // 2 daqiqa timeout
  timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      ch.presence.leave();
      onReady(null, null);
    }
  }, 120000);

  return () => {
    settled = true;
    clearTimeout(timeoutId);
    try { ch.presence.leave(); ch.presence.unsubscribe(); } catch(e) {}
  };
}

// O'yin holatini yuborish
function sendState(gameType, code, stateObj) {
  const ch = getCh(`gz-${gameType}-${code}`);
  if (ch) ch.publish('state', { ...stateObj, _from: getCurrentKey(), ts: Date.now() });
}

// O'yin holatini tinglash (o'zimizdan kelganini skip qilish)
function listenState(gameType, code, callback) {
  const ch = getCh(`gz-${gameType}-${code}`);
  if (!ch) return () => {};
  const myKey = getCurrentKey();
  ch.subscribe('state', (msg) => {
    if (msg.data._from === myKey) return; // o'zimiz yuborganini skip
    callback(msg.data);
  });
  return () => { try { ch.unsubscribe('state'); } catch(e) {} };
}

// O'yin tugadi
function sendGameOver(gameType, code, winner) {
  const ch = getCh(`gz-${gameType}-${code}`);
  if (ch) ch.publish('over', { winner, _from: getCurrentKey() });
}

// ═══════════════════════════════════════════════
//  QUEUE — Tasodifiy raqib
//  Presence asosida: gz-queue-{gameType}
// ═══════════════════════════════════════════════

function findRandom(gameType, myKey, onMatch) {
  const ch = getCh(`gz-queue-${gameType}`);
  if (!ch) { onMatch(null, null, null); return () => {}; }

  let settled = false;
  let timeoutId;

  function tryMatch(members) {
    if (settled) return;
    const keys = members.map(m => m.clientId).filter(k => k && k !== myKey);
    if (keys.length === 0) return;

    settled = true;
    clearTimeout(timeoutId);

    const opponent = keys[0];
    const allKeys = [myKey, opponent].sort();
    const code = 'R' + allKeys.join('').slice(0, 8);

    // Queue dan chiq
    ch.presence.leave();
    ch.presence.unsubscribe();

    onMatch(allKeys[0], allKeys[1], code);
  }

  // Queue ga qo'shil
  ch.presence.enter({ ts: Date.now() });

  // Mavjud odamlarni ko'r
  ch.presence.get((err, members) => {
    if (!err && members) tryMatch(members.filter(m => m.clientId !== myKey));
  });

  // Yangi odam kirsa
  ch.presence.subscribe('enter', () => {
    ch.presence.get((err, members) => {
      if (!err && members) tryMatch(members.filter(m => m.clientId !== myKey));
    });
  });

  timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      try { ch.presence.leave(); ch.presence.unsubscribe(); } catch(e) {}
      onMatch(null, null, null);
    }
  }, 60000);

  return () => {
    settled = true;
    clearTimeout(timeoutId);
    try { ch.presence.leave(); ch.presence.unsubscribe(); } catch(e) {}
  };
}

// ═══════════════════════════════════════════════
//  INVITE — Do'st chaqirish
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
  t._t = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }, 3500);
}
