// api/rates-refresh.js — Обновление копии курсов в Supabase (rates_cache).
//
// Зачем (08.10.2026): Apps Script отрабатывает запрос курса за 1–4 с, но его
// ответ иногда идёт обратно к Vercel дольше 8 с. Заявка в это время ждала и
// уходила с «🚨 КУРС РЕЗЕРВНЫЙ» (с 29.09 — 72 заявки из 196). Теперь копию
// раз в минуту обновляет эта функция, а заявки и экран курсов берут курс из
// копии (api/_lib/rates-server.mjs, шаг 2) и Apps Script не ждут.
//
// Вызов: внешний cron (cron-job.org) раз в минуту, заголовок
// X-Webhook-Secret = HEALTHCHECK_SECRET (для ручной проверки можно ?secret=).
//
// Отвечает 200 и при неудаче (ok:false): cron-job.org выключает задание после
// серии ошибок, а единичный пропуск не страшен — копию обновит следующий
// запуск. О настоящем сбое (курс не обновлялся больше часа) по-прежнему
// сообщает /api/healthcheck.

import { sheetsGet } from './_lib/sheets.mjs';
import { persistRatesToSupabase, readAtOf } from './_lib/rates-server.mjs';

// Ждём дольше, чем заявка (8 с): этот ответ никто не ждёт.
// Меньше 15 с — чтобы уложиться в стандартный лимит функции и в 30 с cron-job.org.
const REFRESH_TIMEOUT_MS = 12000;
// Первый шаг (POST) ждём не дольше 6 с: не дождались — спрашиваем курс заново
// (курс только читается, повтор безопасен). Нормальный ответ — 1–4 с.
const REFRESH_POST_TRY_MS = 6000;

export default async function handler(req, res) {
  const expected = process.env.HEALTHCHECK_SECRET;
  const got = req.headers['x-webhook-secret'] || (req.query && req.query.secret) || '';
  if (!expected || got !== expected) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const started = Date.now();
  // Шаги запроса к Apps Script с длительностью («POST 302 1840мс», «GET таймаут
  // 3000мс»…) — уходят в ответ, их видно в истории запусков cron-job.org.
  const steps = [];
  const data = await sheetsGet({ timeoutMs: REFRESH_TIMEOUT_MS, postTryMs: REFRESH_POST_TRY_MS, trace: steps });
  const waitedMs = Date.now() - started;

  if (!(data && data.ok && data.rates)) {
    console.warn(`[rates-refresh] Apps Script не дал курс за ${waitedMs} мс`);
    return res.status(200).json({ ok: false, step: 'apps_script', waited_ms: waitedMs, steps });
  }

  // 09.10.2026: передаём, когда Apps Script прочитал лист, — база не даст
  // этому ответу затереть курс, который Apps Script положил после правки.
  const saved = await persistRatesToSupabase(data.rates, readAtOf(data, started), data.v);
  if (!saved) {
    console.warn('[rates-refresh] курс получен, но копия в Supabase не записана');
    return res.status(200).json({ ok: false, step: 'supabase', waited_ms: waitedMs, steps });
  }

  return res.status(200).json({
    ok: true,
    waited_ms: waitedMs,
    pairs: Object.keys(data.rates).length,
    apps_script_v: Number.isInteger(data.v) ? data.v : 1,
    steps,
  });
}
