// api/_lib/rates-server.mjs
// Серверный пересчёт курса/суммы для защиты от подмены клиентом.
// Логика 1:1 портирована из index.html: getRate + applyRateLogic.
//
// Источники курсов (по приоритету):
//   1) In-memory кэш в Vercel-функции (TTL 60 сек) — самое быстрое.
//   2) Apps Script (через sheetsGet) — основной источник, fresh из таблицы.
//   3) Supabase rates_cache (persistent fallback) — если Apps Script лежит
//      и in-memory пуст (например, после cold start). Возраст ≤ 24ч.
//   4) Ничего — заявка отклоняется в order.js с 503.

import { sheetsGet } from './sheets.mjs';

const CACHE_TTL_MS = 60_000;
const FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 часа

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let _cache = null;
let _cachedAt = 0;
let _cacheSource = 'none'; // 'fresh' | 'stale-memory' | 'stale-supabase' | 'none'
let _cacheUpdatedAt = 0;   // timestamp реальной свежести данных (не кэша)

// ─── ЗАПИСЬ КУРСОВ В SUPABASE (persistent backup) ────────────
async function persistRatesToSupabase(rates) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rates_cache`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: 1,
        rates: rates,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.warn('[rates-server] persist to Supabase failed:', e.message);
  }
}

// ─── ЧТЕНИЕ КУРСОВ ИЗ SUPABASE (persistent fallback) ─────────
async function loadRatesFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rates_cache?id=eq.1&select=rates,updated_at`,
      {
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      },
    );
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return {
      rates: arr[0].rates,
      updatedAt: new Date(arr[0].updated_at).getTime(),
    };
  } catch (e) {
    console.warn('[rates-server] load from Supabase failed:', e.message);
    return null;
  }
}

// ─── ЗАГРУЗКА КУРСОВ С КАСКАДОМ ИСТОЧНИКОВ ───────────────────
// Возвращает rates-объект (или null если нигде ничего нет).
// Параллельно обновляет _cacheSource / _cacheUpdatedAt — их забирает
// getRatesStaleness() для добавления warning'а в сообщение менеджеру.
export async function getServerRates() {
  const now = Date.now();

  // 1) Свежий in-memory кэш
  if (_cache && now - _cachedAt < CACHE_TTL_MS) {
    return _cache;
  }

  // 2) Пробуем Apps Script (основной источник)
  const data = await sheetsGet();
  if (data && data.ok && data.rates) {
    _cache = data.rates;
    _cachedAt = now;
    _cacheUpdatedAt = now;
    _cacheSource = 'fresh';
    // Параллельно дублируем в Supabase для будущих cold starts
    persistRatesToSupabase(data.rates).catch(() => {});
    return _cache;
  }

  // 3) Apps Script упал — используем in-memory stale если есть
  if (_cache) {
    _cacheSource = 'stale-memory';
    console.warn('[rates-server] Apps Script unavailable — using stale in-memory cache');
    return _cache;
  }

  // 4) In-memory пуст (cold start) — пробуем Supabase
  const fallback = await loadRatesFromSupabase();
  if (fallback && fallback.rates) {
    const age = now - fallback.updatedAt;
    if (age <= FALLBACK_MAX_AGE_MS) {
      _cache = fallback.rates;
      _cachedAt = now;
      _cacheUpdatedAt = fallback.updatedAt;
      _cacheSource = 'stale-supabase';
      console.warn(`[rates-server] Apps Script unavailable — using Supabase fallback (age ${Math.floor(age/60000)} min)`);
      return _cache;
    } else {
      console.error(`[rates-server] Supabase fallback too old: ${Math.floor(age/60000)} min > 24h max`);
    }
  }

  // 5) Полная неудача
  _cacheSource = 'none';
  return null;
}

// Информация о свежести курсов — для warning'а в сообщении менеджеру.
export function getRatesStaleness() {
  return {
    source: _cacheSource,
    ageMs: _cacheUpdatedAt ? Date.now() - _cacheUpdatedAt : null,
    isFallback: _cacheSource === 'stale-supabase' || _cacheSource === 'stale-memory',
  };
}

