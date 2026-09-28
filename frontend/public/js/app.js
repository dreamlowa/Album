// ============================================================
// Семейный альбом — фронтенд (привязан к нашему API)
// Дизайн: лёгкий «семейный альбом» (как образец заказчика),
// но данные — через /api (войти, альбомы, фото, загрузка).
// ============================================================

'use strict';

const API_URL = window.APP_CONFIG?.API_URL || '';
const STORAGE_KEY = 'famarchive_token';

let currentUser = null;
let token = localStorage.getItem(STORAGE_KEY) || null;
let albums = [];
let allMedia = [];        // все фото/видео (кэш для галереи)
let currentAlbumIdx = -1;
let currentPhotoIdx = 0;

// ---------- Утилиты ----------
const $ = (el) => document.getElementById(el);

// Единая иконка из локального SVG-спрайта (#ico-sprites). Вид:
//   ico('camera') → <svg class="ico"><use href="#i-camera"/></svg>
const ico = (name, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
function fmtDate(iso, opts) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ru-RU', opts || { year: 'numeric', month: 'long', day: 'numeric' });
}
async function api(path, { method = 'GET', body, token: useToken = true } = {}) {
  const headers = {};
  if (useToken && token) headers['Authorization'] = `Bearer ${token}`;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

// ============================================================
//   АВТОРИЗАЦИЯ
// ============================================================
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.auth-form').forEach((f) => f.classList.remove('active'));
  $('form-' + tab).classList.add('active');
  hideError();
}
function showError(msg) { $('auth-error').textContent = msg; $('auth-error').classList.add('show'); }
function hideError() { $('auth-error').classList.remove('show'); }

async function doLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email || !password) return showError('Введите email и пароль.');
  hideError();
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password }, token: false });
    token = data.token;
    localStorage.setItem(STORAGE_KEY, data.token);
    currentUser = data.user;
    enterApp();
  } catch (err) { showError(err.message); }
}

async function doRegister() {
  // Только админ может создавать пользователей (или ссылка-приглашение).
  // Здесь показываем подсказку.
  showError('Регистрация закрыта: учётную запись создаёт администратор. Войдите как admin (пароль admin) или получите ссылку-приглашение.');
}

// Восстановление пароля: шаг 1 — запросить ссылку по логину
async function doForgot() {
  const email = $('forgot-email').value.trim();
  const msg = $('forgot-message');
  if (!email) { msg.textContent = 'Введите логин.'; return; }
  msg.textContent = 'Запрашиваем…';
  try {
    const data = await api('/api/password/forgot', { method: 'POST', body: { email }, token: false });
    msg.textContent = 'Ссылка на сброс готова. Откройте её в новом окне (владелец архива передаст её вам).';
    if (data.link) window.prompt('Ссылка сброса:', data.link);
  } catch (err) {
    msg.textContent = 'Ошибка: ' + err.message;
  }
}

// Восстановление пароля: шаг 2 — установить новый пароль по токену
async function doReset() {
  const password = $('reset-password').value;
  const msg = $('reset-message');
  if (!password || password.length < 8) { msg.textContent = 'Пароль должен быть не короче 8 символов.'; return; }
  msg.textContent = 'Сохраняем…';
  try {
    const data = await api('/api/password/reset', { method: 'POST', body: { token: window._resetToken, password }, token: false });
    msg.textContent = data.message || 'Пароль изменён. Войдите со своим логином.';
    setTimeout(() => { switchTab('login'); }, 1500);
  } catch (err) {
    msg.textContent = 'Ошибка: ' + err.message;
  }
}

// Привязка навигации экрана входа (забыли пароль / назад)
function initAuthNav() {
  const forgotLink = $('forgotLink');
  const forgotBack = $('forgotBack');
  const resetBack = $('resetBack');
  if (forgotLink) forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.auth-form').forEach((f) => f.classList.remove('active'));
    $('form-forgot').classList.add('active');
  });
  if (forgotBack) forgotBack.addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });
  if (resetBack) resetBack.addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });
}

// ============================================================
//   ПРОФИЛЬ
// ============================================================
// ===== Новые блоки профиля (Хранитель) =====
let _monthPhotos = [];
let _monthPhotoIdx = 0;

async function renderMonthPhoto() {
  const box = $('pfMonth');
  if (!box) return;
  try {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const since = new Date(now.getTime() - now.getDate() * 864e5 - offset).toISOString().slice(0, 10);
    const { media } = await api(`/api/media?limit=200`);
    _monthPhotos = (media || []).filter((m) => m.kind !== 'video' && (!m.dateTaken || String(m.dateTaken).slice(0, 10) >= since));
    if (!_monthPhotos.length) {
      _monthPhotos = (media || []).filter((m) => m.kind !== 'video').slice(0, 24);
    }
    if (!_monthPhotos.length) { box.style.display = 'none'; return; }
    _monthPhotoIdx = 0;
    showMonthPhoto();
  } catch { box.style.display = 'none'; }
}

function showMonthPhoto() {
  const box = $('pfMonth');
  if (!box || !_monthPhotos.length) return;
  const p = _monthPhotos[_monthPhotoIdx % _monthPhotos.length];
  const img = $('pfMonthImg');
  if (img) img.src = p.thumbUrl || p.url;
  box.style.display = 'block';
}

function pickOtherMonthPhoto() {
  if (!_monthPhotos.length) return;
  _monthPhotoIdx++;
  showMonthPhoto();
}
window.pickOtherMonthPhoto = pickOtherMonthPhoto;

function renderKeeperLevel(totalPhotos) {
  const box = $('keeperLevel');
  if (!box) return;
  const level = Math.min(10, Math.floor(totalPhotos / 200) + 1);
  const pct = Math.min(100, Math.round(((totalPhotos % 200) / 200) * 100));
  const nextAt = level * 200;
  box.innerHTML = `
    <div class="kl-top">
      <span>Уровень ${level} из 10</span>
      <span class="kl-next">до следующего: +${Math.max(0, nextAt - totalPhotos)} фото</span>
    </div>
    <div class="kl-bar"><span style="width:${pct}%"></span></div>`;
}

async function renderWeekActivity() {
  const chart = $('weekChart');
  const empty = $('weekEmpty');
  if (!chart) return;
  try {
    const { media } = await api(`/api/media?limit=200`);
    const days = [0, 0, 0, 0, 0, 0, 0];
    const now = new Date();
    media.forEach((m) => {
      const t = m.createdAt || m.created_at;
      if (!t) return;
      const dd = new Date(t);
      const diff = Math.floor((now - dd) / 864e5);
      if (diff >= 0 && diff < 7 && !isNaN(dd.getDay())) days[6 - diff]++;
    });
    const max = Math.max(...days, 1);
    const pts = days.map((v, i) => [i * 35 + 5, 38 - (v / max) * 32]).map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    if (days.every((d) => d === 0)) {
      if (empty) empty.style.display = 'block';
      chart.style.display = 'none';
      return;
    }
    const area = `${pts} L 205 44 L 5 44 Z`;
    chart.innerHTML = `<path class="wc-line" d="${pts}"/><path class="wc-area" d="${area}"/>${days.map((v, i) => `<circle class="wc-dot" cx="${i * 35 + 5}" cy="${38 - (v / max) * 32}" r="2"/>`).join('')}`;
    if (empty) empty.style.display = 'none';
    chart.style.display = 'block';
  } catch {
    if (empty) empty.style.display = 'block';
    chart.style.display = 'none';
  }
}

function renderSecurity() {
  const lastEl = $('secLastActive');
  if (lastEl && currentUser && currentUser.lastActive) {
    lastEl.textContent = addedLabelSafe(currentUser.lastActive);
  }
}

async function exportArchive() {
  if (!confirm('Экспортировать весь архив? Это может занять время.') ) return;
  const btn = $('exportBtn');
  const prog = $('exportProgress');
  const bar = $('exportBar');
  if (btn) btn.disabled = true;
  if (prog) prog.hidden = false;
  if (bar) bar.style.width = '20%';
  try {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_URL}/api/admin/snapshot`, { method: 'POST', headers });
    if (!res.ok) throw new Error('Не удалось создать архив');
    const data = await res.json();
    if (bar) bar.style.width = '60%';
    const dl = await fetch(`${API_URL}/api/admin/snapshot/${encodeURIComponent(data.name)}`, { headers });
    if (!dl.ok) throw new Error('Не удалось скачать архив');
    if (bar) bar.style.width = '90%';
    const blob = await dl.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = data.name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    if (bar) bar.style.width = '100%';
    setTimeout(() => { if (prog) prog.hidden = true; if (bar) bar.style.width = '0%'; if (btn) btn.disabled = false; }, 1500);
  } catch (err) {
    if (prog) prog.hidden = true;
    if (btn) btn.disabled = false;
    alert(err.message);
  }
}
window.exportArchive = exportArchive;

function enable2FA() {
  alert('Двухфакторная аутентификация появится в ближайшем обновлении. Пока рекомендуем надёжный пароль и регулярные снимки архива.');
}
window.enable2FA = enable2FA;

function toggleProfileTheme(cbx) {
  const dark = cbx.checked;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('famarchive_theme', dark ? 'dark' : 'light');
}
window.toggleProfileTheme = toggleProfileTheme;

function syncThemeToggle() {
  const sw = $('profileThemeSwitch');
  if (sw) sw.checked = (document.documentElement.dataset.theme === 'dark');
}

function quickUpload() { closeProfile(); setTimeout(() => { const c = $('controls-panel'); if (c) c.style.display = 'block'; const f = $('photo-input'); if (f) f.click(); }, 120); }
function quickCreateAlbum() { closeProfile(); setTimeout(() => { const c = $('controls-panel'); if (c) c.style.display = 'block'; const n = $('album-name'); if (n) { n.focus(); n.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 120); }
function quickInvite() { closeProfile(); setTimeout(() => createInvite(), 120); }
window.quickUpload = quickUpload;
window.quickCreateAlbum = quickCreateAlbum;
window.quickInvite = quickInvite;

function openProfile() {
  if (!currentUser) return;
  closeMenuDropdown();
  $('profile-overlay').classList.add('active');

  const avatar = $('profileAvatar');
  if (currentUser.avatar) {
    avatar.innerHTML = `<img src="${currentUser.avatar}" alt="">`;
    avatar.classList.add('has-photo');
  } else {
    avatar.classList.remove('has-photo');
    avatar.innerHTML = `<span class="pa-letter">${(currentUser.name || 'А').trim().charAt(0).toUpperCase()}</span><span class="pa-cam" aria-hidden="true">${ico('camera')}</span>`;
  }
  $('profileEmail').textContent = currentUser.email || '';
  $('profileDisplayName').textContent = currentUser.name || 'Мой профиль';
  $('profileRoleText').textContent = roleTitle(currentUser.role);
  $('profile-name').value = currentUser.name || '';
  $('profile-bio').value = currentUser.bio || '';
  $('profileMsg').textContent = '';
  $('passwordMsg').textContent = '';
  $('old-password').value = '';
  $('new-password').value = '';
  updateBioCounter();
  updatePasswordBtn();
  renderProfileStats();
  renderMonthPhoto();
  renderWeekActivity();
  renderSecurity();
  syncThemeToggle();
  const pl = $('profileLink');
  if (pl) {
    const val = buildProfileLink();
    pl.value = val;
    const row = document.querySelector('.profile-link-row');
    if (row) row.style.display = val ? 'flex' : 'none';
  }
  // Сворачиваемая форма пароля — всегда свёрнута при открытии
  closePasswordForm();
}

function roleTitle(role) {
  if (role === 'admin') return 'Хранитель семейного архива';
  if (role === 'editor') return 'Редактор';
  return 'Гость';
}

function buildProfileLink() {
  // Публичная страница появится позже; пока ссылки нет — возвращаем пустую строку
  const enabled = window.APP_CONFIG && (window.APP_CONFIG.PUBLIC_URL || window.APP_CONFIG.enablePublicProfile);
  if (!enabled) return '';
  const base = window.APP_CONFIG.PUBLIC_URL || (location.origin + '/user');
  const id = currentUser && (currentUser.id || currentUser.email);
  return `${base}/${encodeURIComponent(id || 'guest')}`;
}

async function renderProfileStats() {
  const box = $('profileStats');
  if (!box) return;
  try {
    const [stats, albData, userData] = await Promise.all([
      api('/api/map/stats').catch(() => ({ photos: 0, videos: 0 })),
      api('/api/albums').catch(() => ({ albums: [] })),
      (currentUser && currentUser.role === 'admin')
        ? api('/api/admin/users').catch(() => ({ users: [] }))
        : Promise.resolve({ users: [] }),
    ]);
    const photos = (stats.photos || 0) + (stats.videos || 0);
    const albums = (albData.albums || []).length;
    const members = (userData.users || []).length || 1;
    renderKeeperLevel(photos);
    if (photos === 0 && albums === 0) {
      box.innerHTML = `<div class="profile-stats-empty"><span aria-hidden="true">${ico('sprout','ico-lg')}</span><span>Начните собирать воспоминания — загрузите первое фото</span><div class="ps-activity">Он моментально появится в вашей статистике</div></div>`;
      return;
    }
    box.innerHTML = `
      <div class="profile-stat"><span class="ps-icon">${ico('camera')}</span><div class="ps-num">${photos}</div><div class="ps-label">Фото</div></div>
      <div class="profile-stat"><span class="ps-icon">${ico('folder')}</span><div class="ps-num">${albums}</div><div class="ps-label">Альбомы</div></div>
      <div class="profile-stat"><span class="ps-icon">${ico('users')}</span><div class="ps-num">${members}</div><div class="ps-label">Участники</div></div>`;
    // Последний вклад хранителя (кликабельная ссылка на альбом)
    const latest = (albData.albums || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (latest) {
      const addedLabel = addedLabelSafe(latest.created_at);
      const box2 = document.createElement('div');
      box2.className = 'ps-activity';
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'ps-activity-link';
      a.textContent = latest.title || 'Без названия';
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeProfile();
        try {
          const { media } = await api(`/api/media?albumId=${latest.id}&limit=200`);
          openGallery({ id: latest.id, title: latest.title }, media || []);
        } catch { /* открыть галерею не удалось */ }
      });
      box2.appendChild(document.createTextNode(`${ico('clock','ico-sm')} Последний вклад: «`));
      box2.appendChild(a);
      box2.appendChild(document.createTextNode(`» — ${addedLabel}`));
      box.appendChild(box2);
    }
  } catch {
    box.innerHTML = '';
  }
}

function pickAvatar() {
  const input = $('avatar-input');
  if (input) input.click();
}

function closeProfile() {
  $('profile-overlay').classList.remove('active');
}

function profileIsDirty() {
  const nameEl = $('profile-name');
  const bioEl = $('profile-bio');
  return !!(currentUser
    && ((nameEl && nameEl.value.trim() !== (currentUser.name || ''))
      || (bioEl && bioEl.value.trim() !== (currentUser.bio || ''))));
}

async function requestCloseProfile() {
  if (!profileIsDirty()) { closeProfile(); return; }
  const save = confirm('У вас есть несохранённые изменения. Сохранить их перед закрытием?');
  if (save) {
    await saveProfile();
    if (!profileIsDirty()) closeProfile(); // сохранилось успешно
  } else if (confirm('Закрыть без сохранения?')) {
    closeProfile();
  }
}
window.requestCloseProfile = requestCloseProfile;
window.closeProfile = closeProfile;

async function saveProfile() {
  const name = $('profile-name').value.trim();
  const bio = $('profile-bio').value.trim();
  const msg = $('profileMsg');
  const btn = $('profileSaveBtn');
  if (!name) { msg.textContent = 'Имя не может быть пустым.'; msg.style.color = '#c7250e'; return; }
  if (btn) { btn.disabled = true; btn.dataset.txt = btn.textContent; btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Сохраняем…'; }
  try {
    const { user } = await api('/api/auth/profile', { method: 'PATCH', body: { name, bio } });
    currentUser = { ...currentUser, ...user, avatar: user.avatar || currentUser.avatar };
    msg.textContent = 'Профиль сохранён ✓';
    msg.style.color = 'var(--fb-green-dark)';
    updateHeader();
    refreshSidebar();
    $('profileDisplayName').textContent = name;
    if ($('profileAvatar') && !currentUser.avatar) {
      $('profileAvatar').querySelector('.pa-letter').textContent = name.trim().charAt(0).toUpperCase();
    }
  } catch (err) {
    msg.textContent = 'Ошибка: ' + err.message;
    msg.style.color = '#c7250e';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить профиль'; }
  }
}

function refreshSidebar() {
  // обновить аватар и имя в шапке без полной перерисовки
  const av = $('headerAvatar');
  if (av) {
    if (currentUser.avatar) av.innerHTML = `<img src="${currentUser.avatar}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    else av.textContent = (currentUser.name || 'А').trim().charAt(0).toUpperCase();
  }
  const nm = document.querySelector('.user-name');
  if (nm && currentUser) nm.textContent = `${currentUser.name} · ${currentUser.role}`;
}

