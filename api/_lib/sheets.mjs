// api/_lib/sheets.mjs
// Обёртка над всеми вызовами Apps Script. Автоматически добавляет shared secret.
// Без secret’а Apps Script doPost/doGet возвращает 403 — даже если URL утечёт,
// никто посторонний не сможет писать в листы.

const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// ─── POST → doPost ────────────────────────────────────────────
// Возвращает распарсенный JSON или null (при сетевой/JSON-ошибке).
// Сохраняет совместимость с прошлым контрактом «json или undefined».
export async function sheetsPost(payload) {
  if (!APPS_SCRIPT_URL) return null;
  if (!APPS_SCRIPT_SECRET) {
    console.error('[sheets] APPS_SCRIPT_SECRET is not set — request will be rejected by Apps Script');
  }
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, secret: APPS_SCRIPT_SECRET }),
      redirect: 'follow',
    });
    if (!res.ok) {
      console.warn('[sheets] post non-OK status:', res.status);
      return null;
    }
    try { return await res.json(); } catch { return null; }
  } catch (e) {
    console.error('[sheets] post failed:', e.message);
    return null;
  }
}

// ─── Получение курсов (для /api/rates и серверного recalcOrder) ───
// Раньше делал GET с секретом в URL (?secret=...) — секрет светился
// в Apps Script execution logs. Теперь идём через doPost с секретом
// в body, как все остальные методы.
export async function sheetsGet() {
  return sheetsPost({ type: 'get_rates' });
}
