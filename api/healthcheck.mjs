// api/healthcheck.mjs — Тихая проверка работоспособности
//
// Переработано 06.08.2026 (борьба с шумными алертами):
//   1. Мерим пользовательский путь: «можем ли отдать клиенту курс» — через
//      getServerRates() с тем же каскадом фолбэков, что у /api/rates и
//      /api/order (Apps Script → in-memory кэш → Supabase backup).
//      Красный статус = клиент реально не получит курс, либо курс
//      старше HEALTH_MAX_RATES_AGE_MIN минут (по умолчанию 60).
//   2. Алерт не с первой неудачи: только после HEALTH_ALERT_AFTER (по
//      умолчанию 2) неудачных проверок ПОДРЯД. Счётчик — в Supabase,
//      таблица health_state (переживает перезапуски функции).
//   3. При продолжающемся сбое повторный алерт не чаще раза в
//      HEALTH_REALERT_MIN минут (по умолчанию 60).
//   4. Когда сбой закончился — одно сообщение «✅ Сервис восстановлен».
//   5. HTTP-статус ответа остаётся честным: 503 при любой неудачной
//      пробе (для истории cron-job.org), даже если алерт не отправлялся.

import { getServerRates, getRatesStaleness } from './_lib/rates-server.mjs';

const BOT_TOKEN        = process.env.BOT_TOKEN;
const GROUP_ID         = process.env.GROUP_ID;
const THREAD_ID        = process.env.THREAD_ID;
const PUZZLEBOT_TOKEN  = process.env.PUZZLEBOT_TOKEN;
const SUPPORT_USER_ID  = process.env.SUPPORT_USER_ID;

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Настройки алертов (можно переопределить env-переменными в Vercel)
const ALERT_AFTER       = parseInt(process.env.HEALTH_ALERT_AFTER || '2');       // неудач подряд до алерта
const REALERT_MIN       = parseInt(process.env.HEALTH_REALERT_MIN || '60');      // мин. пауза между повторными алертами
const MAX_RATES_AGE_MIN = parseInt(process.env.HEALTH_MAX_RATES_AGE_MIN || '60'); // допустимый возраст резервного курса

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

async function puzzleSend(userId, text, threadId) {
  if (!PUZZLEBOT_TOKEN || !userId) return { ok: false, error: 'no token or user' };
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}&method=tg.sendMessage`;
    const paramsObj = {
      chat_id: userId,
      text: text,
      parse_mode: 'HTML',
    };
    if (threadId) paramsObj.message_thread_id = threadId;
    const params = new URLSearchParams(paramsObj);
    const res = await fetch(url + '&' + params.toString());
    return res.json();
  } catch(e) {
    console.error('puzzleSend error:', e);
    return { ok: false, error: e.message };
  }
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

// ─── Рассылка алерта по всем каналам (как раньше: группа + личка) ───
async function sendAlert(msg) {
  if (GROUP_ID) {
    await tgSend(GROUP_ID, msg, THREAD_ID || null);
  }
  if (SUPPORT_USER_ID) {
    const r = await puzzleSend(SUPPORT_USER_ID, msg);
    console.log('PuzzleBot alert to support:', JSON.stringify(r));
  }
  if (GROUP_ID) {
    const r = await puzzleSend(GROUP_ID, msg, THREAD_ID || null);
    console.log('PuzzleBot alert to group/thread:', JSON.stringify(r));
  }
}

// ─── Состояние healthcheck в Supabase (таблица health_state, строка id=1) ───
// null = Supabase недоступен (не путать с «строки нет»).
async function loadHealthState() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/health_state?id=eq.1&select=fails,alert_active,failing_since,last_alert_at`,
      {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;
    if (arr.length === 0) return { fails: 0, alert_active: false, failing_since: null, last_alert_at: null };
    return arr[0];
  } catch (e) {
    console.warn('[healthcheck] load state failed:', e.message);
    return null;
  }
}

