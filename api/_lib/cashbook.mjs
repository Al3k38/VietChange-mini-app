// api/_lib/cashbook.mjs
// Отправка заявки клиента в Cashbook (приёмник /api/orders/incoming).
// Менеджер видит заявку в «Кассе» и отправляет её в топик города.
// Старый путь (копирование из технической группы) остаётся — это дополнительный канал.
//
// Правила:
//  • секрет — только в заголовке X-Orders-Secret (не в адресе и не в теле);
//  • таймаут 5 сек; 1 повтор при сбое сети / 500; на таймаут и 4xx/503 не повторяем;
//  • функция НИКОГДА не бросает исключений — сбой Cashbook не ломает заявку;
//  • секрет — переменная INCOMING_ORDERS_SECRET, то же имя и значение, что в Cashbook;
//  • нет секрета в окружении → тихо пропускаем (можно выкладывать код до настройки).

const CASHBOOK_ORDERS_URL    = process.env.CASHBOOK_ORDERS_URL
  || 'https://viet-change-cashbook.vercel.app/api/orders/incoming';
const INCOMING_ORDERS_SECRET = process.env.INCOMING_ORDERS_SECRET;

const TIMEOUT_MS = 5000;
const MAX_TEXT   = 4000;

// Теги, которые Telegram понимает в parse_mode: HTML. Убираем только их —
// обычный текст со знаком «<» не трогаем.
const TG_TAGS = /<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|span|tg-spoiler|tg-emoji|blockquote)(?:\s[^>]*)?>/gi;

// HTML-уведомление → простой текст, ровно как его видит менеджер в Telegram.
// &amp; раскрываем последним — иначе «&amp;lt;» превратится в «<».
export function htmlToPlain(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(TG_TAGS, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Текущее время во Вьетнаме в ISO со смещением: 2026-09-27T10:51:00+07:00
function nowIsoVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19) + '+07:00';
}

export async function sendOrderToCashbook({ orderNum, text, source, clientTgId, clientUsername, createdAt }) {
  if (!INCOMING_ORDERS_SECRET) {
    console.warn(`[cashbook] skip ${orderNum}: INCOMING_ORDERS_SECRET не задан`);
    return { ok: false, skipped: 'no_secret' };
  }
  if (!orderNum || !text) {
    console.warn(`[cashbook] skip: нет номера или текста (order_num=${orderNum || '—'})`);
    return { ok: false, skipped: 'no_data' };
  }

  const body = {
    order_num:  String(orderNum),
    text:       String(text).slice(0, MAX_TEXT),
    created_at: createdAt || nowIsoVN(),
  };
  if (source) body.source = source;
  const tgId = Number(clientTgId);
  if (Number.isSafeInteger(tgId) && tgId > 0) body.client_tg_id = tgId;
  const uname = String(clientUsername || '').trim();
  if (/^@?[A-Za-z0-9_]{3,32}$/.test(uname)) body.client_username = uname;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let retry = false;
    try {
      const res = await fetch(CASHBOOK_ORDERS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orders-Secret': INCOMING_ORDERS_SECRET,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        console.warn(
          `[cashbook] ${orderNum} → ${data.status}` +
          (data.parse_ok === false ? ` parse_ok=false (${data.parse_error || '—'})` : ' parse_ok=true')
        );
        return { ok: true, status: data.status, parse_ok: data.parse_ok };
      }
      const errText = (data && data.error) || '';
      if (res.status === 401) console.error(`[cashbook] ${orderNum}: 401 — секрет не совпадает с INCOMING_ORDERS_SECRET в Cashbook`);
      else if (res.status === 503) console.error(`[cashbook] ${orderNum}: 503 — приёмник Cashbook не настроен: ${errText}`);
      else console.warn(`[cashbook] ${orderNum}: HTTP ${res.status} ${errText} (попытка ${attempt}/2)`);
      // 4xx и 503 — повтор не поможет. 500 и прочие 5xx — повторяем.
      retry = res.status >= 500 && res.status !== 503;
      if (!retry) return { ok: false, http: res.status, error: errText };
    } catch (e) {
      if (e.name === 'AbortError') {
        console.warn(`[cashbook] ${orderNum}: таймаут ${TIMEOUT_MS / 1000} сек — не повторяем`);
        return { ok: false, error: 'timeout' };
      }
      console.warn(`[cashbook] ${orderNum}: сеть — ${e.message} (попытка ${attempt}/2)`);
      retry = true;
    } finally {
      clearTimeout(timer);
    }
    if (retry && attempt < 2) await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, error: 'failed' };
}
