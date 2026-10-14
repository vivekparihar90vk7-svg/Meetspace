// ---------- tiny helpers ----------
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);

const screens = {
  auth: $('#auth-screen'),
  lobby: $('#lobby-screen'),
  room: $('#room-screen'),
};

function showScreen(name) {
  for (const key in screens) {
    screens[key].hidden = (key !== name);
  }
}

let toastTimer = null;
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2500);
}

// ---------- who is logged in ----------
let token = localStorage.getItem('ms_token');
let username = localStorage.getItem('ms_user');

function saveLogin(newToken, newUsername) {
  token = newToken;
  username = newUsername;
  localStorage.setItem('ms_token', token);
  localStorage.setItem('ms_user', username);
}

function logout() {
  token = null;
  username = null;
  localStorage.removeItem('ms_token');
  localStorage.removeItem('ms_user');
  showScreen('auth');
}

// ---------- login / signup form ----------
let mode = 'login';

function setMode(newMode) {
  mode = newMode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = (mode === 'login') ? 'Log in' : 'Create account';
  $('#auth-pass').autocomplete = (mode === 'login') ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#auth-error').textContent = '';

  const url = (mode === 'login') ? '/api/login' : '/api/register';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#auth-user').value.trim(),
        password: $('#auth-pass').value,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong');
    }

    saveLogin(data.token, data.username);
    $('#auth-pass').value = '';
    goLobby();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

// ---------- lobby ----------
function goLobby() {
  $('#lobby-name').textContent = username;
  $('#lobby-error').textContent = '';

  const invitedRoom = new URLSearchParams(location.search).get('room');
  if (invitedRoom) {
    $('#room-input').value = invitedRoom;
  }
  showScreen('lobby');
}

function randomRoomCode() {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) {
    code += letters[b % letters.length];
  }
  return code;
}

$('#new-room').onclick = () => joinRoom(randomRoomCode());

$('#join-room').onclick = () => {
  const code = $('#room-input').value.trim();
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(code)) {
    $('#lobby-error').textContent = 'Room code must be 3-40 letters or numbers';
    return;
  }
  $('#lobby-error').textContent = '';
  joinRoom(code);
};

$('#room-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    $('#join-room').click();
  }
});

$('#logout').onclick = logout;

// ---------- WebRTC setup ----------
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ---------- meeting room state ----------
let socket = null;
let myId = null;
let roomCode = null;
let localStream = null;
let screenStream = null;
let micOn = true;
let camOn = true;
let chatOpen = false;
let whiteboardOpen = false;
let unreadChatCount = 0;
const peers = {}; // id -> { id, name, audio, video, pc }

async function getLocalStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.warn('Camera/mic not available:', err.message);
    return null;
  }
}

function createPeerConnection(id) {
  const pc = new RTCPeerConnection(RTC_CONFIG);

  const streamToSend = screenStream || localStream;
  if (streamToSend) {
    streamToSend.getTracks().forEach(track => pc.addTrack(track, streamToSend));
  }

  pc.ontrack = (event) => {
    attachStream(id, event.streams[0]);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        to: id,
        signal: { type: 'ice-candidate', candidate: event.candidate },
      });
    }
  };

  return pc;
}

async function callPeer(id) {
  const peer = peers[id];
  if (!peer) return;

  peer.pc = createPeerConnection(id);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, signal: { type: 'offer', sdp: offer } });
}

