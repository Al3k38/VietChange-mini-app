// api/rates.js — Прокси к Apps Script для отдачи курсов.
// Использует sheetsGet, который автоматически подставляет APPS_SCRIPT_SECRET.

import { sheetsGet } from './_lib/sheets.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const data = await sheetsGet();
  if (!data) {
    return res.status(502).json({ ok: false, error: 'Upstream unavailable' });
  }
  // Кэш на 60 секунд (как было)
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.status(200).json(data);
}
