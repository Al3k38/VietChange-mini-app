// api/_lib/ratelimit.mjs
// Per-key rate limiting через Supabase + Postgres-функция rate_limit_increment.
// Окно — фиксированная минута (date_trunc('minute', NOW())), счётчик
// инкрементируется атомарно через ON CONFLICT.
//
// Fail-open: если Supabase недоступен → пропускаем запрос, чтобы не ронять
// прод из-за инфра-сбоя rate-limit'а. Anti-replay в /api/order остаётся
// независимым контуром защиты от подмены.
//
// Setup (один раз):
//   SQL для таблицы и функции — см. инструкцию в чате.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Достать клиентский IP из заголовков Vercel.
// На Vercel x-forwarded-for содержит реальный IP клиента (первый в списке).
export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

// Проверка и инкремент счётчика. Возвращает:
//   { allowed: boolean, count: number }
//
// allowed=true если в текущей минуте уже сделано меньше maxPerMinute запросов
// (включая этот). Если Supabase недоступен — fail-open (allowed=true).
export async function checkRateLimit(key, maxPerMinute) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[ratelimit] SUPABASE not configured — skipping rate limit');
    return { allowed: true, count: 0 };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rate_limit_increment`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ p_key: key }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      console.warn(`[ratelimit] non-OK status=${res.status} body=${body} key=${key}`);
      return { allowed: true, count: 0 }; // fail-open
    }
    const data = await res.json();
    // RPC возвращает просто число
    const count = typeof data === 'number' ? data : 0;
    const allowed = count <= maxPerMinute;
    if (!allowed) {
      console.warn(`[ratelimit] BLOCKED key=${key} count=${count} > ${maxPerMinute}/min`);
    }
    return { allowed, count };
  } catch (e) {
    console.error('[ratelimit] error:', e.message);
    return { allowed: true, count: 0 }; // fail-open
  }
}