async function joinRoom(room) {
  if (socket) return;
  $('#lobby-error').textContent = '';

  localStream = await getLocalStream();

  micOn = true;
  camOn = true;
  $('#btn-mic').textContent = '🎤 Mute';
  $('#btn-mic').classList.remove('off');
  $('#btn-cam').textContent = '🎥 Stop video';
  $('#btn-cam').classList.remove('off');
  $('#btn-screen').textContent = '🖥️ Share screen';
  $('#btn-screen').classList.remove('off');
  updateControlsAvailability();

  setChatOpen(false);
  setWhiteboardOpen(false);
  unreadChatCount = 0;
  updateChatBadge();
  $('#chat-messages').innerHTML = '';
  clearLocalCanvas();

  socket = io({ auth: { token } });

  socket.on('connect', () => {
    socket.emit('join', { room }, (reply) => {
      if (reply.error) {
        leaveRoom();
        $('#lobby-error').textContent = reply.error;
        return;
      }

      myId = reply.id;
      roomCode = room;
      history.replaceState(null, '', '?room=' + encodeURIComponent(room));

      $('#room-title').textContent = 'Room: ' + room;

      addTile(myId, username + ' (you)', true, true, true);
      if (localStream) attachStream(myId, localStream);

      reply.peers.forEach((person) => {
        peers[person.id] = { id: person.id, name: person.name, audio: person.audio, video: person.video, pc: null };
        addTile(person.id, person.name, false, person.audio, person.video);
      });

      // Load whiteboard history
      if (reply.whiteboard && reply.whiteboard.length) {
        reply.whiteboard.forEach(stroke => drawLineOnCanvas(stroke, false));
      }

      updateCount();
      showScreen('room');
    });
  });

  socket.on('connect_error', (err) => {
    leaveRoom();
    if (err.message === 'unauthorized') {
      logout();
      $('#auth-error').textContent = 'Your login expired. Please log in again.';
    } else {
      $('#lobby-error').textContent = 'Cannot reach the server';
    }
  });

  socket.on('disconnect', () => {
    if (roomCode) {
      leaveRoom();
      $('#lobby-error').textContent = 'Lost the connection to the server';
    }
  });

  socket.on('peer-joined', (person) => {
    peers[person.id] = { id: person.id, name: person.name, audio: person.audio, video: person.video, pc: null };
    addTile(person.id, person.name, false, person.audio, person.video);
    updateCount();
    toast(person.name + ' joined');
    appendChatMessage('system', person.name + ' joined the room');
    callPeer(person.id);
  });

  socket.on('peer-left', (data) => {
    const peer = peers[data.id];
    if (peer) {
      toast(peer.name + ' left');
      appendChatMessage('system', peer.name + ' left the room');
      if (peer.pc) peer.pc.close();
    }
    delete peers[data.id];
    removeTile(data.id);
    updateCount();
  });

  socket.on('signal', async ({ from, signal }) => {
    const peer = peers[from];
    if (!peer) return;

    if (signal.type === 'offer') {
      peer.pc = createPeerConnection(from);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, signal: { type: 'answer', sdp: answer } });
    } else if (signal.type === 'answer') {
      if (peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      }
    } else if (signal.type === 'ice-candidate') {
      if (peer.pc) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (err) {
          console.warn('Could not add ICE candidate:', err.message);
        }
      }
    }
  });

  socket.on('peer-media', ({ id, audio, video }) => {
    const peer = peers[id];
    if (!peer) return;
    peer.audio = audio;
    peer.video = video;
    setBadge(id, 'mic', !audio);
    setBadge(id, 'cam', !video);
    setCamVisual(id, !video);
  });

  socket.on('chat', (data) => {
    appendChatMessage('other', data.text, data.name, data.at, data.file);
    if (!chatOpen) {
      unreadChatCount++;
      updateChatBadge();
    }
  });

  // Incoming whiteboard stroke
  socket.on('draw-stroke', (data) => {
    drawLineOnCanvas(data, false);
  });

  socket.on('clear-whiteboard', () => {
    clearLocalCanvas();
    toast('Whiteboard was cleared');
  });
}

function leaveRoom() {
  roomCode = null;
  myId = null;
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  for (const id in peers) {
    if (peers[id].pc) {
      peers[id].pc.close();
    }
    delete peers[id];
  }
  $('#grid').innerHTML = '';
  $('#chat-messages').innerHTML = '';
  setChatOpen(false);
  setWhiteboardOpen(false);
  history.replaceState(null, '', location.pathname);
  updateControlsAvailability();

  if (token) {
    goLobby();
  } else {
    showScreen('auth');
  }
}

$('#btn-leave').onclick = leaveRoom;

// ---------- mic / camera / screen sharing ----------
function updateControlsAvailability() {
  const hasAudio = !!(localStream && localStream.getAudioTracks().length);
  const hasVideo = !!(localStream && localStream.getVideoTracks().length);
  $('#btn-mic').disabled = !hasAudio;
  $('#btn-cam').disabled = !hasVideo;
  $('#btn-screen').disabled = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
}

function broadcastMediaState() {
  if (socket) {
    socket.emit('media-state', { audio: micOn, video: camOn });
  }
}

$('#btn-mic').onclick = () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(track => { track.enabled = micOn; });

  $('#btn-mic').textContent = micOn ? '🎤 Mute' : '🎤 Unmute';
  $('#btn-mic').classList.toggle('off', !micOn);
  if (myId) setBadge(myId, 'mic', !micOn);
  broadcastMediaState();
};

$('#btn-cam').onclick = () => {
  if (!localStream) return;
  camOn = !camOn;
  localStream.getVideoTracks().forEach(track => { track.enabled = camOn; });

  $('#btn-cam').textContent = camOn ? '🎥 Stop video' : '🎥 Start video';
  $('#btn-cam').classList.toggle('off', !camOn);
  if (myId) {
    setCamVisual(myId, !camOn);
    setBadge(myId, 'cam', !camOn);
  }
  broadcastMediaState();
};

