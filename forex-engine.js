// ============================================================
// FOREX SIGNAL ENGINE V6.7
// GOLD QUALITY — XAU/USD
// 15M + 1H
//
// V6.7 (over V6.6):
// - Cron trigger (scheduled handler): auto Telegram signals + news
// - KV dedupe for signals and news (falls back to memory)
// - ADX slope filter (trend strength must be rising)
// - 1H confirmation: ADX + DI + MACD
// - Anti-exhaustion filter (distance from EMA20)
// - Session filter (London + New York)
// - Stricter score / lead thresholds
//
// Cloudflare Worker
//
// REQUIRED SECRETS:
//   TWELVE_DATA_API_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//
// OPTIONAL BINDING:
//   KV   (Workers KV namespace, recommended for dedupe)
//
// wrangler.toml:
//   [triggers]
//   crons = ["*/15 * * * *"]
//
//   [[kv_namespaces]]
//   binding = "KV"
//   id = "YOUR_KV_ID"
// ============================================================


const CONFIG = {

  VERSION: "V6.7",

  SYMBOL: "XAU/USD",

  INTERVAL_FAST: "15min",
  INTERVAL_SLOW: "1h",

  OUTPUT_SIZE_FAST: 150,
  OUTPUT_SIZE_SLOW: 150,

  // ----------------------------------------------------------
  // QUALITY FILTERS
  // ----------------------------------------------------------

  MIN_SCORE: 90,
  MIN_DIRECTION_LEAD: 45,

  MIN_ADX: 23,
  MIN_ADX_SLOPE: 0.5,
  MIN_SLOW_ADX: 20,

  MIN_DI_SPREAD: 6,
  MIN_MOMENTUM: 0.03,
  MIN_RR: 1.30,

  MAX_EMA20_DISTANCE_ATR: 1.8,

  // ----------------------------------------------------------
  // SESSION (UTC hours) — London open to New York close
  // ----------------------------------------------------------

  SESSION_FILTER_ENABLED: true,
  SESSION_START_UTC: 7,
  SESSION_END_UTC: 20,

  // ----------------------------------------------------------
  // ATR RISK
  // ----------------------------------------------------------

  ATR_SL_MULTIPLIER: 1.20,
  ATR_ENTRY_MULTIPLIER: 0.55,

  MAX_ENTRY_DISTANCE_ATR: 1.20,
  MAX_ENTRY_DISTANCE_PERCENT: 0.55,
  MIN_ENTRY_DISTANCE_ATR: 0.08,

  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  BULL_RSI_MIN: 53,
  BULL_RSI_MAX: 67,
  BEAR_RSI_MIN: 33,
  BEAR_RSI_MAX: 47,

  // ----------------------------------------------------------
  // NEWS
  // ----------------------------------------------------------

  NEWS_FILTER_ENABLED: true,
  NEWS_BEFORE_MINUTES: 45,
  NEWS_AFTER_MINUTES: 30,
  NEWS_ALERT_BEFORE_MINUTES: 30,
  NEWS_FETCH_TIMEOUT_MS: 10000,
  NEWS_FEED_URL: "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  NEWS_FAIL_CLOSED: true,
  NEWS_CACHE_SECONDS: 900,
  NEWS_LOOKAHEAD_HOURS: 48,

  // ----------------------------------------------------------
  // TELEGRAM
  // ----------------------------------------------------------

  TELEGRAM_ENABLED: true,
  TELEGRAM_SIGNAL_ENABLED: true,
  TELEGRAM_NEWS_ENABLED: true,
  TELEGRAM_NEWS_FOOTER: "عبدالحکیم داودی | ترید عالی",

  // ----------------------------------------------------------
  // KV
  // ----------------------------------------------------------

  SIGNAL_DEDUPE_TTL_SECONDS: 6 * 60 * 60,
  NEWS_DEDUPE_TTL_SECONDS: 24 * 60 * 60,

  // ----------------------------------------------------------
  // API
  // ----------------------------------------------------------

  API_TIMEOUT_MS: 15000,
  PRICE_DECIMALS: 2

};


// ============================================================
// MEMORY (fallback when KV is not bound)
// ============================================================

let memoryNewsCache = null;
let memoryNewsCacheTime = 0;
const memorySentNews = new Set();
let memoryLastSignalKey = "";


// ============================================================
// HELPERS
// ============================================================

function getEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// KV DEDUPE
// ============================================================

async function alreadySent(env, key) {
  if (env.KV) {
    const v = await env.KV.get(key);
    return v !== null;
  }
  return key.startsWith("news:")
    ? memorySentNews.has(key)
    : memoryLastSignalKey === key;
}

async function markSent(env, key, ttl) {
  if (env.KV) {
    await env.KV.put(key, "1", { expirationTtl: ttl });
    return;
  }
  if (key.startsWith("news:")) {
    memorySentNews.add(key);
    if (memorySentNews.size > 100) {
      memorySentNews.delete(memorySentNews.values().next().value);
    }
  } else {
    memoryLastSignalKey = key;
  }
}


// ============================================================
// TWELVE DATA
// ============================================================

