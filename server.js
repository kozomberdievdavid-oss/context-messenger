require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const bcrypt = require('bcryptjs'); // Подключили шифрование

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json()); // ВАЖНО: чтобы сервер понимал JSON

// Подключение к базе
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ База данных MongoDB подключена!'))
    .catch(err => console.error('❌ Ошибка MongoDB:', err));

// Настройка облака для файлов
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'context_uploads' },
});
const upload = multer({ storage: storage });

// База пользователей (теперь с почтой)
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    email: { type: String, unique: true },
    password: String
});
const User = mongoose.model('User', UserSchema);

// База сообщений
const MessageSchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    text: String,
    fileUrl: String,
    fileName: String,
    time: String
}, { timestamps: true });
const Message = mongoose.model('Message', MessageSchema);

// ==========================================
// МАРШРУТЫ (ROUTES)
// ==========================================

// РЕГИСТРАЦИЯ
app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) return res.json({ success: false, message: 'Имя или Email уже заняты' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, email, password: hashedPassword });
        res.json({ success: true });
    } catch (e) { 
        res.json({ success: false, message: 'Ошибка сервера' }); 
    }
});

// ВХОД
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email });
        if (user && await bcrypt.compare(password, user.password)) {
            res.json({ success: true, username: user.username, email: user.email });
        } else {
            res.json({ success: false, message: 'Неверные данные' });
        }
    } catch (e) {
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

// Загрузка контактов
app.get('/users', async (req, res) => {
    const users = await User.find({}, 'username');
    res.json(users);
});

// Загрузка файла
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('Нет файла');
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    res.json({ fileUrl: req.file.path, originalName: originalName });
});

// ==========================================
// СОКЕТЫ (РЕАЛТАЙМ)
// ==========================================
io.on('connection', (socket) => {
    
    // Загрузка истории переписки
    socket.on('load_messages', async ({ me, them }) => {
        const messages = await Message.find({
            $or: [
                { sender: me, receiver: them },
                { sender: them, receiver: me }
            ]
        }).sort({ createdAt: 1 });
        
        const formatted = messages.map(m => ({
            sender: m.sender, receiver: m.receiver, text: m.text, 
            file: m.fileUrl, originalName: m.fileName, time: m.time
        }));
        socket.emit('message_history', formatted);
    });

    // Кто-то печатает...
    socket.on('typing', ({ from, to }) => {
        socket.broadcast.emit('user_typing', { from, to });
    });

    // Отправка нового сообщения
    socket.on('send_message', async (data) => {
        const now = new Date();
        const timeString = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const msg = { ...data, time: timeString };

        // Сохраняем в базу
        await Message.create({
            sender: msg.sender,
            receiver: msg.receiver,
            text: msg.text,
            fileUrl: msg.file,
            fileName: msg.originalName,
            time: msg.time
        });

        // Рассылаем всем
        io.emit('receive_message', msg);
    });
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}!`);
});