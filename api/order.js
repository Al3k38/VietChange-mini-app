// api/order.js — Vercel Serverless Function with Telegram InitData verification + PuzzleBot

import crypto from 'crypto';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const THREAD_ID        = process.env.THREAD_ID;
const APPS_SCRIPT_URL  = process.env.APPS_SCRIPT_URL;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;
const PUZZLEBOT_CMD    = process.env.PUZZLEBOT_CMD || 'Повтор заявки (Mini App)';

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

function genOrderNum() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
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
  } catch(e) { console.error('tgSend error:', e); }
}

// Вызов команды PuzzleBot — клиент получит сообщение с кнопками
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
  if (!APPS_SCRIPT_URL) return;
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow',
    });
  } catch(e) { console.error('Sheets error:', e); }
}

function buildGroupMessage(d, orderNum) {
  const lines = [
    `<b>📋 Заявка №${orderNum}</b>`,
    `📅 ${nowVN()}`,
    ``,
    `<b>Встреча №</b>`,
    ``,
    `👤 Клиент: ${d.username || 'неизвестен'} (ID: <code>${d.userId || '—'}</code>)`,
    ``,
    `🔄 <b>Обмен:</b> ${d.fromLabel} → ${d.toLabel}`,
    `💵 <b>Продажа:</b> ${d.amtFrom} ${d.fromCode}`,
    `💰 <b>Покупка:</b> ${d.amtTo} ${d.toCode}`,
    `📈 <b>Курс:</b> ${d.rate}`,
    ``,
    `🚚 <b>Способ:</b> ${d.method}`,
    `🗓 <b>Дата:</b> ${d.date}`,
    `🕒 <b>Время:</b> ${d.time}`,
  ];
  if (d.location)                lines.push(`📍 <b>Место:</b> ${d.location}`);
  if (d.reqs && d.reqs.fromBank) lines.push(`🏦 <b>Банк отправки:</b> ${d.reqs.fromBank}`);
  if (d.reqs && d.reqs.toName)   lines.push(`👤 <b>Получатель:</b> ${d.reqs.toName}`);
  if (d.reqs && d.reqs.toPhone)  lines.push(`📱 <b>Телефон/карта:</b> <code>${d.reqs.toPhone}</code>`);
  if (d.reqs && d.reqs.toBank)   lines.push(`🏦 <b>Банк получателя:</b> ${d.reqs.toBank}`);
  if (d.reqs && d.reqs.usdtNet)  lines.push(`🔗 <b>Сеть USDT:</b> ${d.reqs.usdtNet}`);
  if (d.reqs && d.reqs.usdtAddr) lines.push(`💳 <b>Адрес:</b> <code>${d.reqs.usdtAddr}</code>`);
  if (d.comment)                 lines.push(``, `💬 <b>Комментарий:</b> ${d.comment}`);
  lines.push(``, `<i>№ заявки: ${orderNum}</i>`);
  return lines.join('\n');
}

function buildClientMessage(d, orderNum) {
  const name = d.firstName || d.username || 'Клиент';
  const lines = [
    `<b>${name}, ваша заявка принята! 🎉</b>`,
    ``,
    `<b>№ заявки:</b> ${orderNum}`,
    ``,
    `<b>Обмен:</b> ${d.fromLabel} → ${d.toLabel}`,
    ``,
    `<b>Продажа:</b> ${d.amtFrom} ${d.fromCode}`,
    `<b>Покупка:</b> ${d.amtTo} ${d.toCode}`,
    ``,
    `<b>Способ:</b> ${d.method}`,
    `<b>Дата:</b> ${d.date}, ${d.time}`,
  ];
  if (d.location) lines.push(`<b>Место:</b> ${d.location}`);
  if (d.comment)  lines.push(`<b>Комментарий:</b> ${d.comment}`);
  lines.push(``, `<b>Ваша заявка уже в обработке. Ожидайте уведомление 🔔</b>`);
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    const orderNum = genOrderNum();
    const datetime = nowVN();

    if (GROUP_ID) await tgSend(GROUP_ID, buildGroupMessage(d, orderNum), THREAD_ID);
    if (d.userId) {
      await tgSend(d.userId, buildClientMessage(d, orderNum));
      // Через секунду вызываем команду PuzzleBot — клиент получит кнопки
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
      amtTo:     d.amtTo     || '',
      rate:      d.rate      || '',
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
    // Алерт в General-топик что заявка не доставлена
    try {
      if (GROUP_ID) {
        const errMsg = `🚨 <b>ОШИБКА ОБРАБОТКИ ЗАЯВКИ</b>\n\n` +
          `❌ Заявка от клиента не была отправлена!\n\n` +
          `<b>Ошибка:</b> ${e.message || 'Unknown'}\n` +
          `<b>Время:</b> ${nowVN()}\n\n` +
          `⚠️ Свяжитесь с клиентом вручную если он напишет в чат.`;
        await tgSend(GROUP_ID, errMsg, null);
      }
    } catch(_) {}
    return res.status(500).json({ ok: false, error: 'Internal error', detail: e.message });
  }
}