async function getTimeSeries(env, interval, outputSize) {

  const apiKey = getEnv(env, ["TWELVE_DATA_API_KEY"]);

  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" + encodeURIComponent(CONFIG.SYMBOL) +
    "&interval=" + encodeURIComponent(interval) +
    "&outputsize=" + encodeURIComponent(outputSize) +
    "&format=JSON" +
    "&apikey=" + encodeURIComponent(apiKey);

  const response = await fetchWithTimeout(
    url,
    { headers: { "Accept": "application/json" } },
    CONFIG.API_TIMEOUT_MS
  );

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Twelve Data returned invalid JSON");
  }

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  if (data.status === "error" || data.code) {
    throw new Error(data.message || `Twelve Data error ${data.code || ""}`);
  }

  if (!Array.isArray(data.values) || data.values.length < 60) {
    throw new Error("Not enough Twelve Data candles");
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume)
    }))
    .filter(c => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .reverse();
}


// ============================================================
// INDICATORS
// ============================================================

function ema(values, period) {

  if (values.length < period) return [];

  const result = [];
  const multiplier = 2 / (period + 1);
  let previous = 0;

  for (let i = 0; i < values.length; i++) {

    const value = num(values[i]);

    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += num(values[j]);
      previous = sum / period;
      result.push(previous);
    } else if (i >= period) {
      previous = (value - previous) * multiplier + previous;
      result.push(previous);
    }
  }

  return result;
}


function rsi(values, period = 14) {

  if (values.length <= period) return [];

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  const result = [];

  const calculate = () => {
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };

  result.push(calculate());

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result.push(calculate());
  }

  return result;
}


function atr(candles, period = 14) {

  if (candles.length <= period) return [];

  const trs = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
      continue;
    }
    const cur = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];

  let previous = sum / period;
  const result = [previous];

  for (let i = period; i < trs.length; i++) {
    previous = (previous * (period - 1) + trs[i]) / period;
    result.push(previous);
  }

  return result;
}


function macd(values) {

  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);

  if (!ema12.length || !ema26.length) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const offset = ema12.length - ema26.length;
  const macdLine = [];

  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }

  const signalLine = ema(macdLine, 9);

  if (!signalLine.length) {
    const last = macdLine[macdLine.length - 1] || 0;
    return { macd: last, signal: 0, histogram: 0 };
  }

  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal
  };
}


function adxDetails(candles, period = 14) {

  const empty = { adx: 0, plusDI: 0, minusDI: 0, spread: 0 };

  if (candles.length <= period + 2) return empty;

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {

    const cur = candles[i];
    const prev = candles[i - 1];

    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    tr.push(Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    ));
  }

  if (tr.length < period) return empty;

  let atrValue = 0;
  let plus = 0;
  let minus = 0;

  for (let i = 0; i < period; i++) {
    atrValue += tr[i];
    plus += plusDM[i];
    minus += minusDM[i];
  }

  atrValue /= period;
  plus /= period;
  minus /= period;

  const dxValues = [];
  let latestPlusDI = 0;
  let latestMinusDI = 0;

  for (let i = period; i < tr.length; i++) {

    atrValue = (atrValue * (period - 1) + tr[i]) / period;
    plus = (plus * (period - 1) + plusDM[i]) / period;
    minus = (minus * (period - 1) + minusDM[i]) / period;

    latestPlusDI = atrValue === 0 ? 0 : 100 * plus / atrValue;
    latestMinusDI = atrValue === 0 ? 0 : 100 * minus / atrValue;

    const denominator = latestPlusDI + latestMinusDI;

    dxValues.push(
      denominator === 0
        ? 0
        : 100 * Math.abs(latestPlusDI - latestMinusDI) / denominator
    );
  }

  const spread = Math.abs(latestPlusDI - latestMinusDI);

  if (dxValues.length < period) {
    return {
      adx: dxValues[dxValues.length - 1] || 0,
      plusDI: latestPlusDI,
      minusDI: latestMinusDI,
      spread
    };
  }

  let adxValue = 0;
  for (let i = 0; i < period; i++) adxValue += dxValues[i];
  adxValue /= period;

  for (let i = period; i < dxValues.length; i++) {
    adxValue = (adxValue * (period - 1) + dxValues[i]) / period;
  }

  return {
    adx: adxValue,
    plusDI: latestPlusDI,
    minusDI: latestMinusDI,
    spread
  };
}


function momentum(values, period = 10) {
  if (values.length <= period) return 0;
  const current = values[values.length - 1];
  const previous = values[values.length - 1 - period];
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}


// ============================================================
// TREND / STRUCTURE / CANDLE
// ============================================================

function analyzeTrend(candles) {

  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);

  if (e20.length < 2 || e50.length < 2) return "NEUTRAL";

  const last = closes[closes.length - 1];
  const ema20 = e20[e20.length - 1];
  const ema50 = e50[e50.length - 1];
  const ema20Slope = ema20 - e20[e20.length - 2];
  const ema50Slope = ema50 - e50[e50.length - 2];

  if (last > ema20 && ema20 > ema50 && ema20Slope > 0 && ema50Slope >= 0) {
    return "BULLISH";
  }

  if (last < ema20 && ema20 < ema50 && ema20Slope < 0 && ema50Slope <= 0) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


function structureSignal(candles) {

  if (candles.length < 20) return "NEUTRAL";

  const recent = candles.slice(-6);
  const previous = candles.slice(-12, -6);

  const recentHigh = Math.max(...recent.map(c => c.high));
  const previousHigh = Math.max(...previous.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));
  const previousLow = Math.min(...previous.map(c => c.low));

  if (recentHigh > previousHigh && recentLow > previousLow) return "BULLISH";
  if (recentHigh < previousHigh && recentLow < previousLow) return "BEARISH";

  return "NEUTRAL";
}