// ─── ПОИСК КУРСА: возвращает МНОЖИТЕЛЬ (amtTo = amtFrom * multiplier) ──
// Полностью повторяет логику getRate() из index.html.
function getRateMultiplier(rates, fromKey, toKey) {
  if (!rates) return null;
  const direct = `${fromKey}_${toKey}`;
  if (rates[direct]) {
    const r = rates[direct];
    if (typeof r === 'object' && r !== null) {
      return r.op === 'div' ? 1 / Number(r.rate) : Number(r.rate);
    }
    return Number(r);
  }
  const reverse = `${toKey}_${fromKey}`;
  if (rates[reverse]) {
    const r = rates[reverse];
    if (typeof r === 'object' && r !== null) {
      return r.op === 'div' ? Number(r.rate) : 1 / Number(r.rate);
    }
    return 1 / Number(r);
  }
  return null;
}

// ─── isInverted — флипнут ли курс для отображения (как в index.html:1844-1852) ──
function isInverted(rates, fromKey, toKey) {
  const direct = `${fromKey}_${toKey}`;
  const reverse = `${toKey}_${fromKey}`;
  if (rates[direct] && typeof rates[direct] === 'object' && rates[direct].op === 'div') return true;
  if (!rates[direct] && rates[reverse] && typeof rates[reverse] === 'object' && rates[reverse].op === 'mul') return true;
  return false;
}

// ─── ОПРЕДЕЛЕНИЕ ПОЛНЫХ КЛЮЧЕЙ ПАРЫ ──────────────────────────
// Клиент шлёт упрощённые коды (RUB), а RATES использует RUB_b/RUB_c.
// Пробуем суффиксы и возвращаем первую найденную пару.
const SUFFIXES = ['_b', '', '_c'];

export function resolvePairKeys(rates, fromCode, toCode) {
  if (!rates || !fromCode || !toCode) return null;
  for (const fs of SUFFIXES) {
    for (const ts of SUFFIXES) {
      const fromKey = `${fromCode}${fs}`;
      const toKey = `${toCode}${ts}`;
      if (rates[`${fromKey}_${toKey}`] || rates[`${toKey}_${fromKey}`]) {
        return { fromKey, toKey };
      }
    }
  }
  return null;
}

// ─── VND→RUB множитель (для расчёта пенальти) ────────────────
function vndToRubMul(rates) {
  const m = getRateMultiplier(rates, 'VND_b', 'RUB_b');
  return m && isFinite(m) && m > 0 ? m : (1 / 357);
}

// ─── РУБЛЁВЫЙ ЭКВИВАЛЕНТ ─────────────────────────────────────
function getRubEquivServer(amount, fromCode, rates) {
  if (!amount || amount <= 0) return 0;
  if (fromCode === 'RUB') return amount;
  // пробуем найти пару X→RUB_b
  for (const fs of SUFFIXES) {
    const m = getRateMultiplier(rates, `${fromCode}${fs}`, 'RUB_b');
    if (m && isFinite(m) && m > 0) return amount * m;
  }
  // Фоллбэк — те же значения, что в order.js
  if (fromCode === 'USDT' || fromCode === 'USD') return amount * 80;
  if (fromCode === 'EUR') return amount * 86;
  if (fromCode === 'KZT') return amount * 0.18;
  if (fromCode === 'VND') return amount * 0.003;
  return 0;
}

