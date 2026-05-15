// api/risk-on-start.js
// Vercel Serverless Function — вызывается из PuzzleBot при /start или /menu
// Проверяет клиента и отправляет риск-блок в топик Risk Check.

import { assessRisk, formatRiskBlock } from './risk-check.mjs';
import { sheetsPost } from './_lib/sheets.mjs';
import { esc } from './_lib/escape.mjs';

const BOT_TOKEN         = process.env.BOT_TOKEN;
const GROUP_ID          = process.env.GROUP_ID;
const RISK_THREAD_ID    = process.env.RISK_THREAD_ID;
const RISK_CHECK_SECRET = process.env.RISK_CHECK_SECRET;

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text, threadId) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (threadId) body.message_thread_id = parseInt(threadId);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); }
}

async function checkRecentAlert(userId) {
  if (!userId) return false;
  const data = await sheetsPost({ type: 'check_alert', userId: String(userId) });
  return data && data.recentAlert === true;
}

async function saveAlert(userId, username, firstName, riskLevel, event, signals) {
  if (!userId) return;
  await sheetsPost({
    type: 'save_alert',
    datetime: nowVN(),
    userId: String(userId),
    username: username || '',
    firstName: firstName || '',
    riskLevel,
    event,
    signals: signals || '',
  });
}

