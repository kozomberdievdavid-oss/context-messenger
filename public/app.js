const typingIndicator = document.getElementById('typing-indicator');
const messageSound = new Audio(
  'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3'
);
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

let socket = null;
let myUsername = '';
let myRole = 'user';
let myAvatarUrl = '';
let currentChatUser = '';
let mainTab = 'chats';
let searchMode = 'users';
let typingTimeout;
let deferredInstall = null;
const onlineUsers = new Set();

initTheme();
applyI18n();
syncLangSelects();
registerServiceWorker();
setupPwaInstall();

function syncLangSelects() {
  const v = currentLang;
  const a = document.getElementById('app-lang');
  const b = document.getElementById('login-lang');
  if (a) a.value = v;
  if (b) b.value = v;
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  setTheme(next);
}

function getToken() {
  return localStorage.getItem('context_token') || '';
}

async function apiFetch(url, options = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (options.body != null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
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

function avatarHtml(u) {
  if (u.avatarUrl) {
    return `<img class="avatar-img" src="${escapeHtml(u.avatarUrl)}" alt="" />`;
  }
  return `<div class="avatar">${escapeHtml((u.username?.[0] || '?').toUpperCase())}</div>`;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function setupPwaInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    const b = document.getElementById('install-banner');
    if (b) b.style.display = 'flex';
  });
}

async function installPwa() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  dismissInstall();
}

function dismissInstall() {
  const b = document.getElementById('install-banner');
  if (b) b.style.display = 'none';
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: getToken() } });

  socket.on('connect_error', () => {
    document.getElementById('login-error').innerText = t('conn_error');
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
    const c = document.getElementById('messages-container');
    c.innerHTML = '';
    c.classList.remove('messages-empty-hint');
    messages.forEach(displayMessage);
  });

  socket.on('receive_message', (msg) => {
    const inThread =
      (msg.sender === myUsername && msg.receiver === currentChatUser) ||
      (msg.sender === currentChatUser && msg.receiver === myUsername);
    if (inThread) {
      const c = document.getElementById('messages-container');
      if (c.querySelector('.empty-chat')) {
        c.innerHTML = '';
        c.classList.remove('messages-empty-hint');
      }
      displayMessage(msg);
      if (msg.sender !== myUsername) messageSound.play().catch(() => {});
    }
    if (mainTab === 'chats') loadChats();
  });

  socket.on('user_typing', ({ from, to }) => {
    if (to === myUsername && from === currentChatUser) {
      typingIndicator.textContent = `${from} ${t('typing')}`;
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        typingIndicator.textContent = '';
      }, 2000);
    }
  });
}

function refreshOnlineIndicators() {
  document.querySelectorAll('.user-item').forEach((li) => {
    const dot = li.querySelector('.online-dot');
    if (dot) dot.classList.toggle('is-online', onlineUsers.has(li.dataset.username));
  });
  if (currentChatUser) updateChatHeader(currentChatUser);
}

function showChatScreen() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('chat-screen').style.display = 'flex';
}

window.onload = () => {
  if (localStorage.getItem('context_user') && getToken()) {
    myUsername = localStorage.getItem('context_user');
    showChatScreen();
    connectSocket();
    loadProfile().then(() => {
      loadChats();
    });
  }
};