async function uploadAvatar() {
  const input = $('avatar-input');
  const file = input.files[0];
  const msg = $('profileMsg');
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const res = await api('/api/auth/avatar', { method: 'POST', body: fd });
    currentUser = { ...currentUser, avatarKey: res.avatarKey, avatar: res.avatar };
    $('profileAvatar').innerHTML = `<img src="${res.avatar}" alt="">`;
    $('profileAvatar').classList.add('has-photo');
    msg.textContent = 'Аватар обновлён ✓';
    msg.style.color = 'var(--fb-green-dark)';
    refreshSidebar();
  } catch (err) {
    msg.textContent = 'Ошибка: ' + err.message;
    msg.style.color = '#c7250e';
  }
}

async function changePassword() {
  const oldPassword = $('old-password').value;
  const newPassword = $('new-password').value;
  const msg = $('passwordMsg');
  if (!oldPassword || newPassword.length < 8) { msg.textContent = 'Заполните оба поля (новый — 8+ символов).'; msg.style.color = '#c7250e'; return; }
  try {
    const res = await api('/api/auth/password', { method: 'PUT', body: { oldPassword, newPassword } });
    msg.textContent = 'Пароль изменён ✓';
    msg.style.color = 'var(--fb-green-dark)';
    $('old-password').value = '';
    $('new-password').value = '';
    updatePasswordBtn();
  } catch (err) {
    msg.textContent = 'Ошибка: ' + err.message;
    msg.style.color = '#c7250e';
  }
}

function togglePasswordForm() {
  const form = $('passwordForm');
  const open = form.hidden;
  form.hidden = !open;
  if (open) {
    $('passwordToggle').textContent = 'Свернуть';
    updatePasswordBtn();
  } else {
    $('passwordToggle').textContent = 'Сменить пароль';
  }
}

function closePasswordForm() {
  const form = $('passwordForm');
  if (form) form.hidden = true;
  const tg = $('passwordToggle');
  if (tg) tg.textContent = 'Сменить пароль';
}

function updateBioCounter() {
  const el = $('bioCounter');
  if (el && $('profile-bio')) el.textContent = `${($('profile-bio').value || '').length}/200`;
}

function updatePasswordBtn() {
  const btn = $('passwordBtn');
  const ok = ($('old-password').value || '').length > 0 && ($('new-password').value || '').length >= 8;
  if (btn) btn.disabled = !ok;
}

function copyProfileLink(btn) {
  const input = $('profileLink');
  if (!input) return;
  const text = input.value;
  const done = () => {
    btn.textContent = 'Скопировано';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Скопировать'; btn.classList.remove('copied'); }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(input, done));
  } else {
    fallbackCopy(input, done);
  }
}

function fallbackCopy(input, done) {
  input.select();
  input.setSelectionRange(0, 99999);
  try { document.execCommand('copy'); } catch { /* ignore */ }
  done();
}

function requestLogout() {
  // Защита несохранённых изменений
  const nameEl = $('profile-name');
  const bioEl = $('profile-bio');
  const dirty = currentUser && ((nameEl && nameEl.value.trim() !== (currentUser.name || '')) || (bioEl && bioEl.value.trim() !== (currentUser.bio || '')));
  if (dirty) {
    if (!confirm('У вас есть несохранённые изменения. Всё равно выйти?')) return;
  } else {
    if (!confirm('Вы действительно хотите выйти из аккаунта?')) return;
  }
  doLogout();
}

window.openProfile = openProfile;
window.closeProfile = closeProfile;
window.saveProfile = saveProfile;
window.uploadAvatar = uploadAvatar;
window.changePassword = changePassword;

function doLogout() {
  token = null;
  currentUser = null;
  localStorage.removeItem(STORAGE_KEY);
  $('app').classList.remove('visible');
  $('auth-screen').style.display = 'block';
  $('login-email').value = '';
  $('login-password').value = '';
  $('header-right').innerHTML = '';
  $('main-nav').innerHTML = '';
  $('profile-overlay').classList.remove('active');
}

function enterApp() {
  $('auth-screen').style.display = 'none';
  $('app').classList.add('visible');
  updateHeader();
}