$('#btn-screen').onclick = async () => {
  if (screenStream) {
    stopScreenShare();
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];

      screenTrack.onended = () => {
        stopScreenShare();
      };

      for (const id in peers) {
        const pc = peers[id].pc;
        if (pc) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(screenTrack);
          }
        }
      }

      attachStream(myId, screenStream);
      $(`#tile-${myId}`).classList.remove('mine');

      $('#btn-screen').textContent = '🖥️ Stop share';
      $('#btn-screen').classList.add('off');
      toast('Screen sharing started');
    } catch (err) {
      console.warn('Screen share canceled or failed:', err.message);
    }
  }
};

function stopScreenShare() {
  if (!screenStream) return;

  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  const camTrack = localStream ? localStream.getVideoTracks()[0] : null;

  for (const id in peers) {
    const pc = peers[id].pc;
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender && camTrack) {
        sender.replaceTrack(camTrack);
      }
    }
  }

  if (localStream) {
    attachStream(myId, localStream);
    $(`#tile-${myId}`).classList.add('mine');
  }

  $('#btn-screen').textContent = '🖥️ Share screen';
  $('#btn-screen').classList.remove('off');
  toast('Screen sharing stopped');
}

// ---------- chat & file sharing ----------
function setChatOpen(open) {
  chatOpen = open;
  $('#chat-panel').hidden = !open;
  if (open) {
    unreadChatCount = 0;
    updateChatBadge();
    $('#chat-input').focus();
  }
}

function updateChatBadge() {
  const badge = $('#chat-badge');
  if (unreadChatCount > 0) {
    badge.textContent = unreadChatCount;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

$('#toggle-chat').onclick = () => setChatOpen(!chatOpen);
$('#close-chat').onclick = () => setChatOpen(false);

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;

  socket.emit('chat', { text });
  appendChatMessage('mine', text, username, Date.now());
  input.value = '';
});

$('#file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    toast('File exceeds 25 MB limit');
    event.target.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  toast('Uploading ' + file.name + '...');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    const filePayload = {
      url: data.url,
      name: data.originalName,
      size: data.size,
    };

    socket.emit('chat', { text: '', file: filePayload });
    appendChatMessage('mine', '', username, Date.now(), filePayload);
    toast('File shared!');
  } catch (err) {
    toast('Upload failed: ' + err.message);
  } finally {
    event.target.value = '';
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function appendChatMessage(type, text, sender = '', time = Date.now(), file = null) {
  const container = $('#chat-messages');
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg ' + type;

  if (type === 'system') {
    msgEl.textContent = text;
  } else {
    const whoEl = document.createElement('div');
    whoEl.className = 'who';
    const dateStr = new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    whoEl.textContent = (type === 'mine' ? 'You' : sender) + ' · ' + dateStr;
    msgEl.appendChild(whoEl);

    if (text) {
      const bodyEl = document.createElement('div');
      bodyEl.textContent = text;
      msgEl.appendChild(bodyEl);
    }

    if (file) {
      const card = document.createElement('a');
      card.className = 'file-card';
      card.href = file.url;
      card.download = file.name;
      card.target = '_blank';

      card.innerHTML = `
        <span class="file-icon">📄</span>
        <div class="file-info">
          <div class="file-name">${file.name}</div>
          <div class="file-size">${formatBytes(file.size)} · Click to download</div>
        </div>
      `;
      msgEl.appendChild(card);
    }
  }

  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

// ---------- Whiteboard UI & Logic ----------
const canvas = $('#whiteboard-canvas');
const ctx = canvas.getContext('2d');
let drawing = false;
let currentColor = '#f2f3f5';
let currentSize = 4;
let isEraser = false;
let lastX = 0;
let lastY = 0;

function setWhiteboardOpen(open) {
  whiteboardOpen = open;
  $('#whiteboard-container').hidden = !open;
  if (open) {
    resizeCanvas();
  }
}

$('#toggle-whiteboard').onclick = () => setWhiteboardOpen(!whiteboardOpen);
$('#close-whiteboard').onclick = () => setWhiteboardOpen(false);

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  // Save current image data
  const tempImg = ctx.getImageData(0, 0, canvas.width || 1, canvas.height || 1);

  canvas.width = rect.width;
  canvas.height = rect.height;

  // Restore line cap and join
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (tempImg.width > 1 && tempImg.height > 1) {
    ctx.putImageData(tempImg, 0, 0);
  }
}
window.addEventListener('resize', () => {
  if (whiteboardOpen) resizeCanvas();
});

// Color picker buttons
$$('.color-btn').forEach(btn => {
  btn.onclick = () => {
    $$('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentColor = btn.dataset.color;
    isEraser = false;
    $('#wb-eraser').classList.remove('active');
  };
});

// Size slider
$('#wb-size').oninput = (e) => {
  currentSize = parseInt(e.target.value, 10);
};

// Eraser button
$('#wb-eraser').onclick = () => {
  isEraser = !isEraser;
  $('#wb-eraser').classList.toggle('active', isEraser);
};

// Clear button
$('#wb-clear').onclick = () => {
  if (confirm('Clear the whiteboard for everyone?')) {
    clearLocalCanvas();
    if (socket) socket.emit('clear-whiteboard');
  }
};

// Save PNG
$('#wb-save').onclick = () => {
  // Create a temporary canvas with dark background for saving
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const expCtx = exportCanvas.getContext('2d');

  expCtx.fillStyle = '#11141c';
  expCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  expCtx.drawImage(canvas, 0, 0);

  const link = document.createElement('a');
  link.download = `whiteboard-${roomCode || 'meetspace'}-${Date.now()}.png`;
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
  toast('Whiteboard saved as PNG!');
};

function clearLocalCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) / rect.width,  // Normalized 0 to 1
    y: (clientY - rect.top) / rect.height, // Normalized 0 to 1
  };
}

