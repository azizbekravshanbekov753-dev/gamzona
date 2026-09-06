// ════════════════════════════════════════════════════════════
//  GAME.JS  —  Dashboard multiplayer controller (Firebase)
// ════════════════════════════════════════════════════════════

let currentGame  = null;   // 'tictactoe' | 'connect4' | 'quiz'
let currentMode  = null;   // 'random' | 'room' | 'friend'
let _unsubQueue  = null;   // queue listener cleanup
let _waitingCode = null;   // host xona kodi (tasodifiy uchun)

const GAME_META = {
  tictactoe: { icon:'⭕', title:'Tic-Tac-Toe',  desc:'3x3 klassik o\'yin. Birinchi 3 tani tizing!',  reward:50,  file:'tictactoe.html' },
  connect4:  { icon:'🔴', title:'Connect Four',  desc:'4 tani qatorga joylashtiring!',                reward:75,  file:'connect4.html'  },
  quiz:      { icon:'🧠', title:'Quiz Battle',   desc:'Savol-javob bellashuvi. Kim ko\'proq biladi?', reward:60,  file:'quiz.html'       },
};

// ── OPEN GAME MODAL ──
function openGameModal(game) {
  currentGame = game;
  const m = GAME_META[game];
  document.getElementById('modal-icon').textContent  = m.icon;
  document.getElementById('modal-title').textContent = m.title;
  document.getElementById('modal-desc').textContent  = m.desc;
  document.getElementById('game-modal').classList.add('open');
}
function closeGameModal() {
  document.getElementById('game-modal').classList.remove('open');
}

// ── MODE SELECTED ──
function startGame(mode) {
  currentMode = mode;
  closeGameModal();
  if (mode === 'random') {
    openWaiting('Tasodifiy raqib qidirilmoqda...', 'Iltimos kuting...');
    findRandomOpponent();
  } else if (mode === 'room') {
    document.getElementById('room-modal').classList.add('open');
    document.getElementById('room-input').value = '';
    document.getElementById('room-status').textContent = '';
  } else if (mode === 'friend') {
    document.getElementById('friend-modal').classList.add('open');
    document.getElementById('friend-input').value = '';
    document.getElementById('friend-status').textContent = '';
  }
}

// ── ROOM MODAL ──
function closeRoomModal() {
  document.getElementById('room-modal').classList.remove('open');
}

async function joinRoomAction() {
  const code     = document.getElementById('room-input').value.trim();
  const statusEl = document.getElementById('room-status');
  if (!code || code.length < 4) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = '❌ Kamida 4 xonali raqam kiriting'; return;
  }

  const myKey = getCurrentKey();
  statusEl.style.color = 'rgba(255,255,255,.5)';
  statusEl.textContent = '⏳ Ulanilmoqda...';

  const ably = getAbly();
  if (!ably) { statusEl.style.color='#f87171'; statusEl.textContent='❌ Ably ulanmadi'; return; }

  closeRoomModal();

  // Try to join as guest first — send join-request, if no host → become host
  const ch = ably.channels.get(`gz-room-${currentGame}-${code}`);

  let resolved = false;

  // Listen for room-ready (host confirms us)
  ch.subscribe('room-ready', (msg) => {
    if (resolved) return;
    if (msg.data.player2 === myKey) {
      resolved = true;
      ch.unsubscribe();
      closeWaiting();
      launchGame(msg.data.player1, msg.data.player2, code);
    }
  });

  // Listen for join-request — if someone else sends it, we are the host
  ch.subscribe('join-request', (msg) => {
    if (resolved) return;
    if (msg.data.from === myKey) return;
    resolved = true;
    ch.unsubscribe();
    ch.publish('room-ready', { player1: myKey, player2: msg.data.from, roomCode: code });
    closeWaiting();
    launchGame(myKey, msg.data.from, code);
  });

  // Send join-request
  ch.publish('join-request', { from: myKey });

  openWaiting(`Xona #${code}`, 'Raqib kutilmoqda... (Raqibingiz ham shu kodni kiriting)');

  // Timeout 2 daqiqa
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      ch.unsubscribe();
      closeWaiting();
      showToast('⏰ Vaqt tugadi. Qayta urining.', 'error');
    }
  }, 120000);
}

// ════════════════════════════════════════════════════════════
//  FRIEND MODAL
// ════════════════════════════════════════════════════════════
function closeFriendModal() {
  document.getElementById('friend-modal').classList.remove('open');
}

async function inviteFriend() {
  const friendName = document.getElementById('friend-input').value.trim().toLowerCase();
  const statusEl   = document.getElementById('friend-status');
  if (!friendName) { statusEl.style.color='#f87171'; statusEl.textContent='❌ Username kiriting'; return; }

  const users = getUsers();
  const myKey = getCurrentKey();

  if (!users[friendName]) {
    statusEl.style.color = '#f87171';
    statusEl.textContent = '❌ Foydalanuvchi topilmadi';
    return;
  }
  if (friendName === myKey) { statusEl.style.color='#f87171'; statusEl.textContent='❌ O\'zingizni chaqira olmaysiz'; return; }

  const code = Math.floor(1000 + Math.random() * 9000).toString();
  sendInvite(friendName, myKey, currentGame, code);

  statusEl.style.color = '#34d399';
  statusEl.textContent = `✅ Taklif yuborildi! Xona kodi: #${code}`;

  setTimeout(() => {
    closeFriendModal();
    // Open as host
    document.getElementById('room-input').value = code;
    joinRoomAction();
  }, 1200);
}

