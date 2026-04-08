require('dotenv').config(); // Загружаем секретные ключи
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// --- НАСТРОЙКА MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ База данных MongoDB подключена!'))
    .catch(err => console.error('❌ Ошибка MongoDB:', err));

// Создаем схемы (как будут выглядеть данные в базе)
const UserSchema = new mongoose.Schema({ username: String, password: String });
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    text: String,
    fileUrl: String, // Теперь здесь полная ссылка на Cloudinary
    fileName: String,
    time: String,
    createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- НАСТРОЙКА CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'context_messenger', // Папка внутри твоего Cloudinary
        resource_type: 'auto' // Принимать и картинки, и другие файлы
    }
});
const upload = multer({ storage: storage });

// --- API ПРОЕКТА ---

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    let user = await User.findOne({ username });
    
    if (!user) {
        user = await User.create({ username, password });
        res.json({ success: true, username });
    } else if (user.password === password) {
        res.json({ success: true, username });
    } else {
        res.json({ success: false, message: 'Неверный пароль' });
    }
});

app.get('/users', async (req, res) => {
    const users = await User.find({}, 'username');
    res.json(users);
});

// Загрузка файла летит напрямую в Cloudinary!
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('Нет файла');
    // req.file.path - это готовая ссылка на файл в интернете от Cloudinary
    res.json({ fileUrl: req.file.path, originalName: req.file.originalname });
});

app.get('/search/files', async (req, res) => {
    const query = req.query.q;
    // Ищем файлы по оригинальному имени (без учета регистра)
    const messages = await Message.find({ fileName: { $regex: query, $options: 'i' } });
    
    // Форматируем для фронтенда
    const formatted = messages.map(m => ({ file: m.fileName, sender: m.sender, url: m.fileUrl }));
    res.json(formatted);
});

app.get('/search/web', async (req, res) => {
    try {
        const query = req.query.q;
        const url = `https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'ContextMessenger/1.0 (test)' } });
        const results = response.data.query.search.map(item => ({
            title: item.title,
            snippet: item.snippet.replace(/<\/?[^>]+(>|$)/g, ""),
            link: `https://ru.wikipedia.org/wiki/${encodeURIComponent(item.title)}`
        }));
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка поиска' });
    }
});

// --- СИСТЕМА ЧАТА (Socket.io) ---
io.on('connection', (socket) => {
    socket.on('load_messages', async ({ me, them }) => {
        const messages = await Message.find({
            $or: [
                { sender: me, receiver: them },
                { sender: them, receiver: me }
            ]
        }).sort({ createdAt: 1 });
        
        // Преобразуем для старого фронтенда
        const formatted = messages.map(m => ({
            sender: m.sender, receiver: m.receiver, text: m.text, 
            file: m.fileUrl, originalName: m.fileName, time: m.time
        }));
        socket.emit('message_history', formatted);
    });

    socket.on('send_message', async (data) => {
        const time = new Date().toLocaleTimeString().slice(0, 5);
        const msgData = { ...data, time };
        
        // Сохраняем в MongoDB
        await Message.create({
            sender: msgData.sender,
            receiver: msgData.receiver,
            text: msgData.text,
            fileUrl: msgData.file || '',
            fileName: msgData.originalName || '',
            time: msgData.time
        });
        
        io.emit('receive_message', msgData);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}!`);
});