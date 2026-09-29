import React, { useState, useEffect } from 'react';
import { me, token, saveToken } from './api/client';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!token()) { setLoading(false); return; }
      try {
        const data = await me();
        setUser(data.user);
      } catch {
        saveToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="app-loading">Загружаем архив…</div>;

  return user ? <Dashboard user={user} onLogout={() => { saveToken(null); setUser(null); }} />
              : <Login onLogin={(u) => setUser(u)} />;
}