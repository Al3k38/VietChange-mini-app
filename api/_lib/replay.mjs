// api/_lib/replay.mjs
// Anti-replay для Telegram initData. Запоминает пару (user_id, auth_date)
// в Supabase. Если такая пара уже встречалась — заявка отклоняется
// как попытка повторного использования перехваченной подписи.
//
// Setup (один раз):
//
//   1) В Supabase SQL Editor выполнить:
//
//      CREATE TABLE IF NOT EXISTS replay_nonces (
//        user_id    BIGINT NOT NULL,
//        auth_date  BIGINT NOT NULL,
//        created_at TIMESTAMPTZ DEFAULT NOW(),
//        PRIMARY KEY (user_id, auth_date)
//      );
//      CREATE INDEX IF NOT EXISTS idx_replay_created
//        ON replay_nonces (created_at);
//
//   2) В Vercel env добавить:
//      SUPABASE_URL          = https://<твой-проект>.supabase.co
//      SUPABASE_SERVICE_KEY  = <service_role key>   ← Sensitive!
//
//   3) Опционально — настроить периодическую чистку старых записей
//      (например через pg_cron или вручную раз в месяц):
//      DELETE FROM replay_nonces WHERE created_at < NOW() - INTERVAL '2 hours';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Возвращает:
//   true  — эту пару (userId, authDate) видим впервые → разрешить
//   false — повтор ИЛИ невозможно проверить → отклонить запрос
//
// Fail-CLOSED: при любой ошибке/недоступности Supabase возвращаем false.
// Иначе атакующий, способный задосить Supabase или потратить квоту,
// мог бы отключить anti-replay и подавать повторы.
// Единственное исключение — env не настроен (фаза bootstrap проекта):
// возвращаем true, чтобы случайно не сломать прод до того как пользователь
// успел добавить Supabase credentials.
export async function markNonceUsed(userId, authDate) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[replay] SUPABASE not configured — skipping anti-replay check');
    return true; // fail-open ТОЛЬКО для конфиг-провала, не для рантайма
  }
  if (!userId || !authDate) {
    console.warn(`[replay] missing userId/authDate — rejecting (user=${userId} auth=${authDate})`);
    return false;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/replay_nonces`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        user_id:   Number(userId),
        auth_date: Number(authDate),
      }),
    });
    if (res.status === 201 || res.status === 204) return true; // первый раз
    if (res.status === 409) {
      console.warn(`[replay] REPLAY DETECTED userId=${userId} auth_date=${authDate}`);
      return false;
    }
    // Любой другой статус (5xx, 401, и т.д.) — FAIL CLOSED + лог body для отладки
    let bodyText = '';
    try { bodyText = await res.text(); } catch {}
    console.error(`[replay] FAIL-CLOSED: Supabase status=${res.status} body=${bodyText} for user=${userId}`);
    return false;
  } catch (e) {
    console.error('[replay] FAIL-CLOSED: Supabase error:', e.message);
    return false;
  }
}

// Достать auth_date (unix timestamp seconds) из строки initData.
// Используется в order.js перед markNonceUsed.
export function getAuthDate(initData) {
  if (!initData) return 0;
  try {
    const v = new URLSearchParams(initData).get('auth_date');
    return parseInt(v || '0', 10) || 0;
  } catch { return 0; }
}
