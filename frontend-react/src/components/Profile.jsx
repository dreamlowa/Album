import React, { useState } from 'react';
import { api } from '../api/client';
import s from './Profile.module.css';

export default function Profile({ user, onUpdated, onClose }) {
  const [name, setName] = useState(user.name || '');
  const [bio, setBio] = useState(user.bio || '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const data = await api('/api/auth/profile', { method: 'PATCH', body: { name, bio } });
      onUpdated({ ...user, ...data.user });
      setMsg('Профиль сохранён ✓');
    } catch (x) { setMsg(x.message); } finally { setBusy(false); }
  };

  return (
    <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={s.card}>
        <div className={s.top}>
          <span className={s.title}>Мой профиль</span>
          <button className={s.close} onClick={onClose}>✕</button>
        </div>
        <div className={s.avatar}>{ (user.name || 'А').charAt(0).toUpperCase() }</div>
        <div className={s.email}>{user.email}</div>
        <div className={s.role}>Хранитель семейного архива</div>

        <form className={s.form} onSubmit={save}>
          <label className={s.label}>Имя</label>
          <input className={s.input} value={name} onChange={(e) => setName(e.target.value)} required />
          <label className={s.label}>О себе</label>
          <textarea className={`${s.input} ${s.ta}`} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200}
                    placeholder="Расскажите, как вы собираете семейный архив" />
          {msg && <div className={s.msg} style={{ color: msg.includes('✓') ? 'green' : 'red' }}>{msg}</div>}
          <button className={s.submit} disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить профиль'}</button>
        </form>
      </div>
    </div>
  );
}