async function auth(type) {
  const user = document.getElementById('username-input').value.trim();
  const email = document.getElementById('email-input').value.trim();
  const pass = document.getElementById('password-input').value;
  if (type === 'register' && !USERNAME_RE.test(user)) {
    document.getElementById('login-error').innerText = t('username_rule');
    return;
  }
  try {
    const res = await fetch(type === 'login' ? '/login' : '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        type === 'login' ? { email, password: pass } : { username: user, email, password: pass }
      ),
    });
    const data = await res.json();
    if (data.success && data.token) {
      myUsername = data.username;
      myRole = data.role || 'user';
      localStorage.setItem('context_user', data.username);
      localStorage.setItem('context_token', data.token);
      showChatScreen();
      connectSocket();
      await loadProfile();
      loadChats();
    } else {
      document.getElementById('login-error').innerText = data.message || t('auth_error');
    }
  } catch {
    document.getElementById('login-error').innerText = t('conn_error');
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
  document.getElementById(`panel-${tab}`)?.classList.add('active');
  document.querySelectorAll('.main-tabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (tab === 'chats') loadChats();
  if (tab === 'search') initSearchPanel();
  if (tab === 'profile') loadProfile();
  if (tab === 'admin') loadAdminStats();
}

function setSearchMode(mode, btn) {
  searchMode = mode;
  document.querySelectorAll('.search-subtabs button').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  clearSearch();
}

function initSearchPanel() {
  const ph = { users: 'find_user', files: 'search_files', web: 'search_web' };
  document.getElementById('search-input').placeholder = t(ph[searchMode]);
  document.getElementById('search-list').innerHTML =
    `<li class="sidebar-hint">${t(searchMode === 'users' ? 'latin_search' : 'min_chars')}</li>`;
}

function clearSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  initSearchPanel();
}

function renderUserItem(u, query = '') {
  const li = document.createElement('li');
  li.className = 'user-item';
  if (currentChatUser === u.username) li.classList.add('active');
  li.dataset.username = u.username;
  const online = u.online || onlineUsers.has(u.username);
  const preview = u.lastMessage
    ? escapeHtml(u.lastMessage.slice(0, 50))
    : `<span class="no-chat">${t('start_chat')}</span>`;
  const time = u.lastTime ? `<span class="chat-time">${escapeHtml(u.lastTime)}</span>` : '';
  li.innerHTML = `
    ${avatarHtml(u)}
    <div class="chat-meta">
      <div class="chat-row-top"><span class="user-name">${highlightMatch(u.username, query)}</span>${time}</div>
      <div class="chat-row-bottom"><span class="preview">${preview}</span>
        <span class="online-dot ${online ? 'is-online' : ''}"></span></div>
    </div>`;
  li.onclick = () => {
    openChat(u.username, li);
    switchMainTab('chats', document.querySelector('.main-tabs button'));
  };
  return li;
}

async function loadChats() {
  const list = document.getElementById('chats-list');
  list.innerHTML = `<li class="sidebar-hint">${t('loading')}</li>`;
  try {
    const res = await apiFetch('/chats');
    const chats = await res.json();
    list.innerHTML = '';
    if (!chats.length) {
      list.innerHTML = `<li class="sidebar-hint">${t('no_chats')}</li>`;
      return;
    }
    const h = document.createElement('li');
    h.className = 'sidebar-section';
    h.textContent = t('recent');
    list.appendChild(h);
    chats.forEach((u) => list.appendChild(renderUserItem(u)));
    refreshOnlineIndicators();
  } catch {
    list.innerHTML = `<li class="sidebar-hint">${t('conn_error')}</li>`;
  }
}

async function loadProfile() {
  try {
    const res = await apiFetch('/me');
    const data = await res.json();
    myRole = data.role || 'user';
    myAvatarUrl = data.avatarUrl || '';
    document.getElementById('profile-username').textContent = data.username;
    document.getElementById('profile-email').textContent = data.email;
    document.getElementById('profile-bio').value = data.bio || '';
    document.getElementById('profile-status').textContent = data.online ? t('you_online') : '';
    setProfileAvatar(data.avatarUrl, data.username);
    const adminTab = document.getElementById('tab-admin');
    if (adminTab) adminTab.classList.toggle('hidden', myRole !== 'admin');
  } catch (e) {
    console.error(e);
  }
}

function setProfileAvatar(url, username) {
  const img = document.getElementById('profile-avatar-img');
  const letter = document.getElementById('profile-avatar-letter');
  if (url) {
    img.src = url;
    img.hidden = false;
    letter.style.display = 'none';
  } else {
    img.hidden = true;
    letter.style.display = 'flex';
    letter.textContent = (username?.[0] || '?').toUpperCase();
  }
}

