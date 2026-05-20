const typingIndicator = document.getElementById('typing-indicator');
const messageSound = new Audio(
  'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3'
);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

let socket = null;
let myUsername = '';
let myEmail = '';
let currentChatUser = '';
let mainTab = 'chats';
let searchMode = 'users';
let typingTimeout;
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
    document.getElementById('login-error').innerText = 'Connection failed. Sign in again.';
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
    loadChats();
  });

  socket.on('user_typing', ({ from, to }) => {
    if (to === myUsername && from === currentChatUser) {
      typingIndicator.textContent = `${from} is typing...`;
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        typingIndicator.textContent = '';
      }, 2000);
    }
  });
}

function refreshOnlineIndicators() {
  document.querySelectorAll('.user-item').forEach((li) => {
    const u = li.dataset.username;
    const dot = li.querySelector('.online-dot');
    if (dot) dot.classList.toggle('is-online', onlineUsers.has(u));
  });
  const headerDot = document.getElementById('chat-header-online');
  if (headerDot && currentChatUser) {
    const on = onlineUsers.has(currentChatUser);
    headerDot.classList.toggle('is-online', on);
    const statusEl = document.getElementById('chat-header-status');
    if (statusEl) statusEl.textContent = on ? 'online' : '';
  }
}

function showChatScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'flex';
}

window.onload = () => {
  const savedUser = localStorage.getItem('context_user');
  if (savedUser && getToken()) {
    myUsername = savedUser;
    showChatScreen();
    connectSocket();
    loadChats();
    loadProfile();
  }
};

async function auth(type) {
  const user = document.getElementById('username-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const pass = document.getElementById('password-input').value;

  if (type === 'register' && !USERNAME_RE.test(user)) {
    document.getElementById('login-error').innerText =
      'Username: only a-z, A-Z, 0-9, _ (3-20 chars)';
    return;
  }

  const payload =
    type === 'login' ? { email, password: pass } : { username: user, email, password: pass };

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
      loadChats();
      loadProfile();
    } else {
      document.getElementById('login-error').innerText = data.message || 'Auth error';
    }
  } catch {
    document.getElementById('login-error').innerText = 'Connection error';
  }
}

function logout() {
  localStorage.removeItem('context_user');
  localStorage.removeItem('context_token');
  if (socket) socket.disconnect();
  location.reload();
}

