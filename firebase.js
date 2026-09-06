// ════════════════════════════════════════════════════════════
//  ABLY REALTIME — Multiplayer backend
//  API Key: KGookQ.FfjOlQ:ueKRpQKBtSsd0m76BPIX3aRBHSNFW8YaLMlmeN2whSs
// ════════════════════════════════════════════════════════════
const ABLY_KEY = 'KGookQ.FfjOlQ:ueKRpQKBtSsd0m76BPIX3aRBHSNFW8YaLMlmeN2whSs';

let _ably = null;

function getAbly() {
  if (!_ably) {
    if (typeof Ably === 'undefined') {
      console.error('Ably SDK yuklanmagan!');
      return null;
    }
    _ably = new Ably.Realtime({ key: ABLY_KEY, clientId: getCurrentKey() || 'guest_' + Date.now() });
  }
  return _ably;
}

// ════════════════════════════════════════════════════════════
//  USERS — localStorage
// ════════════════════════════════════════════════════════════
function getUsers()   { return JSON.parse(localStorage.getItem('gz_users') || '{}'); }
function saveUsers(u) { localStorage.setItem('gz_users', JSON.stringify(u)); }
function getCurrentKey()  { return localStorage.getItem('gz_current_user'); }
function getCurrentUser() {
  const k = getCurrentKey();
  return k ? getUsers()[k] : null;
}

// ════════════════════════════════════════════════════════════
//  ROOM SYSTEM — Ably channels
//  Channel naming: gz-room-{gameType}-{roomCode}
// ════════════════════════════════════════════════════════════

// Xona yaratish — localStorage da saqlanadi
async function createRoom(gameType, roomCode, hostKey) {
  const key = `gz_room_${gameType}_${roomCode}`;
  if (localStorage.getItem(key)) return false;
  localStorage.setItem(key, JSON.stringify({
    player1: hostKey, player2: null,
    gameType, roomCode, status: 'waiting', createdAt: Date.now()
  }));
  // Ably channel ga e'lon qil
  const ably = getAbly();
  if (ably) {
    const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);
    await ch.publish('room-created', { player1: hostKey, gameType, roomCode });
  }
  return true;
}

// Xonaga kirish
async function joinRoom(gameType, roomCode, guestKey) {
  const ably = getAbly();
  if (!ably) return null;

  // Host ga xabar yuborish
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);

  return new Promise((resolve) => {
    // 3 soniya kutamiz — agar host bormi?
    let resolved = false;

    ch.subscribe('room-created', (msg) => {
      if (resolved) return;
      if (msg.data.player1 === guestKey) { resolve(null); return; } // o'zi
      resolved = true;
      ch.publish('player-joined', { player2: guestKey });
      resolve({ player1: msg.data.player1, player2: guestKey, status: 'playing' });
    });

    ch.subscribe('player-joined', (msg) => {
      // Boshqa odam kirib qoldi
    });

    // Mavjud xonaga ulanmoqchi — to'g'ridan-to'g'ri signal yuborish
    ch.publish('join-request', { from: guestKey });

    setTimeout(() => {
      if (!resolved) { resolved = true; resolve(null); }
    }, 3000);
  });
}

// Xona o'zgarishlarini tinglash
function listenRoom(gameType, roomCode, callback) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);

  const handler = (msg) => callback({ type: msg.name, data: msg.data });
  ch.subscribe(handler);
  return () => ch.unsubscribe(handler);
}

// O'yin holatini yuborish
function pushGameState(gameType, roomCode, stateObj) {
  const ably = getAbly();
  if (!ably) return;
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);
  ch.publish('game-state', stateObj);
}

// O'yin tugadi
function finishRoom(gameType, roomCode, winner) {
  const ably = getAbly();
  if (!ably) return;
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);
  ch.publish('game-over', { winner });
}

// ════════════════════════════════════════════════════════════
//  SIMPLE ROOM PROTOCOL
//  Host va Guest bir xil kanal orqali muloqot qiladi
// ════════════════════════════════════════════════════════════

// Host: xona ochadi va kutadi
function hostRoom(gameType, roomCode, hostKey, onGuestJoined) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);

  // Join request kelganda
  const sub = ch.subscribe('join-request', (msg) => {
    if (msg.data.from === hostKey) return; // o'zi
    sub.unsubscribe && sub.unsubscribe();
    ch.publish('room-ready', {
      player1: hostKey,
      player2: msg.data.from,
      roomCode
    });
    onGuestJoined(msg.data.from);
  });

  // E'lon qil — xona tayyor
  ch.publish('room-open', { player1: hostKey, roomCode, gameType, ts: Date.now() });

  return () => { try { ch.unsubscribe(); } catch(e){} };
}