function updateHeader() {
  if (!currentUser) return;
  const initials = (currentUser.name || 'А').trim().charAt(0).toUpperCase();

  // Навигация: Альбомы / Все фото / Избранное / Карта (+ Корзина для админа)
  const isAdmin = currentUser.role === 'admin';
  // Минимальная навигация: только «Альбомы»; остальное — в меню ⋯
  $('main-nav').innerHTML = `
    <button class="nav-tab active" id="navAlbums" data-view="albums">Альбомы</button>
  `;
  $('navAlbums').addEventListener('click', () => { document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active')); $('navAlbums').classList.add('active'); switchView('albums'); });

  const canCreate = canUpload();
  // Прямые кнопки на десктопе + выпадающее меню на мобильных
  $('header-right').innerHTML = `
    ${canCreate ? `<button class="btn-create-sm" id="createBtn">${ico('plus','ico-sm')} Альбом</button>` : ''}
    ${canCreate ? `<button class="btn-create-sm btn-invite" id="inviteBtn">${ico('mail','ico-sm')} Пригласить</button>` : ''}
    <button class="btn-icon" id="themeBtn" title="Тёмная тема">${ico('moon')}</button>
    <button class="music-toggle" id="musicToggle" title="Музыка">${ico('music')}</button>
    <button class="btn-icon" id="frameBtn" title="Рамка">${ico('image')}</button>
    <div class="user-badge" id="profileBadge" title="Мой профиль">
      <div class="user-avatar" id="headerAvatar">${escapeHtml(initials)}</div>
      <div class="user-name">${escapeHtml(currentUser.name)} · ${escapeHtml(currentUser.role)}</div>
    </div>
    <button class="btn-icon menu-toggle" id="menuToggle" onclick="toggleMenu(event)" title="Меню">${ico('menu')}</button>
    <div class="menu-dropdown" id="menuDropdown">
      ${canCreate ? `<button class="menu-item" id="menuCreate">${ico('plus','ico-sm')} Создать альбом</button>` : ''}
      ${canCreate ? `<button class="menu-item" id="menuInvite">${ico('mail','ico-sm')} Пригласить</button>` : ''}
      <button class="menu-item" id="menuProfile">${ico('user')} Профиль</button>
      <button class="menu-item" id="menuTheme">${ico('moon')} Тёмная тема</button>
      <button class="menu-item" id="menuAll">${ico('folder')} Все фото</button>
      <button class="menu-item" id="menuFav">${ico('heart')} Избранное</button>
      <button class="menu-item" id="menuMap">${ico('map')} Карта</button>
      ${isAdmin ? `<button class="menu-item" id="menuTrash">${ico('trash')} Корзина</button>` : ''}
      ${isAdmin ? `<button class="menu-item" id="menuSnapshot">${ico('download')} Скачать снимок</button>` : ''}
      ${isAdmin ? `<button class="menu-item" id="menuRestore">${ico('upload')} Восстановить снимок</button>` : ''}
      <button class="menu-item" id="menuFrame">${ico('image')} Рамка</button>
      <button class="menu-item" id="menuMusic">${ico('music')} Музыка</button>
      <button class="menu-item" id="menuLogout">${ico('logout')} Выйти</button>
    </div>
    <button class="btn-icon" onclick="doLogout()" title="Выйти" id="logoutBtn">${ico('logout')}</button>
  `;
  if (canCreate) {
    $('createBtn').addEventListener('click', toggleControls);
    $('menuCreate').addEventListener('click', toggleControls);
    $('inviteBtn').addEventListener('click', createInvite);
    $('menuInvite').addEventListener('click', createInvite);
  }
  $('profileBadge').addEventListener('click', openProfile);
  $('menuProfile').addEventListener('click', openProfile);
  $('frameBtn').addEventListener('click', () => openFrame(allMedia));
  $('musicToggle').addEventListener('click', toggleMusic);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('menuTheme').addEventListener('click', toggleTheme);
  // Синхронизируем иконку с сохранённой темой
  {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('themeBtn').innerHTML = dark ? ico('sun') : ico('moon');
    $('menuTheme').innerHTML = (dark ? ico('sun') : ico('moon')) + (dark ? ' Светлая тема' : ' Тёмная тема');
  }
  $('menuFav').addEventListener('click', () => switchView('favorites'));
  $('menuMap').addEventListener('click', () => switchView('map'));
  $('menuAll').addEventListener('click', () => switchView('all'));
  if (isAdmin) $('menuTrash').addEventListener('click', () => switchView('trash'));
  if (isAdmin) $('menuSnapshot').addEventListener('click', downloadSnapshot);
  if (isAdmin) $('menuRestore').addEventListener('click', restoreSnapshot);
  $('menuFrame').addEventListener('click', () => openFrame(allMedia));
  $('menuMusic').addEventListener('click', toggleMusic);
  $('menuLogout').addEventListener('click', doLogout);
  document.addEventListener('click', closeMenuDropdown);

  // Восстановление последнего вида
  switchView(localStorage.getItem('famarchive_view') || 'albums');
}

// Инициализация тёмной темы
(function initTheme() {
  const saved = localStorage.getItem('famarchive_theme');
  if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
  else document.documentElement.dataset.theme = 'light';
})();

// Закрыть выпадающее меню
function closeMenuDropdown() {
  const dd = $('menuDropdown');
  if (dd) dd.classList.remove('open');
}

// Открыть/закрыть меню (inline onclick)
window.toggleMenu = function (e) {
  if (e) e.stopPropagation();
  const dd = $('menuDropdown');
  if (dd) dd.classList.toggle('open');
};

window.closeMenuDropdown = closeMenuDropdown;

function toggleTheme() {
  const html = document.documentElement;
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = next;
  localStorage.setItem('famarchive_theme', next);
  const btn = $('themeBtn');
  if (btn) btn.innerHTML = next === 'dark' ? ico('sun') : ico('moon');
  const mi = $('menuTheme');
  if (mi) mi.innerHTML = (next === 'dark' ? ico('sun') : ico('moon'))
    + (next === 'dark' ? ' Светлая тема' : ' Тёмная тема');
}

// Показ/скрытие панели создания альбома
let controlsVisible = false;
function toggleControls() {
  controlsVisible = !controlsVisible;
  $('controls-panel').style.display = controlsVisible ? 'block' : 'none';
}

// ============================================================
//   ПЕРЕКЛЮЧЕНИЕ ВИДОВ (АЛЬБОМЫ / ИЗБРАННОЕ) И РАМКА
// ============================================================
let _frameListenersAttached = false;

function setActiveTab(view) {
  document.querySelectorAll('.nav-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === view);
  });
}

window.switchView = function (view) {
  localStorage.setItem('famarchive_view', view);
  setActiveTab(view);
  heroSliderHide();
  const albumsEl = $('albums-container');
  const favEl = $('favorites-container');
  const allEl = $('all-container');
  const mapEl = $('map-container');
  const statsEl = $('stats-bar');
  const controlsEl = $('controls-panel');

  if (view === 'albums') {
    if (favEl) favEl.style.display = 'none';
    if (mapEl) mapEl.style.display = 'none';
    if (allEl) allEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'none';
    albumsEl.style.display = 'block';
    if (controlsEl && controlsVisible) controlsEl.style.display = 'block';
    $('page-title').textContent = 'Семейные фото';
    renderAlbums();
  } else if (view === 'all') {
    albumsEl.style.display = 'none';
    if (favEl) favEl.style.display = 'none';
    if (mapEl) mapEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = 'none';
    if (!allEl) {
      const container = document.createElement('div');
      container.id = 'all-container';
      container.className = 'albums-grid';
      container.style.display = 'grid';
      $('app').appendChild(container);
    } else {
      allEl.style.display = 'grid';
    }
    $('page-title').textContent = 'Все фото';
    renderAllGrid();
  } else if (view === 'favorites') {
    albumsEl.style.display = 'none';
    if (allEl) allEl.style.display = 'none';
    if (mapEl) mapEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = 'none';
    if (!favEl) {
      const container = document.createElement('div');
      container.id = 'favorites-container';
      container.className = 'albums-grid';
      container.style.display = 'grid';
      $('app').appendChild(container);
    } else {
      favEl.style.display = 'grid';
    }
    $('page-title').textContent = 'Избранное';
    renderFavGrid();
  } else if (view === 'map') {
    albumsEl.style.display = 'none';
    if (favEl) favEl.style.display = 'none';
    if (allEl) allEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = 'none';
    $('page-title').textContent = 'Карта путешествий';
    if (mapEl) { mapEl.style.display = 'block'; renderMap(); }
  } else if (view === 'trash') {
    albumsEl.style.display = 'none';
    if (favEl) favEl.style.display = 'none';
    if (allEl) allEl.style.display = 'none';
    if (mapEl) mapEl.style.display = 'none';
    if (statsEl) statsEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = 'none';
    $('page-title').textContent = 'Корзина';
    renderTrash();
  }
};

window.renderFavGrid = async function () {
  const container = $('favorites-container') || (() => {
    const c = document.createElement('div');
    c.id = 'favorites-container';
    c.className = 'albums-grid fav-studio';
    c.style.display = 'grid';
    $('app').appendChild(c);
    return c;
  })();
  container.classList.add('fav-studio');
  container.style.display = 'block';

  container.innerHTML = `
    <div class="fav-head">
      <div class="fav-head-left">
        <div class="fav-title">Избранное</div>
        <div class="fav-count" id="favCount">загрузка…</div>
      </div>
      <div class="fav-actions">
        <select class="fav-sort" id="favSort" title="Сортировка">
          <option value="added">Сначала свежие</option>
          <option value="old">Сначала старые</option>
          <option value="name">По имени</option>
        </select>
        <div class="fav-view-toggle">
          <button class="fav-view ${(window._favMode || 'grid') === 'grid' ? 'active' : ''}" data-mode="grid" title="Сетка">▦</button>
          <button class="fav-view ${(window._favMode || 'grid') === 'mosaic' ? 'active' : ''}" data-mode="mosaic" title="Мозаика">▤</button>
        </div>
        <button class="fav-action" id="favSlide" title="Слайд-шоу по избранным">${ico('play','ico-sm')} Слайд-шоу</button>
      </div>
    </div>
    <div class="fav-grid ${window._favMode === 'mosaic' ? 'mosaic' : ''}" id="favGrid">
      <div class="loading-row">Загружаем избранное…</div>
    </div>`;

  const grid = $('favGrid');

  const sortMedia = (list, mode) => {
    const sorted = [...list];
    if (mode === 'old') sorted.sort((a, b) => new Date(a.createdAt || a.created_at || 0) - new Date(b.createdAt || b.created_at || 0));
    else if (mode === 'name') sorted.sort((a, b) => (a.filename || '').localeCompare(b.filename || '', 'ru'));
    else sorted.sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
    return sorted;
  };

  try {
    const { media } = await api('/api/media?favorite=1&limit=200');
    $('favCount').textContent = `${media.length} кадр(ов)`;
    if (!media.length) {
      grid.innerHTML = '<div class="empty-state">В избранном пока ничего нет.<br>Нажимайте «♥» на фото, чтобы сохранить их сюда.</div>';
      return;
    }

    const renderCards = (list) => {
      grid.innerHTML = '';
      list.forEach((m, idx) => {
        const card = document.createElement('div');
        card.className = 'fav-card';
        const isVideo = m.kind === 'video';
        // Мозаика: карточки разной высоты
        const tall = window._favMode === 'mosaic' ? (idx % 3 === 0 ? 1.3 : idx % 3 === 1 ? 1.0 : 0.78) : 1;
        card.innerHTML = `
          <div class="fav-media" style="${tall !== 1 ? `padding-top:${(tall * 100).toFixed(0)}%` : ''}">
            <img src="${m.thumbUrl || m.url}" alt="${escapeHtml(m.filename || '')}" loading="lazy">
            ${isVideo ? '<span class="vid-badge">▶</span>' : ''}
          </div>
          <div class="fav-overlay">
            <button class="fav-overlay-btn" data-act="open" title="Открыть">👁</button>
<button class="fav-overlay-btn" data-act="unfav" title="Убрать из избранного">${ico('heart')}</button>
      <button class="fav-overlay-btn" data-act="dl" title="Скачать">${ico('download')}</button>
          </div>
          <div class="fav-name">${escapeHtml(m.filename || '')}</div>`;
        card.querySelector('.fav-overlay [data-act="open"]').addEventListener('click', (e) => { e.stopPropagation(); openFavGallery(list); jumpToFav(list, m.id); });
        card.querySelector('.fav-overlay [data-act="unfav"]').addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFavorite(m.id).then(() => {
            card.classList.add('removing');
            setTimeout(() => {
              card.remove();
              const count = grid.querySelectorAll('.fav-card').length;
              $('favCount').textContent = `${count} кадр(ов)`;
              if (!count) grid.innerHTML = '<div class="empty-state">В избранном пока ничего нет.</div>';
            }, 250);
          });
        });
        card.querySelector('.fav-overlay [data-act="dl"]').addEventListener('click', (e) => { e.stopPropagation(); downloadCurrentMediaById(m); });
        card.addEventListener('click', () => openFavGallery(list));
        grid.appendChild(card);
      });
    };

    let current = sortMedia(media, $('favSort').value || 'added');
    renderCards(current);

    $('favSort').addEventListener('change', () => {
      current = sortMedia(media, $('favSort').value);
      renderCards(current);
    });
    document.querySelectorAll('.fav-view').forEach((btn) => {
      btn.addEventListener('click', () => {
        window._favMode = btn.dataset.mode;
        document.querySelectorAll('.fav-view').forEach((b) => b.classList.toggle('active', b === btn));
        grid.classList.toggle('mosaic', window._favMode === 'mosaic');
        current = sortMedia(media, $('favSort').value);
        renderCards(current);
      });
    });
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(err.message)}</div>`;
  }

  const slideBtn = $('favSlide');
  if (slideBtn) slideBtn.addEventListener('click', () => {
    const items = window._galleryItems || allMedia;
    openFrame(items);
  });
};

// Открыть галерею избранных и перейти к конкретному фото
function jumpToFav(media, id) {
  const idx = media.findIndex((m) => m.id === id);
  if (idx >= 0) setPhotoAfterOpen(idx);
}
let _pendingPhotoIdx = null;
function setPhotoAfterOpen(idx) { _pendingPhotoIdx = idx; }

// Скачать файл по id
async function downloadCurrentMediaById(m) {
  if (!m) return;
  const saved = { url: m.url, filename: m.filename, kind: m.kind, id: m.id };
  window._downloadTarget = saved;
  try {
    let url = saved.url;
    try {
      const { url: dlUrl } = await api(`/api/media/${saved.id}/download`);
      if (dlUrl) url = dlUrl;
    } catch { /* use current */ }
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Не получилось загрузить');
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = saved.filename || `file.${saved.kind === 'video' ? 'mp4' : 'jpg'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    alert('Не удалось скачать: ' + err.message);
  }
}

// В openFavGallery после показа первого фото переходим на нужное
window.openFavGallery = function (items) {
  window._galleryItems = items;
  currentPhotoIdx = 0;
  $('gallery-title').textContent = 'Избранное';
  $('gallery-author').textContent = '';
  const thumbsContainer = $('gallery-thumbs');
  thumbsContainer.innerHTML = '';
  items.forEach((photo, pIdx) => {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';
    thumb.dataset.idx = pIdx;
    thumb.innerHTML = `<img src="${photo.thumbUrl || photo.url}" alt="">${photo.kind === 'video' ? '<span class="vid-badge">▶</span>' : ''}`;
    thumb.addEventListener('click', () => showPhoto(pIdx));
    thumbsContainer.appendChild(thumb);
  });
  const startIdx = (_pendingPhotoIdx != null && _pendingPhotoIdx < items.length) ? _pendingPhotoIdx : 0;
  _pendingPhotoIdx = null;
  if (items.length) showPhoto(startIdx);
  $('gallery').classList.add('active');
};