async function saveProfile() {
  const bio = document.getElementById('profile-bio').value;
  try {
    await apiFetch('/me/profile', { method: 'PATCH', body: JSON.stringify({ bio }) });
    document.getElementById('profile-save-status').textContent = t('saved');
  } catch {
    document.getElementById('profile-save-status').textContent = t('conn_error');
  }
}

async function uploadAvatar() {
  const file = document.getElementById('avatar-input').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const res = await apiFetch('/me/avatar', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.avatarUrl) {
      myAvatarUrl = data.avatarUrl;
      setProfileAvatar(data.avatarUrl, myUsername);
    }
  } catch {
    alert(t('upload_fail'));
  }
  document.getElementById('avatar-input').value = '';
}

async function loadAdminStats() {
  if (myRole !== 'admin') return;
  try {
    const res = await apiFetch('/admin/stats');
    const s = await res.json();
    document.getElementById('admin-stats').textContent = `${t('admin_stats')}: ${s.usersCount} users, ${s.messagesCount} messages`;
  } catch {
    document.getElementById('admin-stats').textContent = '—';
  }
}

async function wipeDatabase() {
  if (myRole !== 'admin') return;
  if (!confirm(t('admin_wipe_btn') + '?')) return;
  const secret = document.getElementById('admin-secret-input').value;
  const status = document.getElementById('wipe-status');
  try {
    const res = await fetch('/admin/wipe-database', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'x-admin-secret': secret,
      },
    });
    const data = await res.json();
    status.textContent = data.success ? 'OK' : data.message || 'Error';
    if (data.success) logout();
  } catch {
    status.textContent = t('conn_error');
  }
}

async function updateChatHeader(username) {
  document.getElementById('current-chat-user').textContent = username;
  const on = onlineUsers.has(username);
  document.getElementById('chat-header-status').textContent = on ? t('online') : '';
  document.getElementById('delete-chat-btn').style.display = username ? 'flex' : 'none';
  try {
    const res = await apiFetch(`/users/${encodeURIComponent(username)}/public`);
    const p = await res.json();
    const wrap = document.getElementById('chat-header-avatar');
    wrap.innerHTML = p.avatarUrl
      ? `<img class="avatar-img small" src="${escapeHtml(p.avatarUrl)}" alt=""/>`
      : `<div class="avatar small">${escapeHtml((username[0] || '?').toUpperCase())}</div>`;
    wrap.innerHTML += `<span class="online-dot header-dot ${on ? 'is-online' : ''}"></span>`;
  } catch {
    /* ignore */
  }
}

function openChat(username, liEl) {
  currentChatUser = username;
  document.getElementById('input-area').style.display = 'flex';
  typingIndicator.textContent = '';
  document.querySelectorAll('.user-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.username === username);
  });
  if (liEl) liEl.classList.add('active');
  document.getElementById('chat-screen').classList.add('chat-open');
  const c = document.getElementById('messages-container');
  c.innerHTML = `<p class="empty-chat loading">${t('loading')}</p>`;
  updateChatHeader(username);
  if (socket?.connected) socket.emit('load_messages', { them: username });
}

function closeChatMobile() {
  document.getElementById('chat-screen').classList.remove('chat-open');
}

