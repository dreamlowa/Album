import React, { useState } from 'react';
import { login, register, saveToken } from '../api/client';
import s from './Login.module.css';

export default function Login({ onLogin }) {
  const [tab, setTab] = useState('login');
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (tab === 'login') {
        const data = await login(form.email, form.password);
        saveToken(data.token);
        onLogin(data.user);
      } else {
        await register(form.name, form.email, form.password);
        setErr('Аккаунт создан ✓. Теперь войдите.');
        setTab('login');
      }
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.screen}>
      <div className={s.card}>
        <h1 className={s.brand}>Album</h1>
        <p className={s.sub}>Сохраняем воспоминания</p>

        <div className={s.tabs}>
          <button className={s.tab + (tab === 'login' ? ' ' + s.tabActive : '')} onClick={() => { setTab('login'); setErr(''); }}>Вход</button>
          <button className={s.tab + (tab === 'register' ? ' ' + s.tabActive : '')} onClick={() => { setTab('register'); setErr(''); }}>Регистрация</button>
        </div>

        {err && <div className={s.error}>{err}</div>}

        <form onSubmit={submit} className={s.form}>
          {tab === 'register' && (
            <input
              className={s.input}
              placeholder="Ваше имя"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          )}
          <input
            className={s.input}
            placeholder="Email"
            type="text"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <input
            className={s.input}
            placeholder="Пароль (8+ символов)"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          <button className={s.submit} disabled={busy}>
            {busy ? 'Подождите…' : tab === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </button>
        </form>

        {tab === 'register' && (
          <p className={s.hint}>Доступ только на просмотр альбомов.</p>
        )}
      </div>
    </div>
  );
}