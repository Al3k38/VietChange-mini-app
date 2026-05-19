// api/_lib/sheets.mjs
// Обёртка над всеми вызовами Apps Script. Автоматически добавляет shared secret.
// Без secret’а Apps Script doPost/doGet возвращает 403 — даже если URL утечёт,
// никто посторонний не сможет писать в листы.

const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// Fetch с таймаутом (Apps Script иногда висит — без таймаута функция
// Vercel-а ждёт до своего лимита 10 сек). Возвращает Response или бросает
// AbortError при таймауте.
async function fetchWithTimeout(url, options, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── POST → doPost ────────────────────────────────────────────
// Возвращает распарсенный JSON или null (при сетевой/JSON-ошибке).
// Сохраняет совместимость с прошлым контрактом «json или undefined».
export async function sheetsPost(payload) {
  if (!APPS_SCRIPT_URL) return null;
  if (!APPS_SCRIPT_SECRET) {
    console.error('[sheets] APPS_SCRIPT_SECRET is not set — request will be rejected by Apps Script');
  }
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, secret: APPS_SCRIPT_SECRET }),
    redirect: 'follow',
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(APPS_SCRIPT_URL, opts, 5000);
      if (!res.ok) {
        console.warn(`[sheets] post non-OK status: ${res.status} (attempt ${attempt}/2)`);
        if (attempt === 2) return null;
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      try { return await res.json(); } catch { return null; }
    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timeout (5s)' : e.message;
      console.error(`[sheets] post failed (attempt ${attempt}/2): ${reason}`);
      if (attempt === 2) return null;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

// ─── Получение курсов (для /api/rates и серверного recalcOrder) ───
// Раньше делал GET с секретом в URL (?secret=...) — секрет светился
// в Apps Script execution logs. Теперь идём через doPost с секретом
// в body, как все остальные методы.
export async function sheetsGet() {
  return sheetsPost({ type: 'get_rates' });
}