// ════════════════════════════════════════════════════════════
//  RANDOM OPPONENT — Ably queue
// ════════════════════════════════════════════════════════════
function findRandomOpponent() {
  const myKey = getCurrentKey();
  let resolved = false;

  _unsubQueue = joinQueue(currentGame, myKey, (p1, p2, code) => {
    if (resolved) return;
    resolved = true;
    _unsubQueue && _unsubQueue();
    closeWaiting();
    launchGame(p1, p2, code);
  });

  setTimeout(() => {
    if (!resolved && document.getElementById('waiting-modal').classList.contains('open')) {
      resolved = true;
      _unsubQueue && _unsubQueue();
      closeWaiting();
      showToast('⏰ Raqib topilmadi. Qayta urinib ko\'ring.', 'error');
    }
  }, 60000);
}
function startInviteListener() {
  const myKey = getCurrentKey();
  if (!myKey) return;
  const gameNames = { tictactoe:'Tic-Tac-Toe', connect4:'Connect Four', quiz:'Quiz Battle' };
  listenInvites(myKey, (invite) => {
    showInvitePopup(invite.from, gameNames[invite.gameType]||invite.gameType, invite.gameType, invite.roomCode);
  });
}

function showInvitePopup(from, gameName, gameType, code) {
  const popup = document.createElement('div');
  popup.style.cssText = `
    position:fixed;bottom:28px;right:24px;z-index:9998;
    background:#1e1e3a;border:1px solid rgba(99,102,241,.4);
    border-radius:18px;padding:20px 22px;width:300px;
    box-shadow:0 12px 48px rgba(0,0,0,.5);
    font-family:'Rajdhani',sans-serif;color:#fff;
    animation:slideUp .3s ease;
  `;
  popup.innerHTML = `
    <div style="font-size:12px;color:rgba(255,255,255,.4);margin-bottom:4px">📨 Do'stdan taklif</div>
    <div style="font-size:16px;font-weight:700;margin-bottom:4px">
      <span style="color:#a78bfa">${from}</span> seni <b>${gameName}</b> ga chaqiryapti!
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,.4);margin-bottom:14px">
      Xona kodi: <b style="color:#fbbf24">#${code}</b>
    </div>
    <div style="display:flex;gap:8px">
      <button id="inv-accept-${code}"
        style="flex:1;padding:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;
        border-radius:10px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:700;cursor:pointer">
        ✅ Qabul
      </button>
      <button onclick="this.closest('[style]').remove()"
        style="flex:1;padding:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
        border-radius:10px;color:#fff;font-family:'Rajdhani',sans-serif;font-size:14px;cursor:pointer">
        ❌ Rad
      </button>
    </div>`;
  document.body.appendChild(popup);

  document.getElementById(`inv-accept-${code}`).addEventListener('click', () => {
    popup.remove();
    currentGame = gameType;
    currentMode = 'room';
    acceptInviteRoom(gameType, code);
  });

  setTimeout(() => popup.remove(), 60000);
}

async function acceptInviteRoom(gameType, code) {
  const myKey = getCurrentKey();
  const room = await joinRoom(gameType, code, myKey);
  if (room) {
    launchGame(room.player1, myKey, code);
  } else {
    showToast('❌ Xona topilmadi yoki to\'la', 'error');
  }
}

// ════════════════════════════════════════════════════════════
//  WAITING MODAL
// ════════════════════════════════════════════════════════════
function openWaiting(title, desc) {
  document.getElementById('waiting-title').textContent = title;
  document.getElementById('waiting-desc').textContent  = desc;
  document.getElementById('waiting-modal').classList.add('open');
}
function closeWaiting() {
  document.getElementById('waiting-modal').classList.remove('open');
}
async function cancelWaiting() {
  const myKey = getCurrentKey();
  if (currentMode === 'random') await leaveQueue(currentGame, myKey);
  _unsubQueue && _unsubQueue();
  closeWaiting();
}

// ════════════════════════════════════════════════════════════
//  LAUNCH GAME
// ════════════════════════════════════════════════════════════
function launchGame(p1, p2, code) {
  const meta = GAME_META[currentGame];
  localStorage.setItem('gz_session', JSON.stringify({
    game: currentGame, player1: p1, player2: p2, roomCode: code, reward: meta.reward
  }));
  window.location.href = meta.file;
}

// ════════════════════════════════════════════════════════════
//  MODAL CLOSE / DROPDOWN / LOGOUT
// ════════════════════════════════════════════════════════════
function closeModal(e) {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
}
function toggleProfile() {
  document.getElementById('profile-dropdown').classList.toggle('open');
}
function closeDropdown() {
  document.getElementById('profile-dropdown').classList.remove('open');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.profile-btn') && !e.target.closest('.profile-dropdown')) closeDropdown();
});
function logout() {
  localStorage.removeItem('gz_current_user');
  window.location.href = 'index.html';
}

// ── dashboard.js ga expose ──
window.GZ = { startInviteListener };
