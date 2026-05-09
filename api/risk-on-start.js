// api/risk-on-start.js
// Vercel Serverless Function — вызывается из PuzzleBot при /start или /menu
// Проверяет клиента и отправляет риск-блок в топик Risk Check

import { assessRisk, formatRiskBlock } from './risk-check.mjs';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const GENERAL_THREAD_ID = process.env.GENERAL_THREAD_ID || null;
const RISK_THREAD_ID   = process.env.RISK_THREAD_ID;
const APPS_SCRIPT_URL  = process.env.APPS_SCRIPT_URL;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;
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

// Проверка — было ли уведомление за последние 7 дней
async function checkRecentAlert(userId) {
  if (!APPS_SCRIPT_URL || !userId) return false;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'check_alert', userId: String(userId) }),
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.recentAlert === true;
  } catch(e) { 
    console.warn('[risk-on-start] check_alert failed:', e.message);
    return false;
  }
}

// Сохранение нового уведомления о риске
async function saveAlert(userId, username, firstName, riskLevel, event, signals) {
  if (!APPS_SCRIPT_URL || !userId) return;
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'save_alert',
        datetime: nowVN(),
        userId: String(userId),
        username: username || '',
        firstName: firstName || '',
        riskLevel,
        event,
        signals: signals || '',
      }),
      redirect: 'follow',
    });
  } catch(e) { 
    console.warn('[risk-on-start] save_alert failed:', e.message);
  }
}

// Проверяет — есть ли в риске КРИТИЧНЫЕ сигналы (только для /menu)
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
  
  const token = req.query.token;
  if (!RISK_CHECK_SECRET || !token || token !== RISK_CHECK_SECRET) {
    console.warn('[risk-on-start] FORBIDDEN — token mismatch or missing');
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    const d = req.body;
    if (!d) return res.status(400).json({ error: 'Invalid data: empty body' });
    
    // Извлекаем тип события (start или menu)
    const event = String(d.event || 'start').toLowerCase();
    
    // Извлекаем данные пользователя (поддержка двух форматов)
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
    
    // Проверка истории клиента в "Визиты"
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
          isNewClient = !firstSeen;
        }
      } catch(e) { 
        console.warn('[risk-on-start] Visit lookup failed:', e.message);
      }
    }
    
    // ─── ОБРАБОТКА СОБЫТИЯ /menu ─────────────────────────────────
    if (event === 'menu') {
      // Антиспам: проверяем было ли уведомление за последние 7 дней
      const recentAlert = await checkRecentAlert(userId);
      if (recentAlert) {
        console.warn(`[/menu] Skip alert for ${userId} — recent alert within 7 days`);
        return res.status(200).json({ ok: true, event: 'menu', skipped: 'recent_alert' });
      }
      
      // Запускаем риск-проверку
      const risk = await assessRisk(userId, {
        username,
        rubEquiv: 0,
        photoUrl,
        firstSeen,
        nameChanges,
        usernameChanges,
      });
      
      // Проверяем наличие КРИТИЧНЫХ сигналов
      if (!hasCriticalSignals(risk)) {
        console.warn(`[/menu] No critical signals for ${userId} — no notification`);
        return res.status(200).json({ ok: true, event: 'menu', sent: false });
      }
      
      console.warn(`[/menu] CRITICAL ${userId} | ${risk.summary}`);
      
      // Формируем сообщение
      const userIdSafe = String(userId);
      const clientLink = `<a href="tg://user?id=${userIdSafe}">${firstName}</a>`;
      const usernamePart = username ? ` · ${username}` : '';
      
      const msg = [
        `🚨 <b>Подозрительная активность (/menu)</b>`,
        `📅 ${nowVN()}`,
        ``,
        `<b>Имя:</b> ${clientLink}${usernamePart}`,
        `<b>ID:</b> <code>${userIdSafe}</code>`,
      ].join('\n');
      
      const riskBlock = formatRiskBlock(risk);
      const fullMsg = msg + '\n' + riskBlock;
      
      // Отправляем в топик Risk Check
      if (GROUP_ID && RISK_THREAD_ID) {
        await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
      }
      
      // Сохраняем уведомление в Risk Alerts
      await saveAlert(userId, username, firstName, risk.summary, '/menu', risk.flags.join(' | '));
      
      return res.status(200).json({ ok: true, event: 'menu', risk: risk.summary, sent: true });
    }
    
    // ─── ОБРАБОТКА СОБЫТИЯ /start (старая логика) ───────────────
    
    // Если клиент УЖЕ был — тишина
    if (!isNewClient) {
      console.warn(`[/start] Existing client ${userId} — no notification`);
      return res.status(200).json({ ok: true, event: 'start', isNew: false });
    }
    
    // Запускаем риск-проверку
    const risk = await assessRisk(userId, {
      username,
      rubEquiv: 0,
      photoUrl,
      firstSeen,
      nameChanges,
      usernameChanges,
    });
    
    console.warn(`[/start] NEW client ${userId} | ${risk.summary}`);
    
    // Если риск НИЗКИЙ — тишина
    if (risk.level === 'LOW') {
      console.warn(`[/start] Low risk — no notification for ${userId}`);
      // Записываем нового клиента в "Визиты" даже при низком риске
      if (APPS_SCRIPT_URL) {
        try {
          await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'visit',
              userId,
              username: username.replace(/^@/, ''),
              firstName,
              datetime: nowVN(),
              platform: 'start',
            }),
            redirect: 'follow',
          });
        } catch(e) {}
      }
      return res.status(200).json({ ok: true, event: 'start', isNew: true, risk: risk.summary, sent: false });
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
    
    // Отправляем в топик Risk Check
    if (GROUP_ID && RISK_THREAD_ID) {
      await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
    }
    
    // Сохраняем уведомление в Risk Alerts
    await saveAlert(userId, username, firstName, risk.summary, '/start', risk.flags.join(' | '));
    
    // Записываем нового клиента в "Визиты" (без checkOnly)
    if (APPS_SCRIPT_URL) {
      try {
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'visit',
            userId,
            username: username.replace(/^@/, ''),
            firstName,
            datetime: nowVN(),
            platform: 'start',
          }),
          redirect: 'follow',
        });
      } catch(e) {
        console.warn('[risk-on-start] Save to Визиты failed:', e.message);
      }
    }
    
    return res.status(200).json({ ok: true, event: 'start', isNew: true, risk: risk.summary, sent: true });
    
  } catch(e) {
    console.error('Handler error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
