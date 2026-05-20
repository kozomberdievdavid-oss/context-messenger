const typingIndicator = document.getElementById('typing-indicator');
const messageSound = new Audio(
  'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3'
);

let socket = null;
let myUsername = '';
let currentChatUser = '';
let currentMode = 'users';
let typingTimeout;
let allUsersCache = [];
const onlineUsers = new Set();

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

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function avatarLetter(name) {
  return (name?.[0] || '?').toUpperCase();
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: getToken() } });

  socket.on('connect_error', () => {
    document.getElementById('login-error').innerText =
      'Не удалось подключиться. Войдите снова.';
    logout();
  });

  socket.on('presence_list', ({ online }) => {
    onlineUsers.clear();
    online.forEach((u) => onlineUsers.add(u));
    refreshOnlineIndicators();
  });

  socket.on('presence_update', ({ username, online }) => {
    if (online) onlineUsers.add(username);
    else onlineUsers.delete(username);
    refreshOnlineIndicators();
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
    if (currentMode === 'users' && !document.getElementById('search-input').value.trim()) {
      loadUsers();
    }
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

function refreshOnlineIndicators() {
  document.querySelectorAll('#sidebar-list .user-item').forEach((li) => {
    const u = li.dataset.username;
    const dot = li.querySelector('.online-dot');
    if (dot) dot.classList.toggle('is-online', onlineUsers.has(u));
  });
  const headerDot = document.getElementById('chat-header-online');
  if (headerDot && currentChatUser) {
    const on = onlineUsers.has(currentChatUser);
    headerDot.classList.toggle('is-online', on);
    const statusEl = document.getElementById('chat-header-status');
    if (statusEl) statusEl.textContent = on ? 'в сети' : '';
  }
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
      localStorage.setItem('context_user', data.username);
      localStorage.setItem('context_token', data.token);
      showChatScreen();
      connectSocket();
      loadUsers();
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

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  if (currentMode === 'users') loadUsers();
}

function setMode(mode, btn) {
  currentMode = mode;
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  document.querySelectorAll('.search-tabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const placeholders = {
    users: 'Поиск по имени...',
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

function renderUserItem(u, query = '') {
  const li = document.createElement('li');
  li.className = 'user-item';
  if (currentChatUser === u.username) li.classList.add('active');
  li.dataset.username = u.username;

  const online = u.online || onlineUsers.has(u.username);
  const preview = u.lastMessage
    ? escapeHtml(u.lastMessage.slice(0, 50))
    : '<span class="no-chat">Нет сообщений — напишите первым</span>';
  const time = u.lastTime ? `<span class="chat-time">${escapeHtml(u.lastTime)}</span>` : '';

  li.innerHTML = `
    <div class="avatar">${escapeHtml(avatarLetter(u.username))}</div>
    <div class="chat-meta">
      <div class="chat-row-top">
        <span class="user-name">${highlightMatch(u.username, query)}</span>
        ${time}
      </div>
      <div class="chat-row-bottom">
        <span class="preview">${preview}</span>
        <span class="online-dot ${online ? 'is-online' : ''}" title="${online ? 'в сети' : 'не в сети'}"></span>
      </div>
    </div>`;

  li.onclick = () => openChat(u.username, li);
  return li;
}

async function loadUsers(query = '') {
  const list = document.getElementById('sidebar-list');
  list.innerHTML = '<li class="sidebar-hint">Загрузка...</li>';

  try {
    const url = query
      ? `/users?q=${encodeURIComponent(query)}`
      : '/users';
    const res = await apiFetch(url);
    const users = await res.json();
    allUsersCache = users;
    list.innerHTML = '';

    if (!users.length) {
      list.innerHTML = query
        ? '<li class="sidebar-hint">Пользователи не найдены</li>'
        : '<li class="sidebar-hint">Пока нет других пользователей</li>';
      return;
    }

    if (query) {
      const header = document.createElement('li');
      header.className = 'sidebar-section';
      header.textContent = 'Результаты поиска';
      list.appendChild(header);
    } else {
      const withChat = users.filter((u) => u.lastMessage);
      const withoutChat = users.filter((u) => !u.lastMessage);
      if (withChat.length) {
        const h = document.createElement('li');
        h.className = 'sidebar-section';
        h.textContent = 'Недавние';
        list.appendChild(h);
        withChat.forEach((u) => list.appendChild(renderUserItem(u)));
      }
      if (withoutChat.length) {
        const h = document.createElement('li');
        h.className = 'sidebar-section';
        h.textContent = 'Все пользователи';
        list.appendChild(h);
        withoutChat.forEach((u) => list.appendChild(renderUserItem(u)));
      }
      refreshOnlineIndicators();
      return;
    }

    users.forEach((u) => list.appendChild(renderUserItem(u, query)));
    refreshOnlineIndicators();
  } catch (e) {
    console.error(e);
    list.innerHTML = '<li class="sidebar-hint">Ошибка загрузки</li>';
  }
}

function openChat(username, liEl) {
  currentChatUser = username;
  document.getElementById('current-chat-user').textContent = username;
  document.getElementById('input-area').style.display = 'flex';
  typingIndicator.textContent = '';

  const headerOnline = document.getElementById('chat-header-online');
  const isOnline = onlineUsers.has(username);
  if (headerOnline) headerOnline.classList.toggle('is-online', isOnline);
  const statusEl = document.getElementById('chat-header-status');
  if (statusEl) statusEl.textContent = isOnline ? 'в сети' : '';

  document.querySelectorAll('#sidebar-list .user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.username === username);
  });
  if (liEl) liEl.classList.add('active');

  document.getElementById('chat-screen').classList.add('chat-open');

  const container = document.getElementById('messages-container');
  container.innerHTML = '<p class="empty-chat loading">Загрузка...</p>';

  if (socket?.connected) {
    socket.emit('load_messages', { them: username });
  }
}

function closeChatMobile() {
  document.getElementById('chat-screen').classList.remove('chat-open');
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

  if (file.size > 10 * 1024 * 1024) {
    alert('Файл слишком большой. Максимум 10 МБ.');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);

  const attachBtn = document.querySelector('.attach-btn');
  attachBtn?.classList.add('uploading');

  try {
    const res = await apiFetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok || !data.fileUrl) {
      alert(data.message || 'Не удалось загрузить файл');
      return;
    }

    socket.emit('send_message', {
      receiver: currentChatUser,
      text: `📎 ${data.originalName}`,
      file: data.fileUrl,
      originalName: data.originalName,
    });
    document.getElementById('file-input').value = '';
  } catch (e) {
    console.error(e);
    alert('Не удалось загрузить файл. Проверьте Cloudinary в Render.');
  } finally {
    attachBtn?.classList.remove('uploading');
  }
}

function displayMessage(msg) {
  const container = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.className = `message ${msg.sender === myUsername ? 'mine' : 'theirs'}`;

  let body = '';
  if (msg.sender !== myUsername) {
    body += `<b>${escapeHtml(msg.sender)}</b>`;
  }
  body += `<span class="msg-text">${escapeHtml(msg.text)}</span>`;

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

let typingDebounce;
document.getElementById('message-input').addEventListener('input', () => {
  if (!currentChatUser || !socket) return;
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    socket.emit('typing', { to: currentChatUser });
  }, 300);
});

let searchDebounce;
function handleSearch() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  clearBtn.style.display = input.value ? 'flex' : 'none';

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 280);
}

async function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  const list = document.getElementById('sidebar-list');

  if (currentMode === 'users') {
    await loadUsers(query);
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
    } catch {
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
    } catch {
      list.innerHTML = '<li class="sidebar-hint">Ошибка веб-поиска</li>';
    }
  }
}
