// api/healthcheck.js — Тихая проверка работоспособности
// Пишет в General только если что-то сломалось

const BOT_TOKEN       = process.env.BOT_TOKEN;
const GROUP_ID        = process.env.GROUP_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

async function tgSend(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); return null; }
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

// Проверка Telegram API
async function checkTelegram() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'Telegram API error' };
    return { ok: true, name: data.result.username };
  } catch(e) {
    return { ok: false, error: 'Telegram API unreachable: ' + e.message };
  }
}

// Проверка Apps Script
async function checkAppsScript() {
  if (!APPS_SCRIPT_URL) return { ok: true, skipped: true };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'GET',
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    // Apps Script для GET может вернуть что угодно, главное что доступен
    if (res.status >= 500) return { ok: false, error: `Apps Script HTTP ${res.status}` };
    return { ok: true };
  } catch(e) {
    return { ok: false, error: 'Apps Script unreachable: ' + e.message };
  }
}

export default async function handler(req, res) {
  const tg = await checkTelegram();
  const sheets = await checkAppsScript();

  const allOk = tg.ok && sheets.ok;

  // Если что-то сломалось — алерт в General
  if (!allOk && GROUP_ID) {
    const errors = [];
    if (!tg.ok) errors.push(`❌ Telegram: ${tg.error}`);
    if (!sheets.ok) errors.push(`❌ Google Sheets: ${sheets.error}`);
    const msg = `🚨 <b>СБОЙ СЕРВИСА</b>\n\n${errors.join('\n')}\n\n<b>Время:</b> ${nowVN()}\n\n⚠️ Заявки могут не обрабатываться. Проверьте сервисы.`;
    await tgSend(GROUP_ID, msg);
  }

  return res.status(allOk ? 200 : 503).json({
    ok: allOk,
    time: nowVN(),
    checks: { telegram: tg, sheets },
  });
}