function hasCriticalSignals(risk) {
  for (const flag of risk.flags) {
    if (flag.includes('CAS:') && flag.includes('🚩')) return true;
    if (flag.includes('LolsBot:') && flag.includes('🚩')) return true;
    if (flag.includes('Возраст:') && flag.includes('⚠️')) return true;
    if (flag.includes('Смена имени:') && flag.includes('🚩')) return true;
    if (flag.includes('Смена @username:') && flag.includes('🚩')) return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Принимаем токен из Authorization-header (предпочтительно — не светится в логах)
  // ИЛИ из URL query — backwards-compat для PuzzleBot, пока его не перенастроим.
  const authHeader = req.headers['authorization'] || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const queryToken  = req.query.token || '';
  const token = headerToken || queryToken;

  if (!RISK_CHECK_SECRET || !token || token !== RISK_CHECK_SECRET) {
    console.warn('[risk-on-start] FORBIDDEN — token mismatch or missing');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ─── БЫСТРЫЙ ПАРСИНГ ВХОДА ─────────────────────────────────
  // PuzzleBot ждёт ответа максимум 5 секунд. Всё что ниже — быстрое
  // (валидация + парсинг). Дальше отвечаем 200 и продолжаем тяжёлую
  // работу (визит-lookup, risk-check, Telegram) в фоне.
  const d = req.body;
  if (!d) return res.status(400).json({ error: 'Invalid data: empty body' });

  const event = String(d.event || 'start').toLowerCase();
  console.warn(`[risk-on-start] event=${event} userId=${d.userId || (d.user && d.user.id) || 'unknown'}`);

  let userId, username, firstName, photoUrl = '';
  if (d.user && d.user.id) {
    userId = String(d.user.id);
    username = d.user.username || '';
    firstName = d.user.first_name || 'Клиент';
    if (d.user.is_bot === true) return res.status(200).json({ ok: true, ignored: 'bot' });
    if (d.chat && d.chat.type && d.chat.type !== 'private') {
      return res.status(200).json({ ok: true, ignored: 'not private chat' });
    }
  } else if (d.userId) {
    userId = String(d.userId);
    username = d.username || '';
    firstName = d.firstName || d.name || 'Клиент';
    photoUrl = d.photoUrl || '';
  } else {
    return res.status(400).json({ error: 'Invalid data: missing user info' });
  }

  if (username && !username.startsWith('@')) username = '@' + username;

  // ─── ОТВЕЧАЕМ PuzzleBot'у СРАЗУ ─────────────────────────────
  // Vercel-функция продолжает выполняться после res.status().json() —
  // мы используем это чтобы PuzzleBot не упирался в 5-сек таймаут.
  res.status(200).json({ ok: true, async: true });

  try {
    // История клиента
    let isNewClient = true;
    let firstSeen = null;
    let nameChanges = 0;
    let usernameChanges = 0;

    const visitData = await sheetsPost({
      type: 'visit',
      userId,
      username,
      firstName,
      datetime: nowVN(),
      checkOnly: true,
    });
    if (visitData) {
      firstSeen = visitData.firstSeen || null;
      nameChanges = visitData.nameChanges || 0;
      usernameChanges = visitData.usernameChanges || 0;
      isNewClient = !firstSeen;
    }

    // ─── /menu или mini_app ──────────────────────────────────
    if (event === 'menu' || event === 'mini_app') {
      const recentAlert = await checkRecentAlert(userId);
      if (recentAlert) {
        console.warn(`[/menu] Skip alert for ${userId} — recent alert within 7 days`);
        return;
      }

      const risk = await assessRisk(userId, {
        username,
        rubEquiv: 0,
        photoUrl,
        firstSeen,
        nameChanges,
        usernameChanges,
      });

      if (!hasCriticalSignals(risk)) {
        console.warn(`[/menu] No critical signals for ${userId} — no notification`);
        return;
      }

      console.warn(`[/menu] CRITICAL ${userId} | ${risk.summary}`);

      const userIdSafe = String(userId);
      const clientLink = `<a href="tg://user?id=${userIdSafe}">${esc(firstName)}</a>`;
      const usernamePart = username ? ` · ${esc(username)}` : '';

      const msg = [
        `🚨 <b>Подозрительная активность (${event === 'menu' ? '/menu' : 'Mini App'})</b>`,
        `📅 ${nowVN()}`,
        ``,
        `<b>Имя:</b> ${clientLink}${usernamePart}`,
        `<b>ID:</b> <code>${userIdSafe}</code>`,
      ].join('\n');

      const riskBlock = formatRiskBlock(risk);
      const fullMsg = msg + '\n' + riskBlock;

      if (GROUP_ID && RISK_THREAD_ID) {
        await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
      }

      const eventLabel = event === 'menu' ? '/menu' : 'mini_app';
      await saveAlert(userId, username, firstName, risk.summary, eventLabel, risk.flags.join(' | '));

      return;
    }

    // ─── /start ──────────────────────────────────────────────
    if (!isNewClient) {
      console.warn(`[/start] Existing client ${userId} — no notification`);
      return;
    }

    const risk = await assessRisk(userId, {
      username,
      rubEquiv: 0,
      photoUrl,
      firstSeen,
      nameChanges,
      usernameChanges,
    });

    console.warn(`[/start] NEW client ${userId} | ${risk.summary}`);

    if (risk.level === 'LOW') {
      console.warn(`[/start] Low risk — no notification for ${userId}`);
      // Записываем нового клиента даже при низком риске
      await sheetsPost({
        type: 'visit',
        userId,
        username: username.replace(/^@/, ''),
        firstName,
        datetime: nowVN(),
        platform: 'start',
      });
      return;
    }

    const userIdSafe = String(userId);
    const clientLink = `<a href="tg://user?id=${userIdSafe}">${esc(firstName)}</a>`;
    const usernamePart = username ? ` · ${esc(username)}` : '';

    const msg = [
      `👤 <b>Новый клиент в боте</b>`,
      `📅 ${nowVN()}`,
      ``,
      `<b>Имя:</b> ${clientLink}${usernamePart}`,
      `<b>ID:</b> <code>${userIdSafe}</code>`,
    ].join('\n');

    const riskBlock = formatRiskBlock(risk);
    const fullMsg = msg + '\n' + riskBlock;

    if (GROUP_ID && RISK_THREAD_ID) {
      await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
    }

    // Записываем нового клиента
    await sheetsPost({
      type: 'visit',
      userId,
      username: username.replace(/^@/, ''),
      firstName,
      datetime: nowVN(),
      platform: 'start',
    });

  } catch(e) {
    // Ответ PuzzleBot'у уже отправлен (200 OK). Здесь только логируем,
    // res трогать нельзя — повторный send бросит ошибку.
    console.error('[risk-on-start] async work error:', e);
  }
}
