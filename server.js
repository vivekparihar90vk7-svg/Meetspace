const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const MAX_PEOPLE = 6;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

// ---------- Directories ----------
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- User Store ----------
let users = [];
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
} catch (err) {}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ---------- JWT Secret ----------
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  try {
    JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8');
  } catch (err) {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, JWT_SECRET);
  }
}

function makeToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
}

// ---------- Multer Uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, safeName);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
});

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- Auth Routes ----------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or _' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const hash = await bcrypt.hash(password, 10);
  const taken = users.some(u => u.username.toLowerCase() === username.toLowerCase());
  if (taken) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  users.push({ username, hash, createdAt: Date.now() });
  saveUsers();
  res.json({ token: makeToken(username), username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};

  let user = null;
  if (typeof username === 'string') {
    user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  }

  let passwordOk = false;
  if (user && typeof password === 'string') {
    passwordOk = await bcrypt.compare(password, user.hash);
  }

  if (!passwordOk) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  res.json({ token: makeToken(user.username), username: user.username });
});

// ---------- File Upload Route ----------
app.post('/api/upload', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File exceeds 25 MB limit' });
      }
      return res.status(400).json({ error: 'File upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    res.json({
      url: '/uploads/' + req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  });
});

// ---------- Socket.io Middleware ----------
io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    socket.data.username = payload.username;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

// ---------- Room Management & Whiteboard State ----------
// rooms: roomCode -> { people: Map(socketId -> {name, audio, video}), whiteboard: Array }
const rooms = new Map();

function leaveRoom(socket) {
  const room = socket.data.room;
  if (!room) return;

  socket.data.room = null;
  socket.leave(room);

  const roomData = rooms.get(room);
  if (!roomData) return;

  roomData.people.delete(socket.id);
  socket.to(room).emit('peer-left', { id: socket.id });
  console.log(socket.data.username + ' left room ' + room);

  if (roomData.people.size === 0) {
    rooms.delete(room);
  }
}

io.on('connection', (socket) => {
  const name = socket.data.username;
  console.log(name + ' connected');

  socket.on('join', (data, reply) => {
    if (typeof reply !== 'function') return;

    const room = data && data.room;
    if (typeof room !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(room)) {
      return reply({ error: 'Room code must be 3-40 letters or numbers' });
    }
    if (socket.data.room) {
      return reply({ error: 'You are already in a room' });
    }

    let roomData = rooms.get(room);
    if (!roomData) {
      roomData = { people: new Map(), whiteboard: [] };
      rooms.set(room, roomData);
    }
    if (roomData.people.size >= MAX_PEOPLE) {
      return reply({ error: 'Room is full (max ' + MAX_PEOPLE + ' people)' });
    }

    const others = [];
    for (const [id, person] of roomData.people) {
      others.push({ id, name: person.name, audio: person.audio, video: person.video });
    }

    roomData.people.set(socket.id, { name, audio: true, video: true });
    socket.join(room);
    socket.data.room = room;
    console.log(name + ' joined room ' + room + ' (' + roomData.people.size + ' inside)');

    socket.to(room).emit('peer-joined', { id: socket.id, name, audio: true, video: true });
    
    // Return existing peers + whiteboard history
    reply({ id: socket.id, peers: others, whiteboard: roomData.whiteboard });
  });

  socket.on('signal', (data) => {
    if (!data || typeof data.to !== 'string' || !data.signal) return;
    io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
  });

  socket.on('chat', (data) => {
    const room = socket.data.room;
    if (!room || !data) return;

    socket.to(room).emit('chat', {
      from: socket.id,
      name: name,
      text: data.text || '',
      file: data.file || null,
      at: Date.now(),
    });
  });

  socket.on('media-state', (data) => {
    const room = socket.data.room;
    if (!room) return;
    const roomData = rooms.get(room);
    if (!roomData) return;
    const person = roomData.people.get(socket.id);
    if (!person) return;

    person.audio = !!(data && data.audio);
    person.video = !!(data && data.video);
    socket.to(room).emit('peer-media', { id: socket.id, audio: person.audio, video: person.video });
  });

  // ---------- Whiteboard Events ----------
  socket.on('draw-stroke', (data) => {
    const room = socket.data.room;
    if (!room || !data) return;
    const roomData = rooms.get(room);
    if (!roomData) return;

    roomData.whiteboard.push(data);
    socket.to(room).emit('draw-stroke', data);
  });

  socket.on('clear-whiteboard', () => {
    const room = socket.data.room;
    if (!room) return;
    const roomData = rooms.get(room);
    if (!roomData) return;

    roomData.whiteboard = [];
    socket.to(room).emit('clear-whiteboard');
  });

  socket.on('leave', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    console.log(name + ' disconnected');
    leaveRoom(socket);
  });
});

server.on('error', (err) => {
  console.error('Could not start the server:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('MeetSpace is running on http://localhost:' + PORT);
});