// Вид «Все фото»: сетка всех медиа
window.renderAllGrid = async function () {
  const container = $('all-container') || (() => {
    const c = document.createElement('div');
    c.id = 'all-container';
    c.className = 'albums-grid';
    c.style.display = 'grid';
    $('app').appendChild(c);
    return c;
  })();
  container.innerHTML = '<div class="section-label">Все фото</div><div class="loading-row">Загружаем архив…</div>';
  try {
    const { media } = await api('/api/media?limit=200');
    if (!media.length) {
      container.innerHTML = '<div class="section-label">Все фото</div><div class="empty-state">В архиве пока нет фото и видео.</div>';
      return;
    }
    container.innerHTML = '<div class="section-label">Все фото</div>';
    media.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'album-card';
      const img = document.createElement('img');
      img.src = m.thumbUrl || m.url;
      img.alt = m.filename || '';
      img.loading = 'lazy';
      const wrap = document.createElement('div');
      wrap.className = 'photo-thumb';
      wrap.appendChild(img);
      if (m.kind === 'video') {
        const v = document.createElement('span');
        v.className = 'vid-badge';
        v.textContent = '▶';
        wrap.appendChild(v);
      }
      const title = document.createElement('div');
      title.className = 'album-card-foot';
      title.innerHTML = `<div class="album-card-title">${escapeHtml(m.filename || '')}</div>`;
      card.appendChild(wrap);
      card.appendChild(title);
      card.addEventListener('click', () => openFavGallery([m]));
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(err.message)}</div>`;
  }
};

// Корзина (admin): удалённые файлы, восстановление / удаление навсегда
window.renderTrash = async function () {
  let trashEl = $('trash-container');
  if (!trashEl) {
    trashEl = document.createElement('div');
    trashEl.id = 'trash-container';
    trashEl.className = 'albums-grid';
    trashEl.style.display = 'grid';
    $('app').appendChild(trashEl);
  }
  trashEl.innerHTML = '<div class="section-label">Корзина</div><div class="loading-row">Загружаем корзину…</div>';
  try {
    const { media } = await api('/api/admin/trash');
    if (!media.length) {
      trashEl.innerHTML = '<div class="section-label">Корзина</div><div class="empty-state">Корзина пуста.</div>';
      return;
    }
    trashEl.innerHTML = '<div class="section-label">Корзина</div>';
    media.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'album-card';
      const wrap = document.createElement('div');
      wrap.className = 'photo-thumb';
      const img = document.createElement('img');
      img.src = m.thumbUrl || m.url;
      img.alt = m.filename || '';
      img.loading = 'lazy';
      wrap.appendChild(img);
      if (m.kind === 'video') {
        const v = document.createElement('span');
        v.className = 'vid-badge';
        v.textContent = '▶';
        wrap.appendChild(v);
      }
      const foot = document.createElement('div');
      foot.className = 'album-card-foot';
      foot.innerHTML = `<div class="album-card-title">${escapeHtml(m.filename || '')}</div>`;
      const actions = document.createElement('div');
      actions.className = 'trash-actions';
      const restore = document.createElement('button');
      restore.className = 'btn-create';
      restore.textContent = 'Восстановить';
      restore.addEventListener('click', async () => {
        await api(`/api/admin/trash/${m.id}/restore`, { method: 'POST' });
        renderTrash();
      });
      const del = document.createElement('button');
      del.className = 'btn-danger-soft';
      del.textContent = 'Удалить навсегда';
      del.addEventListener('click', async () => {
        if (!confirm('Удалить навсегда? Это действие необратимо.')) return;
        await api(`/api/admin/trash/${m.id}`, { method: 'DELETE' });
        renderTrash();
      });
      actions.appendChild(restore);
      actions.appendChild(del);
      foot.appendChild(actions);
      card.appendChild(wrap);
      card.appendChild(foot);
      trashEl.appendChild(card);
    });
  } catch (err) {
    trashEl.innerHTML = `<div class="section-label">Корзина</div><div class="empty-state">Ошибка: ${escapeHtml(err.message)}</div>`;
  }
};

window.openFrame = function (items) {
  if (!items || !items.length) return;
  window._frameItems = items;
  currentPhotoIdx = 0;
  showFramePhoto(0);
  $('frame-overlay').classList.add('active');
  startFrameAutoplay();
};

window.closeFrame = function () {
  stopFrameAutoplay();
  $('frame-overlay').classList.remove('active');
  const v = document.querySelector('#frame-stage video');
  if (v) v.remove();
};

window.showFramePhoto = function (idx) {
  const items = window._frameItems || [];
  if (!items.length) return;
  const i = ((idx % items.length) + items.length) % items.length;
  currentPhotoIdx = i;
  const photo = items[i];
  const stage = $('frame-stage');
  const existingVideo = stage.querySelector('video');
  if (existingVideo) existingVideo.remove();
  if (photo.kind === 'video') {
    const vid = document.createElement('video');
    vid.controls = true;
    vid.src = photo.url;
    vid.poster = photo.posterUrl || '';
    vid.style.cssText = 'width:100%;height:100%;';
    stage.appendChild(vid);
  } else {
    stage.style.backgroundImage = `url('${photo.url}')`;
    stage.style.backgroundSize = 'contain';
    stage.style.backgroundPosition = 'center';
    stage.style.backgroundRepeat = 'no-repeat';
    stage.style.backgroundColor = '#000';
  }
  $('frame-caption').textContent = photo.filename || '';
  $('frame-counter').textContent = `${i + 1} из ${items.length}`;
  document.querySelectorAll('.frame-thumb').forEach((t, j) => t.classList.toggle('active', j === i));
};

window.prevFrame = function () { showFramePhoto(currentPhotoIdx - 1); };
window.nextFrame = function () { showFramePhoto(currentPhotoIdx + 1); };

let frameTimer = null;
window.startFrameAutoplay = function () {
  const speed = Number(localStorage.getItem('frame_speed')) || 4;
  stopFrameAutoplay();
  frameTimer = setInterval(nextFrame, speed * 1000);
  const btn = $('framePlayBtn');
  if (btn) btn.textContent = '⏸';
};

window.stopFrameAutoplay = function () {
  clearInterval(frameTimer);
  frameTimer = null;
  const btn = $('framePlayBtn');
  if (btn) btn.textContent = '▶';
};

window.toggleFramePlay = function () {
  if (frameTimer) stopFrameAutoplay(); else startFrameAutoplay();
};

window.setFrameSpeed = function (s) {
  localStorage.setItem('frame_speed', s);
  startFrameAutoplay();
};

// Навигация и клавиатура для рамки (один раз)
if (!_frameListenersAttached) {
  _frameListenersAttached = true;
  document.addEventListener('keydown', (e) => {
    if (!$('frame-overlay').classList.contains('active')) return;
    if (e.key === 'Escape') { closeFrame(); return; }
    if (e.key === 'ArrowLeft') { prevFrame(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { nextFrame(); e.preventDefault(); }
    if (e.key === ' ') { toggleFramePlay(); e.preventDefault(); }
  });
  let touchStartX = 0;
  $('frame-overlay').addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
  $('frame-overlay').addEventListener('touchend', (e) => {
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) { if (diff > 0) nextFrame(); else prevFrame(); }
  });
}

window.refreshAllMediaCache = async function () {
  try {
    const { media } = await api('/api/media?limit=500');
    allMedia = media;
  } catch (err) {
    console.warn('Не удалось обновить кэш AllMedia:', err);
  }
};

window.toggleFavorite = async function (mediaId) {
  try {
    const item = allMedia.find(m => m.id === mediaId);
    const next = item ? !item.isFavorite : true;
    await api(`/api/media/${mediaId}/favorite`, { method: 'PUT', body: { favorite: next } });
    if (item) item.isFavorite = next;
    const current = localStorage.getItem('famarchive_view') || 'albums';
    if (current === 'favorites') renderFavGrid();
  } catch (err) {
    console.warn('Не удалось переключить избранное:', err);
  }
};

function enhanceGalleryThumbs() {
  const thumbs = document.querySelectorAll('.gallery-thumb');
  thumbs.forEach(thumb => {
    const existing = thumb.querySelector('.fav-thumb-btn');
    if (existing) existing.remove();
    const btn = document.createElement('button');
    btn.className = 'fav-thumb-btn';
    btn.innerHTML = ico('heart');
    btn.title = 'В избранное';
    btn.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(232,77,66,.9);color:#fff;border:none;border-radius:50%;width:28px;height:28px;font-size:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
    thumb.style.position = 'relative';
    thumb.appendChild(btn);
    const pIdx = parseInt(thumb.getAttribute('data-idx'), 10);
    const photo = (window._galleryItems || [])[pIdx];
    if (photo) {
      btn.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite(photo.id);
      };
    }
  });
}
// Подписываемся на показ галереи (один раз)
const origShowPhoto = window.showPhoto;
window.showPhoto = function (photoIdx) {
  origShowPhoto.call(this, photoIdx);
  setTimeout(() => { enhanceGalleryThumbs(); renderGalleryTags(); renderComments(); }, 50);
};

// ============================================================
//   КОММЕНТАРИИ К ФОТО
// ============================================================
async function renderComments() {
  const box = $('gallery-comments');
  const list = $('galleryCommentsList');
  const items = window._galleryItems || [];
  const photo = items[currentPhotoIdx];
  if (!box || !list || !photo) return;
  try {
    const { comments } = await api(`/api/media/${photo.id}/comments`);
    if (!comments || !comments.length) {
      list.innerHTML = '<div class="gallery-comment-empty">Пока нет комментариев. Напишите первый.</div>';
    } else {
      list.innerHTML = comments.map((c) => `
        <div class="gallery-comment">
          <div class="cm-avatar">${escapeHtml((c.author_name || 'Г').trim().charAt(0).toUpperCase())}</div>
          <div class="cm-body">
            <div class="cm-author">${escapeHtml(c.author_name || 'Гость')}${currentUser && (c.user_id === currentUser.id || currentUser.role === 'admin') ? `<button class="cm-del" data-del="${c.id}">✕</button>` : ''}</div>
            <div class="cm-text">${escapeHtml(c.body)}</div>
            <div class="cm-meta">${fmtDate(c.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          </div>
        </div>`).join('');
      list.querySelectorAll('.cm-del').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/api/media/${photo.id}/comments/${btn.dataset.del}`, { method: 'DELETE' });
            renderComments();
          } catch (e) { alert('Не удалось удалить: ' + e.message); }
        });
      });
    }
  } catch (err) {
    list.innerHTML = '<div class="gallery-comment-empty">Комментарии недоступны.</div>';
  }
}

// Отправка комментария
async function sendComment() {
  const photo = (window._galleryItems || [])[currentPhotoIdx];
  const input = $('commentInput');
  const text = (input?.value || '').trim();
  if (!photo || !text) return;
  try {
    await api(`/api/media/${photo.id}/comments`, { method: 'POST', body: { body: text } });
    if (input) input.value = '';
    renderComments();
  } catch (err) {
    alert('Не удалось отправить: ' + err.message);
  }
}
window.sendComment = sendComment;

// Привязка формы комментария
(function initCommentForm() {
  const send = $('commentSend');
  const input = $('commentInput');
  if (send) send.addEventListener('click', sendComment);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });
})();

// Панель инструментов галереи
(function initGalleryToolbar() {
  const editBtn = $('toolEdit');
  const colBtn = $('toolCollage');
  const frBtn = $('toolFrame');
  if (editBtn) editBtn.addEventListener('click', openEditor);
  if (colBtn) colBtn.addEventListener('click', openCollage);
  if (frBtn) frBtn.addEventListener('click', () => openFrame(window._galleryItems || allMedia));
})();

// Теги в галерее: показать для текущего фото, добавить/удалить (только для редакторов)
async function renderGalleryTags() {
  const box = $('gallery-tags');
  const items = window._galleryItems || [];
  const photo = items[currentPhotoIdx];
  if (!box || !photo) { if (box) box.innerHTML = ''; return; }
  try {
    const { tags } = await api(`/api/tags/media/${photo.id}/tags`);
    const editable = canUpload();
    const facesBtn = editable && photo.kind === 'image'
      ? `<button class="gallery-tag-add" id="facesBtn" title="Запустить распознавание лиц">${ico('user','ico-sm')} Распознать</button>`
      : '';
    const capsuleBtn = editable
      ? `<button class="gallery-tag-add" id="capsuleBtn" title="Запечатать в капсулу времени">${ico('lock','ico-sm')} Капсула</button>`
      : '';
    box.innerHTML = (tags || []).map((t) =>
      `<button class="gallery-tag" data-tagid="${t.id}" data-name="${escapeHtml(t.name)}" ${editable ? 'title="Убрать тег"' : ''}>#${escapeHtml(t.name)}</button>`
    ).join('') + (editable ? `<button class="gallery-tag-add" id="tagAddBtn">${ico('plus','ico-sm')} тег</button>` : '') + facesBtn + capsuleBtn;

    if (editable) {
      box.querySelectorAll('.gallery-tag').forEach((t) => {
        t.addEventListener('click', async () => {
          await api(`/api/tags/media/${photo.id}/tags/${t.dataset.tagid}`, { method: 'DELETE' }).catch(() => {});
          renderGalleryTags();
        });
      });
      $('tagAddBtn').addEventListener('click', () => {
        const name = prompt('Название тега:');
        if (name && name.trim()) {
          api(`/api/tags/media/${photo.id}/tags`, { method: 'POST', body: { name: name.trim() } })
            .then(() => renderGalleryTags())
            .catch((e) => alert('Не удалось добавить тег: ' + e.message));
        }
      });
      const facesBtnEl = $('facesBtn');
      if (facesBtnEl) {
        facesBtnEl.addEventListener('click', async () => {
          try {
            await api(`/api/media/${photo.id}/faces`, { method: 'POST' });
            alert('Задача распознавания поставлена. Обновите страницу позже — блок «Люди на фото» появится автоматически.');
          } catch (e) {
            alert('Ошибка: ' + e.message);
          }
        });
      }
      const capsuleBtnEl = $('capsuleBtn');
      if (capsuleBtnEl) {
        capsuleBtnEl.addEventListener('click', () => sealCapsule(photo));
      }
    }
  } catch (err) { box.innerHTML = ''; }
}
function canUpload() { return ['admin', 'editor'].includes(currentUser?.role); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Прогресс-бар загрузки
let _progressTimer = null;
function startProgress() {
  const bar = $('topProgress');
  if (!bar) return;
  bar.classList.remove('done');
  bar.classList.add('on');
  bar.style.width = '12%';
  _progressTimer = setInterval(() => {
    const cur = parseFloat(bar.style.width) || 12;
    if (cur < 80) bar.style.width = Math.min(80, cur + 8) + '%';
  }, 180);
}
function doneProgress() {
  const bar = $('topProgress');
  clearInterval(_progressTimer);
  _progressTimer = null;
  if (!bar) return;
  bar.style.width = '100%';
  setTimeout(() => {
    bar.classList.add('done');
    setTimeout(() => { bar.style.width = '0%'; bar.classList.remove('on'); }, 450);
  }, 220);
}
window.startProgress = startProgress;
window.doneProgress = doneProgress;

// Скачать альбом ZIP
async function downloadAlbum(id, title) {
  try {
    const res = await fetch(`${API_URL}/api/albums/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Ошибка');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'album').replace(/[^a-zа-яё0-9\s_-]/gi, '_')}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Не удалось скачать: ' + err.message);
  }
}

// Переименовать / изменить описание альбома
async function editAlbum(album) {
  if (!canUpload() || !album) return;
  const newTitle = prompt('Название альбома:', album.title || '');
  if (newTitle === null) return;
  const title = String(newTitle).trim();
  if (!title) { alert('Название не может быть пустым'); return; }
  const desc = prompt('Описание (или оставьте пустым):', album.description || '');
  if (desc === null) return;
  try {
    await api(`/api/albums/${album.id}`, { method: 'PATCH', body: { title, description: String(desc).trim() } });
    renderAlbums();
  } catch (err) {
    alert('Не удалось сохранить: ' + err.message);
  }
}

// Скачать текущий файл в галерее (одиночное фото/видео)
async function downloadCurrentMedia() {
  const items = window._galleryItems || [];
  const photo = items[currentPhotoIdx];
  if (!photo) return;
  try {
    let url = photo.url;
    // Пробуем получить оригинал через download-эндпоинт
    try {
      const { url: dlUrl } = await api(`/api/media/${photo.id}/download`);
      if (dlUrl) url = dlUrl;
    } catch { /* используем текущий url */ }
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Не получилось загрузить');
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = photo.filename || `file.${photo.kind === 'video' ? 'mp4' : 'jpg'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    alert('Не удалось скачать: ' + err.message);
  }
}

// Создать ссылку-приглашение (admin, editor)
async function createInvite() {
  if (!canUpload()) return;
  const role = confirm('Пригласить как «редактора» (может загружать фото)?\n\nОК — редактор, Отмена — гость (только смотреть).')
    ? 'editor'
    : 'guest';
  try {
    const { link, expiresAt } = await api('/api/invites', { method: 'POST', body: { role, expiresInDays: 365, maxUses: 1 } });
    showQrModal(`Ссылка для присоединения (до ${fmtDate(expiresAt)}):`, link);
  } catch (err) {
    alert('Не удалось создать приглашение: ' + err.message);
  }
}

// Создать и скачать снимок архива (только админ)
async function downloadSnapshot() {
  try {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch(`${API_URL}/api/admin/snapshot`, { method: 'POST', headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || 'Не удалось создать снимок');
    }
    const data = await res.json();
    // Скачиваем zip с авторизацией через заголовок
    const dl = await fetch(`${API_URL}/api/admin/snapshot/${encodeURIComponent(data.name)}`, { headers });
    if (!dl.ok) throw new Error('Не удалось скачать снимок');
    const blob = await dl.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    alert('Снимок создан и скачивается. Храните его в безопасном месте.');
  } catch (err) {
    alert(err.message);
  }
}
window.downloadSnapshot = downloadSnapshot;

// Восстановить состояние из снимка (только админ)
function restoreSnapshot() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,.application/zip';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!confirm('Восстановить архив из «' + file.name + '»?\n\nТекущие данные будут заменены (старая БД сохранится в backup). После восстановления сервер нужно перезапустить.')) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const res = await fetch(`${API_URL}/api/admin/snapshot/restore`, { method: 'POST', headers, body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось восстановить');
      alert('Архив восстановлен.\n\n' + (data.note || '') + '\n\nДанные и БД обновлены. Перезапустите сервер, чтобы применить серверный код.');
      location.reload();
    } catch (err) {
      alert(err.message);
    }
  };
  input.click();
}
window.restoreSnapshot = restoreSnapshot;

