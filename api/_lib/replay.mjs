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
//   false — повтор → отклонить запрос как replay
//
// Fail-open: при ошибке/недоступности Supabase возвращаем true,
// чтобы не блокировать заявки клиентов из-за инфраструктурных проблем.
export async function markNonceUsed(userId, authDate) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[replay] SUPABASE not configured — skipping anti-replay check');
    return true;
  }
  if (!userId || !authDate) return true;
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
      // Postgres unique_violation: эта initData уже использовалась
      console.warn(`[replay] REPLAY DETECTED userId=${userId} auth_date=${authDate}`);
      return false;
    }
    // Любой другой статус (5xx, 401 итд) — fail-open, не блокируем клиента
    console.warn('[replay] unexpected status', res.status);
    return true;
  } catch (e) {
    console.error('[replay] Supabase error:', e.message);
    return true;
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
