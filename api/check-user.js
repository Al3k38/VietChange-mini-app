// api/check-user.js
// Vercel Serverless Function — ручная проверка клиента менеджером через /check
// Принимает userId или username, запускает риск-проверку, отправляет результат в топик Risk Check

import { assessRisk, formatRiskBlock } from './risk-check.mjs';

const BOT_TOKEN          = process.env.BOT_TOKEN;
const GROUP_ID           = process.env.GROUP_ID;
const RISK_THREAD_ID     = process.env.RISK_THREAD_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;
const RISK_CHECK_SECRET  = process.env.RISK_CHECK_SECRET;

// Список менеджеров — только они могут вызывать /check
const ADMIN_USER_IDS = [
  '5571369741',   // Sasha (Al3k38)
  '7146944016',   // SashaSupport
];

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

// Поиск клиента по username в листе "Визиты"
async function findClientByUsername(username) {
  if (!APPS_SCRIPT_URL || !username) return null;
  const cleanUsername = String(username).replace(/^@/, '').toLowerCase();
  if (!cleanUsername) return null;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'lookup_username',
        username: cleanUsername,
      }),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.found ? data : null;
  } catch(e) { 
    console.warn('Username lookup failed:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  // Защита секретом
  const token = req.query.token;
  if (!RISK_CHECK_SECRET || !token || token !== RISK_CHECK_SECRET) {
    console.warn('[check-user] FORBIDDEN — token mismatch');
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    const d = req.body;
    if (!d) return res.status(400).json({ error: 'Empty body' });
    
    // Менеджер кто запросил проверку
    let managerId;
    if (d.user && d.user.id) {
      managerId = String(d.user.id);
    } else if (d.managerId) {
      managerId = String(d.managerId);
    } else {
      return res.status(400).json({ error: 'Missing manager identification' });
    }
    
    // Проверка прав — только менеджеры
    if (!ADMIN_USER_IDS.includes(managerId)) {
      console.warn(`[check-user] Unauthorized attempt by ${managerId}`);
      return res.status(403).json({ error: 'You are not authorized to use this command' });
    }
    
    // Получаем что менеджер ввёл — userId или @username
    // PuzzleBot отправляет это как текст команды
    let queryText = '';
    if (d.command && d.command.text) queryText = d.command.text;
    else if (d.query) queryText = d.query;
    else if (d.text) queryText = d.text;
    
    // Удаляем "/check" если есть, и пробелы
    queryText = String(queryText).replace(/^\/check\s*/i, '').trim();
    
    if (!queryText) {
      // Подсказка менеджеру
      await tgSend(managerId, 
        '<b>Использование команды /check:</b>\n\n' +
        '/check 7371024261 — проверка по ID\n' +
        '/check @VladMed1983 — проверка по username\n\n' +
        '<i>Поиск по username работает только для клиентов из нашей БД</i>'
      );
      return res.status(200).json({ ok: true, hint: true });
    }
    
    // Определяем — это userId (число) или username (с @ или текст)
    let targetUserId = null;
    let targetUsername = '';
    let targetFirstName = 'Клиент';
    
    if (/^\d{5,}$/.test(queryText)) {
      // Это userId
      targetUserId = queryText;
    } else {
      // Это username — ищем в нашей БД
      const found = await findClientByUsername(queryText);
      if (found) {
        targetUserId = String(found.userId);
        targetUsername = found.username || queryText;
        targetFirstName = found.firstName || 'Клиент';
      } else {
        // Не нашли по username
        await tgSend(managerId, 
          `❌ Клиент <code>${queryText}</code> не найден в нашей БД.\n\n` +
          'Если знаете <b>userId</b> — введите его вместо username:\n' +
          '<code>/check 1234567890</code>'
        );
        return res.status(200).json({ ok: true, found: false });
      }
    }
    
    // Запускаем риск-проверку
    let firstSeen = null;
    let nameChanges = 0;
    let usernameChanges = 0;
    
    if (APPS_SCRIPT_URL && targetUserId) {
      try {
        const visitRes = await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'visit',
            userId: targetUserId,
            username: targetUsername,
            firstName: targetFirstName,
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
        }
      } catch(e) { 
        console.warn('Visit lookup failed:', e.message);
      }
    }
    
    const risk = await assessRisk(targetUserId, {
      username: targetUsername,
      rubEquiv: 0,
      photoUrl: '',
      firstSeen,
      nameChanges,
      usernameChanges,
    });
    
    console.warn(`[check-user] manager=${managerId} target=${targetUserId} risk=${risk.summary}`);
    
    // Формируем сообщение для топика Risk Check
    const usernameLine = targetUsername ? `<b>Username:</b> ${targetUsername.startsWith('@') ? targetUsername : '@' + targetUsername}\n` : '';
    const clientLink = `<a href="tg://user?id=${targetUserId}">${targetFirstName}</a>`;
    
    const msg = [
      `🔎 <b>Ручная проверка клиента</b>`,
      `📅 ${nowVN()}`,
      ``,
      `<b>Имя:</b> ${clientLink}`,
      usernameLine ? usernameLine.trim() : null,
      `<b>ID:</b> <code>${targetUserId}</code>`,
      ``,
      `<i>Запросил: <a href="tg://user?id=${managerId}">менеджер</a></i>`,
    ].filter(Boolean).join('\n');
    
    const riskBlock = formatRiskBlock(risk);
    const fullMsg = msg + '\n' + riskBlock;
    
    // Отправляем в топик Risk Check
    if (GROUP_ID && RISK_THREAD_ID) {
      await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
    }
    
    return res.status(200).json({ 
      ok: true, 
      checked: targetUserId,
      risk: risk.summary 
    });
    
  } catch(e) {
    console.error('[check-user] Handler error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
