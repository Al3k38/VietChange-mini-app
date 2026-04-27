// api/healthcheck.mjs — Тихая проверка работоспособности

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const THREAD_ID        = process.env.THREAD_ID;
const APPS_SCRIPT_URL  = process.env.APPS_SCRIPT_URL;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;
const SUPPORT_USER_ID  = process.env.SUPPORT_USER_ID;

async function tgSend(chatId, text, threadId) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (threadId) body.message_thread_id = parseInt(threadId);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch(e) {
    console.error('tgSend error:', e);
    return { ok: false, error: e.message };
  }
}

async function puzzleSend(userId, text, threadId) {
  if (!PUZZLEBOT_TOKEN || !userId) return { ok: false, error: 'no token or user' };
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}&method=tg.sendMessage`;
    const paramsObj = {
      chat_id: userId,
      text: text,
      parse_mode: 'HTML',
    };
    if (threadId) paramsObj.message_thread_id = threadId;
    const params = new URLSearchParams(paramsObj);
    const res = await fetch(url + '&' + params.toString());
    return res.json();
  } catch(e) {
    console.error('puzzleSend error:', e);
    return { ok: false, error: e.message };
  }
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

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

  if (!allOk) {
    const errors = [];
    if (!tg.ok) errors.push(`❌ Telegram: ${tg.error}`);
    if (!sheets.ok) errors.push(`❌ Google Sheets: ${sheets.error}`);
    const msg = `🚨 <b>СБОЙ СЕРВИСА</b>\n\n${errors.join('\n')}\n\n<b>Время:</b> ${nowVN()}\n\n⚠️ Заявки могут не обрабатываться. Проверьте сервисы.`;

    if (GROUP_ID) {
      await tgSend(GROUP_ID, msg, THREAD_ID || null);
    }

    if (SUPPORT_USER_ID) {
      const r = await puzzleSend(SUPPORT_USER_ID, msg);
      console.log('PuzzleBot alert to support:', JSON.stringify(r));
    }

    if (GROUP_ID) {
      const r = await puzzleSend(GROUP_ID, msg, THREAD_ID || null);
      console.log('PuzzleBot alert to group/thread:', JSON.stringify(r));
    }
  }

  return res.status(allOk ? 200 : 503).json({
    ok: allOk,
    time: nowVN(),
    checks: { telegram: tg, sheets },
  });
}