function switchMainTab(tab, btn) {
  mainTab = tab;
  document.querySelectorAll('.sidebar-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${tab}`).classList.add('active');
  document.querySelectorAll('.main-tabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  if (tab === 'chats') loadChats();
  if (tab === 'search') initSearchPanel();
  if (tab === 'profile') loadProfile();
}

function setSearchMode(mode, btn) {
  searchMode = mode;
  document.querySelectorAll('.search-subtabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  clearSearch();
  initSearchPanel();
}

function initSearchPanel() {
  const placeholders = {
    users: 'Username (Latin, min 2 chars)...',
    files: 'Search files in your chats...',
    web: 'Web search...',
  };
  document.getElementById('search-input').placeholder = placeholders[searchMode];
  const list = document.getElementById('search-list');
  list.innerHTML =
    searchMode === 'users'
      ? '<li class="sidebar-hint">Type a Latin username to find someone</li>'
      : '<li class="sidebar-hint">Enter at least 2 characters</li>';
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  initSearchPanel();
}

function renderUserItem(u, query = '', listId = 'chats-list') {
  const li = document.createElement('li');
  li.className = 'user-item';
  if (currentChatUser === u.username) li.classList.add('active');
  li.dataset.username = u.username;

  const online = u.online || onlineUsers.has(u.username);
  const preview = u.lastMessage
    ? escapeHtml(u.lastMessage.slice(0, 50))
    : '<span class="no-chat">Start chat</span>';
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
        <span class="online-dot ${online ? 'is-online' : ''}"></span>
      </div>
    </div>`;

  li.onclick = () => {
    openChat(u.username, li);
    switchMainTab('chats', document.querySelector('.main-tabs button:first-child'));
  };
  return li;
}

async function loadChats() {
  const list = document.getElementById('chats-list');
  list.innerHTML = '<li class="sidebar-hint">Loading...</li>';

  try {
    const res = await apiFetch('/chats');
    const chats = await res.json();
    list.innerHTML = '';

    if (!chats.length) {
      list.innerHTML = '<li class="sidebar-hint">No chats yet. Use Search → Users</li>';
      return;
    }

    chats.forEach((u) => list.appendChild(renderUserItem(u)));
    refreshOnlineIndicators();
  } catch (e) {
    console.error(e);
    list.innerHTML = '<li class="sidebar-hint">Failed to load chats</li>';
  }
}

async function loadProfile() {
  try {
    const res = await apiFetch('/me');
    const data = await res.json();
    myEmail = data.email || '';
    document.getElementById('profile-username').textContent = data.username;
    document.getElementById('profile-email').textContent = data.email;
    document.getElementById('profile-avatar').textContent = avatarLetter(data.username);
    document.getElementById('profile-status').textContent = data.online ? 'You are online' : '';
  } catch (e) {
    console.error(e);
  }
}

async function wipeDatabase() {
  const secret = document.getElementById('admin-secret-input').value;
  const status = document.getElementById('wipe-status');
  if (!secret) {
    status.textContent = 'Enter ADMIN_SECRET from Render Environment';
    return;
  }
  if (!confirm('Delete ALL users and ALL messages? This cannot be undone.')) return;

  status.textContent = 'Deleting...';
  try {
    const res = await fetch('/admin/wipe-database', {
      method: 'POST',
      headers: { 'x-admin-secret': secret },
    });
    const data = await res.json();
    if (data.success) {
      status.textContent = 'Done. Database is empty. Sign out and register again.';
      logout();
    } else {
      status.textContent = data.message || 'Failed';
    }
  } catch {
    status.textContent = 'Request failed';
  }
}

function openChat(username, liEl) {
  currentChatUser = username;
  document.getElementById('current-chat-user').textContent = username;
  document.getElementById('input-area').style.display = 'flex';
  typingIndicator.textContent = '';

  const isOnline = onlineUsers.has(username);
  document.getElementById('chat-header-online')?.classList.toggle('is-online', isOnline);
  const statusEl = document.getElementById('chat-header-status');
  if (statusEl) statusEl.textContent = isOnline ? 'online' : '';

  document.querySelectorAll('.user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.username === username);
  });
  if (liEl) liEl.classList.add('active');

  document.getElementById('chat-screen').classList.add('chat-open');
  const container = document.getElementById('messages-container');
  container.innerHTML = '<p class="empty-chat loading">Loading...</p>';

  if (socket?.connected) socket.emit('load_messages', { them: username });
}

function closeChatMobile() {
  document.getElementById('chat-screen').classList.remove('chat-open');
}

function sendMessage() {
  const input = document.getElementById('message-input');
  if (!input.value.trim() || !currentChatUser || !socket) return;
  socket.emit('send_message', { receiver: currentChatUser, text: input.value.trim() });
  input.value = '';
}

async function uploadFile() {
  const file = document.getElementById('file-input').files[0];
  if (!file || !currentChatUser) return;

  if (file.size > 10 * 1024 * 1024) {
    alert('Max file size is 10 MB');
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
      alert(data.message || 'Upload failed');
      return;
    }

    socket.emit('send_message', {
      receiver: currentChatUser,
      text: `File: ${data.originalName}`,
      file: data.fileUrl,
      originalName: data.originalName,
    });
    document.getElementById('file-input').value = '';
  } catch (e) {
    console.error(e);
    alert('Upload failed. Check Cloudinary settings on Render.');
  } finally {
    attachBtn?.classList.remove('uploading');
  }
}

function displayMessage(msg) {
  const container = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.className = `message ${msg.sender === myUsername ? 'mine' : 'theirs'}`;

  let body = '';
  if (msg.sender !== myUsername) body += `<b>${escapeHtml(msg.sender)}</b>`;
  body += `<span class="msg-text">${escapeHtml(msg.text)}</span>`;

  if (msg.file) {
    const isImage =
      msg.file.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) ||
      msg.file.includes('/image/') ||
      (msg.originalName && /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.originalName));

    if (isImage) {
      body += `<img src="${escapeHtml(msg.file)}" alt="image" loading="lazy" />`;
    } else {
      const name = escapeHtml(msg.originalName || 'Download file');
      body += `<a class="file-link" href="${escapeHtml(msg.file)}" target="_blank" rel="noopener">${name}</a>`;
    }
  }

  div.innerHTML = `${body}<span class="time">${escapeHtml(msg.time || '')}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

document.getElementById('message-input').addEventListener('input', () => {
  if (!currentChatUser || !socket) return;
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', { to: currentChatUser }), 300);
});

socket?.on?.('user_typing', () => {});

let searchDebounce;
function handleSearch() {
  const input = document.getElementById('search-input');
  document.getElementById('search-clear').style.display = input.value ? 'flex' : 'none';
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 280);
}

async function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  const list = document.getElementById('search-list');

  if (searchMode === 'users') {
    if (query.length < 2) {
      list.innerHTML = '<li class="sidebar-hint">Min 2 Latin characters (a-z, 0-9, _)</li>';
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(query)) {
      list.innerHTML = '<li class="sidebar-hint">Only Latin letters, numbers, _</li>';
      return;
    }
    list.innerHTML = '<li class="sidebar-hint">Searching...</li>';
    try {
      const res = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`);
      const users = await res.json();
      if (users.error) {
        list.innerHTML = `<li class="sidebar-hint">${escapeHtml(users.error)}</li>`;
        return;
      }
      list.innerHTML = '';
      if (!users.length) {
        list.innerHTML = '<li class="sidebar-hint">No users found</li>';
        return;
      }
      users.forEach((u) => list.appendChild(renderUserItem({ ...u, lastMessage: null }, query)));
      refreshOnlineIndicators();
    } catch {
      list.innerHTML = '<li class="sidebar-hint">Search error</li>';
    }
    return;
  }

  if (query.length < 2) {
    list.innerHTML = '<li class="sidebar-hint">Enter at least 2 characters</li>';
    return;
  }

  if (searchMode === 'files') {
    list.innerHTML = '<li class="sidebar-hint">Searching files...</li>';
    try {
      const res = await apiFetch(`/search/files?q=${encodeURIComponent(query)}`);
      const files = await res.json();
      list.innerHTML = '';
      if (!files.length) {
        list.innerHTML = '<li class="sidebar-hint">No files found</li>';
        return;
      }
      files.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'search-result';
        li.innerHTML = `
          <span class="material-icons">attach_file</span>
          <div><strong>${escapeHtml(f.file)}</strong>
          <small>${escapeHtml(f.peer)}</small></div>`;
        li.onclick = () => openChat(f.peer);
        list.appendChild(li);
      });
    } catch {
      list.innerHTML = '<li class="sidebar-hint">Error</li>';
    }
    return;
  }

  if (searchMode === 'web') {
    list.innerHTML = '<li class="sidebar-hint">Searching web...</li>';
    try {
      const res = await apiFetch(`/search/web?q=${encodeURIComponent(query)}`);
      const results = await res.json();
      list.innerHTML = '';
      results.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'search-result web';
        li.innerHTML = `<div><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title)}</strong></a>
          <p>${escapeHtml((r.snippet || '').slice(0, 120))}</p></div>`;
        list.appendChild(li);
      });
    } catch {
      list.innerHTML = '<li class="sidebar-hint">Error</li>';
    }
  }
}