async function saveHealthState(state) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/health_state`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: 1, ...state, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn('[healthcheck] save state failed:', e.message);
  }
}

async function checkTelegram() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || 'Telegram API error' };
    return { ok: true, name: data.result.username };
  } catch(e) {
    return { ok: false, error: 'Telegram API unreachable: ' + e.message };
  }
}

// ─── Главная проба: можем ли отдать клиенту курс ────────────────────
// Идём тем же путём, что и реальные запросы (/api/rates, /api/order):
// Apps Script → stale in-memory → Supabase backup. Если хоть один
// источник дал курс не старше MAX_RATES_AGE_MIN — сервис работает,
// даже если сам Apps Script сейчас тормозит.
async function checkRates() {
  try {
    const rates = await getServerRates();
    if (!rates) {
      return { ok: false, error: 'Курсы недоступны из всех источников (Apps Script + резервные копии)' };
    }
    const st = getRatesStaleness();
    const ageMin = st.ageMs != null ? Math.floor(st.ageMs / 60000) : 0;
    if (st.isFallback && ageMin > MAX_RATES_AGE_MIN) {
      return { ok: false, error: `Apps Script недоступен, резервный курс устарел (~${ageMin} мин)`, source: st.source, ageMin };
    }
    return { ok: true, source: st.source, ageMin };
  } catch (e) {
    return { ok: false, error: 'Ошибка проверки курсов: ' + e.message };
  }
}

export default async function handler(req, res) {
  // Защита: секрет в заголовке X-Webhook-Secret (с 08.10.2026 — так он не
  // светится в истории запусков cron-job.org и журналах) или по-старому в
  // адресе ?secret=. Секрет на сервере не задан — вход закрыт для всех
  // (раньше пустой секрет пропускал запрос без ключа).
  const expected = process.env.HEALTHCHECK_SECRET;
  const secret = req.headers['x-webhook-secret'] || req.query.secret || '';
  if (!expected || secret !== expected) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const tg = await checkTelegram();
  const rates = await checkRates();

  const allOk = tg.ok && rates.ok;
  const state = await loadHealthState(); // null = Supabase недоступен
  const nowIso = new Date().toISOString();
  let alertSent = false;

  if (allOk) {
    // Сбой закончился — если алерт отправлялся, сообщаем о восстановлении.
    if (state && state.alert_active) {
      const downMin = state.failing_since
        ? Math.round((Date.now() - new Date(state.failing_since).getTime()) / 60000)
        : null;
      const msg = `✅ <b>СЕРВИС ВОССТАНОВЛЕН</b>\n\n` +
        `Курсы снова доступны.\n` +
        (downMin ? `<b>Сбой длился:</b> ~${downMin} мин\n` : ``) +
        `<b>Время:</b> ${nowVN()}`;
      await sendAlert(msg);
    }
    if (state && (state.fails > 0 || state.alert_active)) {
      await saveHealthState({ fails: 0, alert_active: false, failing_since: null, last_alert_at: state.last_alert_at });
    }
  } else {
    const fails = state ? state.fails + 1 : 1;
    const failingSince = (state && state.fails > 0 && state.failing_since) ? state.failing_since : nowIso;

    let shouldAlert;
    if (state) {
      const cooldownPassed = !state.last_alert_at ||
        (Date.now() - new Date(state.last_alert_at).getTime()) >= REALERT_MIN * 60000;
      shouldAlert = fails >= ALERT_AFTER && (!state.alert_active || cooldownPassed);
    } else {
      // Supabase (счётчик) недоступен И проба провалилась — это уже
      // серьёзно, алертим сразу, без подавления.
      shouldAlert = true;
    }

    if (shouldAlert) {
      const errors = [];
      if (!tg.ok)    errors.push(`❌ Telegram: ${tg.error}`);
      if (!rates.ok) errors.push(`❌ Курсы: ${rates.error}`);
      const failNote = state
        ? `<b>Подтверждено:</b> ${fails} проверок подряд (~${Math.max(1, Math.round((Date.now() - new Date(failingSince).getTime()) / 60000))} мин)\n`
        : `<b>Внимание:</b> Supabase тоже недоступен\n`;
      const msg = `🚨 <b>СБОЙ СЕРВИСА</b>\n\n${errors.join('\n')}\n\n` +
        failNote +
        `<b>Время:</b> ${nowVN()}\n\n` +
        `⚠️ Заявки могут не обрабатываться. Проверьте сервисы.`;
      await sendAlert(msg);
      alertSent = true;
    }

    if (state) {
      await saveHealthState({
        fails,
        alert_active: state.alert_active || alertSent,
        failing_since: failingSince,
        last_alert_at: alertSent ? nowIso : state.last_alert_at,
      });
    }
  }

  return res.status(allOk ? 200 : 503).json({
    ok: allOk,
    time: nowVN(),
    alertSent,
    checks: { telegram: tg, rates },
  });
}