// ─── ТАРИФНАЯ СЕТКА — порт applyRateLogic из index.html ──────
function applyRateLogicServer(baseRate, rubEquiv, fromKey, toKey, rates) {
  if (!rubEquiv || rubEquiv <= 0) return { rate: baseRate, note: '' };
  let rate = baseRate, note = '';

  const isGroup1 = fromKey === 'RUB_b' &&
    ['VND_b', 'VND', 'USD', 'USDT'].includes(toKey);
  const isGroup2 = ['USD', 'USDT'].includes(fromKey) &&
    ['VND_b', 'VND'].includes(toKey);

  if (rubEquiv < 15000) {
    const vr = vndToRubMul(rates);
    const penaltyRub = 70000 * vr;
    const factor = Math.max(0, 1 - penaltyRub / rubEquiv);
    rate = baseRate * factor;
  } else if (rubEquiv < 20000) {
    const vr = vndToRubMul(rates);
    const penaltyRub = 50000 * vr;
    const factor = Math.max(0, 1 - penaltyRub / rubEquiv);
    rate = baseRate * factor;
  } else if (rubEquiv < 100000) {
    // курс без изменений
  } else {
    let pct = 0;
    if (isGroup1) {
      if (rubEquiv < 300000) pct = 0.7;
      else if (rubEquiv < 800000) pct = 1.3;
      else pct = 1.65;
    } else if (isGroup2) {
      if (rubEquiv < 300000) pct = 0.45;
      else if (rubEquiv < 800000) pct = 0.65;
      else pct = 1.15;
    }
    if (pct > 0) {
      rate = baseRate * (1 + pct / 100);
      note = `↑ +${pct}%`;
    }
    if (rubEquiv >= 1200000) {
      note = (pct > 0 ? note + ' · ' : '') + '⭐ Индивидуальный';
    }
  }
  return { rate, note };
}

// Округление КУРСА для отображения — порт index.html
function roundDisplayRate(rate) {
  if (rate >= 1000) return Math.round(rate);
  if (rate >= 10) return Math.round(rate * 10) / 10;
  if (rate >= 1) return Math.round(rate * 100) / 100;
  if (rate >= 0.1) return Math.round(rate * 1000) / 1000;
  return Math.round(rate * 1000000) / 1000000;
}

// ─── ПАРСИНГ КЛИЕНТСКОЙ СТРОКИ КУРСА ─────────────────────────
// Клиент шлёт «1 USDT = 25.500 VND» или «1 USDT = 84,5 RUB».
// Русский формат: точка — разделитель тысяч, запятая — десятичный.
export function parseClientRateString(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/=\s*([\d\s.,]+)/);
  if (!m) return null;
  const num = parseFloat(
    m[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  );
  return isFinite(num) ? num : null;
}

// Форматтер по русскому стилю — точка как разделитель тысяч, запятая как
// десятичный. Совпадает с клиентским formatNum в index.html.
//   77800     → "77.800"
//   24578000  → "24.578.000"
//   10.5      → "10,5" (USDT)
function formatNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const [intPart, decPart] = String(abs).split('.');
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + (decPart ? `${withSep},${decPart}` : withSep);
}

// Округление СУММЫ по правилам валюты — порт roundAmount из index.html.
//   RUB: до 50, USDT: до 0.1, VND: до 1000, KZT: до 100, USD/EUR: до 1.
// method='Банкомат' + toCode='VND' → особое правило: до 100 000
// (банкоматы выдают только купюры по 100k VND).
function roundAmountServer(amount, currency, method) {
  if (!amount || !isFinite(amount)) return 0;
  const c = String(currency || '').replace('_b', '').replace('_c', '');
  // ATM-специфичное округление для VND
  if (method === 'Банкомат' && c === 'VND') {
    return Math.round(amount / 100000) * 100000;
  }
  if (c === 'RUB')                  return Math.round(amount / 50) * 50;
  if (c === 'USDT')                 return Math.round(amount * 10) / 10;
  if (c === 'VND')                  return Math.round(amount / 1000) * 1000;
  if (c === 'KZT')                  return Math.round(amount / 100) * 100;
  if (c === 'USD' || c === 'EUR')   return Math.round(amount);
  return Math.round(amount * 100) / 100;
}

