// api/_lib/blacklist.mjs
// Multi-identifier blacklist через Supabase. Менеджер может банить клиентов
// по: Telegram User ID, телефону, USDT-адресу, банковской карте.
//
// Setup (один раз в Supabase SQL Editor):
//
//   CREATE TABLE IF NOT EXISTS blacklist (
//     id BIGSERIAL PRIMARY KEY,
//     identifier_type TEXT NOT NULL
//       CHECK (identifier_type IN ('user_id', 'phone', 'usdt', 'card')),
//     identifier_value TEXT NOT NULL,
//     reason TEXT,
//     added_by BIGINT,
//     created_at TIMESTAMPTZ DEFAULT NOW(),
//     UNIQUE (identifier_type, identifier_value)
//   );
//   CREATE INDEX idx_blacklist_lookup ON blacklist (identifier_type, identifier_value);
//   ALTER TABLE blacklist DISABLE ROW LEVEL SECURITY;
//   GRANT ALL ON blacklist TO service_role;
//   GRANT USAGE ON SEQUENCE blacklist_id_seq TO service_role;
//
//   CREATE OR REPLACE FUNCTION blacklist_check(
//     p_user_id TEXT DEFAULT NULL,
//     p_phone   TEXT DEFAULT NULL,
//     p_usdt    TEXT DEFAULT NULL,
//     p_card    TEXT DEFAULT NULL
//   )
//   RETURNS TABLE(matched_type TEXT, matched_value TEXT, reason TEXT)
//   LANGUAGE plpgsql SECURITY DEFINER
//   AS $$
//   BEGIN
//     RETURN QUERY
//       SELECT b.identifier_type, b.identifier_value, b.reason
//       FROM blacklist b
//       WHERE
//         (p_user_id IS NOT NULL AND b.identifier_type = 'user_id' AND b.identifier_value = p_user_id)
//         OR (p_phone IS NOT NULL AND b.identifier_type = 'phone' AND b.identifier_value = p_phone)
//         OR (p_usdt IS NOT NULL AND b.identifier_type = 'usdt' AND b.identifier_value = p_usdt)
//         OR (p_card IS NOT NULL AND b.identifier_type = 'card' AND b.identifier_value = p_card)
//       LIMIT 1;
//   END;
//   $$;
//   GRANT EXECUTE ON FUNCTION blacklist_check(TEXT, TEXT, TEXT, TEXT) TO service_role;

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PUZZLEBOT_TOKEN      = process.env.PUZZLEBOT_TOKEN;
const BOT_TOKEN            = process.env.BOT_TOKEN;

// Bot's numeric Telegram ID — для PuzzleBot tg_chat_id в приватных чатах
// (док: «Telegram id of chat, bot id for private»).
// Telegram-токен формата "<bot_id>:<hash>", извлекаем до двоеточия.
const BOT_ID = BOT_TOKEN ? BOT_TOKEN.split(':')[0] : null;

// Дата до которой действует ban (timestamp). 2099-01-01.
const FAR_FUTURE_TS = 4070908800;

const ALLOWED_TYPES = ['user_id', 'phone', 'usdt', 'card'];

// ─── PuzzleBot userBan / userUnban ───────────────────────────
// Полный блок: PuzzleBot перестаёт реагировать на сообщения от user_id.
// Метод применяется ТОЛЬКО к типу user_id (для phone/card/usdt нет смысла).
async function puzzleBanUser(userId) {
  if (!PUZZLEBOT_TOKEN || !BOT_ID || !userId) {
    return { ok: false, error: 'PUZZLEBOT_TOKEN/BOT_TOKEN/userId missing' };
  }
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}`
      + `&method=userBan`
      + `&tg_chat_id=${encodeURIComponent(BOT_ID)}`
      + `&user_id=${encodeURIComponent(userId)}`
      + `&until_date=${FAR_FUTURE_TS}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data.code === 0) {
      console.warn(`[blacklist] PuzzleBot userBan OK user=${userId}`);
      return { ok: true };
    }
    console.warn(`[blacklist] PuzzleBot userBan failed user=${userId}:`, data);
    return { ok: false, error: `PuzzleBot code=${data.code}` };
  } catch (e) {
    console.error('[blacklist] PuzzleBot userBan error:', e.message);
    return { ok: false, error: e.message };
  }
}

