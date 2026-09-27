// api/risk-on-start.js
// Vercel Serverless Function — вызывается из PuzzleBot при /start или /menu
// Проверяет клиента и отправляет риск-блок в топик Risk Check.

import { assessRisk, formatRiskBlock, formatRiskShort } from './risk-check.mjs';
import { sheetsPost } from './_lib/sheets.mjs';
import { esc } from './_lib/escape.mjs';
import { checkRateLimit } from './_lib/ratelimit.mjs';

const BOT_TOKEN         = process.env.BOT_TOKEN;
const GROUP_ID          = process.env.GROUP_ID;
const RISK_THREAD_ID    = process.env.RISK_THREAD_ID;
const RISK_CHECK_SECRET = process.env.RISK_CHECK_SECRET;
const PUZZLEBOT_TOKEN   = process.env.PUZZLEBOT_TOKEN;

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Больше скольких /start в минуту считаем флудом.
const START_ALERT_LIMIT = 10;

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

// Номер заявки — копия genOrderNum() из api/order.js, формат YYYYMMDD-XXXX (GMT+7)
function genOrderNum() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-B${Math.floor(Math.random()*9000+1000)}`;
}

// Установка переменной PuzzleBot для конкретного клиента
async function puzzleSetVariable(userId, variableName, value) {
  if (!PUZZLEBOT_TOKEN || !userId || !variableName) return { ok: false };
  try {
    // PuzzleBot evaluates `expression` as a formula (2+2, $VAR$, "text").
    // Wrap value in double quotes + escape inner backslashes/quotes —
    // иначе многострочный HTML с эмодзи валится с «Variable evaluate exception!».
    const escapedValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const expression = `"${escapedValue}"`;
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}`
      + `&method=variableChange`
      + `&variable=${encodeURIComponent(variableName)}`
      + `&expression=${encodeURIComponent(expression)}`
      + `&user_id=${userId}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data.code !== 0) {
      console.warn(`[risk-on-start] PuzzleBot variableChange failed user=${userId} var=${variableName}:`, data);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error(`[risk-on-start] PuzzleBot variableChange error user=${userId} var=${variableName}:`, e.message);
    return { ok: false };
  }
}

// Грубый рублёвый эквивалент для «крупная сумма + молодой» флага в risk-check.
function approxRubEquiv(amtFrom, fromCode) {
  const amt = parseFloat(
    String(amtFrom || '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  ) || 0;
  if (amt <= 0) return 0;
  const c = String(fromCode || '').toUpperCase();
  if (c === 'RUB')                    return amt;
  if (c === 'USDT' || c === 'USD')    return amt * 80;
  if (c === 'EUR')                    return amt * 86;
  if (c === 'KZT')                    return amt * 0.18;
  if (c === 'VND')                    return amt * 0.003;
  return 0;
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
    const send = async () => {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    let data = await send();
    // 429 = Telegram просит подождать retry_after секунд. Одна повторная
    // попытка, ожидание капим 5 сек — дольше ждать нельзя (5-сек таймаут
    // PuzzleBot + лимит времени Vercel-функции).
    if (data && data.ok === false && data.error_code === 429) {
      const wait = Math.min((data.parameters && data.parameters.retry_after) || 1, 5);
      console.warn(`[tgSend] 429 — retry in ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
      data = await send();
      if (data && data.ok === false) {
        console.warn(`[tgSend] DROPPED after retry: ${JSON.stringify(data).slice(0, 150)}`);
      }
    }
    return data;
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

