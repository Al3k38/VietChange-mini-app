// api/order.js — Vercel Serverless Function with Telegram InitData verification + PuzzleBot
// SECURITY: ставка/сумма пересчитываются на сервере (см. _lib/rates-server.mjs).

import { assessRisk, formatRiskBlock, formatRiskShort } from './risk-check.mjs';
import { recalcOrder } from './_lib/rates-server.mjs';
import { esc } from './_lib/escape.mjs';
import { sheetsPost } from './_lib/sheets.mjs';
import { verifyTelegramInitData } from './_lib/verify.mjs';
import { setCorsHeaders } from './_lib/cors.mjs';
import { markNonceUsed, getAuthDate } from './_lib/replay.mjs';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const THREAD_ID        = process.env.THREAD_ID;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;
const PUZZLEBOT_CMD    = process.env.PUZZLEBOT_CMD || 'Повтор заявки (Mini App)';

function genOrderNum() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text, threadId, replyToMessageId) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (threadId) body.message_thread_id = parseInt(threadId);
    if (replyToMessageId) body.reply_to_message_id = parseInt(replyToMessageId);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); }
}

async function puzzleSetVariable(userId, variableName, value) {
  if (!PUZZLEBOT_TOKEN || !userId || !variableName) {
    console.warn(`[PuzzleBot] skipped variableChange: token/user/name missing (user=${userId}, var=${variableName})`);
    return;
  }
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}&method=variableChange&variable=${encodeURIComponent(variableName)}&expression=${encodeURIComponent(value)}&user_id=${userId}`;
    const res = await fetch(url);
    const data = await res.json();
    // Всегда логируем результат — для отладки
    console.warn(`[PuzzleBot] variableChange ${variableName}="${value}" user=${userId} → ${JSON.stringify(data)}`);
  } catch(e) {
    console.error('[PuzzleBot] setVariable error:', e);
  }
}

async function puzzleSendCommand(userId, commandName) {
  if (!PUZZLEBOT_TOKEN || !userId) return;
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}&method=sendCommand&command_name=${encodeURIComponent(commandName)}&tg_chat_id=${userId}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 0) console.warn('PuzzleBot error:', data);
  } catch(e) { console.error('PuzzleBot error:', e); }
}

async function appendToSheet(data) {
  await sheetsPost(data);
}

function buildGroupMessage(d, orderNum, mismatchFlag) {
  // ВСЕ значения от клиента — через esc(). Только серверные литералы вставляются как есть.
  const clientName = d.firstName || (d.username && d.username.replace('@','')) || 'Клиент';
  const userIdSafe = d.userId || '';
  const clientLink = userIdSafe
    ? `<a href="tg://user?id=${userIdSafe}">${esc(clientName)}</a>`
    : esc(clientName);
  const usernamePart = (d.username && d.username.startsWith('@')) ? ` · ${esc(d.username)}` : '';

  const FLAGS = {
    'RUB': '🇷🇺', 'USDT': '💵', 'VND': '🇻🇳',
    'KZT': '🇰🇿', 'USD': '🇺🇸', 'EUR': '🇪🇺',
  };
  const fromFlag = FLAGS[d.fromCode] || '';
  const toFlag = FLAGS[d.toCode] || '';

  const lines = [
    `<b>Встреча №</b>`,
    `${nowVN()}`,
    ``,
    `<b>📋 Заявка №${orderNum}</b>`,
    `<b>Клиент:</b> ${clientLink}${usernamePart}`,
    `<b>ID:</b> <code>${userIdSafe || '—'}</code>`,
    ``,
    `<b>Обмен: ${esc(d.fromLabel)} → ${esc(d.toLabel)}</b>`,
    `<b>Продажа:</b> <code>${esc(d.amtFrom)}</code> ${fromFlag} ${esc(d.fromCode)}`,
    `<b>Покупка:</b> <code>${esc(d.amtTo)}</code> ${toFlag} ${esc(d.toCode)}`,
    `<pre>Курс: ${esc(d.rate)}  </pre>`,
  ];
  // ── Если курс/сумма были подменены клиентом — выводим явный флаг (уже эскейпнут внутри)
  if (mismatchFlag) lines.push(mismatchFlag);
  lines.push(
    ``,
    `<b>Способ:</b> ${esc(d.method)}`,
    `<b>Дата:</b> ${esc(d.date)}`,
    `<b>Время:</b> ${esc(d.time)}`,
  );
  if (d.location) lines.push(`📍 <b>Место:</b> ${esc(d.location)}`);

  const reqLines = [];
  if (d.reqs && d.reqs.fromBank) reqLines.push(`<b>Банк отправки:</b> <code>${esc(d.reqs.fromBank)}</code>`);
  if (d.reqs && d.reqs.toName)   reqLines.push(`<b>Получатель:</b> <code>${esc(d.reqs.toName)}</code>`);
  if (d.reqs && d.reqs.toPhone)  reqLines.push(`<b>Телефон/карта:</b> <code>${esc(d.reqs.toPhone)}</code>`);
  if (d.reqs && d.reqs.toBank)   reqLines.push(`<b>Банк получателя:</b> <code>${esc(d.reqs.toBank)}</code>`);
  if (d.reqs && d.reqs.usdtNet)  reqLines.push(`<b>Сеть USDT:</b> <code>${esc(d.reqs.usdtNet)}</code>`);
  if (d.reqs && d.reqs.usdtAddr) reqLines.push(`<b>Адрес:</b> <code>${esc(d.reqs.usdtAddr)}</code>`);

  if (reqLines.length > 0) {
    lines.push(``, `<b>📝 Реквизиты:</b>`, ...reqLines);
  }

  if (d.comment) lines.push(``, `<b>Комментарий:</b> ${esc(d.comment)}`);
  lines.push(``, `<i>№ заявки: ${orderNum}</i>`);
  return lines.join('\n');
}

function buildClientMessage(d, orderNum) {
  const name = d.firstName || d.username || 'Клиент';
  const lines = [
    `<b>${esc(name)}, ваша заявка принята! 🎉</b>`,
    ``,
    `<b>№ заявки:</b> ${orderNum}`,
    ``,
    `<b>Обмен: ${esc(d.fromLabel)} → ${esc(d.toLabel)}</b>`,
    `<b>Продажа:</b> ${esc(d.amtFrom)} ${esc(d.fromCode)}`,
    `<b>Покупка:</b> ${esc(d.amtTo)} ${esc(d.toCode)}`,
    ``,
    `<b>Способ:</b> ${esc(d.method)}`,
    `<b>Дата:</b> ${esc(d.date)}, ${esc(d.time)}`,
  ];
  if (d.location) lines.push(`<b>Место:</b> ${esc(d.location)}`);
  if (d.comment)  lines.push(`<b>Комментарий:</b> ${esc(d.comment)}`);
  lines.push(``, `<b>Ваша заявка уже в обработке. Ожидайте уведомление 🔔</b>`);
  return lines.join('\n');
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const d = req.body;
    if (!d || !d.amtFrom) return res.status(400).json({ error: 'Invalid data' });

    const verifiedUser = verifyTelegramInitData(d.initData, BOT_TOKEN);
    if (!verifiedUser) {
      console.warn('Invalid initData, request rejected');
      return res.status(403).json({ error: 'Forbidden: invalid signature' });
    }
   d.userId    = verifiedUser.id;
    d.username  = verifiedUser.username ? '@' + verifiedUser.username : (verifiedUser.first_name || 'Клиент');
    d.firstName = verifiedUser.first_name || d.username;

    // Anti-replay: одну и ту же initData можно использовать для заявки только один раз.
    // Чтобы оформить вторую — клиент закрывает Mini App и открывает заново.
    const authDate = getAuthDate(d.initData);
    const firstUse = await markNonceUsed(d.userId, authDate);
    if (!firstUse) {
      console.warn(`[order] REPLAY rejected userId=${d.userId} auth_date=${authDate}`);
      return res.status(403).json({ error: 'Forbidden: replay detected' });
    }

    const orderNum = genOrderNum();
    const datetime = nowVN();

    // ─── СЕРВЕРНЫЙ ПЕРЕСЧЁТ КУРСА И СУММЫ ────────────────────
    // Защита от подмены: курс/сумма получения никогда не берутся «как есть»
    // от клиента — сервер сам считает по актуальным курсам + applyRateLogic.
    let mismatchFlag = '';
    let rubEquiv = 0;
    let serverRecalc = null;
    try {
      serverRecalc = await recalcOrder({
        amtFrom: d.amtFrom,
        fromCode: d.fromCode,
        toCode:   d.toCode,
        clientRateStr: d.rate,
      });
    } catch (e) {
      console.error('[order] recalcOrder threw:', e);
    }

    if (serverRecalc && serverRecalc.verified) {
      rubEquiv = serverRecalc.rubEquiv || 0;
      // Подменяем клиентские значения серверными — менеджер видит правду
      const clientRateOriginal = d.rate;
      const clientAmtToOriginal = d.amtTo;
      d.rate  = serverRecalc.serverRateStr;
      d.amtTo = serverRecalc.serverAmtToFormatted;

      if (serverRecalc.mismatch) {
        // Не отклоняем заявку (UX), но явно подсвечиваем менеджеру
        console.warn(
          `[order] RATE MISMATCH userId=${d.userId} client="${clientRateOriginal}" server="${serverRecalc.serverRateStr}" Δ=${serverRecalc.mismatchPct}%`
        );
        mismatchFlag =
          `\n❗ <b>Расхождение курса (${serverRecalc.mismatchPct}%):</b>\n` +
          `   клиент видел: <code>${esc(clientRateOriginal)}</code>\n` +
          `   клиент сумму: <code>${esc(clientAmtToOriginal)}</code>\n` +
          `   сервер пересчитал по актуальному курсу.`;
      }

      // Если курс из резервного хранилища (Apps Script был недоступен) —
      // ОБЯЗАТЕЛЬНО предупреждаем менеджера.
      if (serverRecalc.isFallback) {
        const ageMin = Math.floor((serverRecalc.ratesAgeMs || 0) / 60000);
        const sourceLabel = serverRecalc.ratesSource === 'stale-supabase'
          ? 'persistent backup'
          : 'in-memory';
        console.warn(`[order] FALLBACK rates used: source=${serverRecalc.ratesSource} age=${ageMin}min`);
        mismatchFlag = (mismatchFlag || '') +
          `\n🚨 <b>КУРС РЕЗЕРВНЫЙ</b> (источник: ${sourceLabel}, возраст ~${ageMin} мин)\n` +
          `   Google Sheets / Apps Script был недоступен — взят последний сохранённый курс.\n` +
          `   <b>Проверьте курс вручную перед обменом.</b>`;
      }
    } else {
      const reason = (serverRecalc && serverRecalc.reason) || 'unknown';

      if (reason === 'pair_not_found') {
        // OTHER-пара (клиент выбрал «Другой банк / Другая сеть» с произвольной валютой) —
        // в листе «Курсы» такой пары нет, сервер не знает курса. Пропускаем заявку
        // с явной пометкой менеджеру: проверять курс и сумму вручную.
        console.warn(`[order] OTHER pair (no server rate): ${d.fromCode} → ${d.toCode}`);
        mismatchFlag = `\n⚠️ <b>OTHER-пара</b> (<code>${esc(d.fromCode)} → ${esc(d.toCode)}</code>) — сервер не знает курса, значения от клиента, курс и сумму проверить вручную.`;
        // Fallback rubEquiv для риск-проверки (русский формат).
        try {
          const amt = parseFloat(String(d.amtFrom).replace(/\s/g,'').replace(/\./g,'').replace(',','.')) || 0;
          if (d.fromCode === 'RUB') rubEquiv = amt;
          else if (d.fromCode === 'USDT' || d.fromCode === 'USD') rubEquiv = amt * 80;
          else if (d.fromCode === 'EUR') rubEquiv = amt * 86;
          else if (d.fromCode === 'KZT') rubEquiv = amt * 0.18;
          else if (d.fromCode === 'VND') rubEquiv = amt * 0.003;
        } catch (e) { /* skip */ }
      } else {
        // rates_unavailable / rate_invalid / invalid_amount / unknown — отклоняем.
        // Если пропустить, клиент мог бы подменить курс пока Apps Script лежит.
        console.error(`[order] REJECT 503: recalc failed reason=${reason} userId=${d.userId}`);
        return res.status(503).json({
          ok: false,
          error: 'Курсы временно недоступны. Попробуйте через минуту.',
        });
      }
    }

    // Запрос к Apps Script для firstSeen + истории
    let firstSeen = null;
    let nameChanges = 0;
    let usernameChanges = 0;
    if (d.userId) {
      const visitData = await sheetsPost({
        type: 'visit',
        userId: d.userId,
        username: d.username || '',
        firstName: d.firstName || '',
        datetime: nowVN(),
        checkOnly: true,
      });
      if (visitData) {
        firstSeen = visitData.firstSeen || null;
        nameChanges = visitData.nameChanges || 0;
        usernameChanges = visitData.usernameChanges || 0;
      }
    }

    // Риск-проверка
    let riskShort = '';
    let riskBlock = '';
    try {
      const risk = await assessRisk(d.userId, {
        username: d.username,
        rubEquiv,
        photoUrl: d.photoUrl || '',
        firstSeen,
        nameChanges,
        usernameChanges,
      });
      riskShort = formatRiskShort(risk);
      riskBlock = formatRiskBlock(risk);
      console.warn('Risk check:', risk.summary, '| flags:', risk.flags.length);
    } catch(e) {
      console.error('Risk check failed:', e);
    }

    const groupMsg = buildGroupMessage(d, orderNum, mismatchFlag) + (riskShort ? '\n\n' + riskShort : '');
    let orderMessageId = null;
    if (GROUP_ID) {
      const orderResp = await tgSend(GROUP_ID, groupMsg, THREAD_ID);
      if (orderResp && orderResp.ok && orderResp.result) {
        orderMessageId = orderResp.result.message_id;
      }
    }

    if (GROUP_ID && riskBlock && orderMessageId) {
      await tgSend(GROUP_ID, riskBlock, THREAD_ID, orderMessageId);
    }
    if (d.userId) {
      // Сумма продажи в PuzzleBot-переменную sum_3 — для любой валюты.
      // Сама переменная sum_3 — сырое число; PuzzleBot формулой Correct_sum_3
      // переформатирует её для показа клиенту.
      // Парсинг русского формата: точка как тысячи, запятая как десятичная.
      // "77.800" → "77800", "10,5" → "10.5".
      const amtFromNumber = String(d.amtFrom).replace(/\s/g,'').replace(/\./g,'').replace(',','.');
      await puzzleSetVariable(d.userId, 'sum_3', amtFromNumber);

      await tgSend(d.userId, buildClientMessage(d, orderNum));
      await new Promise(r => setTimeout(r, 800));
      await puzzleSendCommand(d.userId, PUZZLEBOT_CMD);
    }

    await appendToSheet({
      orderNum, datetime,
      username:  d.username  || '',
      userId:    d.userId    || '',
      fromLabel: d.fromLabel || '',
      amtFrom:   d.amtFrom   || '',
      toLabel:   d.toLabel   || '',
      amtTo:     d.amtTo     || '',       // ← уже серверное значение
      rate:      d.rate      || '',       // ← уже серверное значение
      method:    d.method    || '',
      date:      d.date      || '',
      time:      d.time      || '',
      location:  d.location  || '',
      reqs:      d.reqs      || {},
      comment:   d.comment   || '',
    });

    return res.status(200).json({ ok: true, orderNum });

  } catch(e) {
    console.error('Handler error:', e);
    try {
      if (GROUP_ID) {
        const errMsg = `🚨 <b>ОШИБКА ОБРАБОТКИ ЗАЯВКИ</b>\n\n` +
          `❌ Заявка от клиента не была отправлена!\n\n` +
          `<b>Ошибка:</b> ${esc(e.message || 'Unknown')}\n` +
          `<b>Время:</b> ${nowVN()}\n\n` +
          `⚠️ Свяжитесь с клиентом вручную если он напишет в чат.`;
        await tgSend(GROUP_ID, errMsg, null);
      }
    } catch(_) {}
    // НЕ возвращаем e.message клиенту — может содержать пути файлов,
    // имена env переменных, URL внутренних сервисов. Детали остаются
    // только в console.error выше для Vercel логов.
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
