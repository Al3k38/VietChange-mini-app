// api/_lib/order-sheet.mjs — запись заявки в лист «Заявки» (Apps Script).
//
// 09.10.2026. Раньше order.js записывал заявку в таблицу последним шагом и
// ждал ответа до 8 с; ответ Google до Vercel иногда теряется (разбор 07–09.10),
// тогда заявка либо всё-таки записана (а мы не знаем), либо нет — и никто
// не узнаёт. Повторить было нельзя: старый Apps Script записал бы дубль.
//
// Теперь:
//   1. Запись начинается сразу после отправки заявки в чат менеджеров и идёт
//      параллельно с остальными шагами (сообщение клиенту, PuzzleBot).
//   2. Vercel сразу получает эту работу через waitUntil — функция не
//      выключится, пока запись не закончится (правило проекта: без waitUntil
//      работа после ответа обрывается, см. «fast-respond ненадёжен», 20.05.2026).
//   3. Первая попытка не удалась — ещё две, с паузами. Повтор безопасен:
//      Apps Script версии 2 ту же заявку второй раз не добавляет. Со старым
//      Apps Script (версия 1) или без waitUntil — без повторов. Внутри одной
//      попытки запрос уходит ровно один раз (noPostRetry).
//   4. Не вышло ни разу — сообщение в чат менеджеров ответом на заявку.

import { sheetsPost } from './sheets.mjs';

const ATTEMPTS = [
  { waitMs: 0,      timeoutMs: 8000  }, // первая — как раньше
  { waitMs: 3000,   timeoutMs: 15000 }, // дальше — обычно уже после ответа клиенту
  { waitMs: 10000,  timeoutMs: 20000 },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Контекст запроса Vercel (тот же, что читает пакет @vercel/functions).
function requestContext() {
  try {
    const holder = globalThis[Symbol.for('@vercel/request-context')];
    const ctx = holder && typeof holder.get === 'function' ? holder.get() : null;
    return ctx && typeof ctx.waitUntil === 'function' ? ctx : null;
  } catch {
    return null;
  }
}

// Передать Vercel работу, которая может закончиться после ответа клиенту.
// true — Vercel её дождётся; false — waitUntil нет, ждать надо самим.
export function keepAliveAfterResponse(promise) {
  const ctx = requestContext();
  if (!ctx) return false;
  try {
    ctx.waitUntil(Promise.resolve(promise).catch(() => {})); // вызов как метода — как в @vercel/functions
    return true;
  } catch {
    return false;
  }
}

// Запуск записи. Возвращает { first, done }:
//   first — обещание итога первой попытки (true/false);
//   done  — обещание итога всей записи { ok, attempts, duplicate } (не падает).
//   canRetry() — спрашивается после неудачной первой попытки: можно ли
//                повторять (Apps Script версии 2 + Vercel держит функцию);
//   onGiveUp(attempts) — что сделать, если не вышло ни разу.
export function startOrderSheetWrite(row, { canRetry = () => false, onGiveUp } = {}) {
  let resolveFirst;
  const first = new Promise(r => { resolveFirst = r; });

  const done = (async () => {
    let plan = ATTEMPTS.slice(0, 1);
    for (let i = 0; i < plan.length; i++) {
      if (plan[i].waitMs) await sleep(plan[i].waitMs);
      let json = null;
      try {
        json = await sheetsPost(row, { timeoutMs: plan[i].timeoutMs, noPostRetry: true });
      } catch (e) {
        console.error('[order-sheet] sheetsPost threw:', e && e.message);
      }
      const ok = !!(json && json.ok);
      if (i === 0) {
        resolveFirst(ok);
        if (!ok) {
          let retry = false;
          try { retry = !!canRetry(); } catch { retry = false; }
          if (retry) plan = ATTEMPTS;
        }
      }
      if (ok) {
        if (i > 0 || json.duplicate) {
          console.warn(`[order-sheet] ${row.orderNum}: записана с попытки ${i + 1}${json.duplicate ? ' (строка уже была — дубль не добавлен)' : ''}`);
        }
        return { ok: true, attempts: i + 1, duplicate: !!json.duplicate };
      }
      console.warn(`[order-sheet] ${row.orderNum}: попытка ${i + 1} из ${plan.length} — ${json ? 'ответ ' + JSON.stringify(json).slice(0, 150) : 'нет ответа от Google'}`);
    }
    console.error(`[order-sheet] ${row.orderNum}: НЕ подтверждена в листе «Заявки» (попыток: ${plan.length})`);
    if (onGiveUp) {
      try { await onGiveUp(plan.length); } catch (e) { console.error('[order-sheet] onGiveUp failed:', e && e.message); }
    }
    return { ok: false, attempts: plan.length, duplicate: false };
  })();

  // На случай непредвиденной ошибки внутри — first не должен висеть вечно
  done.then(() => resolveFirst(false), () => resolveFirst(false));
  return { first, done };
}
