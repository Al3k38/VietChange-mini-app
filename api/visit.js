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

// Примерное определение года регистрации Telegram-аккаунта по ID
function estimateAccountYear(userId) {
  const id = Number(userId);
  if (!id || isNaN(id)) return null;
  const milestones = [
    { id: 100000000,  year: 2014 },
    { id: 500000000,  year: 2016 },
    { id: 1000000000, year: 2018 },
    { id: 1500000000, year: 2020 },
    { id: 2000000000, year: 2021 },
    { id: 5000000000, year: 2022 },
    { id: 6000000000, year: 2023 },
    { id: 7000000000, year: 2024 },
    { id: 7500000000, year: 2025 },
    { id: 8000000000, year: 2026 },
  ];
  for (const m of milestones) {
    if (id < m.id) return m.year;
  }
  return 2026;
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text, threadId) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (threadId) body.message_thread_id = parseInt(threadId);
    console.log('TG SEND request:', JSON.stringify(body));
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    console.log('TG SEND response:', JSON.stringify(json));
    return json;
  } catch(e) {
    console.error('tgSend error:', e);
    return { ok: false, error: e.message };
  }
}

async function logToSheet(data) {
  if (!APPS_SCRIPT_URL) return null;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'visit', ...data }),
      redirect: 'follow',
    });
    const json = await res.json().catch(() => ({}));
    return json;
  } catch(e) { 
    console.error('Sheets error:', e);
    return null;
  }
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

    // Сначала пишем в Sheets и получаем firstSeen
    const sheetResp = await logToSheet({
      datetime, userId, username, firstName, lastName,
      lang, isPremium, platform, tgVersion,
    });
    
    // Дата первого визита (из ответа Apps Script)
    const firstSeen = sheetResp && sheetResp.firstSeen ? sheetResp.firstSeen : null;
    
    // Примерный год регистрации Telegram-аккаунта
    const accountYear = estimateAccountYear(userId);
    const currentYear = new Date().getFullYear();
    let accountAgeText = '';
    if (accountYear) {
      const age = currentYear - accountYear;
      if (age <= 0) accountAgeText = `🕐 <b>Аккаунт:</b> ~${accountYear} (новый)`;
      else if (age === 1) accountAgeText = `🕐 <b>Аккаунт:</b> ~${accountYear} (${age} год)`;
      else if (age < 5) accountAgeText = `🕐 <b>Аккаунт:</b> ~${accountYear} (${age} года)`;
      else accountAgeText = `🕐 <b>Аккаунт:</b> ~${accountYear} (${age} лет)`;
    }
    
    // С нами с — расчёт возраста
    let withUsText = '';
    if (firstSeen) {
      const firstDate = new Date(firstSeen);
      const ms = Date.now() - firstDate.getTime();
      const days = Math.floor(ms / 86400000);
      const ddmm = `${String(firstDate.getDate()).padStart(2,'0')}.${String(firstDate.getMonth()+1).padStart(2,'0')}.${firstDate.getFullYear()}`;
      let ageStr;
      if (days === 0) ageStr = 'сегодня';
      else if (days === 1) ageStr = 'вчера';
      else if (days < 7) ageStr = `${days} дн.`;
      else if (days < 30) {
        const w = Math.floor(days / 7);
        ageStr = `${w} ${w === 1 ? 'неделя' : w < 5 ? 'недели' : 'недель'} назад`;
      } else if (days < 365) {
        const m = Math.floor(days / 30);
        ageStr = `${m} ${m === 1 ? 'месяц' : m < 5 ? 'месяца' : 'месяцев'} назад`;
      } else {
        const y = Math.floor(days / 365);
        ageStr = `${y} ${y === 1 ? 'год' : y < 5 ? 'года' : 'лет'} назад`;
      }
      withUsText = `👋 <b>С нами с:</b> ${ddmm} (${ageStr})`;
    }

    // Сообщение в General-топик
    const msg = [
      `👤 <b>Клиент в Mini App</b>`,
      `📅 ${datetime}`,
      ``,
      `<b>Имя:</b> ${firstName} ${lastName}`.trim(),
      username ? `<b>Username:</b> ${username}` : null,
      `<b>ID:</b> <code>${userId}</code>`,
      accountAgeText || null,
      withUsText || null,
      `<b>Язык:</b> ${lang || '—'} · <b>Premium:</b> ${isPremium}`,
      `<b>Платформа:</b> ${platform || '—'} · Telegram ${tgVersion || '—'}`,
    ].filter(Boolean).join('\n');

    if (GROUP_ID) {
      const r = await tgSend(GROUP_ID, msg, null);
      console.log('TG SEND result:', JSON.stringify(r));
    }

    return res.status(200).json({ ok: true });
} catch(e) {
    console.error('Visit handler error:', e);
    try {
      if (GROUP_ID) {
        await tgSend(GROUP_ID, `⚠️ Ошибка логирования визита: ${e.message}`, null);
      }
    } catch(_) {}
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
