// api/visit.js — Логирование визитов клиентов в Mini App

import crypto from 'crypto';

const BOT_TOKEN          = process.env.BOT_TOKEN;
const GROUP_ID           = process.env.GROUP_ID;
const GENERAL_THREAD_ID  = process.env.GENERAL_THREAD_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;

function verifyTelegramInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const authDate = parseInt(params.get('auth_date') || '0');
  if (Date.now()/1000 - authDate > 3600) return null;
  try {
    return JSON.parse(params.get('user') || '{}');
  } catch { return null; }
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text, threadId) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_notification: true };
    if (threadId) body.message_thread_id = parseInt(threadId);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); }
}

async function logToSheet(data) {
  if (!APPS_SCRIPT_URL) return;
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'visit', ...data }),
      redirect: 'follow',
    });
  } catch(e) { console.error('Sheets error:', e); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const d = req.body || {};
    const verifiedUser = verifyTelegramInitData(d.initData, BOT_TOKEN);
    if (!verifiedUser) return res.status(403).json({ error: 'Forbidden' });

    const userId    = verifiedUser.id;
    const username  = verifiedUser.username ? '@' + verifiedUser.username : '';
    const firstName = verifiedUser.first_name || '';
    const lastName  = verifiedUser.last_name || '';
    const lang      = verifiedUser.language_code || '';
    const isPremium = verifiedUser.is_premium ? 'Да' : 'Нет';
    const platform  = d.platform || '';
    const tgVersion = d.version  || '';
    const datetime  = nowVN();

    // Сообщение в General-топик
    const msg = [
      `👤 <b>Клиент в Mini App</b>`,
      `📅 ${datetime}`,
      ``,
      `Имя: ${firstName} ${lastName}`.trim(),
      username ? `Username: ${username}` : null,
      `ID: <code>${userId}</code>`,
      `Язык: ${lang || '—'} · Premium: ${isPremium}`,
      `Платформа: ${platform || '—'} · Telegram ${tgVersion || '—'}`,
    ].filter(Boolean).join('\n');

    if (GROUP_ID && GENERAL_THREAD_ID) {
      await tgSend(GROUP_ID, msg, GENERAL_THREAD_ID);
    }

    await logToSheet({
      datetime, userId, username, firstName, lastName,
      lang, isPremium, platform, tgVersion,
    });

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Visit handler error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