// Показать модалку с QR-кодом и текстом ссылки
function showQrModal(title, link) {
  const overlay = document.createElement('div');
  overlay.className = 'qr-overlay';
  overlay.innerHTML = `
    <div class="qr-card">
      <button class="gallery-close qr-close" title="Закрыть">✕</button>
      <div class="qr-title">${escapeHtml(title)}</div>
      <img class="qr-img" src="${API_URL}/api/map/qr?text=${encodeURIComponent(link)}" alt="QR">
      <div class="qr-link">${escapeHtml(link)}</div>
      <div class="qr-actions">
        <button class="btn-create" id="qrCopy">Копировать ссылку</button>
      </div>
    </div>`;
  overlay.querySelector('.qr-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#qrCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link);
      overlay.querySelector('#qrCopy').textContent = 'Скопировано ✓';
    } catch {
      window.prompt('Скопируйте ссылку:', link);
    }
  });
  document.body.appendChild(overlay);
}

// Поделиться альбомом: создать публичную ссылку + показать QR
async function shareAlbumQr(albumId) {
  try {
    const { link } = await api('/api/media/share-album', { method: 'POST', body: { albumId } });
    showQrModal('Ссылка для просмотра альбома (без входа):', link);
  } catch (err) {
    alert('Не удалось создать ссылку: ' + err.message);
  }
}

// ============================================================
//   СТАТИСТИКА
// ============================================================
async function renderStats() {
  const bar = $('stats-bar');
  if (!bar || !currentUser) return;
  try {
    const stats = await api('/api/map/stats');
    const total = (stats.photos || 0) + (stats.videos || 0);
    // Период архива: «за год», «за 3 года», «за 2012–2026»
    let period = '';
    if (stats.byYear && stats.byYear.length) {
      const ys = stats.byYear.map((y) => Number(y.year)).filter((n) => !isNaN(n)).sort((a, b) => a - b);
      if (ys.length === 1) {
        const n = new Date().getFullYear() - ys[0];
        let suffix = 'год';
        if (n >= 2 && n <= 4) suffix = 'года';
        else if (n >= 5) suffix = 'лет';
        period = n <= 0 ? 'этот год' : `за ${n} ${suffix}`;
      } else {
        period = `за ${ys[0]}–${ys[ys.length - 1]}`;
      }
    } else {
      period = 'пока немного';
    }
    // «воспоминаний» / «воспоминание»
    let word = 'воспоминаний';
    if (total === 1) word = 'воспоминание';
    else if (total >= 2 && total <= 4) word = 'воспоминания';

    bar.innerHTML = `
      <div class="history-line">
        <div class="history-icon">📖</div>
        <div><b>${total} ${word} ${period}.</b><br>Самое время перелистать страницы истории.</div>
      </div>`;
  } catch (err) {
    bar.innerHTML = '';
  }
}

// ============================================================
//   КАРТА
// ============================================================
let _map = null;
let _mapMarkers = [];

async function renderMap() {
  const container = $('map-container');
  if (!container || !currentUser) return;
  const mapEl = $('map');
  if (!mapEl) return;

  // Сначала покажем загрузку
  mapEl.innerHTML = '<div class="loading-row">Загружаем карту…</div>';

  let items;
  try {
    const data = await api('/api/map');
    items = data.media || [];
  } catch (err) {
    mapEl.innerHTML = `<div class="map-empty">Карта недоступна: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!items.length) {
    mapEl.innerHTML = '<div class="map-empty">Фото с геолокацией пока нет. Снимите несколько кадров с телефоном, включив GPS.</div>';
    if (_map) { _map.remove(); _map = null; _mapMarkers = []; }
    return;
  }

  // Лениво подгружаем Leaflet, если вдруг не загрузился
  if (typeof L === 'undefined') {
    mapEl.innerHTML = '<div class="map-empty">Карта не загрузилась (Leaflet недоступен).</div>';
    return;
  }

  if (!_map) {
    _map = L.map(mapEl).setView([55.75, 37.61], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(_map);
  }

  // Очистка старых маркеров
  _mapMarkers.forEach((m) => _map.removeLayer(m));
  _mapMarkers = [];

  items.forEach((it) => {
    if (!it.lat || !it.lng) return;
    const popupContent = `
      <div style="min-width:140px;text-align:center">
        <img src="${it.thumbUrl || ''}" style="width:100%;border-radius:6px;margin-bottom:6px" onerror="this.style.display='none'">
        <div style="font-size:12px">${escapeHtml(it.filename)}${it.dateTaken ? '<br>' + escapeHtml(fmtDate(it.dateTaken)) : ''}</div>
      </div>`;
    const marker = L.marker([it.lat, it.lng]).addTo(_map).bindPopup(popupContent);
    _mapMarkers.push(marker);
  });

  // Подгоняем видимую область под маркеры
  if (_mapMarkers.length > 0) {
    const group = L.featureGroup(_mapMarkers);
    _map.fitBounds(group.getBounds().pad(0.2));
  }
}

window.renderStats = renderStats;
window.renderMap = renderMap;

// ============================================================
//   СЛАЙДЕР ПОСЛЕДНЕГО АЛЬБОМА
// ============================================================
let heroTimer = null;
let heroIdx = 0;
let heroPhotos = [];

function heroSliderHide() {
  clearInterval(heroTimer);
  heroTimer = null;
  const slider = $('hero-slider');
  if (slider) slider.style.display = 'none';
  const label = $('heroLabel');
  if (label) label.remove();
}

function heroSliderBuild(album, photos) {
  const slider = $('hero-slider');
  if (!slider) return;
  if (!album || !photos || photos.length === 0) {
    heroSliderHide();
    return;
  }
  heroPhotos = photos.slice(0, 20); // максимум 20 слайдов
  heroIdx = 0;
  slider.style.display = 'block';
  const label = $('heroLabel') || document.createElement('div');
  label.id = 'heroLabel';
  label.className = 'section-label';
  label.textContent = 'Главный альбом';
  slider.insertAdjacentElement('beforebegin', label);
  slider.innerHTML = `
    <button class="hero-nav prev" id="heroPrev" title="Назад">‹</button>
    <div class="hero-dots" id="heroDots"></div>
    <div class="hero-slide" id="heroSlide"></div>
    <button class="hero-nav next" id="heroNext" title="Вперёд">›</button>
    <button class="hero-frame-btn" id="heroFrameBtn" title="Полноэкранная рамка">${ico('arrow-down','ico-sm')}</button>
    <div class="hero-caption" id="heroCaption">
      <div class="hero-album">Альбом «${escapeHtml(album.title)}» — лучшие моменты вместе</div>
      <div class="hero-file" id="heroFile">Наши самые тёплые дни — здесь</div>
    </div>
  `;
  $('heroPrev').addEventListener('click', (e) => { e.stopPropagation(); heroStep(-1); });
  $('heroNext').addEventListener('click', (e) => { e.stopPropagation(); heroStep(1); });
  $('heroSlide').addEventListener('click', () => openGallery(album, heroPhotos));
  $('heroFrameBtn').addEventListener('click', (e) => { e.stopPropagation(); openFrame(heroPhotos); });
  heroShow(0);
  // Hero — статичная обложка: без автопрокрутки
  stopFrameAutoplay();
  heroTimer = null;
}

function heroShow(idx) {
  heroIdx = ((idx % heroPhotos.length) + heroPhotos.length) % heroPhotos.length;
  const p = heroPhotos[heroIdx];
  const slide = $('heroSlide');
  if (!slide) return;
  slide.style.backgroundImage = `url('${p.url}')`;
  slide.title = p.filename || '';
  const dots = $('heroDots');
  if (dots) {
    dots.innerHTML = heroPhotos.map((_, i) =>
      `<button class="hero-dot${i === heroIdx ? ' active' : ''}" data-i="${i}"></button>`).join('');
    dots.querySelectorAll('.hero-dot').forEach((d) => {
      d.addEventListener('click', (e) => { e.stopPropagation(); heroShow(Number(d.dataset.i)); });
    });
  }
  const file = $('heroFile');
  if (file) file.textContent = p.filename || '';
}

function heroStep(dir) {
  heroShow(heroIdx + dir);
}

function renderHeroSlider(album, photos) {
  heroSliderBuild(album, photos);
}

window.heroSliderHide = heroSliderHide;
window.renderHeroSlider = renderHeroSlider;

// Моменты: 3–4 самых ценных альбома с бейджами
function renderMoments(albumsList, grouped, parent) {
  if (!albumsList || !albumsList.length) return;
  const withMedia = albumsList
    .map((a) => ({ album: a, photos: grouped[a.id] || [] }))
    .filter((x) => x.photos.length > 0)
    .sort((x, y) => y.photos.length - x.photos.length)
    .slice(0, 4);
  if (!withMedia.length) return;

  const s = document.createElement('section');
  s.className = 'moments';
  s.innerHTML = `
    <div class="moments-head">
      <div class="moments-title">Моменты</div>
      <div class="moments-sub">Самые тёплые альбомы</div>
    </div>
    <div class="moments-grid"></div>`;
  const grid = s.querySelector('.moments-grid');

  withMedia.forEach(({ album, photos }, idx) => {
    const cover = photos[0];
    const badge = idx === 0 ? 'Популярное' : idx === 1 ? 'Любимое' : 'Новое';
    const videos = photos.filter((p) => p.kind === 'video').length;
    const card = document.createElement('div');
    card.className = 'moment-card';
    card.innerHTML = `
      <div class="moment-media">
        <img src="${cover.thumbUrl || cover.url}" alt="" loading="lazy">
        <span class="moment-badge">${badge}</span>
        <span class="moment-type">${videos > 0 ? ico('play') : ico('camera')}</span>
      </div>
      <div class="moment-body">
        <div class="moment-name">${escapeHtml(album.title || 'Без названия')}</div>
        <div class="moment-count">${photos.length} элемент(ов)${videos ? ` · ${videos} видео` : ''}</div>
      </div>`;
    card.addEventListener('click', () => openGallery(album, photos));
    grid.appendChild(card);
  });

  parent.appendChild(s);
}

// ============================================================
//   АЛЬБОМЫ
// ============================================================
async function renderAlbums() {
  const container = $('albums-container');
  if (!currentUser) return;
  container.innerHTML = '<div class="loading-row">Загружаем альбомы…</div>';
  startProgress();

  try {
    const { albums: list } = await api('/api/albums');
    albums = list;

    // Грузим медиа для превью (до 500 на альбом)
    const { media } = await api('/api/media?limit=500');
    allMedia = media;
    renderStats();

    const grouped = {};
    media.forEach((m) => {
      const aid = m.albumId || 0; // 0 = без альбома
      if (!grouped[aid]) grouped[aid] = [];
      grouped[aid].push(m);
    });

    // Главный альбом (самый свежий) теперь показывается внутри карточки года,
    // а не отдельным слайдером сверху — прячем верхний hero-блок.
    heroSliderHide();

    // Моменты: самые ценные альбомы
    renderMoments(albums, grouped, container);

    if (albums.length === 0) {
      container.innerHTML = '<div class="empty-state">Альбомов пока нет. Создайте первый!</div>';
      return;
    }

    container.innerHTML = '';

    // «Главы нашей истории» — агрегация по годам съёмки
    const leadAlbum = [...albums].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .find((a) => (grouped[a.id] || []).length > 0);
    renderTimeline(allMedia, container, { leadAlbum, leadPhotos: leadAlbum ? grouped[leadAlbum.id] : [] });

    // Сетка «Последние воспоминания» — свежие зашиты в смысл блока
    const railHeader = document.createElement('div');
    railHeader.className = 'mem-head';
    railHeader.innerHTML = `<h2 class="mem-head-title">Последние воспоминания</h2>`;
    container.appendChild(railHeader);

    const rail = document.createElement('div');
    rail.className = 'mem-grid';
    container.appendChild(rail);

    const sortAlbums = (albumsList, mode) => {
      const sorted = [...albumsList];
      if (mode === 'old') sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      else if (mode === 'name') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
      else if (mode === 'count') sorted.sort((a, b) => (grouped[b.id] || []).length - (grouped[a.id] || []).length);
      else sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return sorted;
    };

    const renderRailCards = (albumsList) => {
      rail.innerHTML = '';
      const nonEmpty = albumsList.filter((a) => (grouped[a.id] || []).length > 0);
      if (!nonEmpty.length) {
        rail.innerHTML = `<div class="mem-empty">
          <div class="mem-empty-ill" aria-hidden="true">${ico('image','ico-lg')}</div>
          <div class="mem-empty-text">Пока нет новых воспоминаний</div>
        </div>`;
        return;
      }
      nonEmpty.forEach((album) => {
        const photos = grouped[album.id] || [];
        const cover = photos[0];
        const t = album.title || 'Без названия';
        const days = Math.max(0, Math.floor((Date.now() - new Date(album.created_at).getTime()) / 864e5));
        const hrs = Math.max(0, Math.floor((Date.now() - new Date(album.created_at).getTime()) / 36e5));
        const mins = Math.max(0, Math.floor((Date.now() - new Date(album.created_at).getTime()) / 6e4));
        let addedLabel;
        if (hrs < 24) addedLabel = `сегодня, ${new Date(album.created_at).toTimeString().slice(0, 5)}`;
        else if (hrs < 48) addedLabel = `вчера, ${new Date(album.created_at).toTimeString().slice(0, 5)}`;
        else if (days < 7) addedLabel = `${days} ${pluralDays(days)} назад`;
        else addedLabel = fmtDate(album.created_at, { day: 'numeric', month: 'long' });
        const isNew = days <= 2 || hrs < 48;
        const n = photos.length;

        const card = document.createElement('article');
        card.className = 'mem-card';
        const portrait = cover && cover.height > cover.width;
        // Контекстная подсказка (CTA) по состоянию альбома
        const albumDesc = (album.description || '').trim();
        const hintTxt = !albumDesc ? 'Добавьте описание' : '';
        // Тепловая карта: распределение фото по последним 7 дням
        const heat = [0, 0, 0, 0, 0, 0, 0];
        const nowD = new Date();
        photos.forEach((p) => {
          const src = p.dateTaken || p.createdAt || p.created_at;
          const d = src ? new Date(src) : null;
          if (!d || isNaN(d.getTime())) return;
          const diff = Math.floor((nowD - d) / 864e5);
          if (diff >= 0 && diff < 7) heat[6 - diff]++;
        });
        const heatMax = Math.max(...heat, 1);
        const dayN = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
        const dayFull = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
        const heatButtons = heat.map((v, i) =>
          `<button type="button" class="heat-dot" data-day="${i}" data-count="${v}" style="background-color:${heatColor(v)}"
             aria-label="${dayFull[i]}, ${v} фото" ${v ? `title="${dayN[i]}: ${v} фото"` : `title="${dayN[i]}: 0 фото"`}>
             <span class="heat-tip">${dayN[i]}: ${v} фото</span>
           </button>`).join('');
        const heatHtml = n ? `<span class="heatmap" role="group" aria-label="Активность за неделю">${heatButtons}</span>` : '';
        // Адаптив <768px: вместо точек — сводная строка с общим числом
        const heatTotalHtml = n ? `<span class="heat-sum">Активность за неделю: ${n} фото</span>` : '';
        // Быстрый просмотр: первые превью
        const quickPreviews = photos.slice(0, 3).map((p) =>
          `<img src="${p.thumbUrl || p.url}" alt="" loading="lazy">`).join('');
        card.innerHTML = `
          <div class="mem-cover" data-orient="${portrait ? 'portrait' : 'landscape'}">
            ${cover ? `<img src="${cover.thumbUrl || cover.url}" alt="${escapeHtml(t)}" loading="lazy">` : `<span class="mem-empty-cover">Пока пусто</span>`}
            ${isNew ? '<span class="mem-badge">Новое</span>' : ''}
            <div class="mem-quick" tabindex="0" title="Быстрый просмотр">${quickPreviews}</div>
            <div class="mem-plate">
              <div class="mp-top">
                <span class="sync-status" data-state="ok" title="Синхронизировано">${ico('cloud','ico-sm')} Синхронизировано</span>
                <div class="mp-actions">
                  ${canUpload() ? `<button class="mem-action" data-albact="edit" title="Редактировать альбом">${ico('edit','ico-sm')}</button>` : ''}
                  <button class="mem-action" data-albact="comment" title="Участники">${ico('users','ico-sm')}</button>
                </div>
              </div>
              <div class="mp-text">
                <h3 class="mem-title">${escapeHtml(t)}</h3>
                ${hintTxt ? `<div class="mem-hint">${escapeHtml(hintTxt)}</div>` : ''}
                <div class="mem-meta">
                  <span class="mem-date">Добавлено ${addedLabel}</span>
                  <span class="mem-count">${n === 0 ? 'нет фото' : `${n} ${pluralPhoto(n)}`}</span>
                  ${heatHtml}
                  <span class="heat-sum">${heatTotalHtml}</span>
                </div>
              </div>
            </div>
          </div>`;
        card.querySelector('[data-albact="edit"]')?.addEventListener('click', (e) => { e.stopPropagation(); editAlbum(album); });
        card.querySelector('[data-albact="comment"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          openGallery(album, photos);
          setTimeout(() => { const bc = $('gallery-comments'); if (bc) bc.scrollIntoView({ behavior: 'smooth', block: 'center' }); const ci = $('commentInput'); if (ci) ci.focus(); }, 400);
        });
        const quickEl = card.querySelector('.mem-quick');
        if (quickEl) quickEl.addEventListener('click', (e) => { e.stopPropagation(); openGallery(album, photos); });
        // Тепловая карта: клик по точке → фильтр галереи по дню
        card.querySelectorAll('.heat-dot').forEach((dotBtn) => {
          dotBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const day = Number(dotBtn.dataset.day);
            const active = dotBtn.classList.toggle('active');
            card.querySelectorAll('.heat-dot').forEach((d) => d.classList.toggle('dimmed', active && d !== dotBtn));
            if (active) {
              const week = photos.filter((p) => {
                const src = p.dateTaken || p.createdAt || p.created_at;
                const d = src ? new Date(src) : null;
                return d && !isNaN(d.getTime()) && Math.floor((nowD - d) / 864e5) === (6 - day);
              });
              window.openFavGallery(week);
            }
          });
        });
        card.addEventListener('click', () => {
          if (!cover) { toggleControls(); setTimeout(() => { const f = $('photo-input'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150); return; }
          openGallery(album, photos);
        });
rail.appendChild(card);
      });
    };

    // Цвет точки тепловой карты по ТЗ: 0 → #333, 1–2 → #999, 3+ → #FF9F1C
    function heatColor(count) {
      if (!count || count <= 0) return '#333';
      if (count <= 2) return '#999';
      return '#FF9F1C';
    }

    renderRailCards(sortAlbums(albums, 'new'));

    // --- Дашборд-виджеты (воспоминания, люди, капсулы) ---
    const widgets = document.createElement('div');
    widgets.className = 'dashboard-widgets';
    container.appendChild(widgets);

    const memCard = document.createElement('div');
    memCard.className = 'dashboard-widget';
    widgets.appendChild(memCard);
    renderMemories(allMedia, memCard);

    const peopleCard = document.createElement('div');
    peopleCard.className = 'dashboard-widget';
    widgets.appendChild(peopleCard);
    renderPeopleSection(peopleCard);

    const capsCard = document.createElement('div');
    capsCard.className = 'dashboard-widget';
    widgets.appendChild(capsCard);
    renderCapsules(capsCard);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Ошибка: ${escapeHtml(err.message)}</div>`;
  }
  doneProgress();
}