function candleQuality(candles) {

  if (!candles.length) {
    return { bullish: false, bearish: false, bodyRatio: 0 };
  }

  const c = candles[candles.length - 1];
  const range = c.high - c.low;

  if (range <= 0) {
    return { bullish: false, bearish: false, bodyRatio: 0 };
  }

  const bodyRatio = Math.abs(c.close - c.open) / range;

  return {
    bullish: c.close > c.open && bodyRatio >= 0.45,
    bearish: c.close < c.open && bodyRatio >= 0.45,
    bodyRatio
  };
}


// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function analyzeTimeframe(candles) {

  const closes = candles.map(c => c.close);

  const trend = analyzeTrend(candles);
  const structure = structureSignal(candles);

  const rsiValues = rsi(closes, 14);
  const rsi14 = rsiValues[rsiValues.length - 1] || 50;
  const previousRSI = rsiValues.length >= 2
    ? rsiValues[rsiValues.length - 2]
    : rsi14;

  const macdData = macd(closes);

  const atrValues = atr(candles, 14);
  const atr14 = atrValues[atrValues.length - 1] || 0;

  const adxData = adxDetails(candles, 14);

  // ADX slope: compare with ADX computed 3 candles ago
  const adxPrev = adxDetails(candles.slice(0, -3), 14).adx;
  const adxSlope = adxData.adx - adxPrev;

  // Distance from EMA20 in ATR units (anti-exhaustion)
  const e20 = ema(closes, 20);
  const ema20Last = e20[e20.length - 1] || closes[closes.length - 1];
  const emaDistanceATR = atr14 > 0
    ? Math.abs(closes[closes.length - 1] - ema20Last) / atr14
    : 0;

  const mom = momentum(closes, 10);
  const candle = candleQuality(candles);

  return {
    trend,
    structure,
    rsi14,
    previousRSI,
    macd: macdData.macd,
    macdSignal: macdData.signal,
    macdHistogram: macdData.histogram,
    atr14,
    adx14: adxData.adx,
    adxSlope,
    plusDI: adxData.plusDI,
    minusDI: adxData.minusDI,
    diSpread: adxData.spread,
    emaDistanceATR,
    momentum: mom,
    candleBodyRatio: candle.bodyRatio,
    candleBullish: candle.bullish,
    candleBearish: candle.bearish
  };
}


// ============================================================
// NEWS
// ============================================================

function normalizeNewsCurrency(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (
    s === "USD" || s === "US DOLLAR" || s === "UNITED STATES" ||
    s === "UNITED STATES DOLLAR" || s === "USA"
  ) return "USD";
  return s;
}

function normalizeNewsImpact(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "high" || s.includes("high") || s === "3") return "High";
  if (s === "medium" || s === "med" || s.includes("medium") || s === "2") return "Medium";
  if (s === "low" || s.includes("low") || s === "1") return "Low";
  return "";
}

function parseNewsTimestamp(item) {

  if (item.timestamp !== undefined && item.timestamp !== null && item.timestamp !== "") {
    const numeric = Number(item.timestamp);
    if (Number.isFinite(numeric)) {
      return numeric < 10000000000 ? numeric * 1000 : numeric;
    }
  }

  for (const value of [item.date, item.datetime, item.datetime_utc, item.time]) {
    if (!value) continue;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function normalizeNewsEvents(data) {

  const source = Array.isArray(data)
    ? data
    : Array.isArray(data?.events) ? data.events : [];

  return source
    .map(item => ({
      title: String(item.title || item.event || item.name || "USD News"),
      country: normalizeNewsCurrency(item.country || item.currency || item.curr),
      impact: normalizeNewsImpact(item.impact || item.importance),
      timestamp: parseNewsTimestamp(item),
      forecast: item.forecast ?? "",
      previous: item.previous ?? ""
    }))
    .filter(item =>
      item.country === "USD" &&
      item.impact === "High" &&
      Number.isFinite(item.timestamp)
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function getLiveNews() {

  const now = Date.now();

  if (
    memoryNewsCache &&
    now - memoryNewsCacheTime < CONFIG.NEWS_CACHE_SECONDS * 1000
  ) {
    return memoryNewsCache;
  }

  const started = Date.now();

  try {

    const response = await fetchWithTimeout(
      CONFIG.NEWS_FEED_URL,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 HakimGoldSignals/6.7"
        }
      },
      CONFIG.NEWS_FETCH_TIMEOUT_MS
    );

    const fetchMs = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`News HTTP ${response.status}`);
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("News feed returned invalid JSON");
    }

    const rawEvents = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.events) ? raw.events : [];

    const events = normalizeNewsEvents(raw);

    const usdEvents = rawEvents.filter(item =>
      normalizeNewsCurrency(item.country || item.currency || item.curr) === "USD"
    );

    const beforeMs = CONFIG.NEWS_BEFORE_MINUTES * 60 * 1000;
    const afterMs = CONFIG.NEWS_AFTER_MINUTES * 60 * 1000;
    const lookaheadMs = CONFIG.NEWS_LOOKAHEAD_HOURS * 60 * 60 * 1000;

    let blockedEvent = null;
    let nextEvent = null;

    for (const event of events) {

      const diff = event.timestamp - now;

      if (diff >= -afterMs && diff <= beforeMs) {
        blockedEvent = event;
        break;
      }

      if (diff >= 0 && diff <= lookaheadMs && !nextEvent) {
        nextEvent = event;
      }
    }

    const result = {
      enabled: true,
      feedStatus: "connected",
      httpStatus: response.status,
      fetchMs,
      rawEvents: rawEvents.length,
      usdEvents: usdEvents.length,
      highImpactUsd: events.length,
      events,
      blocked: Boolean(blockedEvent),
      blockedEvent,
      nextEvent,
      message: blockedEvent
        ? "High impact USD news window is active."
        : "No high impact USD news in the checked window."
    };

    memoryNewsCache = result;
    memoryNewsCacheTime = now;

    return result;

  } catch (error) {

    return {
      enabled: true,
      feedStatus: "error",
      httpStatus: 0,
      fetchMs: Date.now() - started,
      rawEvents: 0,
      usdEvents: 0,
      highImpactUsd: 0,
      events: [],
      blocked: CONFIG.NEWS_FAIL_CLOSED,
      blockedEvent: null,
      nextEvent: null,
      error: String(error?.message || error),
      message: CONFIG.NEWS_FAIL_CLOSED
        ? "News feed unavailable. New entries blocked."
        : "News feed unavailable."
    };
  }
}


