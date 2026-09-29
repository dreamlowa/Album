import React, { useState, useCallback } from 'react';
import { api } from '../api/client';
import s from './AlbumGallery.module.css';

export default function AlbumGallery({ album, photos, onBack }) {
  const [idx, setIdx] = useState(0);
  const [list, setList] = useState(photos);

  const photo = list[idx];

  const go = useCallback((dir) => {
    setIdx((i) => (i + dir + list.length) % list.length);
  }, [list.length]);

  const toggleFav = async (e) => {
    e.stopPropagation();
    if (!photo) return;
    try {
      const next = !photo.isFavorite;
      await api(`/api/media/${photo.id}/favorite`, { method: 'PUT', body: { favorite: next } });
      setList((l) => l.map((p) => (p.id === photo.id ? { ...p, isFavorite: next } : p)));
    } catch (err) {
      alert(err.message);
    }
  };

  if (!photo) return <div className={s.title}>Нет фото.</div>;

  return (
    <div className={s.gallery}>
      <div className={s.top}>
        <button className={s.back} onClick={onBack}>← Альбомы</button>
        <span className={s.title}>{album.title || 'Без названия'}</span>
        <span className={s.counter}>{idx + 1} / {list.length}</span>
      </div>

      <div className={s.main} onClick={() => go(1)}>
        <img src={photo.url || photo.thumbUrl} alt={photo.filename || ''} />
        <button className={s.fav} onClick={toggleFav}>{photo.isFavorite ? '★' : '☆'}</button>
      </div>

      <div className={s.webNav}>
        <button className={s.nav} onClick={() => go(-1)}>‹</button>
        <button className={s.nav} onClick={() => go(1)}>›</button>
      </div>
    </div>
  );
}