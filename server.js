require('dotenv').config();

const path = require('path');
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

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const SEARCH_QUERY_RE = /^[a-zA-Z0-9_]+$/;

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

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.warn('⚠️  Cloudinary не настроен (CLOUDINARY_*) — аватары и файлы не загрузятся');
}

function isValidUsername(username) {
  return USERNAME_RE.test(String(username || ''));
}

function decodeFilename(name) {
  try {
    return Buffer.from(name || 'file', 'latin1').toString('utf8');
  } catch {
    return name || 'file';
  }
}

function cloudinarySafeId(name) {
  const decoded = decodeFilename(name).replace(/\.[^.]+$/, '');
  return decoded.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 80) || 'file';
}

function isAdminEmail(email) {
  const list = (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email || '').toLowerCase());
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isImage = (file.mimetype || '').startsWith('image/');
    const safe = cloudinarySafeId(file.originalname);
    return {
      folder: 'context_uploads',
      resource_type: isImage ? 'image' : 'raw',
      public_id: `${Date.now()}_${safe}`.slice(0, 120),
    };
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const safeUser = String(req.user?.username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = cloudinarySafeId(file.originalname || 'avatar');
    return {
      folder: 'context_avatars',
      resource_type: 'image',
      // Уникальный public_id: иначе все клиенты шлют avatar.jpg и Cloudinary отклоняет повтор
      public_id: `${safeUser}_${Date.now()}_${safeName}`.slice(0, 120),
      transformation: [{ width: 256, height: 256, crop: 'fill', gravity: 'auto' }],
    };
  },
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) cb(null, true);
    else cb(new Error('Допустимы только изображения'));
  },
});

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
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  bio: { type: String, default: '', maxlength: 280 },
  avatarUrl: { type: String, default: '' },
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
    { username: user.username, email: user.email, role: user.role || 'user' },
    secret,
    { expiresIn: JWT_EXPIRES }
  );
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin only' });
  }
  next();
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

app.get('/me', authMiddleware, async (req, res) => {
  const user = await User.findOne(
    { username: req.user.username },
    'username email role bio avatarUrl'
  ).lean();
  if (!user) return res.status(404).json({ success: false });
  res.json({
    username: user.username,
    email: user.email,
    role: user.role || 'user',
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    online: userSockets.has(user.username),
  });
});

app.patch('/me/profile', authMiddleware, async (req, res) => {
  const bio = String(req.body.bio || '').slice(0, 280);
  await User.updateOne({ username: req.user.username }, { bio });
  res.json({ success: true, bio });
});

app.post('/me/avatar', authMiddleware, (req, res) => {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    return res.status(503).json({
      success: false,
      message: 'Cloudinary не настроен на сервере (проверьте CLOUDINARY_* в Render)',
    });
  }
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) {
      console.error('Avatar upload error:', err.message || err);
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Файл слишком большой (макс. 5 МБ)'
          : err.message || 'Ошибка загрузки аватара';
      return res.status(400).json({ success: false, message: msg });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Файл не получен' });
    }
    const avatarUrl = req.file.secure_url || req.file.path || req.file.url;
    if (!avatarUrl) {
      console.error('Avatar upload: no URL in req.file', req.file);
      return res.status(500).json({ success: false, message: 'Не удалось получить URL из Cloudinary' });
    }
    try {
      await User.updateOne({ username: req.user.username }, { avatarUrl });
      res.json({ success: true, avatarUrl });
    } catch (e) {
      console.error('Avatar DB update error:', e);
      res.status(500).json({ success: false, message: 'Ошибка сохранения в базе' });
    }
  });
});

