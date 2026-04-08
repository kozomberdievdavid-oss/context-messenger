const socket = io();
let myUsername = '';
let currentChatUser = '';
let currentMode = 'users'; // 'users', 'files', 'web'

// 1. Авторизация
async function login() {
    const user = document.getElementById('username-input').value;
    const pass = document.getElementById('password-input').value;
    
    try {
        const res = await fetch('/login', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Bypass-Tunnel-Reminder': 'true' // <-- Вот эта магия спасет мобильный вход!
            },
            body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json();
        
        if (data.success) {
            myUsername = data.username;
            document.getElementById('login-screen').style.display = 'none';
            document.getElementById('chat-screen').style.display = 'flex';
            document.getElementById('my-name').innerText = `Я: ${myUsername}`;
            loadUsers();
        } else {
            document.getElementById('login-error').innerText = data.message;
        }
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('login-error').innerText = 'Ошибка соединения';
    }
}

// 2. Переключение вкладок левой панели
function setMode(mode) {
    currentMode = mode;
    document.getElementById('search-input').value = '';
    if (mode === 'users') loadUsers();
    else document.getElementById('sidebar-list').innerHTML = '<li style="text-align:center;">Введите запрос...</li>';
}

// Загрузка контактов
async function loadUsers() {
    const res = await fetch('/users');
    const users = await res.json();
    const list = document.getElementById('sidebar-list');
    list.innerHTML = '';
    users.forEach(u => {
        if(u.username !== myUsername) {
            const li = document.createElement('li');
            li.innerText = u.username;
            li.onclick = () => openChat(u.username);
            list.appendChild(li);
        }
    });
}

// 3. Открытие чата с пользователем
function openChat(username) {
    currentChatUser = username;
    document.getElementById('current-chat-user').innerText = `Диалог с: ${username}`;
    document.getElementById('input-area').style.display = 'flex';
    // Запрашиваем историю
    socket.emit('load_messages', { me: myUsername, them: username });
}

// 4. Отправка сообщений
function sendMessage() {
    const input = document.getElementById('message-input');
    if (!input.value.trim() || !currentChatUser) return;
    
    socket.emit('send_message', {
        sender: myUsername,
        receiver: currentChatUser,
        text: input.value
    });
    input.value = '';
}

// 5. Загрузка файла в чат
async function uploadFile() {
    const file = document.getElementById('file-input').files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    // Отправляем сообщение со ссылкой на файл
    socket.emit('send_message', {
        sender: myUsername,
        receiver: currentChatUser,
        text: `📎 Отправлен файл: ${data.originalName}`,
        file: data.fileName
    });
}

// 6. Получение сообщений (Реалтайм и История)
socket.on('message_history', (messages) => {
    document.getElementById('messages-container').innerHTML = '';
    messages.forEach(displayMessage);
});

socket.on('receive_message', (msg) => {
    // Показываем, только если это сообщение из текущего диалога
    if (
        (msg.sender === myUsername && msg.receiver === currentChatUser) ||
        (msg.sender === currentChatUser && msg.receiver === myUsername)
    ) {
        displayMessage(msg);
    }
});

function displayMessage(msg) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `message ${msg.sender === myUsername ? 'mine' : ''}`;
    
    let content = `<b>${msg.sender}</b>: ${msg.text}`;
    if (msg.file) {
        // Если это картинка, показываем её, иначе даем ссылку
        if(msg.file.match(/\.(jpg|jpeg|png|gif)$/i)) {
            content += `<br><img src="/uploads/${msg.file}" style="max-width: 200px; margin-top:10px; border-radius:4px;">`;
        } else {
            content += `<br><a href="/uploads/${msg.file}" target="_blank" style="color:inherit;">Скачать файл</a>`;
        }
    }
    
    div.innerHTML = `${content} <span class="time">${msg.time}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight; // Скролл вниз
}

// 7. Поиск (Файлы и Веб)
async function handleSearch() {
    const query = document.getElementById('search-input').value;
    if (query.length < 2) return;

    const list = document.getElementById('sidebar-list');
    
    if (currentMode === 'files') {
        const res = await fetch(`/search/files?q=${query}`);
        const files = await res.json();
        list.innerHTML = files.map(f => `<li>📎 ${f.file} <br><small>От: ${f.sender}</small></li>`).join('');
    } 
    else if (currentMode === 'web') {
        list.innerHTML = '<li>Ищем...</li>';
        const res = await fetch(`/search/web?q=${query}`);
        const results = await res.json();
        list.innerHTML = results.map(r => `
            <li class="search-result">
                <a href="${r.link}" target="_blank">${r.title}</a>
                <p>${r.snippet}...</p>
            </li>
        `).join('');
    }
}