// Блок 1: «Свежие воспоминания» — последние 10 альбомов
function pluralDays(n) { return n === 1 ? 'день' : (n >= 2 && n <= 4) ? 'дня' : 'дней'; }
function pluralAlbums(n) { return n === 1 ? 'альбом' : (n >= 2 && n <= 4) ? 'альбома' : 'альбомов'; }
function pluralPhoto(n) { return n === 1 ? 'фото' : (n >= 2 && n <= 4) ? 'фото' : 'фото'; }
function addedLabelSafe(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const hrs = Math.max(0, Math.floor((Date.now() - t) / 36e5));
  const days = Math.max(0, Math.floor((Date.now() - t) / 864e5));
  if (hrs < 24) return `сегодня, ${new Date(iso).toTimeString().slice(0, 5)}`;
  if (hrs < 48) return `вчера, ${new Date(iso).toTimeString().slice(0, 5)}`;
  if (days < 7) return `${days} ${pluralDays(days)} назад`;
  return fmtDate(iso, { day: 'numeric', month: 'long' });
}
function renderFreshAlbums(freshAlbums, grouped, parent) {
  if (!freshAlbums || !freshAlbums.length) return;
  const section = document.createElement('section');
  section.className = 'fresh-albums';
  const head = document.createElement('div');
  head.className = 'block-head';
  const title = document.createElement('h2');
  title.className = 'block-title';
  title.textContent = 'Свежие воспоминания';
  const allBtn = document.createElement('button');
  allBtn.className = 'link-btn';
  allBtn.textContent = 'Все альбомы →';
  allBtn.addEventListener('click', () => { const a = $('albums-container'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  head.append(title, allBtn);
  section.appendChild(head);

  const row = document.createElement('div');
  row.className = 'album-row';
  freshAlbums.forEach((album) => {
    const photos = grouped[album.id] || [];
    const cover = photos[0];
    const daysAgo = Math.max(0, Math.floor((Date.now() - new Date(album.created_at).getTime()) / 864e5));
    const card = document.createElement('article');
    card.className = 'album-card fresh';
    const isNew = daysAgo <= 30;
    card.innerHTML = `
      <div class="cover">
        ${cover ? `<img src="${cover.thumbUrl || cover.url}" alt="${escapeHtml(album.title || '')}" loading="lazy">` : '<div class="cover-empty">Пока пусто</div>'}
        ${isNew ? '<span class="badge-new">Новый</span>' : ''}
      </div>
      <div class="card-body">
        <h3 class="name">${escapeHtml(album.title || 'Без названия')}</h3>
        <div class="meta">
          <span class="date">${daysAgo <= 1 ? 'сегодня' : daysAgo < 30 ? `${daysAgo} ${pluralDays(daysAgo)} назад` : fmtDate(album.created_at, { day: 'numeric', month: 'long' })}</span>
          <span class="count">${photos.length} ${pluralPhoto(photos.length)}</span>
        </div>
      </div>`;
    card.addEventListener('click', () => openGallery(album, photos));
    row.appendChild(card);
  });
  section.appendChild(row);
  parent.appendChild(section);
}

// Анимированное окно «Главный альбом» в карточке самого свежего года
function startChapterSlider(el, photos) {
  const slides = el.querySelectorAll('.slider-slide');
  const bar = el.querySelector('.sp-bar');
  const n = slides.length;
  if (!n) return;
  slides.forEach((s, i) => s.classList.toggle('active', i === 0));
  let i = 0;
  const stepMs = 3500; // пауза между кадрами
  let barAnim = null;
  const runBar = (ms) => { if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; requestAnimationFrame(() => { bar.style.transition = `width ${ms}ms linear`; bar.style.width = '100%'; }); } };
  const tick = () => {
    i = (i + 1) % n;
    slides.forEach((s, k) => s.classList.toggle('active', k === i));
    runBar(stepMs);
  };
  runBar(stepMs);
  const iv = setInterval(tick, stepMs);
  el._stopSlider = () => clearInterval(iv);
  el.addEventListener('mouseenter', () => { clearInterval(iv); if (bar) bar.style.transition = 'none'; }, { passive: true });
  el.addEventListener('mouseleave', () => { startChapterSlider(el, photos); }, { passive: true });
  if (window.IntersectionObserver) {
    const obs = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) runBar(stepMs);
      });
    }, { threshold: 0.3 });
    obs.observe(el);
  }
}