function startDrawing(e) {
  drawing = true;
  const pos = getCanvasCoords(e);
  lastX = pos.x;
  lastY = pos.y;
}

function drawMove(e) {
  if (!drawing) return;
  e.preventDefault();

  const pos = getCanvasCoords(e);
  const stroke = {
    x0: lastX,
    y0: lastY,
    x1: pos.x,
    y1: pos.y,
    color: isEraser ? '#11141c' : currentColor,
    size: isEraser ? currentSize * 3 : currentSize,
    isEraser,
  };

  drawLineOnCanvas(stroke, true);
  if (socket) {
    socket.emit('draw-stroke', stroke);
  }

  lastX = pos.x;
  lastY = pos.y;
}

function stopDrawing() {
  drawing = false;
}

canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', drawMove);
window.addEventListener('mouseup', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, { passive: false });
canvas.addEventListener('touchmove', drawMove, { passive: false });
window.addEventListener('touchend', stopDrawing);

function drawLineOnCanvas(stroke, isLocal) {
  if (canvas.width === 0 || canvas.height === 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
  }

  ctx.lineWidth = stroke.size;
  ctx.beginPath();
  ctx.moveTo(stroke.x0 * canvas.width, stroke.y0 * canvas.height);
  ctx.lineTo(stroke.x1 * canvas.width, stroke.y1 * canvas.height);
  ctx.stroke();
  ctx.restore();
}

// ---------- people tiles ----------
function addTile(id, label, isMine, audio, video) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isMine ? ' mine' : '');
  tile.id = 'tile-' + id;

  const videoEl = document.createElement('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  if (isMine) videoEl.muted = true;
  tile.appendChild(videoEl);

  const placeholder = document.createElement('div');
  placeholder.className = 'no-camera';
  placeholder.textContent = '📷';
  tile.appendChild(placeholder);

  const badges = document.createElement('div');
  badges.className = 'badges';
  const micBadge = document.createElement('span');
  micBadge.className = 'badge mic-badge';
  micBadge.textContent = '🔇';
  const camBadge = document.createElement('span');
  camBadge.className = 'badge cam-badge';
  camBadge.textContent = '🚫';
  badges.appendChild(micBadge);
  badges.appendChild(camBadge);
  tile.appendChild(badges);

  const nameTag = document.createElement('div');
  nameTag.className = 'label';
  nameTag.textContent = label;
  tile.appendChild(nameTag);

  $('#grid').appendChild(tile);

  setCamVisual(id, !video);
  setBadge(id, 'mic', !audio);
  setBadge(id, 'cam', !video);
}

function attachStream(id, stream) {
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  const video = tile.querySelector('video');
  if (video) video.srcObject = stream;
}

function setCamVisual(id, showPlaceholder) {
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  const video = tile.querySelector('video');
  const placeholder = tile.querySelector('.no-camera');
  if (video) video.hidden = showPlaceholder;
  if (placeholder) placeholder.hidden = !showPlaceholder;
}

function setBadge(id, type, show) {
  const tile = document.getElementById('tile-' + id);
  if (!tile) return;
  const badge = tile.querySelector('.' + type + '-badge');
  if (badge) badge.hidden = !show;
}

function removeTile(id) {
  const tile = document.getElementById('tile-' + id);
  if (tile) {
    tile.remove();
  }
}

function updateCount() {
  const count = Object.keys(peers).length + 1;
  $('#room-count').textContent = '· ' + count + ' in call';
}

// ---------- invite link ----------
$('#copy-link').onclick = async () => {
  const link = location.origin + '/?room=' + encodeURIComponent(roomCode);
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch (err) {
    prompt('Copy this invite link:', link);
  }
};

// ---------- start ----------
setMode('login');
if (token && username) {
  goLobby();
} else {
  showScreen('auth');
}