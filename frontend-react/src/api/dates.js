// Безопасный парсинг дат: формат "2026-09-24 17:08:34" не проходит в new Date() в браузере.
const toDate = (val) => {
  if (!val) return null;
  if (typeof val === 'number') return new Date(val);
  if (val instanceof Date) return val;
  const s = String(val).trim();
  // "YYYY-MM-DD HH:MM:SS" или "YYYY-MM-DDTHH:MM:SS" → нормализуем в ISO
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const getYear = (m) => {
  const d = toDate(m.dateTaken || m.createdAt || m.created_at);
  return d ? d.getFullYear() : null;
};

const getMonthLabel = (m) => {
  const d = toDate(m.dateTaken || m.createdAt || m.created_at);
  return d ? d.toLocaleDateString('ru-RU', { month: 'long' }) : '';
};

export { toDate, getYear, getMonthLabel };