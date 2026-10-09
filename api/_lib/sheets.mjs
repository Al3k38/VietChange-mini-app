// api/_lib/sheets.mjs
// Обёртка над всеми вызовами Apps Script. Автоматически добавляет shared secret.
// Без secret’а Apps Script doPost/doGet возвращает 403 — даже если URL утечёт,
// никто посторонний не сможет писать в листы.
//
// 08.10.2026: запрос к Apps Script — это ДВА шага:
//   1) POST на script.google.com — Google выполняет скрипт и отвечает
//      переадресацией (302) на адрес с готовым ответом;
//   2) GET по этому адресу (script.googleusercontent.com) — забираем ответ.
// Раньше оба шага делал fetch сам (redirect: 'follow'), и при сбое было не
// понять, какой из них завис. А зависает часто: скрипт отработал за 1–3 с
// (видно в «Выполнениях»), а ответ до Vercel за 8–12 с так и не дошёл.
// Теперь шаги идём сами:
//   — в журнал Vercel пишется, сколько длился каждый шаг (строка [sheets]);
//   — второй шаг при зависании повторяется: он только забирает готовый
//     ответ, скрипт второй раз НЕ выполняется, в таблицу ничего не пишется;
//   — первый шаг повторяется после таймаута только для чтения курса
//     (sheetsGet): заявку или визит повтор записал бы в таблицу дважды.

const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// Одна попытка второго шага (забрать готовый ответ) — не дольше этого.
// Нормальный второй шаг занимает доли секунды.
const GET_TRY_MS = 3000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Один шаг с таймаутом. Таймаут покрывает и заголовки, и тело ответа
// (раньше он снимался, как только приходили заголовки, и чтение тела
// могло висеть до лимита функции). При таймауте бросает AbortError.
async function fetchStep(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── POST → doPost ────────────────────────────────────────────
// Возвращает распарсенный JSON или null (при сетевой/JSON-ошибке).
// Сохраняет совместимость с прошлым контрактом «json или undefined».
//   timeoutMs  — сколько ждать всего (по умолчанию 8 с). Дольше ждёт только
//                /api/rates-refresh: его ответ не ждёт ни клиент, ни менеджер.
//   readOnly   — запрос только читает (курс): после таймаута первого шага его
//                можно отправить заново.
//   postTryMs  — сколько ждать первого шага в одной попытке (по умолчанию —
//                весь остаток времени, то есть без повтора).
//   trace      — массив: сюда же складываются шаги (для ответа rates-refresh).
//   noPostRetry — (09.10.2026) первый шаг отправлять ровно один раз, даже после
//                сетевой ошибки или ошибки Google: так пишет заявка
//                (_lib/order-sheet.mjs) — повторы она делает сама и только когда
//                Apps Script не задваивает строки. Раньше после ошибки «fetch
//                failed» (ответ оборвался, а скрипт уже записал строку) запрос
//                уходил второй раз — так в «Заявках» появлялись дубли.
export async function sheetsPost(payload, { timeoutMs = 8000, readOnly = false, postTryMs, trace, noPostRetry = false } = {}) {
  if (!APPS_SCRIPT_URL) return null;
  if (!APPS_SCRIPT_SECRET) {
    console.error('[sheets] APPS_SCRIPT_SECRET is not set — request will be rejected by Apps Script');
  }
  const what = payload.type || 'order';
  const body = JSON.stringify({ ...payload, secret: APPS_SCRIPT_SECRET });
  const started = Date.now();
  const left = () => timeoutMs - (Date.now() - started);
  const steps = [];
  const note = (s) => { steps.push(s); if (trace) trace.push(s); };
  // В журнал — только сбои и медленные ответы (нормальный ответ — 1–3 с).
  const report = (ok) => {
    const total = Date.now() - started;
    if (!ok || total > 3000) {
      const line = `[sheets] ${what}: ${ok ? 'ответ' : 'НЕТ ответа'} за ${total} мс — ${steps.join(', ')}`;
      if (ok) console.warn(line); else console.error(line);
    }
  };

  let postFailures = 0;
  while (left() > 300) {
    // ── Шаг 1: POST ──
    const t1 = Date.now();
    let step1;
    try {
      step1 = await fetchStep(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'manual',
      }, Math.min(left(), postTryMs || Infinity));
      note(`POST ${step1.status} ${Date.now() - t1}мс`);
    } catch (e) {
      const isTimeout = e.name === 'AbortError';
      note(`POST ${isTimeout ? 'таймаут' : 'ошибка «' + e.message + '»'} ${Date.now() - t1}мс`);
      postFailures++;
      if (noPostRetry) break;
      // Таймаут: скрипт запрос всё равно выполнит — повтор задвоил бы запись.
      // Курс только читается — его можно спросить ещё раз, если вызов сам
      // ограничил ожидание первого шага (postTryMs, сейчас — только rates-refresh).
      if (isTimeout && !(readOnly && postTryMs)) break;
      if (postFailures >= 3) break; // не больше трёх POST за вызов
      if (postFailures >= 2 && !isTimeout) break;
      if (!isTimeout) await sleep(500);
      continue;
    }

    // Ответ без переадресации (так бывает при ошибке доступа) — разбираем как есть.
    if (step1.status < 300 || step1.status >= 400) {
      if (step1.status >= 200 && step1.status < 300) {
        const json = parseJson(step1.text);
        report(json !== null);
        return json;
      }
      // Ошибка Google (500, 429…) — скрипт не выполнялся, можно повторить один раз.
      postFailures++;
      if (noPostRetry || postFailures >= 2) break;
      await sleep(500);
      continue;
    }
    if (!step1.location) {
      note('нет адреса переадресации');
      break;
    }

    // ── Шаг 2: GET готового ответа (повторять безопасно, до 3 попыток) ──
    for (let getTry = 1; getTry <= 3 && left() > 300; getTry++) {
      const t2 = Date.now();
      try {
        const step2 = await fetchStep(step1.location, { method: 'GET', redirect: 'follow' },
          Math.min(left(), GET_TRY_MS));
        note(`GET ${step2.status} ${Date.now() - t2}мс`);
        if (step2.status >= 200 && step2.status < 300) {
          const json = parseJson(step2.text);
          report(json !== null);
          return json;
        }
        await sleep(300); // ошибка Google (500, 429…) — короткая пауза перед повтором
      } catch (e) {
        note(`GET ${e.name === 'AbortError' ? 'таймаут' : 'ошибка «' + e.message + '»'} ${Date.now() - t2}мс`);
      }
    }
    break; // готовый ответ так и не забрали — новый POST не шлём (задвоил бы запись)
  }

  report(false);
  return null;
}

// ─── Получение курсов (для /api/rates и серверного recalcOrder) ───
// Раньше делал GET с секретом в URL (?secret=...) — секрет светился
// в Apps Script execution logs. Теперь идём через doPost с секретом
// в body, как все остальные методы. Курс только читается — readOnly.
export async function sheetsGet(options = {}) {
  return sheetsPost({ type: 'get_rates' }, { ...options, readOnly: true });
}