// Guest: xonaga ulanadi
function guestJoinRoom(gameType, roomCode, guestKey, onReady) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);

  ch.subscribe('room-ready', (msg) => {
    if (msg.data.player2 === guestKey) {
      onReady(msg.data.player1, msg.data.player2);
    }
  });

  // So'rov yuborish
  ch.publish('join-request', { from: guestKey });

  return () => { try { ch.unsubscribe(); } catch(e){} };
}

// ════════════════════════════════════════════════════════════
//  QUEUE — Tasodifiy raqib
// ════════════════════════════════════════════════════════════
function joinQueue(gameType, playerKey, onMatch) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-queue-${gameType}`);

  // Boshqa o'yinchini tinglash
  ch.subscribe('looking', (msg) => {
    if (msg.data.from === playerKey) return;
    // Match!
    const code = 'R' + Math.floor(Math.random() * 9000 + 1000);
    ch.publish('matched', { p1: msg.data.from, p2: playerKey, code });
    onMatch(msg.data.from, playerKey, code);
  });

  ch.subscribe('matched', (msg) => {
    if (msg.data.p1 === playerKey || msg.data.p2 === playerKey) {
      onMatch(msg.data.p1, msg.data.p2, msg.data.code);
    }
  });

  // E'lon qil
  ch.publish('looking', { from: playerKey, ts: Date.now() });

  return () => { try { ch.unsubscribe(); } catch(e){} };
}

// ════════════════════════════════════════════════════════════
//  INVITE — Do'st chaqirish
// ════════════════════════════════════════════════════════════
function sendInvite(toKey, fromKey, gameType, roomCode) {
  const ably = getAbly();
  if (!ably) return;
  const ch = ably.channels.get(`gz-invite-${toKey}`);
  ch.publish('invite', { from: fromKey, gameType, roomCode, ts: Date.now() });
}

function listenInvites(playerKey, callback) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-invite-${playerKey}`);
  ch.subscribe('invite', (msg) => {
    if (Date.now() - msg.data.ts < 120000) callback(msg.data);
  });
  return () => { try { ch.unsubscribe(); } catch(e){} };
}

// ════════════════════════════════════════════════════════════
//  GAME STATE — Real-time sync
// ════════════════════════════════════════════════════════════
function listenGameState(gameType, roomCode, callback) {
  const ably = getAbly();
  if (!ably) return () => {};
  const ch = ably.channels.get(`gz-room-${gameType}-${roomCode}`);
  ch.subscribe('game-state', (msg) => callback(msg.data));
  ch.subscribe('game-over',  (msg) => callback({ ...msg.data, gameOver: true }));
  return () => { try { ch.unsubscribe(); } catch(e){} };
}

// ════════════════════════════════════════════════════════════
//  COINS & STATS
// ════════════════════════════════════════════════════════════
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

// Leaderboard — localStorage dan
async function getLeaderboard(limit = 10) {
  return Object.values(getUsers())
    .sort((a, b) => (b.wins || 0) - (a.wins || 0))
    .slice(0, limit);
}

// ════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════
function showToast(msg, type = 'success') {
  let t = document.getElementById('gz-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'gz-toast';
    t.style.cssText = `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%);
      background:#1e1e3a;border:1px solid rgba(255,255,255,.15);
      border-radius:12px;padding:12px 24px;font-size:15px;
      font-family:'Rajdhani',sans-serif;font-weight:600;
      color:#fff;z-index:9999;transition:all .3s;
      box-shadow:0 8px 32px rgba(0,0,0,.4);white-space:nowrap;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.borderColor = type === 'error' ? 'rgba(239,68,68,.5)' : 'rgba(99,102,241,.5)';
  t.style.opacity = '1'; t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.style.display = 'none', 300); }, 3000);
}

// ════════════════════════════════════════════════════════════
//  Ably ni HTML da yuklash uchun helper
// ════════════════════════════════════════════════════════════
function loadAblySDK(callback) {
  if (typeof Ably !== 'undefined') { callback(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.ably.com/lib/ably.min-2.js';
  s.onload = callback;
  document.head.appendChild(s);
}