async function deleteCurrentChat() {
  if (!currentChatUser) return;
  if (!confirm(t('delete_chat_confirm'))) return;
  try {
    const res = await apiFetch(`/chats/${encodeURIComponent(currentChatUser)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.success) {
      currentChatUser = '';
      document.getElementById('input-area').style.display = 'none';
      document.getElementById('messages-container').innerHTML = `<p class="empty-chat">${t('select_chat')}</p>`;
      closeChatMobile();
      loadChats();
    }
  } catch {
    alert(t('conn_error'));
  }
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
    alert(t('file_max'));
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  const btn = document.querySelector('.attach-btn');
  btn?.classList.add('uploading');
  try {
    const res = await apiFetch('/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || !data.fileUrl) {
      alert(data.message || t('upload_fail'));
      return;
    }
    socket.emit('send_message', {
      receiver: currentChatUser,
      text: `${t('file_label')}: ${data.originalName}`,
      file: data.fileUrl,
      originalName: data.originalName,
    });
  } catch {
    alert(t('upload_fail'));
  } finally {
    btn?.classList.remove('uploading');
    document.getElementById('file-input').value = '';
  }
}

function displayMessage(msg) {
  const c = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.className = `message ${msg.sender === myUsername ? 'mine' : 'theirs'}`;
  let body = msg.sender !== myUsername ? `<b>${escapeHtml(msg.sender)}</b>` : '';
  body += `<span class="msg-text">${escapeHtml(msg.text)}</span>`;
  if (msg.file) {
    const isImg =
      /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(msg.file) ||
      msg.file.includes('/image/') ||
      (msg.originalName && /\.(jpg|jpeg|png|gif|webp)$/i.test(msg.originalName));
    if (isImg) body += `<img src="${escapeHtml(msg.file)}" alt="" loading="lazy" />`;
    else {
      body += `<a class="file-link" href="${escapeHtml(msg.file)}" target="_blank" rel="noopener">${escapeHtml(msg.originalName || 'file')}</a>`;
    }
  }
  div.innerHTML = `${body}<span class="time">${escapeHtml(msg.time || '')}</span>`;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

document.getElementById('message-input')?.addEventListener('input', () => {
  if (!currentChatUser || !socket) return;
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => socket.emit('typing', { to: currentChatUser }), 300);
});
let typingDebounce;

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
      list.innerHTML = `<li class="sidebar-hint">${t('min_chars')}</li>`;
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(query)) {
      list.innerHTML = `<li class="sidebar-hint">${t('latin_search')}</li>`;
      return;
    }
    list.innerHTML = `<li class="sidebar-hint">${t('loading')}</li>`;
    try {
      const res = await apiFetch(`/users/search?q=${encodeURIComponent(query)}`);
      const users = await res.json();
      list.innerHTML = '';
      if (!users.length) {
        list.innerHTML = `<li class="sidebar-hint">${t('not_found')}</li>`;
        return;
      }
      const h = document.createElement('li');
      h.className = 'sidebar-section';
      h.textContent = t('search_results');
      list.appendChild(h);
      users.forEach((u) => list.appendChild(renderUserItem({ ...u, lastMessage: null }, query)));
    } catch {
      list.innerHTML = `<li class="sidebar-hint">${t('conn_error')}</li>`;
    }
    return;
  }
  if (query.length < 2) {
    list.innerHTML = `<li class="sidebar-hint">${t('min_chars')}</li>`;
    return;
  }
  if (searchMode === 'files') {
    list.innerHTML = `<li class="sidebar-hint">${t('loading')}</li>`;
    try {
      const res = await apiFetch(`/search/files?q=${encodeURIComponent(query)}`);
      const files = await res.json();
      list.innerHTML = '';
      files.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'search-result';
        li.innerHTML = `<span class="material-icons">attach_file</span><div><strong>${escapeHtml(f.file)}</strong><small>${escapeHtml(f.peer)}</small></div>`;
        li.onclick = () => openChat(f.peer);
        list.appendChild(li);
      });
      if (!files.length) list.innerHTML = `<li class="sidebar-hint">${t('not_found')}</li>`;
    } catch {
      list.innerHTML = `<li class="sidebar-hint">${t('conn_error')}</li>`;
    }
    return;
  }
  if (searchMode === 'web') {
    list.innerHTML = `<li class="sidebar-hint">${t('loading')}</li>`;
    try {
      const res = await apiFetch(`/search/web?q=${encodeURIComponent(query)}`);
      const results = await res.json();
      list.innerHTML = '';
      results.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'search-result web';
        li.innerHTML = `<div><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(r.title)}</strong></a><p>${escapeHtml((r.snippet || '').slice(0, 120))}</p></div>`;
        list.appendChild(li);
      });
    } catch {
      list.innerHTML = `<li class="sidebar-hint">${t('conn_error')}</li>`;
    }
  }
}

// click avatar label triggers file input
document.querySelector('.profile-avatar-wrap')?.addEventListener('click', () => {
  document.getElementById('avatar-input')?.click();
});
