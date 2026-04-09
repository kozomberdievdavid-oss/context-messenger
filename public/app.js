const typingIndicator = document.getElementById('typing-indicator');
const messageSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
const socket = io();
let myUsername = '';
let currentChatUser = '';
let currentMode = 'users';

// 1. Авторизация
window.onload = () => {
    const savedUser = localStorage.getItem('context_user');
    if (savedUser) {
        myUsername = savedUser;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('chat-screen').style.display = 'flex';
        loadUsers();
    }
};

async function auth(type) {
    const user = document.getElementById('username-input').value;
    const email = document.getElementById('email-input').value;
    const pass = document.getElementById('password-input').value;

    const payload = type === 'login' ? { email, password: pass } : { username: user, email, password: pass };
    
    try {
        const res = await fetch(type === 'login' ? '/login' : '/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.success) {
            if (type === 'login') {
                myUsername = data.username;
                localStorage.setItem('context_user', data.username);
                location.reload();
            } else { 
                alert("Успешная регистрация! Теперь нажмите 'Войти'."); 
            }
        } else { 
            document.getElementById('login-error').innerText = data.message; 
        }
    } catch (err) {
        console.error('Ошибка:', err);
        document.getElementById('login-error').innerText = 'Ошибка соединения';
    }
}

function logout() {
    localStorage.removeItem('context_user');
    location.reload();
}

// 2. Переключение вкладок
function setMode(mode) {
    currentMode = mode;
    document.getElementById('search-input').value = '';
    if (mode === 'users') loadUsers();
    else document.getElementById('sidebar-list').innerHTML = '<li style="text-align:center;">Введите запрос...</li>';
}

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

// 3. Чат
function openChat(username) {
    currentChatUser = username;
    document.getElementById('current-chat-user').innerText = `Диалог с: ${username}`;
    document.getElementById('input-area').style.display = 'flex';
    socket.emit('load_messages', { me: myUsername, them: username });
}

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

async function uploadFile() {
    const file = document.getElementById('file-input').files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();

    socket.emit('send_message', {
        sender: myUsername,
        receiver: currentChatUser,
        text: `📎 Отправлен файл: ${data.originalName}`,
        file: data.fileUrl,
        originalName: data.originalName
    });
}

// 4. Отображение и получение сообщений
function displayMessage(msg) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `message ${msg.sender === myUsername ? 'mine' : ''}`;
    
    let content = `<b>${msg.sender}</b>: ${msg.text}`;
    if (msg.file) {
        if(msg.file.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) || msg.file.includes('image')) {
            content += `<br><img src="${msg.file}" style="max-width: 200px; margin-top:10px; border-radius:4px;">`;
        } else {
            content += `<br><a href="${msg.file}" target="_blank" style="color:inherit; text-decoration:underline;">Скачать файл</a>`;
        }
    }
    
    div.innerHTML = `${content} <span class="time">${msg.time}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

socket.on('message_history', (messages) => {
    document.getElementById('messages-container').innerHTML = '';
    messages.forEach(displayMessage);
});

socket.on('receive_message', (msg) => {
    if (
        (msg.sender === myUsername && msg.receiver === currentChatUser) ||
        (msg.sender === currentChatUser && msg.receiver === myUsername)
    ) {
        displayMessage(msg);
        if (msg.sender !== myUsername) messageSound.play(); // Воспроизводим звук
    }
});

// 5. Логика "Кто-то печатает..."
let typingTimeout;
document.getElementById('message-input').addEventListener('input', () => {
    if (currentChatUser) {
        socket.emit('typing', { from: myUsername, to: currentChatUser });
    }
});

socket.on('user_typing', ({ from, to }) => {
    if (to === myUsername && from === currentChatUser) {
        typingIndicator.innerText = `${from} печатает...`;
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => { typingIndicator.innerText = ''; }, 2000);
    }
});

// 6. Поиск
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