// api/bot-to-cashbook.js
// Копия заявки из чат-бота PuzzleBot в Cashbook (менеджер видит её в «Кассе»).
// PuzzleBot зовёт эту функцию действием «Отправить запрос» ПОСЛЕ уведомления
// в техническую группу. Секрет Cashbook хранится только здесь, в Vercel.
//
// Вход — любой из вариантов:
//  A) Content-Type: text/plain — тело = текст уведомления как есть (многострочный),
//     номер и клиент — в адресе: ?order_num=...&user_id=...&username=...
//  B) JSON или форма: { "order_num": "...", "text": "...", "user_id": ..., "username": "..." }
// Если номер не передан или не похож на номер — берём его из текста («Заявка №…»).
// Авторизация — тот же токен, что у /api/risk-on-start: ?token=... или Authorization: Bearer ...

import { sendOrderToCashbook, htmlToPlain } from './_lib/cashbook.mjs';

const RISK_CHECK_SECRET = process.env.RISK_CHECK_SECRET;

// 20260927-123456 (Mini App) или 20260927-B267417 (чат-бот)
const ORDER_NUM_RE         = /^\d{8}-B?\d{4,}$/;
const ORDER_NUM_IN_TEXT_RE = /№\s*(\d{8}-B?\d{4,})/;

// Первое непустое значение из объекта по списку ключей
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const authHeader  = req.headers['authorization'] || '';
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token       = headerToken || (req.query && req.query.token) || '';
  if (!RISK_CHECK_SECRET || !token || token !== RISK_CHECK_SECRET) {
    console.warn('[bot-to-cashbook] FORBIDDEN — token mismatch or missing');
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const ct = String(req.headers['content-type'] || '—');

  try {
    // Vercel бросает ошибку при чтении req.body, если JSON битый
    // (например, в строку попали настоящие переносы строк).
    let body;
    try {
      body = req.body;
    } catch (e) {
      console.warn(`[bot-to-cashbook] body unreadable ct=${ct}: ${e.message}`);
      return res.status(400).json({
        ok: false,
        error: 'Тело не читается. Для многострочного текста поставьте Content-Type: text/plain и шлите текст как есть.',
      });
    }
    if (Buffer.isBuffer(body)) body = body.toString('utf8');

    let fields = {};
    let text   = '';
    if (typeof body === 'string') {
      // text/plain: тело — сам текст уведомления. Если прислали JSON строкой — разбираем.
      let parsed = null;
      if (body.trim().startsWith('{')) {
        try { parsed = JSON.parse(body); } catch { /* не JSON — значит это текст */ }
      }
      if (parsed && typeof parsed === 'object') {
        fields = parsed;
        text   = pick(fields, 'text');
      } else {
        text = body;
      }
    } else if (body && typeof body === 'object') {
      fields = body;
      text   = pick(fields, 'text');
    } else {
      console.warn(`[bot-to-cashbook] empty/unsupported body ct=${ct}`);
      return res.status(400).json({
        ok: false,
        error: `Пустое тело или неподдерживаемый Content-Type (${ct}). Используйте text/plain или application/json.`,
      });
    }

    text = htmlToPlain(text).trim();
    if (!text) {
      console.warn(`[bot-to-cashbook] no text ct=${ct}`);
      return res.status(400).json({ ok: false, error: 'Нет текста заявки' });
    }

    const q = req.query || {};
    let orderNum   = pick(fields, 'order_num', 'orderNum') || pick(q, 'order_num', 'orderNum');
    const userId   = pick(fields, 'user_id', 'userId', 'client_tg_id') || pick(q, 'user_id', 'userId', 'client_tg_id');
    const username = pick(fields, 'username', 'client_username') || pick(q, 'username', 'client_username');

    if (!ORDER_NUM_RE.test(orderNum)) {
      const m = text.match(ORDER_NUM_IN_TEXT_RE);
      if (m) {
        if (orderNum) console.warn(`[bot-to-cashbook] order_num "${orderNum}" не похож на номер — беру из текста ${m[1]}`);
        orderNum = m[1];
      } else {
        console.warn(`[bot-to-cashbook] no order_num (param="${orderNum}") user=${userId || '—'}`);
        return res.status(400).json({ ok: false, error: 'Нет номера заявки ни в параметрах, ни в тексте' });
      }
    }

    const result = await sendOrderToCashbook({
      orderNum,
      text,
      source: 'puzzlebot',
      clientTgId: userId,
      clientUsername: username,
    });
    // lines=1 при длинном тексте → PuzzleBot склеил переносы строк
    console.warn(
      `[bot-to-cashbook] order_num=${orderNum} user=${userId || '—'} ct=${ct} ` +
      `len=${text.length} lines=${text.split('\n').length} → ${JSON.stringify(result)}`
    );
    return res.status(200).json({ ok: result.ok, order_num: orderNum, cashbook: result });

  } catch (e) {
    console.error('[bot-to-cashbook] error:', e);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: 'internal' });
  }
}