// ============================================================
// SCORE (absolute quality score)
// ============================================================

function calculateScore(fast, slow) {

  let bullish = 0;
  let bearish = 0;

  const add = (dir, pts) => {
    if (dir === "BULLISH") bullish += pts;
    if (dir === "BEARISH") bearish += pts;
  };

  // Max raw = 115

  add(slow.trend, 20);        // 1H trend
  add(fast.trend, 15);        // 15M trend
  add(slow.structure, 10);    // 1H structure
  add(fast.structure, 10);    // 15M structure

  // ADX quality (15)
  const adxDir =
    fast.plusDI > fast.minusDI ? "BULLISH"
    : fast.minusDI > fast.plusDI ? "BEARISH"
    : "";

  if (fast.adx14 >= 30) add(adxDir, 15);
  else if (fast.adx14 >= 25) add(adxDir, 12);
  else if (fast.adx14 >= CONFIG.MIN_ADX) add(adxDir, 10);

  // DI spread (10)
  if (fast.diSpread >= CONFIG.MIN_DI_SPREAD) add(adxDir, 10);

  // 1H DI + MACD confirmation (10)
  if (slow.plusDI > slow.minusDI && slow.macdHistogram > 0) bullish += 10;
  if (slow.minusDI > slow.plusDI && slow.macdHistogram < 0) bearish += 10;

  // 15M MACD (10)
  if (fast.macdHistogram > 0 && fast.macd > fast.macdSignal) bullish += 10;
  if (fast.macdHistogram < 0 && fast.macd < fast.macdSignal) bearish += 10;

  // RSI (5)
  if (
    fast.rsi14 >= CONFIG.BULL_RSI_MIN &&
    fast.rsi14 <= CONFIG.BULL_RSI_MAX &&
    fast.rsi14 >= fast.previousRSI
  ) bullish += 5;

  if (
    fast.rsi14 >= CONFIG.BEAR_RSI_MIN &&
    fast.rsi14 <= CONFIG.BEAR_RSI_MAX &&
    fast.rsi14 <= fast.previousRSI
  ) bearish += 5;

  // Momentum (5)
  if (fast.momentum >= CONFIG.MIN_MOMENTUM) bullish += 5;
  if (fast.momentum <= -CONFIG.MIN_MOMENTUM) bearish += 5;

  // Candle quality (5)
  if (fast.candleBullish) bullish += 5;
  if (fast.candleBearish) bearish += 5;

  const rawMax = 115;
  const rawDirectional = Math.max(bullish, bearish);

  let score = Math.round((rawDirectional / rawMax) * 100);

  let direction = "WAIT";
  if (bullish > bearish) direction = "BULLISH";
  if (bearish > bullish) direction = "BEARISH";

  // ADX score cap: weak trend cannot show a high score
  if (fast.adx14 < 18) score = Math.min(score, 59);
  else if (fast.adx14 < 23) score = Math.min(score, 74);
  else if (fast.adx14 < 25) score = Math.min(score, 84);

  return {
    bullish,
    bearish,
    direction,
    score,
    lead: Math.abs(bullish - bearish),
    rawMax,
    adxQuality:
      fast.adx14 >= 30 ? "STRONG"
      : fast.adx14 >= 25 ? "GOOD"
      : fast.adx14 >= 23 ? "MINIMUM"
      : "WEAK"
  };
}


// ============================================================
// SESSION FILTER
// ============================================================

function inSession() {
  if (!CONFIG.SESSION_FILTER_ENABLED) return true;
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = new Date().getUTCHours();
  return h >= CONFIG.SESSION_START_UTC && h < CONFIG.SESSION_END_UTC;
}


// ============================================================
// DIRECTION CONFIRMATION — returns null if OK, else reason
// ============================================================

