require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';
const PORT = process.env.PORT || 10000;

if (!JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET не задан — задайте его в .env для безопасной авторизации');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ База данных MongoDB подключена!'))
  .catch((err) => console.error('❌ Ошибка MongoDB:', err));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'context_uploads' },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getOnlineUsernames() {
  return [...userSockets.keys()];
}

function broadcastPresence(username, online) {
  io.emit('presence_update', { username, online });
}

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  email: { type: String, unique: true },
  password: String,
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema(
  {
    sender: String,
    receiver: String,
    text: String,
    fileUrl: String,
    fileName: String,
    time: String,
  },
  { timestamps: true }
);
const Message = mongoose.model('Message', MessageSchema);

/** username → Set<socketId> */
const userSockets = new Map();

function createToken(user) {
  const secret = JWT_SECRET || 'dev-only-insecure-secret';
  return jwt.sign(
    { username: user.username, email: user.email },
    secret,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  const secret = JWT_SECRET || 'dev-only-insecure-secret';
  return jwt.verify(token, secret);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Требуется авторизация' });
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Сессия истекла — войдите снова' });
  }
}

function addSocket(username, socketId) {
  if (!userSockets.has(username)) userSockets.set(username, new Set());
  userSockets.get(username).add(socketId);
}

function removeSocket(username, socketId) {
  const set = userSockets.get(username);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(username);
}

function emitToUser(username, event, data) {
  const sockets = userSockets.get(username);
  if (!sockets) return;
  for (const id of sockets) {
    io.to(id).emit(event, data);
  }
}

// ——— REST ———

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      return res.json({ success: false, message: 'Имя или Email уже заняты' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashedPassword });
    const token = createToken(user);
    res.json({ success: true, username: user.username, token });
  } catch {
    res.json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (user && (await bcrypt.compare(password, user.password))) {
      const token = createToken(user);
      return res.json({ success: true, username: user.username, token });
    }
    res.json({ success: false, message: 'Неверные данные' });
  } catch {
    res.json({ success: false, message: 'Ошибка сервера' });
  }
});

app.get('/users', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const q = String(req.query.q || '').trim();

  const filter = { username: { $ne: me } };
  if (q.length > 0) {
    filter.username = { $ne: me, $regex: escapeRegex(q), $options: 'i' };
  }

  const users = await User.find(filter, 'username').limit(80).lean();
  if (!users.length) return res.json([]);

  const usernames = users.map((u) => u.username);
  const lastMessages = await Message.aggregate([
    {
      $match: {
        $or: [
          { sender: me, receiver: { $in: usernames } },
          { sender: { $in: usernames }, receiver: me },
        ],
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: {
          $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'],
        },
        text: { $first: '$text' },
        time: { $first: '$time' },
        createdAt: { $first: '$createdAt' },
      },
    },
  ]);

  const lastMap = Object.fromEntries(lastMessages.map((m) => [m._id, m]));

  const result = users.map((u) => ({
    username: u.username,
    online: userSockets.has(u.username),
    lastMessage: lastMap[u.username]?.text?.slice(0, 80) || null,
    lastTime: lastMap[u.username]?.time || null,
    lastActivity: lastMap[u.username]?.createdAt || null,
  }));

  result.sort((a, b) => {
    const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return a.username.localeCompare(b.username, 'ru');
  });

  res.json(result);
});

app.post('/upload', authMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Файл слишком большой (макс. 10 МБ)'
          : err.message || 'Ошибка загрузки';
      return res.status(400).json({ success: false, message: msg });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Файл не выбран' });
    }
    const fileUrl = req.file.path || req.file.secure_url;
    if (!fileUrl) {
      return res.status(500).json({ success: false, message: 'Cloudinary не вернул ссылку' });
    }
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    res.json({ success: true, fileUrl, originalName });
  });
});

app.get('/search/files', authMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const me = req.user.username;
  const messages = await Message.find({
    fileUrl: { $exists: true, $nin: [null, ''] },
    $and: [
      { $or: [{ sender: me }, { receiver: me }] },
      { $or: [{ fileName: { $regex: q, $options: 'i' } }, { text: { $regex: q, $options: 'i' } }] },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  res.json(
    messages.map((m) => ({
      file: m.fileName || m.text || 'Файл',
      fileUrl: m.fileUrl,
      sender: m.sender,
      receiver: m.receiver,
      peer: m.sender === me ? m.receiver : m.sender,
      time: m.time,
    }))
  );
});

app.get('/search/web', authMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const { data } = await axios.get('https://api.duckduckgo.com/', {
      params: { q, format: 'json', no_redirect: 1, no_html: 1 },
      timeout: 10000,
    });

    const results = [];
    if (data.AbstractURL && data.Abstract) {
      results.push({
        title: data.Heading || q,
        snippet: data.Abstract,
        url: data.AbstractURL,
      });
    }

    for (const item of data.RelatedTopics || []) {
      if (item.Text && item.FirstURL) {
        results.push({
          title: item.Text.split(' - ')[0],
          snippet: item.Text,
          url: item.FirstURL,
        });
      } else if (item.Topics) {
        for (const sub of item.Topics) {
          if (sub.Text && sub.FirstURL) {
            results.push({
              title: sub.Text.split(' - ')[0],
              snippet: sub.Text,
              url: sub.FirstURL,
            });
          }
        }
      }
      if (results.length >= 10) break;
    }

    if (results.length === 0) {
      results.push({
        title: `Поиск: ${q}`,
        snippet: 'Откройте полные результаты в DuckDuckGo',
        url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
      });
    }

    res.json(results.slice(0, 10));
  } catch (err) {
    console.error('Web search error:', err.message);
    res.status(500).json([]);
  }
});

// ——— Socket.io ———

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  addSocket(username, socket.id);
  console.log(`🔌 ${username} подключился`);

  socket.emit('presence_list', { online: getOnlineUsernames() });
  broadcastPresence(username, true);

  socket.on('disconnect', () => {
    removeSocket(username, socket.id);
    broadcastPresence(username, userSockets.has(username));
    console.log(`🔌 ${username} отключился`);
  });

  socket.on('load_messages', async ({ them }) => {
    if (!them || typeof them !== 'string') return;

    const peer = await User.findOne({ username: them });
    if (!peer) return;

    const messages = await Message.find({
      $or: [
        { sender: username, receiver: them },
        { sender: them, receiver: username },
      ],
    }).sort({ createdAt: 1 });

    socket.emit(
      'message_history',
      messages.map((m) => ({
        sender: m.sender,
        receiver: m.receiver,
        text: m.text,
        file: m.fileUrl,
        originalName: m.fileName,
        time: m.time,
      }))
    );
  });

  socket.on('typing', ({ to }) => {
    if (!to) return;
    emitToUser(to, 'user_typing', { from: username, to });
  });

  socket.on('send_message', async (data) => {
    const { receiver, text, file, originalName } = data || {};
    if (!receiver || (!text?.trim() && !file)) return;

    const peer = await User.findOne({ username: receiver });
    if (!peer) return;

    const now = new Date();
    const timeString = now.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });

    const msg = {
      sender: username,
      receiver,
      text: text?.trim() || '',
      file: file || null,
      originalName: originalName || null,
      time: timeString,
    };

    await Message.create({
      sender: msg.sender,
      receiver: msg.receiver,
      text: msg.text,
      fileUrl: msg.file,
      fileName: msg.originalName,
      time: msg.time,
    });

    emitToUser(username, 'receive_message', msg);
    if (receiver !== username) {
      emitToUser(receiver, 'receive_message', msg);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 CONTEXT запущен на порту ${PORT}`);
});
