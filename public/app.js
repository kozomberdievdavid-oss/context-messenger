const typingIndicator = document.getElementById('typing-indicator');
const messageSound = new Audio(
  'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3'
);

let socket = null;
let myUsername = '';
let authToken = '';
let currentChatUser = '';
let currentMode = 'users';
let typingTimeout;

function getToken() {
  return localStorage.getItem('context_token') || '';
}

async function apiFetch(url, options = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  const isFormData = options.body instanceof FormData;
  if (options.body != null && !isFormData) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  return res;
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: getToken() } });

  socket.on('connect_error', () => {
    document.getElementById('login-error').innerText =
      'Не удалось подключиться. Войдите снова.';
    logout();
  });

  socket.on('message_history', (messages) => {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';
    container.classList.remove('messages-empty-hint');
    messages.forEach(displayMessage);
  });

  socket.on('receive_message', (msg) => {
    const inThread =
      (msg.sender === myUsername && msg.receiver === currentChatUser) ||
      (msg.sender === currentChatUser && msg.receiver === myUsername);

    if (inThread) {
      const container = document.getElementById('messages-container');
      if (container.querySelector('.empty-chat')) {
        container.innerHTML = '';
        container.classList.remove('messages-empty-hint');
      }
      displayMessage(msg);
      if (msg.sender !== myUsername) messageSound.play().catch(() => {});
    }
    updateSidebarPreview(msg);
  });

  socket.on('user_typing', ({ from, to }) => {
    if (to === myUsername && from === currentChatUser) {
      typingIndicator.textContent = `${from} печатает...`;
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        typingIndicator.textContent = '';
      }, 2000);
    }
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function showChatScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'flex';
}

window.onload = () => {
  const savedUser = localStorage.getItem('context_user');
  const savedToken = getToken();
  if (savedUser && savedToken) {
    myUsername = savedUser;
    authToken = savedToken;
    showChatScreen();
    connectSocket();
    loadUsers();
  }
};

async function auth(type) {
  const user = document.getElementById('username-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const pass = document.getElementById('password-input').value;

  const payload =
    type === 'login'
      ? { email, password: pass }
      : { username: user, email, password: pass };

  try {
    const res = await fetch(type === 'login' ? '/login' : '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.success && data.token) {
      myUsername = data.username;
      authToken = data.token;
      localStorage.setItem('context_user', data.username);
      localStorage.setItem('context_token', data.token);
      showChatScreen();
      connectSocket();
      loadUsers();
      if (type === 'register') {
        document.getElementById('login-error').innerText = '';
      }
    } else {
      document.getElementById('login-error').innerText =
        data.message || 'Ошибка авторизации';
    }
  } catch (err) {
    console.error(err);
    document.getElementById('login-error').innerText = 'Ошибка соединения';
  }
}

function logout() {
  localStorage.removeItem('context_user');
  localStorage.removeItem('context_token');
  if (socket) socket.disconnect();
  location.reload();
}

function setMode(mode, btn) {
  currentMode = mode;
  document.getElementById('search-input').value = '';
  document.querySelectorAll('.search-tabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const placeholders = {
    users: 'Найти пользователя...',
    files: 'Поиск по файлам в чатах...',
    web: 'Поиск в интернете...',
  };
  document.getElementById('search-input').placeholder = placeholders[mode] || 'Поиск...';

  if (mode === 'users') loadUsers();
  else {
    document.getElementById('sidebar-list').innerHTML =
      '<li class="sidebar-hint">Введите запрос (мин. 2 символа)</li>';
  }
}

async function loadUsers() {
  try {
    const res = await apiFetch('/users');
    const users = await res.json();
    const list = document.getElementById('sidebar-list');
    list.innerHTML = '';

    if (!users.length) {
      list.innerHTML = '<li class="sidebar-hint">Пока нет других пользователей</li>';
      return;
    }

    users.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'user-item';
      li.dataset.username = u.username;
      li.innerHTML = `<span class="user-name">${escapeHtml(u.username)}</span>`;
      li.onclick = () => openChat(u.username, li);
      list.appendChild(li);
    });
  } catch (e) {
    console.error(e);
  }
}

function openChat(username, liEl) {
  currentChatUser = username;
  document.getElementById('current-chat-user').textContent = username;
  document.getElementById('input-area').style.display = 'flex';
  typingIndicator.textContent = '';

  document.querySelectorAll('#sidebar-list .user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.username === username);
  });
  if (liEl) liEl.classList.add('active');

  const container = document.getElementById('messages-container');
  container.innerHTML = '<p class="empty-chat loading">Загрузка...</p>';

  if (socket?.connected) {
    socket.emit('load_messages', { them: username });
  }
}

