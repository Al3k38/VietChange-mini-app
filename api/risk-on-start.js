// api/risk-on-start.js
// Vercel Serverless Function — вызывается из PuzzleBot при /start
// Проверяет нового клиента и отправляет риск-блок в группу менеджеров

import { assessRisk, formatRiskBlock } from './risk-check.mjs';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const GENERAL_THREAD_ID = process.env.GENERAL_THREAD_ID || null; // топик "General"
const APPS_SCRIPT_URL  = process.env.APPS_SCRIPT_URL;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;

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

export default async function handler(req, res) {
  // Только POST + защита по токену
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  // Защита — простой токен в URL (?token=XXX)
  // PuzzleBot вызывает: https://viet-change-mini-app.vercel.app/api/risk-on-start?token=PUZZLEBOT_TOKEN
  const token = req.query.token;
  if (!token || token !== PUZZLEBOT_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    const d = req.body;
    if (!d || !d.userId) return res.status(400).json({ error: 'Invalid data: missing userId' });
    
    const userId = String(d.userId);
    const username = d.username ? (d.username.startsWith('@') ? d.username : '@' + d.username) : '';
    const firstName = d.firstName || d.name || 'Клиент';
    
    // Проверяем есть ли клиент уже в БД через Apps Script
    let isNewClient = true;
    let firstSeen = null;
    let nameChanges = 0;
    let usernameChanges = 0;
    
    if (APPS_SCRIPT_URL) {
      try {
        const visitRes = await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'visit',
            userId,
            username,
            firstName,
            datetime: nowVN(),
            checkOnly: true,
          }),
          redirect: 'follow',
        });
        if (visitRes.ok) {
          const visitData = await visitRes.json();
          firstSeen = visitData.firstSeen || null;
          nameChanges = visitData.nameChanges || 0;
          usernameChanges = visitData.usernameChanges || 0;
          // Если firstSeen был — клиент уже был у нас
          isNewClient = !firstSeen;
        }
      } catch(e) { 
        console.error('Visit lookup failed:', e); 
        // Если не удалось проверить — считаем новым (лучше лишнее уведомление)
      }
    }
    
    // Если клиент УЖЕ был — не отправляем уведомление
    if (!isNewClient) {
      console.log(`[/start] Existing client ${userId} — no notification`);
      return res.status(200).json({ ok: true, isNew: false });
    }
    
    // Запускаем риск-проверку
    const risk = await assessRisk(userId, {
      username,
      rubEquiv: 0,
      photoUrl: '',  // photo_url не передаётся через PuzzleBot, проверим без него
      firstSeen,
      nameChanges,
      usernameChanges,
    });
    
    console.log(`[/start] NEW client ${userId} | ${risk.summary}`);
    
    // Если риск НИЗКИЙ — не отправляем уведомление (нормальный клиент)
    if (risk.level === 'LOW') {
      console.log(`[/start] Low risk — no notification for ${userId}`);
      return res.status(200).json({ ok: true, isNew: true, risk: risk.summary, sent: false });
    }
    
    // Формируем сообщение в группу
    const userIdSafe = String(userId);
    const clientLink = `<a href="tg://user?id=${userIdSafe}">${firstName}</a>`;
    const usernamePart = username ? ` · ${username}` : '';
    
    const msg = [
      `👤 <b>Новый клиент в боте</b>`,
      `📅 ${nowVN()}`,
      ``,
      `<b>Имя:</b> ${clientLink}${usernamePart}`,
      `<b>ID:</b> <code>${userIdSafe}</code>`,
    ].join('\n');
    
    const riskBlock = formatRiskBlock(risk);
    const fullMsg = msg + '\n' + riskBlock;
    
    // Отправляем в General-топик группы
    const threadIdToUse = GENERAL_THREAD_ID && GENERAL_THREAD_ID !== '1' ? GENERAL_THREAD_ID : null;
    if (GROUP_ID) {
      await tgSend(GROUP_ID, fullMsg, threadIdToUse);
    }
    
    return res.status(200).json({ ok: true, isNew: true, risk: risk.summary });
    
  } catch(e) {
    console.error('Handler error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