// ─── Гейт против флуда /start ────────────────────────────────
// Счётчик rate_limits считает по минутам. Если смотреть только текущую
// минуту, в начале каждой новой минуты сквозь гейт проскакивало бы ещё
// 10 алёртов, поэтому дополнительно читаем предыдущую минуту.
async function prevMinuteCount(key) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return 0;
  try {
    const prevMin = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/rate_limits`
      + `?key=eq.${encodeURIComponent(key)}`
      + `&window_minute=eq.${encodeURIComponent(prevMin)}`
      + `&select=count`;
    const res = await fetch(url, {
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!res.ok) return 0;
    const rows = await res.json();
    return (rows && rows[0] && rows[0].count) || 0;
  } catch (e) {
    console.warn('[/start] prevMinuteCount failed:', e.message);
    return 0; // fail-open — при сбое Supabase гейт не блокирует
  }
}

// pass=false → алёрт не шлём. notify=true → шлём одно сводное сообщение.
async function startFloodGate() {
  const cur  = await checkRateLimit('start_alert', START_ALERT_LIMIT);
  const prev = await prevMinuteCount('start_alert');
  const floodNow  = !cur.allowed;              // лимит пробит в этой минуте
  const floodPrev = prev > START_ALERT_LIMIT;  // прошлая минута была флудовой
  if (!floodNow && !floodPrev) return { pass: true, count: cur.count, prev };
  // Сводка ровно один раз в минуту — на первом заблокированном событии.
  const notify = floodNow && cur.count === START_ALERT_LIMIT + 1;
  return { pass: false, notify, count: cur.count, prev };
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

  // Что именно шлёт PuzzleBot на /start — чтобы при следующей атаке сразу
  // видеть источник (start-параметр / метку), а не раскапывать постфактум.
  if (event === 'start') {
    console.warn(`[/start] src=${d.start || d.startParam || d.start_param || d.ref || d.source || '-'} keys=${Object.keys(d).join(',')}`);
  }

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

  // Не отвечаем заранее — на Vercel fast-respond рубит функцию рандомно.
  // Отвечаем 200 в конце каждой ветки (return res.status(200).json(...)).

  try {
    // ─── ЗАЩИТА ОТ ФЛУДА /start ──────────────────────────────
    // Гейт стоит ДО sheets-lookup и risk-check: при флуде не тратим
    // ни квоту Apps Script, ни лимиты CAS/LolsBot, ни лимиты Telegram.
    if (event === 'start') {
      const gate = await startFloodGate();
      if (!gate.pass) {
        if (gate.notify && GROUP_ID && RISK_THREAD_ID) {
          await tgSend(GROUP_ID, [
            `⚠️ <b>Флуд /start</b>`,
            `📅 ${nowVN()}`,
            ``,
            `Поток превысил ${START_ALERT_LIMIT}/мин (за прошлую минуту: <b>${gate.prev}</b>).`,
            `Алёрты «Новый клиент в боте» приостановлены — возобновятся автоматически, когда поток спадёт.`,
          ].join('\n'), RISK_THREAD_ID);
        }
        console.warn(`[/start] FLOOD — skipped user=${userId} min=${gate.count} prev=${gate.prev}`);
        return res.status(200).json({ ok: true, skipped: 'flood' });
      }
    }

    // История клиента
    let isNewClient = true;
    let firstSeen = null;
    let nameChanges = 0;
    let usernameChanges = 0;

    // Если visit-данные пришли в body (от /api/visit) — используем их
    // и пропускаем sheets lookup. Экономит 1 sheetsPost на открытие Mini App.
    // Для /start, /menu от PuzzleBot — body этих полей не содержит, поэтому
    // fallback на старую логику. Для /order sheets-lookup отдельно ниже.
    if (d.firstSeen !== undefined) {
      firstSeen = d.firstSeen || null;
      nameChanges = Number(d.nameChanges || 0);
      usernameChanges = Number(d.usernameChanges || 0);
      isNewClient = !firstSeen;
    } else if (event !== 'order') {
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
    }

    // ─── PuzzleBot-заявка: риск в переменные ─────────────────
    // Полный 9-сигнальный риск, результат пишется в PuzzleBot переменные
    // risk_short и risk_block. Алёрт в Risk Check НЕ шлём — риск идёт
    // прямо в сообщение заявки через {{risk_short}} / {{risk_block}}.
    if (event === 'order') {
      const rubEquiv = approxRubEquiv(d.amtFrom || d.amount, d.fromCode || d.currency);
      // Sheets-lookup с укороченным таймаутом 1.5 сек — если Apps Script
      // быстро ответит, получим firstSeen для «С нами с DATE» в риск-блоке.
      // Иначе продолжаем без него, чтобы уложиться в 5-сек таймаут PuzzleBot.
      const orderVisit = await Promise.race([
        sheetsPost({
          type: 'visit',
          userId,
          username,
          firstName,
          datetime: nowVN(),
          checkOnly: true,
        }),
        new Promise(r => setTimeout(() => r(null), 2500)),
      ]);
      const orderFirstSeen = orderVisit ? (orderVisit.firstSeen || null) : null;
      const risk = await assessRisk(userId, {
        username,
        rubEquiv,
        photoUrl,
        firstSeen: orderFirstSeen,
        nameChanges,
        usernameChanges,
      });
      console.warn(`[risk-on-start order] userId=${userId} risk=${risk.summary} rubEquiv=${rubEquiv} firstSeen=${orderFirstSeen || 'null'} flagsCount=${risk.flags.length}`);

      const shortText = formatRiskShort(risk);
      const fullBlock = formatRiskBlock(risk);
      const orderNum = genOrderNum();
      await Promise.all([
        puzzleSetVariable(userId, 'risk_short', shortText),
        puzzleSetVariable(userId, 'risk_block', fullBlock),
        puzzleSetVariable(userId, 'order_num', orderNum),
      ]);
      console.warn(`[risk-on-start order] order_num=${orderNum} userId=${userId}`);
      return res.status(200).json({ ok: true, vars_set: true });
    }

    // ─── /menu или mini_app ──────────────────────────────────
    if (event === 'menu' || event === 'mini_app') {
      const recentAlert = await checkRecentAlert(userId);
      if (recentAlert) {
        console.warn(`[/menu] Skip alert for ${userId} — recent alert within 7 days`);
        return res.status(200).json({ ok: true, skipped: 'recent_alert' });
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
        return res.status(200).json({ ok: true, skipped: 'no_critical' });
      }

      console.warn(`[/menu] CRITICAL ${userId} | ${risk.summary}`);
      console.warn(`[/menu] env check: GROUP_ID=${!!GROUP_ID} RISK_THREAD_ID=${!!RISK_THREAD_ID} BOT_TOKEN=${!!BOT_TOKEN}`);

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
        const tgRes = await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
        console.warn(`[/menu] tgSend result: ${JSON.stringify(tgRes).slice(0, 200)}`);
      } else {
        console.warn(`[/menu] SKIP tgSend — GROUP_ID or RISK_THREAD_ID missing`);
      }

      const eventLabel = event === 'menu' ? '/menu' : 'mini_app';
      await saveAlert(userId, username, firstName, risk.summary, eventLabel, risk.flags.join(' | '));
      return res.status(200).json({ ok: true, alert: 'sent' });
    }

    // ─── /start ──────────────────────────────────────────────
    if (!isNewClient) {
      console.warn(`[/start] Existing client ${userId} — no notification`);
      return res.status(200).json({ ok: true, skipped: 'existing' });
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
    console.warn(`[/start] env check: GROUP_ID=${!!GROUP_ID} RISK_THREAD_ID=${!!RISK_THREAD_ID} BOT_TOKEN=${!!BOT_TOKEN}`);

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
      const tgRes = await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
      console.warn(`[/start] tgSend result: ${JSON.stringify(tgRes).slice(0, 200)}`);
    } else {
      console.warn(`[/start] SKIP tgSend — GROUP_ID or RISK_THREAD_ID missing`);
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
    res.status(200).json({ ok: true, alert: 'sent' });

  } catch(e) {
    console.error('[risk-on-start] async work error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  }
}