// Лента времени «Главы нашей истории»
function renderTimeline(media, parent, opts = {}) {
  if (!media || !media.length) return;
  const leadAlbum = opts.leadAlbum || null;
  const leadPhotos = (opts.leadPhotos || []).filter((p) => p.kind !== 'video' || p.thumbUrl || p.posterUrl).slice(0, 12);
  const byYear = {};
  media.forEach((m) => {
    const yr = (m.dateTaken || m.createdAt || '');
    const year = yr ? new Date(yr).getFullYear() : null;
    if (!year || isNaN(year)) return;
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(m);
  });
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  if (!years.length) return;

  const warmLines = [
    ['пикников и рассветов', 'первой ёлки у малышей', 'первых шагов и больших слёз радости'],
    ['походов, игр и смеха', 'самых долгих утренников', 'семи дней в неделю любви'],
    ['переездов и новых маршрутов', 'самых тёплых кадров', 'огней и долгих разговоров'],
  ];
  const captions = [
    'самые тёплые дни этого года',
    'вот что осталось у нас в памяти',
    'смотрим и опять улыбаемся',
  ];

  const section = document.createElement('div');
  section.className = 'timeline';
  const head = document.createElement('div');
  head.className = 'story-title';
  head.textContent = 'Главы нашей истории';
  section.appendChild(head);

  const MONTHS_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

  years.forEach((year, yi) => {
    const items = byYear[year].slice();
    const idx = yi % warmLines.length;
    const phrase = warmLines[idx][0];
    const defaultCaption = captions[years.length === 1 ? 0 : idx];

    // Редактируемое описание главы (localStorage)
    const descKey = `famarchive_chapter_desc_${year}`;
    const storedDesc = localStorage.getItem(descKey);

    // Статистика главы
    const photoCount = items.filter((m) => m.kind !== 'video').length;
    const videoCount = items.length - photoCount;
    const albumIds = new Set(items.map((m) => m.albumId).filter(Boolean));
    const monthMap = {};
    items.forEach((m) => {
      const d = m.dateTaken ? new Date(m.dateTaken) : null;
      if (d && !isNaN(d.getMonth())) {
        const mo = d.getMonth();
        monthMap[mo] = (monthMap[mo] || 0) + 1;
      }
    });
    const tooltip = Object.keys(monthMap).sort((a, b) => a - b)
      .map((mo) => `${MONTHS_RU[mo]} — ${monthMap[mo]}`).join(', ');

    const wrap = document.createElement('div');
    wrap.className = 'chapter chapter-reveal';
    const feature = items[0];
    const restList = items.slice(1, 8);
    const rest = restList.map((m) => `
      <div class="year-thumb chapter-thumb" data-mid="${m.id}" data-date="${escapeHtml(m.dateTaken || '')}">
        <img src="${m.thumbUrl || m.url}" alt="${year} год — воспоминание" loading="lazy">${m.kind === 'video' ? '<span class="vid-badge">▶</span>' : ''}
        <button class="ch-fav" data-mid="${m.id}" title="В избранное">${m.isFavorite ? ico('star') : ico('star-plus')}</button>
        <div class="ch-date">${dateLabel(m)}</div>
      </div>`).join('');

    // Самый свежий год: анимированное окно «Главный альбом»
    const isLead = yi === 0 && leadAlbum && leadPhotos.length > 0;
    const featureHtml = isLead
      ? `<div class="year-thumb chapter-thumb chapter-feature chapter-slider" data-lead="${leadAlbum.id}">
           <div class="slider-track">${leadPhotos.slice(0, 8).map((p) => `
             <div class="slider-slide" style="background-image:url('${p.url || p.thumbUrl}')"></div>`).join('')}
           </div>
           <span class="slider-badge">Главный альбом</span>
           <div class="slider-progress"><span class="sp-bar"></span></div>
         </div>`
      : `<div class="year-thumb chapter-thumb chapter-feature">
           <img src="${feature.thumbUrl || feature.url}" alt="${year} год — воспоминание" loading="lazy">${feature.kind === 'video' ? '<span class="vid-badge">▶</span>' : ''}
           <div class="chapter-caption">${defaultCaption}</div>
         </div>`;

    // Хронология (точки по месяцам) + фильтр
    const monthDots = Object.keys(monthMap).sort((a, b) => a - b).map((mo) => `
      <button class="chron-dot" data-month="${mo}" title="${MONTHS_RU[mo]} (${monthMap[mo]})" aria-label="${MONTHS_RU[mo]}"></button>`).join('');

    // Панель действий
    const actions = `
      <div class="chapter-actions">
        <button class="ca-btn" data-act="edit" data-year="${year}" title="Редактировать главу">${ico('edit','ico-sm')}</button>
        <button class="ca-btn" data-act="add" data-year="${year}" title="Добавить фото в ${year}">${ico('plus','ico-sm')}</button>
        ${isLead && leadAlbum ? `<button class="ca-btn" data-act="share" data-album="${leadAlbum.id}" title="Поделиться главой">${ico('link','ico-sm')}</button>` : ''}
      </div>`;

    // Статистика главы (в углу фото)
    const statsBubble = `
      <div class="ch-stats" data-tooltip="${escapeHtml(tooltip || 'Нет данных по месяцам')}">
        ${photoCount} фото${videoCount ? ` • ${videoCount} видео` : ''} • ${albumIds.size} ${pluralAlbums(albumIds.size)}
      </div>`;

    wrap.innerHTML = `
      <div class="chapter-head-zone">
        ${actions}
        <div class="chapter-head">
          <span class="chapter-year">${year}</span>
          <span class="chapter-dash">—</span>
          <span class="chapter-desc">год ${phrase}</span>
        </div>
      </div>
      <div class="chapter-desc-edit" data-year="${year}">
        <span class="cde-view">${escapeHtml(storedDesc || defaultCaption + ' — нажмите, чтобы изменить заметку')}</span>
        <div class="cde-form" hidden>
          <textarea maxlength="300" class="cde-text">${escapeHtml(storedDesc || defaultCaption)}</textarea>
          <div class="cde-actions"><button class="cde-save">Сохранить</button><button class="cde-cancel">Отмена</button></div>
        </div>
      </div>
      <div class="chapter-media">
        ${featureHtml}
        <div class="ch-right-col">
          ${statsBubble}
          <div class="chapter-grid-sub">${rest || '<div class="chapter-grid-empty"></div>'}</div>
        </div>
      </div>
      ${monthDots ? `<div class="chapter-chron"><span class="chron-line"></span>${monthDots}</div>` : ''}
      <button class="chapter-more" aria-label="Открыть главу ${year}">Открыть главу ${year} →</button>
      <div class="chapter-scroll-hint" aria-hidden="true">↓</div>`;

    // Редактирование описания
    const descWrap = wrap.querySelector('.chapter-desc-edit');
    const viewEl = descWrap.querySelector('.cde-view');
    const formEl = descWrap.querySelector('.cde-form');
    const txtEl = descWrap.querySelector('.cde-text');
    viewEl.addEventListener('click', () => { viewEl.hidden = true; formEl.hidden = false; txtEl.focus(); });
    descWrap.querySelector('.cde-save').addEventListener('click', () => {
      const val = txtEl.value.trim();
      localStorage.setItem(descKey, val);
      viewEl.textContent = val || defaultCaption;
      viewEl.hidden = false; formEl.hidden = true;
    });
    descWrap.querySelector('.cde-cancel').addEventListener('click', () => { viewEl.hidden = false; formEl.hidden = true; });

    // Панель действий
    wrap.querySelectorAll('.ca-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'edit') { viewEl.click(); }
        else if (act === 'add') { toggleControls(); setTimeout(() => { const f = $('photo-input'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150); }
        else if (act === 'share' && btn.dataset.album) { shareAlbumQr(Number(btn.dataset.album)); }
      });
    });

    // Звёздочки избранного
    wrap.querySelectorAll('.ch-fav').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.mid);
        await toggleFavorite(id);
        const item = allMedia.find((m) => m.id === id);
        btn.innerHTML = (item && item.isFavorite) ? ico('star') : ico('star-plus');
      });
    });

    // Фильтр по месяцу (клик по точке хронологии)
    wrap.querySelectorAll('.chron-dot').forEach((dotBtn) => {
      dotBtn.addEventListener('click', () => {
        const mo = Number(dotBtn.dataset.month);
        const active = dotBtn.classList.toggle('active');
        const subs = wrap.querySelectorAll('.chapter-grid-sub .year-thumb');
        subs.forEach((t) => {
          const d = new Date(t.dataset.date || '');
          const match = !isNaN(d.getTime()) && d.getMonth() === mo;
          t.style.display = (active && !match) ? 'none' : '';
        });
      });
    });

    // Клик по фото → найденная галерея
    wrap.querySelectorAll('.chapter-grid-sub .year-thumb').forEach((t) => t.addEventListener('click', () => window.openFavGallery(items)));
    const leadSlider = wrap.querySelector('.chapter-slider');
    if (leadSlider) {
      const album = leadAlbum, albumPhotos = leadPhotos;
      leadSlider.addEventListener('click', () => openGallery(album, albumPhotos));
      startChapterSlider(leadSlider, albumPhotos);
    }
    wrap.querySelector('.chapter-more').addEventListener('click', () => window.openFavGallery(items));
    section.appendChild(wrap);
  });

  // Плавное появление глав при скролле
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('chapter-shown');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    section.querySelectorAll('.chapter-reveal').forEach((c) => { io.observe(c); });
  }

  // «Пустая глава»: история не кончается внезапно
  const moreYearsHint = document.createElement('div');
  moreYearsHint.className = 'chapter-more-hint';
  moreYearsHint.innerHTML = `${ico('sprout','ico-sm')} впереди ещё много глав`;
  section.appendChild(moreYearsHint);
  parent.appendChild(section);
}

// Подпись под фото: «12 июня» или «Без даты»
function dateLabel(m) {
  const d = m.dateTaken ? new Date(m.dateTaken) : null;
  if (!d || isNaN(d.getTime())) return 'Без даты';
  const md = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  return `${d.getDate()} ${md[d.getMonth()]}`;
}

// Блок «Люди на фото»
async function renderPeopleSection(parent) {
  try {
    const { persons } = await api('/api/persons');
    if (!persons || !persons.length) return;
    const section = document.createElement('div');
    section.className = 'people-section';
    section.innerHTML = '<div class="section-label">Люди на фото</div>';
    const row = document.createElement('div');
    row.className = 'people-row';
    persons.forEach((p) => {
      const chip = document.createElement('button');
      chip.className = 'person-chip';
      chip.innerHTML = `<span class="person-avatar">${escapeHtml((p.name || '?').charAt(0).toUpperCase())}</span><span>${escapeHtml(p.name)}</span><span class="person-count">${p.photo_count}</span>`;
      chip.addEventListener('click', async () => {
        const { media } = await api(`/api/persons/${p.id}`);
        if (media && media.length) window.openFavGallery(media);
      });
      row.appendChild(chip);
    });
    section.appendChild(row);
    parent.appendChild(section);
  } catch (err) { /* нет раздела людей */ }
}

// Воспоминания «В этот день / N лет назад»
function renderMemories(media, parent) {
  if (!media || !media.length) return;
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisDay = now.getDate();

  const onThisDay = media
    .map((m) => ({ m, d: m.dateTaken ? new Date(m.dateTaken) : null }))
    .filter(({ d }) => d && !isNaN(d.getTime()) && d.getMonth() === thisMonth && d.getDate() === thisDay)
    .map(({ m, d }) => ({ m, yearsAgo: now.getFullYear() - d.getFullYear() }))
    .filter((x) => x.yearsAgo >= 1)
    .sort((a, b) => a.yearsAgo - b.yearsAgo);

  if (!onThisDay.length) return;

  const section = document.createElement('div');
  section.className = 'memories';
  const total = onThisDay.length;
  const yearsTxt = [...new Set(onThisDay.map((x) => x.yearsAgo))].join(', ');
  section.innerHTML = `
    <div class="section-label">Воспоминания</div>
    <div class="memories-banner">
      <div>
        <div class="memories-title">В этот день ${yearsTxt} ${yearsTxt.split(',').length > 1 ? 'лет назад' : 'год назад'} · ${total} кадр(ов)</div>
        <div class="memories-sub">Нажмите, чтобы листать</div>
      </div>
      <button class="memories-btn">Смотреть</button>
    </div>`;
  section.querySelector('.memories-btn').addEventListener('click', () => {
    window.openFavGallery(onThisDay.map((x) => x.m));
  });
  parent.insertBefore(section, parent.firstChild);
}

// Капсулы времени: закрытые файлы с датой раскрытия
async function renderCapsules(parent) {
  try {
    const { media } = await api('/api/media?capsules=1&limit=100');
    // Показываем только ещё закрытые
    const now = Date.now();
    const locked = (media || []).filter((m) => m.revealAt && new Date(m.revealAt).getTime() > now);
    if (!locked.length) return;

    const section = document.createElement('div');
    section.className = 'capsules';
    section.innerHTML = '<div class="section-label">Капсулы времени</div>';
    const grid = document.createElement('div');
    grid.className = 'capsule-grid';
    locked.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'capsule-card';
      const date = fmtDate(m.revealAt, { year: 'numeric', month: 'long', day: 'numeric' });
      card.innerHTML = `
        <img src="${m.thumbUrl || m.url}" alt="" loading="lazy">
        <div class="capsule-lock">
          <div class="lock-icon">${ico('lock','ico-lg')}</div>
          <div>Откроется ${escapeHtml(date)}</div>
        </div>`;
      grid.appendChild(card);
    });
    section.appendChild(grid);
    parent.appendChild(section);
  } catch (err) { /* капсулы недоступны */ }
}

// Запечатать текущее фото в капсулу (admin/editor)
async function sealCapsule(photo) {
  if (!canUpload() || !photo) return;
  const input = prompt('Дата открытия капсулы (ГГГГ-ММ-ДД), оставьте пустым, чтобы открыть сейчас:');
  if (input === null) return;
  const val = String(input).trim();
  try {
    const revealDate = /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : null;
    await api(`/api/media/${photo.id}/capsule`, { method: 'PUT', body: { revealDate } });
    renderGalleryTags();
    if (currentUser.role === 'admin' || currentUser.role === 'editor') {
      const cur = localStorage.getItem('famarchive_view') || 'albums';
      if (cur === 'albums') renderAlbums();
    }
  } catch (err) {
    alert('Ошибка: ' + err.message);
  }
}

// ============================================================
//   СОЗДАНИЕ АЛЬБОМА
// ============================================================
async function createAlbum() {
  const name = $('album-name').value.trim();
  const eventDate = $('event-date').value;
  const description = $('album-desc').value.trim();
  const files = Array.from($('photo-input').files);
  const status = $('upload-status');

  if (!name) return alert('Пожалуйста, укажите название альбома.');
  if (!canUpload()) return alert('У вас нет прав на создание альбома.');

  status.textContent = 'Создаём альбом…';
  try {
    // 1) Альбом
    const { album } = await api('/api/albums', { method: 'POST', body: { title: name, description: (description || '') + (eventDate ? ` · ${eventDate}` : '') } });
    // 2) Фото/видео
    let uploaded = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('albumId', album.id);
      try {
        await api('/api/media/upload', { method: 'POST', body: fd });
        uploaded++;
        status.textContent = `Загружено: ${uploaded} / ${files.length}`;
      } catch (e) { console.warn('Не удалось загрузить', file.name, e); }
    }
    status.textContent = '';
    $('album-name').value = '';
    $('event-date').value = '';
    $('album-desc').value = '';
    $('photo-input').value = '';
    await renderAlbums();
    if (uploaded === 0 && files.length > 0) {
      // файлы могли быть не выбраны — всё равно показали
    }
  } catch (err) {
    status.textContent = 'Ошибка: ' + err.message;
  }
}

// ============================================================
//   ГАЛЕРЕЯ
// ============================================================
function openGallery(album, photos) {
  const items = (photos && photos.length) ? photos : [];
  currentAlbumIdx = 0; // запишем в глобальный список items
  window._galleryItems = items;
  currentPhotoIdx = 0;

  $('gallery-title').textContent = album.title;
  $('gallery-author').textContent = 'Семейный альбом · ' + (album.description ? escapeHtml(album.description) : '');

  const thumbsContainer = $('gallery-thumbs');
  thumbsContainer.innerHTML = '';
  items.forEach((photo, pIdx) => {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';
    thumb.dataset.idx = pIdx;
    thumb.innerHTML = `<img src="${photo.thumbUrl || photo.url}" alt="">${photo.kind === 'video' ? '<span class="vid-badge">▶</span>' : ''}`;
    thumb.addEventListener('click', () => showPhoto(pIdx));
    thumbsContainer.appendChild(thumb);
  });

  if (items.length > 0) {
    showPhoto(0);
  } else {
    $('gallery-photo').src = '';
    $('gallery-photo').style.display = 'none';
    $('gallery-caption').textContent = 'В этом альбоме пока нет фото';
    $('gallery-counter').textContent = '';
  }

  $('gallery').classList.add('active');
}

function showPhoto(photoIdx) {
  const items = window._galleryItems || [];
  if (!items.length || photoIdx < 0 || photoIdx >= items.length) return;
  const photo = items[photoIdx];
  currentPhotoIdx = photoIdx;

  const img = $('gallery-photo');
  img.classList.remove('visible');
  img.style.display = 'none';

  // Видео показываем через <video>, фото через <img>
  const existingVideo = document.querySelector('#gallery-stage video');
  if (existingVideo) existingVideo.remove();

  if (photo.kind === 'video') {
    const vid = document.createElement('video');
    vid.controls = true;
    vid.src = photo.url;
    vid.poster = photo.posterUrl || '';
    vid.style.cssText = 'max-width:90vw;max-height:78vh;border-radius:8px;opacity:0;transition:opacity .3s';
    $('gallery-stage').appendChild(vid);
    vid.onloadeddata = () => { vid.style.opacity = 1; };
  } else {
    setTimeout(() => {
      img.src = photo.url;
      img.alt = photo.filename;
      img.style.display = 'block';
    }, 150);
    img.onload = function () { img.classList.add('visible'); };
  }

  $('gallery-caption').textContent = photo.filename || '';

  // Метаданные: дата съёмки + размер
  const meta = [];
  if (photo.dateTaken) meta.push(fmtDate(photo.dateTaken));
  if (photo.sizeBytes) {
    const size = photo.sizeBytes >= 1048576 ? `${(photo.sizeBytes / 1048576).toFixed(1)} МБ` : `${(photo.sizeBytes / 1024).toFixed(0)} КБ`;
    meta.push(size);
  }
  $('gallery-counter').textContent = `${photoIdx + 1} из ${items.length}${meta.length ? ` · ${meta.join(' · ')}` : ''}`;

  document.querySelectorAll('.gallery-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === photoIdx);
    if (i === photoIdx) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });

  const prevBtn = document.querySelector('.gallery-nav.prev');
  const nextBtn = document.querySelector('.gallery-nav.next');
  prevBtn.style.display = items.length <= 1 ? 'none' : 'flex';
  nextBtn.style.display = items.length <= 1 ? 'none' : 'flex';
}

