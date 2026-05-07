// api/risk-on-start.js
// Vercel Serverless Function вЂ” РІС‹Р·С‹РІР°РµС‚СЃСЏ РёР· PuzzleBot РїСЂРё /start
// РџСЂРѕРІРµСЂСЏРµС‚ РЅРѕРІРѕРіРѕ РєР»РёРµРЅС‚Р° Рё РѕС‚РїСЂР°РІР»СЏРµС‚ СЂРёСЃРє-Р±Р»РѕРє РІ РіСЂСѓРїРїСѓ РјРµРЅРµРґР¶РµСЂРѕРІ

import { assessRisk, formatRiskBlock } from './risk-check.mjs';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const GENERAL_THREAD_ID = process.env.GENERAL_THREAD_ID || null; // С‚РѕРїРёРє "General"
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

export default async function handler(req, res) {
  // РўРѕР»СЊРєРѕ POST + Р·Р°С‰РёС‚Р° РїРѕ С‚РѕРєРµРЅСѓ
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  // Р—Р°С‰РёС‚Р° вЂ” РѕС‚РґРµР»СЊРЅС‹Р№ СЃРµРєСЂРµС‚ (РќР• PUZZLEBOT_TOKEN!)
  const token = req.query.token;
  if (!RISK_CHECK_SECRET || !token || token !== RISK_CHECK_SECRET) {
    console.log('[risk-on-start] FORBIDDEN вЂ” token mismatch or missing');
    return res.status(403).json({ error: 'Forbidden' });
  }
  
  try {
    const d = req.body;
    console.log('[risk-on-start] body received:', JSON.stringify(d));
    if (!d) return res.status(400).json({ error: 'Invalid data: empty body' });
    
    // РџРѕРґРґРµСЂР¶РєР° РґРІСѓС… С„РѕСЂРјР°С‚РѕРІ:
    // 1. РџСЂСЏРјРѕР№ POST: { userId, username, firstName }
    // 2. PuzzleBot subscription: { user: {id, username, first_name}, command: {name}, ... }
    let userId, username, firstName;
    if (d.user && d.user.id) {
      // Р¤РѕСЂРјР°С‚ PuzzleBot subscriptions
      userId = String(d.user.id);
      username = d.user.username || '';
      firstName = d.user.first_name || 'РљР»РёРµРЅС‚';
      // РРіРЅРѕСЂРёСЂСѓРµРј СЃРѕР±С‹С‚РёСЏ РѕС‚ Р±РѕС‚РѕРІ
      if (d.user.is_bot === true) {
        return res.status(200).json({ ok: true, ignored: 'bot' });
      }
      // РРіРЅРѕСЂРёСЂСѓРµРј РєРѕРјР°РЅРґС‹ РќР• РѕС‚ С‡Р°СЃС‚РЅРѕРіРѕ С‡Р°С‚Р°
      if (d.chat && d.chat.type && d.chat.type !== 'private') {
        return res.status(200).json({ ok: true, ignored: 'not private chat' });
      }
    } else if (d.userId) {
      // РџСЂСЏРјРѕР№ POST С„РѕСЂРјР°С‚
      userId = String(d.userId);
      username = d.username || '';
      firstName = d.firstName || d.name || 'РљР»РёРµРЅС‚';
    } else {
      return res.status(400).json({ error: 'Invalid data: missing user info' });
    }
    
    // РќРѕСЂРјР°Р»РёР·Р°С†РёСЏ username (РґРѕР±Р°РІР»СЏРµРј @ РµСЃР»Рё РЅРµС‚)
    if (username && !username.startsWith('@')) {
      username = '@' + username;
    }
    
    // РџСЂРѕРІРµСЂСЏРµРј РµСЃС‚СЊ Р»Рё РєР»РёРµРЅС‚ СѓР¶Рµ РІ Р‘Р” С‡РµСЂРµР· Apps Script
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
          // Р•СЃР»Рё firstSeen Р±С‹Р» вЂ” РєР»РёРµРЅС‚ СѓР¶Рµ Р±С‹Р» Сѓ РЅР°СЃ
          isNewClient = !firstSeen;
        }
      } catch(e) { 
        console.error('Visit lookup failed:', e); 
        // Р•СЃР»Рё РЅРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕРІРµСЂРёС‚СЊ вЂ” СЃС‡РёС‚Р°РµРј РЅРѕРІС‹Рј (Р»СѓС‡С€Рµ Р»РёС€РЅРµРµ СѓРІРµРґРѕРјР»РµРЅРёРµ)
      }
    }
    
    // Р•СЃР»Рё РєР»РёРµРЅС‚ РЈР–Р• Р±С‹Р» вЂ” РЅРµ РѕС‚РїСЂР°РІР»СЏРµРј СѓРІРµРґРѕРјР»РµРЅРёРµ
    if (!isNewClient) {
      console.log(`[/start] Existing client ${userId} вЂ” no notification`);
      return res.status(200).json({ ok: true, isNew: false });
    }
    
    // Р—Р°РїСѓСЃРєР°РµРј СЂРёСЃРє-РїСЂРѕРІРµСЂРєСѓ
    const risk = await assessRisk(userId, {
      username,
      rubEquiv: 0,
      photoUrl: '',  // photo_url РЅРµ РїРµСЂРµРґР°С‘С‚СЃСЏ С‡РµСЂРµР· PuzzleBot, РїСЂРѕРІРµСЂРёРј Р±РµР· РЅРµРіРѕ
      firstSeen,
      nameChanges,
      usernameChanges,
    });
    
    console.log(`[/start] NEW client ${userId} | ${risk.summary}`);
    
    // Р•СЃР»Рё СЂРёСЃРє РќРР—РљРР™ вЂ” РЅРµ РѕС‚РїСЂР°РІР»СЏРµРј СѓРІРµРґРѕРјР»РµРЅРёРµ (РЅРѕСЂРјР°Р»СЊРЅС‹Р№ РєР»РёРµРЅС‚)
    if (risk.level === 'LOW') {
      console.log(`[/start] Low risk вЂ” no notification for ${userId}`);
      return res.status(200).json({ ok: true, isNew: true, risk: risk.summary, sent: false });
    }
    
    // Р¤РѕСЂРјРёСЂСѓРµРј СЃРѕРѕР±С‰РµРЅРёРµ РІ РіСЂСѓРїРїСѓ
    const userIdSafe = String(userId);
    const clientLink = `<a href="tg://user?id=${userIdSafe}">${firstName}</a>`;
    const usernamePart = username ? ` В· ${username}` : '';
    
    const msg = [
      `рџ‘¤ <b>РќРѕРІС‹Р№ РєР»РёРµРЅС‚ РІ Р±РѕС‚Рµ</b>`,
      `рџ“… ${nowVN()}`,
      ``,
      `<b>РРјСЏ:</b> ${clientLink}${usernamePart}`,
      `<b>ID:</b> <code>${userIdSafe}</code>`,
    ].join('\n');
    
    const riskBlock = formatRiskBlock(risk);
    const fullMsg = msg + '\n' + riskBlock;
    
    // РћС‚РїСЂР°РІР»СЏРµРј РІ General-С‚РѕРїРёРє РіСЂСѓРїРїС‹
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