app.get('/users/:username/public', authMiddleware, async (req, res) => {
  const user = await User.findOne(
    { username: req.params.username },
    'username bio avatarUrl'
  ).lean();
  if (!user) return res.status(404).json({ success: false });
  res.json({
    username: user.username,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    online: userSockets.has(user.username),
  });
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!isValidUsername(username)) {
    return res.json({
      success: false,
      message: 'Username: only a-z, A-Z, 0-9, _ (3-20 characters)',
    });
  }
  try {
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      return res.json({ success: false, message: 'Имя или Email уже заняты' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const role = isAdminEmail(email) ? 'admin' : 'user';
    const user = await User.create({ username, email, password: hashedPassword, role });
    const token = createToken(user);
    res.json({ success: true, username: user.username, role: user.role, token });
  } catch {
    res.json({ success: false, message: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (user && (await bcrypt.compare(password, user.password))) {
      if (isAdminEmail(user.email) && user.role !== 'admin') {
        user.role = 'admin';
        await user.save();
      }
      const token = createToken(user);
      return res.json({
        success: true,
        username: user.username,
        role: user.role || 'user',
        token,
      });
    }
    res.json({ success: false, message: 'Неверные данные' });
  } catch {
    res.json({ success: false, message: 'Ошибка сервера' });
  }
});

async function buildChatList(me, peerNames) {
  if (!peerNames.length) return [];
  const users = await User.find(
    { username: { $in: peerNames } },
    'username avatarUrl bio'
  ).lean();
  const lastMessages = await Message.aggregate([
    {
      $match: {
        $or: [
          { sender: me, receiver: { $in: peerNames } },
          { sender: { $in: peerNames }, receiver: me },
        ],
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'] },
        text: { $first: '$text' },
        time: { $first: '$time' },
        createdAt: { $first: '$createdAt' },
      },
    },
  ]);
  const lastMap = Object.fromEntries(lastMessages.map((m) => [m._id, m]));
  return users
    .map((u) => ({
      username: u.username,
      avatarUrl: u.avatarUrl || '',
      bio: u.bio || '',
      online: userSockets.has(u.username),
      lastMessage: lastMap[u.username]?.text?.slice(0, 80) || null,
      lastTime: lastMap[u.username]?.time || null,
      lastActivity: lastMap[u.username]?.createdAt || null,
    }))
    .sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });
}

app.get('/chats', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const peers = await Message.aggregate([
    { $match: { $or: [{ sender: me }, { receiver: me }] } },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$sender', me] }, '$receiver', '$sender'] },
      },
    },
  ]);
  const peerNames = peers.map((p) => p._id).filter((n) => n && n !== me);
  res.json(await buildChatList(me, peerNames));
});

app.get('/users/search', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  if (!SEARCH_QUERY_RE.test(q)) {
    return res.json({
      error: 'Use Latin letters, numbers and _ only',
    });
  }

  const users = await User.find(
    { username: { $ne: me, $regex: escapeRegex(q), $options: 'i' } },
    'username avatarUrl bio'
  )
    .limit(20)
    .lean();

  res.json(
    users.map((u) => ({
      username: u.username,
      avatarUrl: u.avatarUrl || '',
      bio: u.bio || '',
      online: userSockets.has(u.username),
    }))
  );
});

app.delete('/chats/:peer', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const peer = req.params.peer;
  if (!isValidUsername(peer)) {
    return res.status(400).json({ success: false, message: 'Invalid username' });
  }
  const result = await Message.deleteMany({
    $or: [
      { sender: me, receiver: peer },
      { sender: peer, receiver: me },
    ],
  });
  res.json({ success: true, deleted: result.deletedCount });
});

app.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const [usersCount, messagesCount] = await Promise.all([
    User.countDocuments(),
    Message.countDocuments(),
  ]);
  res.json({ usersCount, messagesCount });
});

app.post('/admin/wipe-database', authMiddleware, adminMiddleware, async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (process.env.ADMIN_SECRET && secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ success: false, message: 'Invalid admin secret' });
  }
  await Message.deleteMany({});
  await User.deleteMany({});
  userSockets.clear();
  res.json({ success: true, message: 'Database wiped' });
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
    const originalName = decodeFilename(req.file.originalname);
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
