// api/rates.js — Прокси к Apps Script для отдачи курсов.
// Использует sheetsGet, который автоматически подставляет APPS_SCRIPT_SECRET.
// Rate limit: 60 запросов/мин с одного IP — защита квоты Apps Script.

import { sheetsGet } from './_lib/sheets.mjs';
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

  const data = await sheetsGet();
  if (!data) {
    return res.status(502).json({ ok: false, error: 'Upstream unavailable' });
  }
  // Кэш на 60 секунд (как было)
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json(data);
}
