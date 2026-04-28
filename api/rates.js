// api/rates.js — Прокси к Apps Script для отдачи курсов

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const r = await fetch(APPS_SCRIPT_URL, { redirect: 'follow' });
    const data = await r.json();
    // Кэш на 60 секунд
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
