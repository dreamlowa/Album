// Лёгкий клиент API для React-версии
const API = (import.meta.env.VITE_API_URL || '') + '';

const TOKEN_KEY = 'famarchive_token';

export const token = () => localStorage.getItem(TOKEN_KEY);

export function saveToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function api(path, { method = 'GET', body, token: useToken = true } = {}) {
  const headers = {};
  const t = useToken ? token() : null;
  if (t) headers['Authorization'] = `Bearer ${t}`;
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так');
  return data;
}

// Auth
export const login = (email, password) => api('/api/auth/login', { method: 'POST', body: { email, password }, token: false });
export const register = (name, email, password) => api('/api/auth/register', { method: 'POST', body: { name, email, password }, token: false });
export const me = () => api('/api/auth/me');
export const albums = () => api('/api/albums');
export const media = (params = '') => api(`/api/media?limit=500${params}`);