function directionCheck(direction, fast, slow) {

  if (direction !== "BULLISH" && direction !== "BEARISH") {
    return "No clear direction";
  }

  const bull = direction === "BULLISH";

  if (fast.adx14 < CONFIG.MIN_ADX) {
    return `15M ADX ${round(fast.adx14, 1)} below ${CONFIG.MIN_ADX}`;
  }

  if (fast.adxSlope < CONFIG.MIN_ADX_SLOPE) {
    return `15M ADX slope ${round(fast.adxSlope, 2)} below ${CONFIG.MIN_ADX_SLOPE} (trend strength not rising)`;
  }

  if (slow.adx14 < CONFIG.MIN_SLOW_ADX) {
    return `1H ADX ${round(slow.adx14, 1)} below ${CONFIG.MIN_SLOW_ADX}`;
  }

  if (fast.diSpread < CONFIG.MIN_DI_SPREAD) {
    return `15M DI spread ${round(fast.diSpread, 1)} below ${CONFIG.MIN_DI_SPREAD}`;
  }

  if (fast.emaDistanceATR > CONFIG.MAX_EMA20_DISTANCE_ATR) {
    return `Price ${round(fast.emaDistanceATR, 2)} ATR from EMA20 (late / exhausted move)`;
  }

  if (bull) {
    if (fast.trend !== "BULLISH" || slow.trend !== "BULLISH") return "15M/1H trend not both bullish";
    if (fast.structure !== "BULLISH" || slow.structure !== "BULLISH") return "15M/1H structure not both bullish";
    if (!(fast.plusDI > fast.minusDI)) return "15M DI not bullish";
    if (!(slow.plusDI > slow.minusDI)) return "1H DI not bullish";
    if (!(fast.macdHistogram > 0 && fast.macd > fast.macdSignal)) return "15M MACD not bullish";
    if (!(slow.macdHistogram > 0)) return "1H MACD not bullish";
    if (fast.rsi14 < CONFIG.BULL_RSI_MIN || fast.rsi14 > CONFIG.BULL_RSI_MAX) return "15M RSI outside bullish zone";
    if (fast.rsi14 < fast.previousRSI) return "15M RSI falling";
    if (fast.momentum < CONFIG.MIN_MOMENTUM) return "15M momentum weak";
    if (!fast.candleBullish) return "Last 15M candle not a strong bullish candle";
    return null;
  }

  if (fast.trend !== "BEARISH" || slow.trend !== "BEARISH") return "15M/1H trend not both bearish";
  if (fast.structure !== "BEARISH" || slow.structure !== "BEARISH") return "15M/1H structure not both bearish";
  if (!(fast.minusDI > fast.plusDI)) return "15M DI not bearish";
  if (!(slow.minusDI > slow.plusDI)) return "1H DI not bearish";
  if (!(fast.macdHistogram < 0 && fast.macd < fast.macdSignal)) return "15M MACD not bearish";
  if (!(slow.macdHistogram < 0)) return "1H MACD not bearish";
  if (fast.rsi14 < CONFIG.BEAR_RSI_MIN || fast.rsi14 > CONFIG.BEAR_RSI_MAX) return "15M RSI outside bearish zone";
  if (fast.rsi14 > fast.previousRSI) return "15M RSI rising";
  if (fast.momentum > -CONFIG.MIN_MOMENTUM) return "15M momentum weak";
  if (!fast.candleBearish) return "Last 15M candle not a strong bearish candle";
  return null;
}


// ============================================================
// TRADE PLAN
// ============================================================

function recentLevels(candles) {
  const sample = candles.slice(-20);
  return {
    high: Math.max(...sample.map(c => c.high)),
    low: Math.min(...sample.map(c => c.low))
  };
}

function buildTradePlan(direction, currentPrice, fast, candles) {

  const atrValue = fast.atr14;

  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    return { valid: false, reason: "Invalid ATR" };
  }

  const levels = recentLevels(candles);

  let entry, sl, tp1, tp2, tp3;

  if (direction === "BULLISH") {

    const pullbackEntry = currentPrice - atrValue * CONFIG.ATR_ENTRY_MULTIPLIER;
    const structureFloor = levels.low + atrValue * 0.15;

    entry = Math.max(structureFloor, pullbackEntry);

    if (entry >= currentPrice) entry = pullbackEntry;

    sl = entry - atrValue * CONFIG.ATR_SL_MULTIPLIER;

    const risk = entry - sl;
    tp1 = entry + risk * 1.50;
    tp2 = entry + risk * 2.20;
    tp3 = entry + risk * 3.00;

  } else if (direction === "BEARISH") {

    const pullbackEntry = currentPrice + atrValue * CONFIG.ATR_ENTRY_MULTIPLIER;
    const structureCeiling = levels.high - atrValue * 0.15;

    entry = Math.min(structureCeiling, pullbackEntry);

    if (entry <= currentPrice) entry = pullbackEntry;

    sl = entry + atrValue * CONFIG.ATR_SL_MULTIPLIER;

    const risk = sl - entry;
    tp1 = entry - risk * 1.50;
    tp2 = entry - risk * 2.20;
    tp3 = entry - risk * 3.00;

  } else {
    return { valid: false, reason: "No direction" };
  }

  const distance = Math.abs(currentPrice - entry);
  const distanceAtr = distance / atrValue;
  const distancePercent = (distance / currentPrice) * 100;

  if (distanceAtr > CONFIG.MAX_ENTRY_DISTANCE_ATR) {
    return { valid: false, reason: "Entry too far from market" };
  }

  if (distancePercent > CONFIG.MAX_ENTRY_DISTANCE_PERCENT) {
    return { valid: false, reason: "Entry percentage distance too large" };
  }

  if (distanceAtr < CONFIG.MIN_ENTRY_DISTANCE_ATR) {
    return { valid: false, reason: "Entry too close to market" };
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp1 - entry);
  const rr = risk > 0 ? reward / risk : 0;

  if (rr < CONFIG.MIN_RR) {
    return { valid: false, reason: "R:R below minimum" };
  }

  if (direction === "BULLISH") {
    if (!(sl < entry && entry < currentPrice && entry < tp1 && tp1 < tp2 && tp2 < tp3)) {
      return { valid: false, reason: "Invalid bullish geometry" };
    }
  } else {
    if (!(sl > entry && entry > currentPrice && entry > tp1 && tp1 > tp2 && tp2 > tp3)) {
      return { valid: false, reason: "Invalid bearish geometry" };
    }
  }

  const d = CONFIG.PRICE_DECIMALS;

  return {
    valid: true,
    currentPrice: round(currentPrice, d),
    entry: round(entry, d),
    sl: round(sl, d),
    tp1: round(tp1, d),
    tp2: round(tp2, d),
    tp3: round(tp3, d),
    rr: round(rr, 2),
    atr: round(atrValue, d),
    entryDistance: round(distance, d),
    entryDistanceATR: round(distanceAtr, 2),
    entryDistancePercent: round(distancePercent, 3)
  };
}


