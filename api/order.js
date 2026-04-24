// api/order.js — Vercel Serverless Function
// Принимает заявку из Mini App и:
// 1. Отправляет в группу операторов
// 2. Отправляет клиенту в личку
// 3. Записывает в Google Таблицу через Apps Script

const BOT_TOKEN       = process.env.BOT_TOKEN;
const GROUP_ID        = process.env.GROUP_ID;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

function genOrderNum() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${Math.floor(Math.random()*9000+1000)}`;
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); }
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
    `👤 Клиент: ${d.username || 'неизвестен'} (ID: ${d.userId || '—'})`,
    ``,
    `🔄 Обмен: ${d.fromLabel} → ${d.toLabel}`,
    `💵 Продажа: <b>${d.amtFrom} ${d.fromCode}</b>`,
    `💰 Покупка: <b>${d.amtTo} ${d.toCode}</b>`,
    `📈 Курс: ${d.rate}`,
    ``,
    `🚚 Способ: ${d.method}`,
    `🗓 Дата: ${d.date}`,
    `🕒 Время: ${d.time}`,
  ];
  if (d.location)              lines.push(`📍 Место: ${d.location}`);
  if (d.reqs && d.reqs.fromBank) lines.push(`🏦 Банк отправки: ${d.reqs.fromBank}`);
  if (d.reqs && d.reqs.toName)   lines.push(`👤 Получатель: ${d.reqs.toName}`);
  if (d.reqs && d.reqs.toPhone)  lines.push(`📱 Телефон/карта: ${d.reqs.toPhone}`);
  if (d.reqs && d.reqs.toBank)   lines.push(`🏦 Банк получателя: ${d.reqs.toBank}`);
  if (d.reqs && d.reqs.usdtNet)  lines.push(`🔗 Сеть USDT: ${d.reqs.usdtNet}`);
  if (d.reqs && d.reqs.usdtAddr) lines.push(`💳 Адрес: ${d.reqs.usdtAddr}`);
  if (d.comment)               lines.push(``, `💬 Комментарий: ${d.comment}`);
  lines.push(``, `<i>№ заявки: ${orderNum}</i>`);
  return lines.join('\n');
}

function buildClientMessage(d, orderNum) {
  const name = d.firstName || d.username || 'Клиент';
  const lines = [
    `${name}, ваша заявка принята! 🎉`,
    ``,
    `Обмен: ${d.fromLabel} → ${d.toLabel}`,
    `Продажа: <b>${d.amtFrom} ${d.fromCode}</b>`,
    `Покупка: <b>${d.amtTo} ${d.toCode}</b>`,
    `Способ: ${d.method}`,
    `Дата: ${d.date}, ${d.time}`,
  ];
  if (d.location) lines.push(`Место: ${d.location}`);
  if (d.comment)  lines.push(`Комментарий: ${d.comment}`);
  lines.push(``, `<b>Я сообщу, когда всё будет готово. 🛵</b>`);
  lines.push(``, `<i>№ заявки: ${orderNum}</i>`);
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

    const orderNum = genOrderNum();
    const datetime = nowVN();

    if (GROUP_ID) await tgSend(GROUP_ID, buildGroupMessage(d, orderNum));
    if (d.userId) await tgSend(d.userId, buildClientMessage(d, orderNum));

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
    return res.status(500).json({ error: 'Internal error', detail: e.message });
  }
}