function sendMessage() {
  const input = document.getElementById('message-input');
  if (!input.value.trim() || !currentChatUser || !socket) return;

  socket.emit('send_message', {
    receiver: currentChatUser,
    text: input.value.trim(),
  });
  input.value = '';
}

async function uploadFile() {
  const file = document.getElementById('file-input').files[0];
  if (!file || !currentChatUser) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.fileUrl) return;

    socket.emit('send_message', {
      receiver: currentChatUser,
      text: `📎 ${data.originalName}`,
      file: data.fileUrl,
      originalName: data.originalName,
    });
    document.getElementById('file-input').value = '';
  } catch (e) {
    console.error(e);
    alert('Не удалось загрузить файл');
  }
}

function displayMessage(msg) {
  const container = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.className = `message ${msg.sender === myUsername ? 'mine' : 'theirs'}`;

  let body = `<b>${escapeHtml(msg.sender)}</b><span class="msg-text">${escapeHtml(msg.text)}</span>`;

  if (msg.file) {
    if (
      msg.file.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) ||
      msg.file.includes('/image/')
    ) {
      body += `<img src="${escapeHtml(msg.file)}" alt="image" loading="lazy" />`;
    } else {
      const name = escapeHtml(msg.originalName || 'Скачать файл');
      body += `<a class="file-link" href="${escapeHtml(msg.file)}" target="_blank" rel="noopener">${name}</a>`;
    }
  }

  div.innerHTML = `${body}<span class="time">${escapeHtml(msg.time || '')}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function updateSidebarPreview(msg) {
  const peer = msg.sender === myUsername ? msg.receiver : msg.sender;
  const item = document.querySelector(`#sidebar-list .user-item[data-username="${peer}"]`);
  if (!item) return;
  let preview = item.querySelector('.preview');
  if (!preview) {
    preview = document.createElement('span');
    preview.className = 'preview';
    item.appendChild(preview);
  }
  preview.textContent = (msg.text || '📎 Файл').slice(0, 40);
}

let typingDebounce;
document.getElementById('message-input').addEventListener('input', () => {
  if (!currentChatUser || !socket) return;
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    socket.emit('typing', { to: currentChatUser });
  }, 300);
});

let searchDebounce;
async function handleSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 350);
}

async function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  const list = document.getElementById('sidebar-list');

  if (currentMode === 'users') {
    if (!query) return loadUsers();
    list.querySelectorAll('.user-item').forEach((li) => {
      const name = li.dataset.username?.toLowerCase() || '';
      li.style.display = name.includes(query.toLowerCase()) ? '' : 'none';
    });
    return;
  }

  if (query.length < 2) {
    list.innerHTML = '<li class="sidebar-hint">Введите минимум 2 символа</li>';
    return;
  }

  if (currentMode === 'files') {
    list.innerHTML = '<li class="sidebar-hint">Ищем файлы...</li>';
    try {
      const res = await apiFetch(`/search/files?q=${encodeURIComponent(query)}`);
      const files = await res.json();
      list.innerHTML = '';
      if (!files.length) {
        list.innerHTML = '<li class="sidebar-hint">Файлы не найдены</li>';
        return;
      }
      files.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'search-result';
        li.innerHTML = `
          <span class="material-icons">attach_file</span>
          <div>
            <strong>${escapeHtml(f.file)}</strong>
            <small>От ${escapeHtml(f.sender)} · чат с ${escapeHtml(f.peer)}</small>
          </div>`;
        li.onclick = () => openChat(f.peer);
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li class="sidebar-hint">Ошибка поиска</li>';
    }
    return;
  }

  if (currentMode === 'web') {
    list.innerHTML = '<li class="sidebar-hint">Ищем в интернете...</li>';
    try {
      const res = await apiFetch(`/search/web?q=${encodeURIComponent(query)}`);
      const results = await res.json();
      list.innerHTML = '';
      if (!results.length) {
        list.innerHTML = '<li class="sidebar-hint">Ничего не найдено</li>';
        return;
      }
      results.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'search-result web';
        li.innerHTML = `
          <div>
            <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title)}</strong></a>
            <p>${escapeHtml((r.snippet || '').slice(0, 120))}</p>
          </div>`;
        list.appendChild(li);
      });
    } catch (e) {
      list.innerHTML = '<li class="sidebar-hint">Ошибка веб-поиска</li>';
    }
  }
}