// ─── ГЛАВНАЯ ФУНКЦИЯ ─────────────────────────────────────────
// Возвращает результат пересчёта или причину отказа.
//   method      — для method-specific округления (ATM → 100к VND).
//   clientAmtTo — сумма получения от клиента. Если в пределах 1% от
//                 серверного расчёта — доверяем клиенту (сохраняем интент:
//                 «хочу получить ровно 10М VND»). Иначе override на сервер.
export async function recalcOrder({ amtFrom, fromCode, toCode, clientRateStr, method, clientAmtTo }) {
  const rates = await getServerRates();
  if (!rates) return { verified: false, reason: 'rates_unavailable' };

  // Парсинг по русскому формату: точка — разделитель тысяч, запятая — десятичный.
  // Совпадает с Apps Script parseAmount. "77.800" → 77800, "10,5" → 10.5
  const amtFromNum = parseFloat(
    String(amtFrom || '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
  ) || 0;
  if (amtFromNum <= 0) return { verified: false, reason: 'invalid_amount' };

  const keys = resolvePairKeys(rates, fromCode, toCode);
  if (!keys) return { verified: false, reason: 'pair_not_found', amtFromNum };

  const baseMul = getRateMultiplier(rates, keys.fromKey, keys.toKey);
  if (!baseMul || !isFinite(baseMul) || baseMul <= 0) {
    return { verified: false, reason: 'rate_invalid', amtFromNum };
  }

  const rubEquiv = getRubEquivServer(amtFromNum, fromCode, rates);
  const { rate: appliedMul, note } = applyRateLogicServer(
    baseMul, rubEquiv, keys.fromKey, keys.toKey, rates
  );

  // amtTo считается всегда умножением (баз. сетка возвращает множитель)
  const serverAmtTo = amtFromNum * appliedMul;

  // Для отображения учитываем isInverted
  const inv = isInverted(rates, keys.fromKey, keys.toKey);
  let dispRate, dispFrom, dispTo;
  if (inv) {
    dispRate = 1 / appliedMul;
    dispFrom = toCode;
    dispTo = fromCode;
  } else {
    dispRate = appliedMul;
    dispFrom = fromCode;
    dispTo = toCode;
  }
  const dispRateRounded = roundDisplayRate(dispRate);
  const serverRateStr = `1 ${dispFrom} = ${formatNum(dispRateRounded)} ${dispTo}`;

  // Сравнение с тем, что прислал клиент
  const clientRateNum = parseClientRateString(clientRateStr);
  let mismatch = false;
  let mismatchPct = 0;
  if (clientRateNum && dispRateRounded > 0) {
    mismatchPct = Math.abs(clientRateNum - dispRateRounded) / dispRateRounded * 100;
    mismatch = mismatchPct > 0.5;
  }

  // Округление суммы получения по правилам целевой валюты + метода
  // (для Банкомат+VND — кратно 100к, иначе обычные правила)
  const serverAmtToRoundedBase = roundAmountServer(serverAmtTo, toCode, method);

  // Если клиент прислал свой amtTo, и он в пределах 1% от серверного
  // расчёта — доверяем клиенту. Это позволяет сохранить «красивые» суммы
  // которые юзер хотел получить (например ровно 10 000 000 VND вместо
  // server-recalculated 9 995 000 после RUB-округления). 1% — это «честная»
  // разница которая возникает из-за разной логики округления RUB до 50.
  // Атака подмены (например в 2 раза) сюда не пройдёт.
  let serverAmtToRounded = serverAmtToRoundedBase;
  let amtToTrustedClient = false;
  if (clientAmtTo) {
    const clientAmtToNum = parseFloat(
      String(clientAmtTo).replace(/\s/g, '').replace(/\./g, '').replace(',', '.')
    ) || 0;
    if (clientAmtToNum > 0 && serverAmtTo > 0) {
      const diff = Math.abs(serverAmtTo - clientAmtToNum) / serverAmtTo;
      if (diff < 0.01) {
        // Разница < 1% — клиентский расчёт нормальный, используем его
        serverAmtToRounded = clientAmtToNum;
        amtToTrustedClient = true;
      }
    }
  }

  // Информация о свежести курсов (для warning'а менеджеру при fallback'е)
  const stale = getRatesStaleness();

  return {
    verified: true,
    serverRate: dispRateRounded,
    serverRateStr,
    serverAmtTo: serverAmtToRounded,
    serverAmtToFormatted: formatNum(serverAmtToRounded),
    serverAmtFromNum: amtFromNum,
    rubEquiv,
    note,
    mismatch,
    mismatchPct: Number(mismatchPct.toFixed(2)),
    clientRateNum,
    fromKey: keys.fromKey,
    toKey: keys.toKey,
    ratesSource: stale.source,         // 'fresh' | 'stale-memory' | 'stale-supabase'
    ratesAgeMs: stale.ageMs,
    isFallback: stale.isFallback,      // true если курс не свежий
  };
}
