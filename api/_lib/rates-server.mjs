// api/_lib/rates-server.mjs
// Серверный пересчёт курса/суммы для защиты от подмены клиентом.
// Логика 1:1 портирована из index.html: getRate + applyRateLogic.

import { sheetsGet } from './sheets.mjs';

const CACHE_TTL_MS = 60_000;

let _cache = null;
let _cachedAt = 0;

// ─── ЗАГРУЗКА КУРСОВ С КЭШИРОВАНИЕМ ──────────────────────────
export async function getServerRates() {
  const now = Date.now();
  if (_cache && now - _cachedAt < CACHE_TTL_MS) return _cache;
  const data = await sheetsGet();
  if (data && data.ok && data.rates) {
    _cache = data.rates;
    _cachedAt = now;
  }
  return _cache;
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
// Клиент шлёт «1 RUB = 315 VND» или «1 RUB = 315.5 VND».
export function parseClientRateString(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/=\s*([\d\s.,]+)/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
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
function roundAmountServer(amount, currency) {
  if (!amount || !isFinite(amount)) return 0;
  const c = String(currency || '').replace('_b', '').replace('_c', '');
  if (c === 'RUB')                  return Math.round(amount / 50) * 50;
  if (c === 'USDT')                 return Math.round(amount * 10) / 10;
  if (c === 'VND')                  return Math.round(amount / 1000) * 1000;
  if (c === 'KZT')                  return Math.round(amount / 100) * 100;
  if (c === 'USD' || c === 'EUR')   return Math.round(amount);
  return Math.round(amount * 100) / 100;
}

// ─── ГЛАВНАЯ ФУНКЦИЯ ─────────────────────────────────────────
// Возвращает результат пересчёта или причину отказа.
export async function recalcOrder({ amtFrom, fromCode, toCode, clientRateStr }) {
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

  // Округление суммы получения по правилам целевой валюты
  const serverAmtToRounded = roundAmountServer(serverAmtTo, toCode);

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
  };
}