// ============================================================
// SIGNAL ENGINE
// ============================================================

function waitResponse(currentPrice, scoring, fast, slow, news, reason, started, tradePlan = null) {
  return {
    version: CONFIG.VERSION,
    symbol: CONFIG.SYMBOL,
    generatedAt: new Date().toISOString(),
    price: round(currentPrice, 4),
    signal: "WAIT",
    reason,
    score: scoring.score,
    direction: scoring.direction,
    directionLead: scoring.lead,
    adxQuality: scoring.adxQuality,
    fast,
    slow,
    news,
    tradePlan,
    executionMs: Date.now() - started
  };
}


async function generateSignal(env) {

  const started = Date.now();

  const [fastCandles, slowCandles] = await Promise.all([
    getTimeSeries(env, CONFIG.INTERVAL_FAST, CONFIG.OUTPUT_SIZE_FAST),
    getTimeSeries(env, CONFIG.INTERVAL_SLOW, CONFIG.OUTPUT_SIZE_SLOW)
  ]);

  const currentPrice = fastCandles[fastCandles.length - 1].close;

  const fast = analyzeTimeframe(fastCandles);
  const slow = analyzeTimeframe(slowCandles);
  const scoring = calculateScore(fast, slow);

  const news = CONFIG.NEWS_FILTER_ENABLED
    ? await getLiveNews()
    : { feedStatus: "disabled", blocked: false, message: "News filter disabled." };

  const wait = (reason, plan = null) =>
    waitResponse(currentPrice, scoring, fast, slow, news, reason, started, plan);

  if (!inSession()) {
    return wait("Outside trading session (London + New York only).");
  }

  if (CONFIG.NEWS_FILTER_ENABLED && news.blocked) {
    return wait(news.message);
  }

  if (scoring.score < CONFIG.MIN_SCORE) {
    return wait(`Score ${scoring.score} below minimum ${CONFIG.MIN_SCORE}.`);
  }

  if (scoring.lead < CONFIG.MIN_DIRECTION_LEAD) {
    return wait(`Direction lead ${scoring.lead} below minimum ${CONFIG.MIN_DIRECTION_LEAD}.`);
  }

  const failure = directionCheck(scoring.direction, fast, slow);

  if (failure) {
    return wait(failure);
  }

  const tradePlan = buildTradePlan(scoring.direction, currentPrice, fast, fastCandles);

  if (!tradePlan.valid) {
    return wait(tradePlan.reason, tradePlan);
  }

  return {
    version: CONFIG.VERSION,
    symbol: CONFIG.SYMBOL,
    generatedAt: new Date().toISOString(),
    price: round(currentPrice, 4),
    signal: scoring.direction === "BULLISH" ? "BUY LIMIT" : "SELL LIMIT",
    score: scoring.score,
    direction: scoring.direction,
    directionLead: scoring.lead,
    adxQuality: scoring.adxQuality,
    fast,
    slow,
    news,
    tradePlan,
    riskMessage:
      "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\n" +
      "📊 این سیگنال بر اساس شرایط فعلی بازار است و با تغییر شرایط ممکن است اعتبار آن از بین برود.",
    executionMs: Date.now() - started
  };
}


// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(env, message) {

  if (!CONFIG.TELEGRAM_ENABLED) {
    return { ok: false, skipped: true };
  }

  const token = getEnv(env, ["TELEGRAM_BOT_TOKEN"]);
  const chatId = getEnv(env, ["TELEGRAM_CHAT_ID"]);

  if (!token || !chatId) {
    return { ok: false, error: "Telegram credentials missing" };
  }

  const response = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    },
    CONFIG.API_TIMEOUT_MS
  );

  let data = {};
  try {
    data = await response.json();
  } catch {}

  return {
    ok: response.ok && data.ok === true,
    status: response.status,
    data
  };
}


