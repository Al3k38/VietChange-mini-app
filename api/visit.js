// api/visit.js — Логирование визитов клиентов в Mini App

import { sheetsPost } from './_lib/sheets.mjs';
import { esc } from './_lib/escape.mjs';
import { verifyTelegramInitData } from './_lib/verify.mjs';
import { setCorsHeaders } from './_lib/cors.mjs';
import { checkRateLimit } from './_lib/ratelimit.mjs';

const VISIT_PER_MINUTE = 10;

const BOT_TOKEN          = process.env.BOT_TOKEN;
const GROUP_ID           = process.env.GROUP_ID;
const GENERAL_THREAD_ID  = process.env.GENERAL_THREAD_ID;
const RISK_CHECK_SECRET  = process.env.RISK_CHECK_SECRET;


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

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const d = req.body || {};
    const verifiedUser = verifyTelegramInitData(d.initData, BOT_TOKEN);
    if (!verifiedUser) return res.status(403).json({ error: 'Forbidden' });

    // Rate limit per userId — защита от флуда группы менеджеров
    // и записей в Sheets.
    const rl = await checkRateLimit(`visit:${verifiedUser.id}`, VISIT_PER_MINUTE);
    if (!rl.allowed) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ ok: false, error: 'Too many requests' });
    }

    const userId    = verifiedUser.id;
    const username  = verifiedUser.username ? '@' + verifiedUser.username : '';
    const firstName = verifiedUser.first_name || '';
    const lastName  = verifiedUser.last_name || '';
    const lang      = verifiedUser.language_code || '';
    const isPremium = verifiedUser.is_premium ? 'Да' : 'Нет';
    const platform  = d.platform || '';
    const tgVersion = d.version  || '';
    const datetime  = nowVN();

    const accountYearForSheet = estimateAccountYear(userId);

    // Пишем визит и получаем firstSeen
    const sheetResp = await sheetsPost({
      type: 'visit',
      datetime, userId, username, firstName, lastName,
      lang, isPremium, platform, tgVersion,
      accountYear: accountYearForSheet,
    });

    const firstSeen = sheetResp && sheetResp.firstSeen ? sheetResp.firstSeen : null;

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

    // Сообщение в General-топик (имя/username — через esc, на всякий случай)
    const msg = [
      `👤 <b>Клиент в Mini App</b>`,
      `📅 ${datetime}`,
      ``,
      `<b>Имя:</b> ${esc(firstName)} ${esc(lastName)}`.trim(),
      username ? `<b>Username:</b> ${esc(username)}` : null,
      `<b>ID:</b> <code>${userId}</code>`,
      accountAgeText || null,
      withUsText || null,
      `<b>Язык:</b> ${esc(lang) || '—'} · <b>Premium:</b> ${isPremium}`,
      `<b>Платформа:</b> ${esc(platform) || '—'} · Telegram ${esc(tgVersion) || '—'}`,
    ].filter(Boolean).join('\n');

    // Антиспам: было ли уведомление за последний час
    const recentRes = await sheetsPost({ type: 'check_visit_alert', userId: String(userId) });
    const recentVisitAlert = recentRes && recentRes.recentAlert === true;

    if (GROUP_ID && !recentVisitAlert) {
      await tgSend(GROUP_ID, msg, null);
      await sheetsPost({
        type: 'save_visit_alert',
        datetime: nowVN(),
        userId: String(userId),
        username: username || '',
        firstName: firstName || '',
      });
    } else if (recentVisitAlert) {
      console.warn(`[visit] Skip alert for ${userId} — recent visit within 1 hour`);
    }

    // Запуск риск-проверки (свой endpoint, не Apps Script).
    // NB: token в URL — оставлено как было; будет переведено на Authorization-header в задаче #5.
    if (RISK_CHECK_SECRET) {
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const riskUrl = `${proto}://${host}/api/risk-on-start`;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch(riskUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RISK_CHECK_SECRET}`,
          },
          body: JSON.stringify({
            userId,
            username: username.replace(/^@/, ''),
            firstName,
            photoUrl: '',
            isPremium: verifiedUser.is_premium ? '1' : '0',
            event: 'mini_app',
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
      } catch(e) {
        console.warn('[visit] risk-on-start failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    console.error('Visit handler error:', e);
    try {
      if (GROUP_ID) {
        await tgSend(GROUP_ID, `⚠️ Ошибка логирования визита: ${esc(e.message)}`, null);
      }
    } catch(_) {}
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