async function puzzleUnbanUser(userId) {
  if (!PUZZLEBOT_TOKEN || !BOT_ID || !userId) {
    return { ok: false, error: 'PUZZLEBOT_TOKEN/BOT_TOKEN/userId missing' };
  }
  try {
    const url = `https://api.puzzlebot.top/?token=${PUZZLEBOT_TOKEN}`
      + `&method=userUnban`
      + `&tg_chat_id=${encodeURIComponent(BOT_ID)}`
      + `&user_id=${encodeURIComponent(userId)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data.code === 0) {
      console.warn(`[blacklist] PuzzleBot userUnban OK user=${userId}`);
      return { ok: true };
    }
    console.warn(`[blacklist] PuzzleBot userUnban failed user=${userId}:`, data);
    return { ok: false, error: `PuzzleBot code=${data.code}` };
  } catch (e) {
    console.error('[blacklist] PuzzleBot userUnban error:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── НОРМАЛИЗАЦИЯ ИДЕНТИФИКАТОРОВ ─────────────────────────────
// Чтобы «+7 (999) 123-45-67» и «79991234567» матчились как одно.
export function normalizePhone(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, '');
  return d.length >= 10 ? d : null;
}
export function normalizeCard(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, '');
  return d.length >= 12 ? d : null;
}
export function normalizeUsdt(s) {
  if (!s) return null;
  return String(s).trim();
}
export function normalizeUserId(s) {
  if (s === null || s === undefined) return null;
  const d = String(s).replace(/\D/g, '');
  return d || null;
}

// ─── ПРОВЕРКА ЗАЯВКИ ПРОТИВ BLACKLIST ────────────────────────
// Возвращает { type, value, reason } если найдено совпадение,
// или null. При недоступности Supabase — null (fail-open для blacklist'а:
// лучше пропустить, чем заблокировать легитимного клиента).
export async function checkBlacklist({ userId, phone, usdt, card }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const body = {
    p_user_id: userId ? normalizeUserId(userId) : null,
    p_phone:   phone ? normalizePhone(phone) : null,
    p_usdt:    usdt  ? normalizeUsdt(usdt)  : null,
    p_card:    card  ? normalizeCard(card)  : null,
  };
  if (!body.p_user_id && !body.p_phone && !body.p_usdt && !body.p_card) {
    return null;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/blacklist_check`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let txt = ''; try { txt = await res.text(); } catch {}
      console.warn(`[blacklist] non-OK status=${res.status} body=${txt}`);
      return null;
    }
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length > 0) {
      return {
        type:   arr[0].matched_type,
        value:  arr[0].matched_value,
        reason: arr[0].reason || '',
      };
    }
    return null;
  } catch (e) {
    console.error('[blacklist] check error:', e.message);
    return null;
  }
}

// ─── ДОБАВЛЕНИЕ В BLACKLIST ──────────────────────────────────
// Используется из admin-webhook (/blacklist add ...).
// Возвращает { ok: true } или { ok: false, error: '...' }.
export async function addToBlacklist({ type, value, reason, addedBy }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: 'Supabase не сконфигурирован' };
  }
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, error: `Неверный тип. Допустимы: ${ALLOWED_TYPES.join(', ')}` };
  }
  let normalizedValue = value;
  if (type === 'user_id') normalizedValue = normalizeUserId(value);
  else if (type === 'phone') normalizedValue = normalizePhone(value);
  else if (type === 'card')  normalizedValue = normalizeCard(value);
  else if (type === 'usdt')  normalizedValue = normalizeUsdt(value);
  if (!normalizedValue) return { ok: false, error: 'Значение пустое или невалидное после нормализации' };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/blacklist`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal,resolution=ignore-duplicates',
      },
      body: JSON.stringify({
        identifier_type:  type,
        identifier_value: normalizedValue,
        reason:           reason || null,
        added_by:         addedBy ? Number(addedBy) : null,
      }),
    });
    if (res.status === 201 || res.status === 204 || res.status === 200) {
      // Доп. шаг: если тип user_id — забаним в PuzzleBot тоже.
      let puzzle = null;
      if (type === 'user_id') {
        puzzle = await puzzleBanUser(normalizedValue);
      }
      return { ok: true, normalizedValue, puzzle };
    }
    if (res.status === 409) {
      // Уже в Supabase — на всякий случай ещё раз попробуем PuzzleBot
      // (если ранее по какой-то причине userBan не сработал).
      let puzzle = null;
      if (type === 'user_id') {
        puzzle = await puzzleBanUser(normalizedValue);
      }
      return { ok: false, error: 'Уже в чёрном списке', puzzle };
    }
    let txt = ''; try { txt = await res.text(); } catch {}
    return { ok: false, error: `Supabase status=${res.status} body=${txt}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── УДАЛЕНИЕ ИЗ BLACKLIST ───────────────────────────────────
export async function removeFromBlacklist({ type, value }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { ok: false, error: 'Supabase не сконфигурирован' };
  }
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, error: `Неверный тип. Допустимы: ${ALLOWED_TYPES.join(', ')}` };
  }
  let normalizedValue = value;
  if (type === 'user_id') normalizedValue = normalizeUserId(value);
  else if (type === 'phone') normalizedValue = normalizePhone(value);
  else if (type === 'card')  normalizedValue = normalizeCard(value);
  else if (type === 'usdt')  normalizedValue = normalizeUsdt(value);
  if (!normalizedValue) return { ok: false, error: 'Значение пустое или невалидное после нормализации' };

  try {
    const url = `${SUPABASE_URL}/rest/v1/blacklist`
      + `?identifier_type=eq.${encodeURIComponent(type)}`
      + `&identifier_value=eq.${encodeURIComponent(normalizedValue)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer':        'return=minimal',
      },
    });
    if (res.status === 204 || res.status === 200) {
      // Доп. шаг: если тип user_id — разбаним в PuzzleBot.
      let puzzle = null;
      if (type === 'user_id') {
        puzzle = await puzzleUnbanUser(normalizedValue);
      }
      return { ok: true, normalizedValue, puzzle };
    }
    let txt = ''; try { txt = await res.text(); } catch {}
    return { ok: false, error: `Supabase status=${res.status} body=${txt}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── СПИСОК ЗАПИСЕЙ ─────────────────────────────────────────
export async function listBlacklist() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/blacklist?select=*&order=created_at.desc&limit=100`,
      {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[blacklist] list error:', e.message);
    return [];
  }
}