function formatSignalMessage(signal) {

  if (!signal || signal.signal === "WAIT") return null;

  const p = signal.tradePlan;

  return [
    `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,
    "",
    "🥇 XAUUSD",
    `📊 ${signal.signal}`,
    `⭐ Score: ${signal.score}/100`,
    "",
    `📍 Entry: ${p.entry}`,
    `🛑 SL: ${p.sl}`,
    `🎯 TP1: ${p.tp1}`,
    `🎯 TP2: ${p.tp2}`,
    `🎯 TP3: ${p.tp3}`,
    "",
    `📊 R:R: ${p.rr}`,
    `📏 Entry Distance: ${p.entryDistance} (${p.entryDistanceATR} ATR)`,
    "",
    `📈 15M: ${signal.fast.trend}`,
    `📈 1H: ${signal.slow.trend}`,
    `💪 ADX 15M: ${round(signal.fast.adx14, 1)} | 1H: ${round(signal.slow.adx14, 1)}`,
    `📊 DI Spread: ${round(signal.fast.diSpread, 1)}`,
    `📉 RSI: ${round(signal.fast.rsi14, 1)}`,
    `📰 News: ${signal.news.blocked ? "BLOCKED" : "CLEAR"}`,
    "",
    signal.riskMessage,
    "",
    "👤 عبدالحکیم داودی",
    "💎 ترید عالی"
  ].join("\n");
}


async function sendNewsAlert(env, news) {

  if (!CONFIG.TELEGRAM_NEWS_ENABLED) return;
  if (!news || !news.nextEvent) return;

  const event = news.nextEvent;
  const key = `news:${event.title}-${event.timestamp}`;

  const diff = event.timestamp - Date.now();

  if (diff < 0 || diff > CONFIG.NEWS_ALERT_BEFORE_MINUTES * 60 * 1000) return;

  if (await alreadySent(env, key)) return;

  const minutes = Math.max(0, Math.round(diff / 60000));

  const message = [
    "📰 USD HIGH IMPACT NEWS",
    "",
    `🇺🇸 ${event.title}`,
    `⏰ حدود ${minutes} دقیقه دیگر`,
    `📊 Impact: ${event.impact}`,
    event.forecast ? `📌 Forecast: ${event.forecast}` : "",
    event.previous ? `📌 Previous: ${event.previous}` : "",
    "",
    "⚠️ در محدوده خبر مهم، از ورود عجولانه خودداری کنید.",
    "",
    CONFIG.TELEGRAM_NEWS_FOOTER
  ].filter(line => line !== "").join("\n");

  const result = await sendTelegram(env, message);

  if (result.ok) {
    await markSent(env, key, CONFIG.NEWS_DEDUPE_TTL_SECONDS);
  }
}


async function maybeSendSignal(env, signal) {

  if (signal.signal === "WAIT" || !CONFIG.TELEGRAM_SIGNAL_ENABLED) {
    return { sent: false, reason: "no signal" };
  }

  const message = formatSignalMessage(signal);
  if (!message) return { sent: false, reason: "no message" };

  const key = "signal:" + [
    signal.signal,
    signal.tradePlan?.entry,
    signal.tradePlan?.sl,
    signal.tradePlan?.tp1
  ].join("|");

  if (await alreadySent(env, key)) {
    return { sent: false, reason: "duplicate" };
  }

  const result = await sendTelegram(env, message);

  if (result.ok) {
    await markSent(env, key, CONFIG.SIGNAL_DEDUPE_TTL_SECONDS);
    return { sent: true };
  }

  return { sent: false, reason: "telegram error", detail: result };
}


// ============================================================
// SCHEDULED RUN (cron)
// ============================================================

async function runScheduled(env) {

  try {
    const news = await getLiveNews();
    await sendNewsAlert(env, news);
  } catch (e) {
    console.error("news error:", e);
  }

  try {
    const signal = await generateSignal(env);
    const result = await maybeSendSignal(env, signal);
    console.log("cron:", signal.signal, signal.reason || "", JSON.stringify(result));
  } catch (e) {
    console.error("signal error:", e);
  }
}


// ============================================================
// ROUTE HANDLERS
// ============================================================

async function healthResponse(env) {
  return Response.json({
    ok: true,
    service: "FOREX SIGNAL ENGINE",
    version: CONFIG.VERSION,
    symbol: CONFIG.SYMBOL,
    intervals: [CONFIG.INTERVAL_FAST, CONFIG.INTERVAL_SLOW],
    kvBound: Boolean(env.KV),
    filters: {
      minScore: CONFIG.MIN_SCORE,
      minADX: CONFIG.MIN_ADX,
      minADXSlope: CONFIG.MIN_ADX_SLOPE,
      minSlowADX: CONFIG.MIN_SLOW_ADX,
      minDISpread: CONFIG.MIN_DI_SPREAD,
      minMomentum: CONFIG.MIN_MOMENTUM,
      minDirectionLead: CONFIG.MIN_DIRECTION_LEAD,
      maxEma20DistanceATR: CONFIG.MAX_EMA20_DISTANCE_ATR,
      sessionUTC: `${CONFIG.SESSION_START_UTC}-${CONFIG.SESSION_END_UTC}`
    },
    inSession: inSession(),
    time: new Date().toISOString()
  });
}

async function newsResponse() {
  const news = await getLiveNews();
  return Response.json({ version: CONFIG.VERSION, ...news });
}

// Manual view: does NOT send Telegram (cron does that).
// Add ?send=1 to also push to Telegram.
async function signalResponse(env, request) {
  try {
    const signal = await generateSignal(env);
    const url = new URL(request.url);

    if (url.searchParams.get("send") === "1") {
      signal.telegram = await maybeSendSignal(env, signal);
    }

    return Response.json(signal);

  } catch (error) {
    return Response.json({
      version: CONFIG.VERSION,
      signal: "WAIT",
      error: String(error?.message || error),
      time: new Date().toISOString()
    }, { status: 500 });
  }
}


// ============================================================
// HOMEPAGE
// ============================================================

function renderHomepage() {

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#12163a">
<title>FX · موتور سیگنال فارکس ${CONFIG.VERSION}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#0b1020;color:#f5f7ff}
.wrap{max-width:900px;margin:auto;padding:20px}
header{padding:25px 0}
h1{margin:0;font-size:27px}
.sub{opacity:.75;margin-top:8px}
.card{background:#121a30;border:1px solid #263250;border-radius:18px;padding:20px;margin-top:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.item{background:#0e1629;border-radius:14px;padding:14px}
.label{font-size:13px;opacity:.65}
.value{font-size:19px;font-weight:bold;margin-top:5px}
button{width:100%;padding:13px;border:0;border-radius:12px;background:#2563eb;color:#fff;font-size:16px;font-weight:bold}
pre{white-space:pre-wrap;word-break:break-word;line-height:1.9}
.good{color:#65e6a5}.wait{color:#ffd166}.bad{color:#ff8585}
.signature{text-align:center;opacity:.85;margin-top:20px}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>FX · موتور سیگنال فارکس ${CONFIG.VERSION}</h1>
<div class="sub">Gold Quality · XAU/USD · 15M + 1H</div>
</header>
<div class="card"><button onclick="loadSignal()">🔄 بروزرسانی سیگنال</button></div>
<div id="result" class="card">در حال دریافت اطلاعات...</div>
<div class="signature">عبدالحکیم داودی | ترید عالی</div>
</div>
<script>
async function loadSignal(){
  const box=document.getElementById("result");
  box.innerHTML="⏳ در حال بررسی بازار...";
  try{
    const r=await fetch("/api/signals",{cache:"no-store"});
    render(await r.json());
  }catch(e){
    box.innerHTML="<div class='bad'>خطا در دریافت سیگنال</div>";
  }
}
function esc(v){
  return String(v??"-").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function item(l,v){
  return "<div class='item'><div class='label'>"+esc(l)+"</div><div class='value'>"+esc(v)+"</div></div>";
}
function fmt(v){return typeof v==="number"?Math.round(v*100)/100:v}
function render(d){
  const box=document.getElementById("result");
  if(d.signal==="WAIT"){
    box.innerHTML=
      "<h2 class='wait'>⏸ WAIT</h2>"+
      "<p>"+esc(d.reason||d.error||"شرایط مناسب نیست.")+"</p>"+
      "<div class='grid'>"+
      item("قیمت",d.price)+item("Score",d.score)+
      item("15M",d.fast&&d.fast.trend)+item("1H",d.slow&&d.slow.trend)+
      item("ADX 15M",d.fast&&fmt(d.fast.adx14))+
      item("ADX Slope",d.fast&&fmt(d.fast.adxSlope))+
      item("ADX 1H",d.slow&&fmt(d.slow.adx14))+
      item("DI Spread",d.fast&&fmt(d.fast.diSpread))+
      item("RSI",d.fast&&fmt(d.fast.rsi14))+
      "</div>";
    return;
  }
  const p=d.tradePlan;
  box.innerHTML=
    "<h2 class='good'>💎 "+esc(d.signal)+"</h2>"+
    "<div class='grid'>"+
    item("قیمت فعلی",d.price)+item("Score",d.score+"/100")+
    item("15M",d.fast.trend)+item("1H",d.slow.trend)+
    item("ADX 15M",fmt(d.fast.adx14))+item("ADX 1H",fmt(d.slow.adx14))+
    item("News",d.news&&d.news.blocked?"BLOCKED":"CLEAR")+
    item("R:R",p&&p.rr)+
    "</div>"+
    "<div class='card'><h3>Trade Plan</h3><pre>"+
    "📍 Entry: "+esc(p.entry)+
    "\\n🛑 SL: "+esc(p.sl)+
    "\\n🎯 TP1: "+esc(p.tp1)+
    "\\n🎯 TP2: "+esc(p.tp2)+
    "\\n🎯 TP3: "+esc(p.tp3)+
    "\\n📏 Entry Distance: "+esc(p.entryDistance)+" ("+esc(p.entryDistanceATR)+" ATR)"+
    "</pre></div>"+
    "<div class='card'><pre>💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\\n📊 این سیگنال بر اساس شرایط فعلی بازار است و با تغییر شرایط ممکن است اعتبار آن از بین برود.</pre></div>";
}
loadSignal();
setInterval(loadSignal,60000);
</script>
</body>
</html>`;
}


// ============================================================
// CORS
// ============================================================

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {

      if (url.pathname === "/" || url.pathname === "") {
        return new Response(renderHomepage(), {
          headers: { "Content-Type": "text/html; charset=UTF-8" }
        });
      }

      if (url.pathname === "/health") {
        return withCors(await healthResponse(env));
      }

      if (url.pathname === "/api/news") {
        return withCors(await newsResponse());
      }

      if (url.pathname === "/api/signals") {
        return withCors(await signalResponse(env, request));
      }

      if (url.pathname === "/telegram-test") {
        const result = await sendTelegram(
          env,
          `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}\n\n` +
          "✅ Telegram connection test successful.\n\n" +
          "👤 عبدالحکیم داودی\n" +
          "💎 ترید عالی"
        );
        return withCors(Response.json(result));
      }

      if (url.pathname === "/telegram-status") {
        return withCors(Response.json({
          telegram: Boolean(CONFIG.TELEGRAM_ENABLED),
          tokenConfigured: Boolean(getEnv(env, ["TELEGRAM_BOT_TOKEN"])),
          chatIdConfigured: Boolean(getEnv(env, ["TELEGRAM_CHAT_ID"])),
          kvBound: Boolean(env.KV),
          signature: "عبدالحکیم داودی | ترید عالی"
        }));
      }

      // Manual trigger of the cron job (for testing)
      if (url.pathname === "/run-now") {
        await runScheduled(env);
        return withCors(Response.json({ ok: true, ran: "scheduled job" }));
      }

      return withCors(Response.json({
        ok: false,
        error: "Not found",
        routes: [
          "/", "/health", "/api/signals", "/api/signals?send=1",
          "/api/news", "/telegram-test", "/telegram-status", "/run-now"
        ]
      }, { status: 404 }));

    } catch (error) {
      return withCors(Response.json({
        ok: false,
        error: String(error?.message || error)
      }, { status: 500 }));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  }

};
