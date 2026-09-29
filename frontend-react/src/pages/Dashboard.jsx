import React, { useState, useEffect, useMemo } from 'react';
import { albums, media } from '../api/client';
import { getYear } from '../api/dates';
import AlbumGallery from '../components/AlbumGallery.jsx';
import Profile from '../components/Profile.jsx';
import s from './Dashboard.module.css';

export default function Dashboard({ user, onLogout }) {
  const [albums, setAlbums] = useState([]);
  const [allMedia, setAllMedia] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // { album, photos }
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [a, m] = await Promise.all([albums(), media()]);
        setAlbums(a.albums || []);
        setAllMedia(m.media || []);
      } catch (e) { alert(e.message); } finally { setLoading(false); }
    })();
  }, []);

  const coverOf = (id) => allMedia.find((x) => x.albumId === id);
  const photosOf = (id) => allMedia.filter((m) => m.albumId === id);

  // Главы по годам (безопасный парсинг дат)
  const chapters = useMemo(() => {
    const map = {};
    allMedia.forEach((m) => {
      const y = getYear(m);
      if (y == null) return;
      if (!map[y]) map[y] = [];
      map[y].push(m);
    });
    return Object.entries(map).map(([y, list]) => ({ year: y, list }))
      .sort((a, b) => b.year - a.year);
  }, [allMedia]);

  if (open) return <AlbumGallery album={open.album} photos={open.photos} onBack={() => setOpen(null)} />;

  return (
    <div className={s.app}>
      <header className={s.topbar}>
        <div className={s.brand}>
          <span className={s.brandName}>Album</span>
          <span className={s.brandTag}>Сохраняем воспоминания</span>
        </div>
        <div className={s.topUser}>
          <span className={s.userName}>{user.name}</span>
          <button className={s.logout} onClick={() => setShowProfile(true)}>Профиль</button>
          <button className={s.logout} onClick={onLogout}>Выйти</button>
        </div>
      </header>

      {showProfile && (
        <Profile user={user} onClose={() => setShowProfile(false)} />
      )}

      <main className={s.content}>
        <h2 className={s.title}>Главы нашей истории</h2>
        {loading ? <p className={s.muted}>Загружаем…</p> : (
          <div className={s.chapters}>
            {chapters.map((c) => (
              <section className="chapter" key={c.year}>
                <div className={s.chapterHead}>
                  <span className={s.chapterYear}>{c.year}</span>
                  <span className={s.chapterDash}>—</span>
                  <span className={s.chapterDesc}>год, который мы помним</span>
                </div>
                <div className={s.chapterGrid}>
                  {c.list.map((m) => (
                    <img key={m.id} className={s.chapterImg} src={m.thumbUrl || m.url} alt="" loading="lazy" />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <h2 className={s.titleGap}>Наши альбомы</h2>
        {albums.length === 0 ? (
          <p className={s.muted}>Альбомов пока нет.</p>
        ) : (
          <div className={s.albumGrid}>
            {albums.map((a) => {
              const cover = coverOf(a.id);
              const count = photosOf(a.id).length;
              return (
                <div className={s.albumCard} key={a.id} onClick={() => setOpen({ album: a, photos: photosOf(a.id) })}>
                  <div className={s.albumCover}>
                    {cover ? <img src={cover.thumbUrl || cover.url} alt={a.title} loading="lazy" />
                            : <div className={s.albumEmpty}>Пока пусто</div>}
                  </div>
                  <div className={s.albumInfo}>
                    <h3>{a.title || 'Без названия'}</h3>
                    <span className={s.albumCount}>{count} фото</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}