// api/rates.js — Курсы для клиента с каскадным фолбэком через rates-server.mjs.
// Каскад источников: in-memory кэш (60 сек) → Apps Script → Supabase backup (≤24ч).
// Если все три уровня недоступны — возвращаем 502 как раньше.
// Rate limit: 60 запросов/мин с одного IP — защита квоты Apps Script.

import { getServerRates, getRatesStaleness } from './_lib/rates-server.mjs';
import { checkRateLimit, getClientIp } from './_lib/ratelimit.mjs';

const RATES_PER_MINUTE = 60;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Rate limit per IP
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`rates:${ip}`, RATES_PER_MINUTE);
  if (!rl.allowed) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  const rates = await getServerRates();
  if (!rates) {
    return res.status(502).json({ ok: false, error: 'Upstream unavailable' });
  }

  const stale = getRatesStaleness();
  // Если курсы из fallback (Supabase backup) — не кэшируем CDN-ом, чтобы
  // следующий запрос мог попасть на ожившие Apps Script. Свежие — кэш 60 сек.
  if (stale.isFallback) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  }

  return res.status(200).json({
    ok: true,
    rates,
    updated: new Date().toISOString(),
    source: stale.source,
    isFallback: stale.isFallback,
  });
}