function changePhoto(direction) {
  const items = window._galleryItems || [];
  if (!items.length) return;
  let newIdx = (currentPhotoIdx + direction + items.length) % items.length;
  showPhoto(newIdx);
}
function closeGallery() {
  $('gallery').classList.remove('active');
  const v = document.querySelector('#gallery-stage video');
  if (v) v.remove();
  window._galleryItems = [];
  currentPhotoIdx = 0;
}

document.addEventListener('keydown', (e) => {
  if (!$('gallery').classList.contains('active')) return;
  if (e.key === 'ArrowLeft') changePhoto(-1);
  if (e.key === 'ArrowRight') changePhoto(1);
  if (e.key === 'Escape') closeGallery();
});

let touchStartX = 0;
$('gallery').addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
$('gallery').addEventListener('touchend', (e) => {
  const diff = touchStartX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 50) changePhoto(diff > 0 ? 1 : -1);
});

// ============================================================
//   ФОТОРЕДАКТОР И КОЛЛАЖ (Canvas)
// ============================================================
let editorImg = null;
let editorRotate = 0;

function currentPhoto() {
  const items = window._galleryItems || [];
  return items[currentPhotoIdx] || items[0] || null;
}

function openEditor() {
  const photo = currentPhoto();
  if (!photo) return;
  closeProfile();
  $('editor-overlay').classList.add('active');
  $('edBright').value = 1;
  $('edContrast').value = 1;
  $('edSaturate').value = 1;
  $('edFilter').value = 'none';
  editorRotate = 0;
  editorImg = new Image();
  editorImg.crossOrigin = 'anonymous';
  editorImg.onload = renderEditor;
  editorImg.src = photo.url;
}
function closeEditor() { $('editor-overlay').classList.remove('active'); }
window.openEditor = openEditor;
window.closeEditor = closeEditor;

function renderEditor() {
  const canvas = $('editorCanvas');
  if (!canvas || !editorImg || !editorImg.width) return;
  const rad = (editorRotate * Math.PI) / 180;
  const swap = Math.abs(editorRotate) % 180 === 90;
  const w = swap ? editorImg.height : editorImg.width;
  const h = swap ? editorImg.width : editorImg.height;
  const maxW = 800, maxH = 560;
  const scale = Math.min(maxW / w, maxH / h, 1);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const filter = $('edFilter').value;
  const bright = Number($('edBright').value);
  const contrast = Number($('edContrast').value);
  const sat = Number($('edSaturate').value);
  const filters = [];
  if (filter === 'grayscale') filters.push('grayscale(1)');
  else if (filter === 'sepia') filters.push('sepia(1)');
  else if (filter === 'vintage') filters.push('sepia(0.5) contrast(1.1)');
  else if (filter === 'cool') filters.push('saturate(0.8) hue-rotate(180deg) brightness(1.05)');
  else if (filter === 'warm') filters.push('saturate(1.3) sepia(0.25)');
  filters.push(`brightness(${bright}) contrast(${contrast}) saturate(${sat})`);
  ctx.filter = filters.join(' ');
  ctx.imageSmoothingQuality = 'high';

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(editorImg, -editorImg.width * scale / 2, -editorImg.height * scale / 2, editorImg.width * scale, editorImg.height * scale);
  ctx.restore();
}

function rotateEditor(deg) {
  editorRotate += deg;
  renderEditor();
}
window.rotateEditor = rotateEditor;

function downloadEdited() {
  const canvas = $('editorCanvas');
  if (!canvas) return;
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  tmp.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edited-' + (currentPhoto()?.filename || 'photo.jpg');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/jpeg', 0.92);
}
window.downloadEdited = downloadEdited;

// --- Коллаж ---
let collageSelected = [];
let collageLayout = 'grid2';

const COLLAGE_LAYOUTS = {
  grid2: { label: '2 фото', cells: [[0, 0, 50, 100], [50, 0, 50, 100]] },
  grid3: { label: '3 сбоку', cells: [[0, 0, 50, 100], [50, 0, 25, 100], [75, 0, 25, 100]] },
  grid4: { label: '2×2', cells: [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]] },
};

function openCollage() {
  const items = window._galleryItems || [];
  if (items.length < 2) {
    alert('Нужно минимум 2 фото в альбоме для коллажа.');
    return;
  }
  closeProfile();
  collageSelected = items.slice(0, 4).map((m) => m.id);
  collageLayout = 'grid4';
  $('collage-overlay').classList.add('active');
  renderCollageThumbs();
  renderCollageLayouts();
}
function closeCollage() { $('collage-overlay').classList.remove('active'); }
window.openCollage = openCollage;
window.closeCollage = closeCollage;

function renderCollageThumbs() {
  const items = window._galleryItems || [];
  const box = $('collageThumbs');
  box.innerHTML = '';
  items.slice(0, 8).forEach((m, i) => {
    if (m.kind === 'video') return;
    const t = document.createElement('div');
    t.className = 'collage-thumb' + (collageSelected.includes(m.id) ? ' selected' : '');
    const idx = i + 1;
    t.innerHTML = `<img src="${m.thumbUrl || m.url}" alt=""><span class="collage-num">${collageSelected.includes(m.id) ? collageSelected.indexOf(m.id) + 1 : ''}</span>`;
    t.addEventListener('click', () => {
      if (collageSelected.includes(m.id)) collageSelected = collageSelected.filter((x) => x !== m.id);
      else if (collageSelected.length < 4) collageSelected.push(m.id);
      renderCollageThumbs();
      renderCollageLayouts();
    });
    box.appendChild(t);
  });
}
window.renderCollageThumbs = renderCollageThumbs;

function renderCollageLayouts() {
  const box = $('collageLayouts');
  box.innerHTML = Object.entries(COLLAGE_LAYOUTS).map(([key, l]) =>
    `<button class="collage-layout-btn${key === collageLayout ? ' active' : ''}" data-layout="${key}">${l.label}</button>`
  ).join('');
  box.querySelectorAll('.collage-layout-btn').forEach((b) => {
    b.addEventListener('click', () => { collageLayout = b.dataset.layout; renderCollageLayouts(); });
  });
}
window.renderCollageLayouts = renderCollageLayouts;

function downloadCollage() {
  const items = window._galleryItems || [];
  const chosen = collageSelected.map((id) => items.find((m) => m.id === id)).filter(Boolean);
  const layout = COLLAGE_LAYOUTS[collageLayout] || COLLAGE_LAYOUTS.grid2;
  const cells = layout.cells.slice(0, Math.min(chosen.length, 4));
  if (!chosen.length) return;

  const W = 1200, H = 900;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  let loaded = 0;
  cells.forEach((cell, ci) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const cw = W * cell[2] / 100;
      const ch = H * cell[3] / 100;
      const cx = W * cell[0] / 100;
      const cy = H * cell[1] / 100;
      const scale = Math.max(cw / img.width, ch / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, cx + (cw - dw) / 2, cy + (ch - dh) / 2, dw, dh);
      loaded++;
      if (loaded === cells.length) {
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'collage.jpg';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }, 'image/jpeg', 0.92);
      }
    };
    img.src = chosen[ci]?.url || '';
  });
}
window.downloadCollage = downloadCollage;

// ============================================================
//   МУЗЫКА (из образца — приятная фоновая мелодия)
// ============================================================
let audioCtx = null;
let musicPlaying = false;
let melodyTimer = null;
let melodyStep = 0;

const notes = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23,
  G4: 392.00, A4: 440.00, C5: 523.25, D5: 587.33,
  E5: 659.25, G5: 783.99, A5: 880.00
};
const melody = [
  ['E4', 1.0], ['G4', 0.5], ['A4', 0.5], ['C5', 1.0],
  ['A4', 0.5], ['G4', 0.5], ['E4', 1.5],
  ['D4', 0.5], ['E4', 0.5], ['G4', 1.0], ['E4', 1.0],
  ['D4', 1.5], [null, 0.5],
  ['C4', 1.0], ['E4', 0.5], ['G4', 0.5], ['E5', 1.0],
  ['D5', 0.5], ['C5', 0.5], ['A4', 1.5],
  ['G4', 0.5], ['E4', 0.5], ['D4', 1.0], ['C4', 1.5],
  [null, 1.0]
];

function startMusic() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  musicPlaying = true;
  playMelody();
}
function playMelody() {
  if (!musicPlaying) return;
  const [noteName, duration] = melody[melodyStep];
  const beatLength = 0.55;
  const time = audioCtx.currentTime;
  if (noteName && notes[noteName]) playNote(notes[noteName], time, duration * beatLength);
  melodyStep = (melodyStep + 1) % melody.length;
  melodyTimer = setTimeout(playMelody, duration * beatLength * 1000);
}
function playNote(freq, startTime, duration) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  osc.type = 'sine';
  osc.frequency.value = freq;
  filter.type = 'lowpass';
  filter.frequency.value = 2000;
  filter.Q.value = 0.5;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.12, startTime + 0.05);
  gain.gain.linearRampToValueAtTime(0.08, startTime + 0.15);
  gain.gain.setValueAtTime(0.08, startTime + duration * 0.5);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
  osc.start(startTime); osc.stop(startTime + duration + 0.05);
  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();
  osc2.type = 'triangle';
  osc2.frequency.value = freq * 2;
  gain2.gain.setValueAtTime(0, startTime);
  gain2.gain.linearRampToValueAtTime(0.03, startTime + 0.05);
  gain2.gain.linearRampToValueAtTime(0, startTime + duration);
  osc2.connect(gain2); gain2.connect(audioCtx.destination);
  osc2.start(startTime); osc2.stop(startTime + duration + 0.05);
}
function stopMusic() {
  musicPlaying = false;
  clearTimeout(melodyTimer);
}
function toggleMusic() {
  if (musicPlaying) stopMusic();
  else startMusic();
}
window.toggleMusic = toggleMusic;
window.startMusicGlobal = startMusic;

// ============================================================
//   СТАРТ / ВОССТАНОВЛЕНИЕ СЕССИИ
// ============================================================
(async function init() {
  // Ссылка-приглашение
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  const share = params.get('share');

  // Ссылка сброса пароля ?reset=token → сразу показываем форму нового пароля
  const resetToken = params.get('reset');
  if (resetToken) {
    history.replaceState(null, '', window.location.pathname);
    $('auth-screen').style.display = 'block';
    switchTab('login');
    document.querySelectorAll('.auth-form').forEach((f) => f.classList.remove('active'));
    $('form-reset').classList.add('active');
    window._resetToken = resetToken;
    return;
  }

  // Публичная ссылка на альбом ?share=token — просмотр без входа
  if (share) {
    try {
      const data = await api(`/api/media/shared/${share}`, { token: false });
      history.replaceState(null, '', window.location.pathname);
      currentUser = { id: 0, email: '', name: 'Гость', role: 'guest' };
      token = null;
      $('auth-screen').style.display = 'none';
      $('app').classList.add('visible');
      $('page-title').textContent = data.album?.title || 'Общий альбом';
      openGallery(data.album || { title: 'Общий альбом', description: '' }, data.media || []);
      return;
    } catch (err) {
      console.warn('Публичная ссылка не сработала:', err.message);
    }
  }

  if (invite) {
    try {
      const data = await api('/api/invites/login', { method: 'POST', body: { token: invite }, token: false });
      token = data.token;
      localStorage.setItem(STORAGE_KEY, data.token);
      currentUser = data.user;
      history.replaceState(null, '', window.location.pathname);
      enterApp();
      return;
    } catch (err) {
      console.warn('Приглашение не сработало:', err.message);
    }
  }

  // Восстановление по сохранённому токену
  if (token) {
    try {
      const data = await api('/api/auth/me');
      currentUser = data.user;
      enterApp();
      return;
    } catch {
      token = null;
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  // Экран входа
  $('auth-screen').style.display = 'block';
  initAuthNav();

  // Подсказка: admin/admin
})();

// Привязка кнопок профиля — глобально, чтобы работать при любом способе входа
(function bindProfileActions() {
  const psBtn = $('profileSaveBtn');
  if (psBtn) psBtn.addEventListener('click', saveProfile);
  const avInput = $('avatar-input');
  if (avInput) avInput.addEventListener('change', uploadAvatar);
  const pwBtn = $('passwordBtn');
  if (pwBtn) pwBtn.addEventListener('click', changePassword);
  const bioEl = $('profile-bio');
  if (bioEl) bioEl.addEventListener('input', updateBioCounter);
  const opPw = $('old-password');
  const npPw = $('new-password');
  if (opPw) opPw.addEventListener('input', updatePasswordBtn);
  if (npPw) npPw.addEventListener('input', updatePasswordBtn);
  // Закрытие профиля по клику вне карточки (с проверкой изменений)
  const po = $('profile-overlay');
  if (po) po.addEventListener('click', (e) => { if (e.target === po) requestCloseProfile(); });
})();

// Закрытие профиля по Esc (глобально, работает в любом состоянии входа)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const po = $('profile-overlay');
  if (po && po.classList.contains('active')) {
    e.preventDefault();
    requestCloseProfile();
  }
});
