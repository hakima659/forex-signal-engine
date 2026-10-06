// ============================================================
// FOREX SIGNAL ENGINE V7.0.4 — GOLD QUALITY
// Cloudflare Worker + Twelve Data + Telegram
//
// PROJECT: موتور سیگنال فارکس
// SYMBOL: XAU/USD
// TIMEFRAMES: 15M + 1H
//
// V7.0.4
// - XAU/USD focused
// - 15M + 1H confluence
// - EMA 20/50/200
// - RSI
// - MACD
// - ATR
// - ADX / DI
// - Candle confirmation
// - Pullback-first entry
// - Anti-chase protection
// - Structure based SL
// - ATR based TP
// - Break-even
// - Profit lock
// - Telegram alerts
// - Duplicate protection
// - Cron every 15 minutes
// ============================================================

const CONFIG = {
  SYMBOL: "XAU/USD",

  FAST_INTERVAL: "15min",
  SLOW_INTERVAL: "1h",

  FAST_OUTPUTSIZE: 250,
  SLOW_OUTPUTSIZE: 180,

  MIN_SCORE: 88,
  MIN_DIRECTION_LEAD: 40,

  MIN_ADX: 22,
  MIN_ADX_SLOPE: -0.20,

  MIN_SLOW_ADX: 22,
  MIN_DI_SPREAD: 6,
  MIN_SLOW_DI_SPREAD: 6,

  MIN_MOMENTUM: 0.020,
  MIN_RR: 1.50,
  MIN_SLOW_SCORE: 72,

  ATR_PERIOD: 14,

  SL_ATR: 1.10,
  STRUCTURE_BUFFER_ATR: 0.10,

  TP1_R: 1.50,
  TP2_R: 2.20,
  TP3_R: 3.20,

  BREAK_EVEN_R: 0.70,
  PROFIT_LOCK_R: 1.00,
  PROFIT_LOCK_AMOUNT_R: 0.20,

  MAX_PULLBACK_ATR: 0.85,
  EMA_TOLERANCE_ATR: 0.20,

  ANTI_CHASE_ATR: 1.10,

  FAST_CACHE_SECONDS: 60,
  SLOW_CACHE_SECONDS: 300,

  MAX_FAST_AGE_SECONDS: 120,
  MAX_SLOW_AGE_SECONDS: 420,

  SESSION_START_UTC: 7,
  SESSION_END_UTC: 20,

  NEWS_ENABLED: false,

  TELEGRAM_ENABLED: true,

  DUPLICATE_TTL_SECONDS: 3600,

  VERSION: "V7.0.4"
};

// ============================================================
// BASIC HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function text(data, status = 200) {
  return new Response(String(data), {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round(num(value) * p) / p;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function utcHour() {
  return new Date().getUTCHours();
}

function utcDay() {
  return new Date().getUTCDay();
}

function isWeekday() {
  const d = utcDay();
  return d >= 1 && d <= 5;
}

function sessionOpen() {
  const h = utcHour();

  if (!isWeekday()) return false;

  return h >= CONFIG.SESSION_START_UTC &&
         h < CONFIG.SESSION_END_UTC;
}

function safeString(value) {
  return String(value ?? "")
    .replace(/[<>&]/g, c => ({
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;"
    }[c]));
}

// ============================================================
// ENVIRONMENT
// ============================================================

function getTwelveDataKey(env) {
  return String(
    env.TWELVE_DATA_API_KEY ||
    env.TWELVE_DATA_KEY ||
    ""
  ).trim();
}

function getTelegramToken(env) {
  return String(
    env.TELEGRAM_BOT_TOKEN ||
    env.TELEGRAM_TOKEN ||
    ""
  ).trim();
}

function getTelegramChatId(env) {
  return String(
    env.TELEGRAM_CHAT_ID ||
    env.TELEGRAM_CHAT ||
    ""
  ).trim();
}

// ============================================================
// CACHE
// ============================================================

async function getCached(env, key) {
  if (!env.SIGNAL_KV) return null;

  try {
    const value = await env.SIGNAL_KV.get(key, "json");
    return value || null;
  } catch {
    return null;
  }
}

async function putCached(env, key, value, ttl) {
  if (!env.SIGNAL_KV) return;

  try {
    await env.SIGNAL_KV.put(
      key,
      JSON.stringify(value),
      { expirationTtl: ttl }
    );
  } catch {
    // KV is optional
  }
}

// ============================================================
// TWELVE DATA
// ============================================================

async function fetchTwelveData(symbol, interval, outputsize, env) {
  const apiKey = getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" + encodeURIComponent(symbol) +
    "&interval=" + encodeURIComponent(interval) +
    "&outputsize=" + encodeURIComponent(outputsize) +
    "&format=JSON" +
    "&timezone=UTC" +
    "&apikey=" + encodeURIComponent(apiKey);

  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (
    data.status === "error" ||
    data.code ||
    data.message
  ) {
    throw new Error(
      `Twelve Data: ${data.message || "API error"}`
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error("Twelve Data returned no candles");
  }

  const candles = data.values
    .map(x => ({
      time: new Date(x.datetime).getTime(),
      datetime: x.datetime,

      open: num(x.open),
      high: num(x.high),
      low: num(x.low),
      close: num(x.close),

      volume: num(x.volume)
    }))
    .filter(x =>
      x.time > 0 &&
      x.open > 0 &&
      x.high > 0 &&
      x.low > 0 &&
      x.close > 0
    )
    .sort((a, b) => a.time - b.time);

  if (candles.length < 80) {
    throw new Error(
      `Not enough candles: ${candles.length}`
    );
  }

  return candles;
}

// ============================================================
// DATA LOADING WITH CACHE
// ============================================================

async function loadCandles(interval, outputsize, env) {
  const isFast = interval === CONFIG.FAST_INTERVAL;

  const cacheKey =
    isFast
      ? "xauusd:15m"
      : "xauusd:1h";

  const ttl =
    isFast
      ? CONFIG.FAST_CACHE_SECONDS
      : CONFIG.SLOW_CACHE_SECONDS;

  const cached = await getCached(env, cacheKey);

  if (
    cached &&
    Array.isArray(cached.candles) &&
    cached.candles.length > 0
  ) {
    const age =
      (Date.now() - cached.cachedAt) / 1000;

    if (age <= ttl) {
      return cached.candles;
    }
  }

  const candles = await fetchTwelveData(
    CONFIG.SYMBOL,
    interval,
    outputsize,
    env
  );

  await putCached(
    env,
    cacheKey,
    {
      cachedAt: Date.now(),
      candles
    },
    ttl
  );

  return candles;
}

// ============================================================
// FRESHNESS
// ============================================================

function intervalSeconds(interval) {
  if (interval === "15min") return 15 * 60;
  if (interval === "1h") return 60 * 60;
  return 60;
}

function candleBucket(timestamp, interval) {
  const seconds =
    intervalSeconds(interval);

  return Math.floor(
    timestamp / 1000 / seconds
  );
}

function isCurrentOrPreviousBucket(
  candleTime,
  interval
) {
  const nowBucket =
    candleBucket(Date.now(), interval);

  const candleBucketValue =
    candleBucket(candleTime, interval);

  return (
    candleBucketValue === nowBucket ||
    candleBucketValue === nowBucket - 1
  );
}

function getDataAgeSeconds(candle) {
  return Math.max(
    0,
    Math.floor(
      (Date.now() - candle.time) / 1000
    )
  );
}

function freshnessInfo(candles, interval) {
  const last =
    candles[candles.length - 1];

  if (!last) {
    return {
      fresh: false,
      age: Infinity,
      bucketFresh: false
    };
  }

  const age =
    getDataAgeSeconds(last);

  const bucketFresh =
    isCurrentOrPreviousBucket(
      last.time,
      interval
    );

  const maxAge =
    interval === CONFIG.FAST_INTERVAL
      ? CONFIG.MAX_FAST_AGE_SECONDS
      : CONFIG.MAX_SLOW_AGE_SECONDS;

  return {
    fresh:
      bucketFresh ||
      age <= maxAge,

    age,
    bucketFresh
  };
}

// ============================================================
// BASIC INDICATORS
// ============================================================

function sma(values, period) {
  const result =
    new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += num(values[i]);

    if (i >= period) {
      sum -= num(values[i - period]);
    }

    if (i >= period - 1) {
      result[i] =
        sum / period;
    }
  }

  return result;
}

function ema(values, period) {
  const result =
    new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  const multiplier =
    2 / (period + 1);

  let seed = 0;

  for (let i = 0; i < period; i++) {
    seed += num(values[i]);
  }

  seed /= period;

  result[period - 1] = seed;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    result[i] =
      (
        (values[i] - result[i - 1]) *
        multiplier
      ) +
      result[i - 1];
  }

  return result;
}

function rsi(values, period = 14) {
  const result =
    new Array(values.length).fill(null);

  if (values.length <= period) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  result[period] =
    avgLoss === 0
      ? 100
      : 100 -
        (
          100 /
          (
            1 +
            avgGain /
            avgLoss
          )
        );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      (
        (avgGain * (period - 1)) +
        gain
      ) / period;

    avgLoss =
      (
        (avgLoss * (period - 1)) +
        loss
      ) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs =
        avgGain / avgLoss;

      result[i] =
        100 -
        (
          100 /
          (1 + rs)
        );
    }
  }

  return result;
}

function trueRanges(candles) {
  const result =
    new Array(candles.length)
      .fill(null);

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {
    if (i === 0) {
      result[i] =
        candles[i].high -
        candles[i].low;
      continue;
    }

    const high =
      candles[i].high;

    const low =
      candles[i].low;

    const previousClose =
      candles[i - 1].close;

    result[i] =
      Math.max(
        high - low,
        Math.abs(
          high - previousClose
        ),
        Math.abs(
          low - previousClose
        )
      );
  }

  return result;
}

function atr(candles, period = 14) {
  const tr =
    trueRanges(candles);

  return ema(
    tr.map(x => num(x)),
    period
  );
}

// ============================================================
// MACD
// ============================================================

function macd(values) {
  const fast =
    ema(values, 12);

  const slow =
    ema(values, 26);

  const line =
    values.map((_, i) => {
      if (
        fast[i] == null ||
        slow[i] == null
      ) {
        return null;
      }

      return fast[i] - slow[i];
    });

  const valid =
    line.map(x => x == null ? 0 : x);

  const signal =
    ema(valid, 9);

  const histogram =
    line.map((x, i) => {
      if (
        x == null ||
        signal[i] == null
      ) {
        return null;
      }

      return x - signal[i];
    });

  return {
    line,
    signal,
    histogram
  };
}

// ============================================================
// ADX / DI
// ============================================================

function adx(candles, period = 14) {
  const n = candles.length;

  const tr =
    new Array(n).fill(0);

  const plusDM =
    new Array(n).fill(0);

  const minusDM =
    new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up =
      candles[i].high -
      candles[i - 1].high;

    const down =
      candles[i - 1].low -
      candles[i].low;

    plusDM[i] =
      up > down && up > 0
        ? up
        : 0;

    minusDM[i] =
      down > up && down > 0
        ? down
        : 0;

    tr[i] =
      Math.max(
        candles[i].high -
          candles[i].low,

        Math.abs(
          candles[i].high -
          candles[i - 1].close
        ),

        Math.abs(
          candles[i].low -
          candles[i - 1].close
        )
      );
  }

  const atrValues =
    ema(tr, period);

  const plusSmoothed =
    ema(plusDM, period);

  const minusSmoothed =
    ema(minusDM, period);

  const plusDI =
    new Array(n).fill(null);

  const minusDI =
    new Array(n).fill(null);

  const dx =
    new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (
      atrValues[i] == null ||
      atrValues[i] === 0 ||
      plusSmoothed[i] == null ||
      minusSmoothed[i] == null
    ) {
      continue;
    }

    plusDI[i] =
      100 *
      plusSmoothed[i] /
      atrValues[i];

    minusDI[i] =
      100 *
      minusSmoothed[i] /
      atrValues[i];

    const sum =
      plusDI[i] +
      minusDI[i];

    if (sum > 0) {
      dx[i] =
        100 *
        Math.abs(
          plusDI[i] -
          minusDI[i]
        ) /
        sum;
    }
  }

  const dxClean =
    dx.map(x =>
      x == null ? 0 : x
    );

  const adxValues =
    ema(dxClean, period);

  return {
    adx: adxValues,
    plusDI,
    minusDI
  };
}

// ============================================================
// CANDLE FEATURES
// ============================================================

function candleFeatures(candles) {
  const c =
    candles[candles.length - 1];

  const p =
    candles[candles.length - 2];

  const range =
    Math.max(
      c.high - c.low,
      0.0000001
    );

  const body =
    Math.abs(
      c.close - c.open
    );

  const upperWick =
    c.high -
    Math.max(
      c.open,
      c.close
    );

  const lowerWick =
    Math.min(
      c.open,
      c.close
    ) -
    c.low;

  return {
    bullish:
      c.close > c.open,

    bearish:
      c.close < c.open,

    bodyRatio:
      body / range,

    upperWickRatio:
      upperWick / range,

    lowerWickRatio:
      lowerWick / range,

    closeLocation:
      (c.close - c.low) /
      range,

    previousBullish:
      p.close > p.open,

    previousBearish:
      p.close < p.open,

    bullishEngulfing:
      c.close > c.open &&
      p.close < p.open &&
      c.close >= p.open &&
      c.open <= p.close,

    bearishEngulfing:
      c.close < c.open &&
      p.close > p.open &&
      c.open >= p.close &&
      c.close <= p.open
  };
}

// ============================================================
// MARKET STRUCTURE
// ============================================================

function recentHigh(candles, count = 20) {
  const slice =
    candles.slice(-count);

  return Math.max(
    ...slice.map(x => x.high)
  );
}

function recentLow(candles, count = 20) {
  const slice =
    candles.slice(-count);

  return Math.min(
    ...slice.map(x => x.low)
  );
}

function averageRange(candles, count = 14) {
  const slice =
    candles.slice(-count);

  if (!slice.length) return 0;

  return (
    slice.reduce(
      (sum, c) =>
        sum +
        (c.high - c.low),
      0
    ) /
    slice.length
  );
}

// ============================================================
// INDICATOR SNAPSHOT
// ============================================================

function analyzeCandles(candles) {
  const closes =
    candles.map(x => x.close);

  const e20 =
    ema(closes, 20);

  const e50 =
    ema(closes, 50);

  const e200 =
    ema(closes, 200);

  const rsiValues =
    rsi(closes, 14);

  const atrValues =
    atr(candles, CONFIG.ATR_PERIOD);

  const macdValues =
    macd(closes);

  const adxValues =
    adx(candles, 14);

  const i =
    candles.length - 1;

  const prev =
    Math.max(0, i - 1);

  const price =
    closes[i];

  const atrNow =
    num(atrValues[i]);

  const adxNow =
    num(adxValues.adx[i]);

  const adxPrev =
    num(adxValues.adx[prev]);

  const plusDI =
    num(adxValues.plusDI[i]);

  const minusDI =
    num(adxValues.minusDI[i]);

  const macdLine =
    num(macdValues.line[i]);

  const macdSignal =
    num(macdValues.signal[i]);

  const histogram =
    num(macdValues.histogram[i]);

  const histogramPrev =
    num(macdValues.histogram[prev]);

  const rsiNow =
    num(rsiValues[i]);

  const candle =
    candleFeatures(candles);

  return {
    price,

    ema20: num(e20[i]),
    ema50: num(e50[i]),
    ema200: num(e200[i]),

    previousEma20:
      num(e20[prev]),

    previousEma50:
      num(e50[prev]),

    rsi: rsiNow,

    atr: atrNow,

    adx: adxNow,
    adxPrevious: adxPrev,
    adxSlope:
      adxNow - adxPrev,

    plusDI,
    minusDI,

    diSpread:
      Math.abs(
        plusDI - minusDI
      ),

    macdLine,
    macdSignal,
    macdHistogram:
      histogram,

    macdHistogramPrevious:
      histogramPrev,

    candle,

    high20:
      recentHigh(candles, 20),

    low20:
      recentLow(candles, 20),

    high10:
      recentHigh(candles, 10),

    low10:
      recentLow(candles, 10),

    averageRange:
      averageRange(candles, 14)
  };
}

// ============================================================
// TREND DIRECTION
// ============================================================

function trendDirection(a) {
  let bull = 0;
  let bear = 0;

  if (a.price > a.ema20) bull += 1;
  else bear += 1;

  if (a.ema20 > a.ema50) bull += 1;
  else bear += 1;

  if (a.ema50 > a.ema200) bull += 1;
  else bear += 1;

  if (
    a.ema20 >
    a.previousEma20
  ) bull += 1;
  else bear += 1;

  if (
    a.ema50 >
    a.previousEma50
  ) bull += 1;
  else bear += 1;

  if (
    a.macdHistogram > 0
  ) bull += 1;
  else bear += 1;

  if (a.rsi >= 50) bull += 1;
  else bear += 1;

  return {
    direction:
      bull > bear
        ? "BUY"
        : bear > bull
          ? "SELL"
          : "NEUTRAL",

    bull,
    bear
  };
}

// ============================================================
// SCORE ENGINE
// ============================================================

function calculateDirectionScore(
  fast,
  slow,
  direction
) {
  let score = 0;

  const tFast =
    trendDirection(fast);

  const tSlow =
    trendDirection(slow);

  // ----------------------------------------------------------
  // 1. FAST TREND — 20
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (fast.price > fast.ema20)
      score += 4;

    if (fast.ema20 > fast.ema50)
      score += 4;

    if (fast.ema50 > fast.ema200)
      score += 4;

    if (fast.ema20 > fast.previousEma20)
      score += 3;

    if (fast.ema50 > fast.previousEma50)
      score += 3;

    if (tFast.direction === "BUY")
      score += 2;
  }

  if (direction === "SELL") {
    if (fast.price < fast.ema20)
      score += 4;

    if (fast.ema20 < fast.ema50)
      score += 4;

    if (fast.ema50 < fast.ema200)
      score += 4;

    if (fast.ema20 < fast.previousEma20)
      score += 3;

    if (fast.ema50 < fast.previousEma50)
      score += 3;

    if (tFast.direction === "SELL")
      score += 2;
  }

  // ----------------------------------------------------------
  // 2. SLOW TREND — 20
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (slow.price > slow.ema20)
      score += 4;

    if (slow.ema20 > slow.ema50)
      score += 4;

    if (slow.ema50 > slow.ema200)
      score += 4;

    if (slow.ema20 > slow.previousEma20)
      score += 3;

    if (slow.ema50 > slow.previousEma50)
      score += 3;

    if (tSlow.direction === "BUY")
      score += 2;
  }

  if (direction === "SELL") {
    if (slow.price < slow.ema20)
      score += 4;

    if (slow.ema20 < slow.ema50)
      score += 4;

    if (slow.ema50 < slow.ema200)
      score += 4;

    if (slow.ema20 < slow.previousEma20)
      score += 3;

    if (slow.ema50 < slow.previousEma50)
      score += 3;

    if (tSlow.direction === "SELL")
      score += 2;
  }

  // ----------------------------------------------------------
  // 3. RSI — 15
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (
      fast.rsi >= 52 &&
      fast.rsi <= 68
    ) {
      score += 10;
    } else if (
      fast.rsi > 50 &&
      fast.rsi < 72
    ) {
      score += 6;
    }

    if (
      slow.rsi >= 50 &&
      slow.rsi <= 70
    ) {
      score += 5;
    }
  }

  if (direction === "SELL") {
    if (
      fast.rsi <= 48 &&
      fast.rsi >= 32
    ) {
      score += 10;
    } else if (
      fast.rsi < 50 &&
      fast.rsi > 28
    ) {
      score += 6;
    }

    if (
      slow.rsi <= 50 &&
      slow.rsi >= 30
    ) {
      score += 5;
    }
  }

  // ----------------------------------------------------------
  // 4. MACD — 15
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (
      fast.macdLine >
      fast.macdSignal
    ) {
      score += 6;
    }

    if (
      fast.macdHistogram > 0
    ) {
      score += 4;
    }

    if (
      fast.macdHistogram >
      fast.macdHistogramPrevious
    ) {
      score += 3;
    }

    if (
      slow.macdHistogram > 0
    ) {
      score += 2;
    }
  }

  if (direction === "SELL") {
    if (
      fast.macdLine <
      fast.macdSignal
    ) {
      score += 6;
    }

    if (
      fast.macdHistogram < 0
    ) {
      score += 4;
    }

    if (
      fast.macdHistogram <
      fast.macdHistogramPrevious
    ) {
      score += 3;
    }

    if (
      slow.macdHistogram < 0
    ) {
      score += 2;
    }
  }

  // ----------------------------------------------------------
  // 5. ADX / DI — 15
  // ----------------------------------------------------------

  if (
    fast.adx >= CONFIG.MIN_ADX
  ) {
    score += 5;
  }

  if (
    slow.adx >= CONFIG.MIN_SLOW_ADX
  ) {
    score += 4;
  }

  if (
    fast.adxSlope >=
    CONFIG.MIN_ADX_SLOPE
  ) {
    score += 2;
  }

  if (
    direction === "BUY" &&
    fast.plusDI >
      fast.minusDI
  ) {
    score += 4;
  }

  if (
    direction === "SELL" &&
    fast.minusDI >
      fast.plusDI
  ) {
    score += 4;
  }

  // ----------------------------------------------------------
  // 6. CANDLE CONFIRMATION — 10
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (fast.candle.bullish)
      score += 3;

    if (
      fast.candle.bodyRatio >= 0.45
    ) {
      score += 2;
    }

    if (
      fast.candle.closeLocation >=
      0.60
    ) {
      score += 2;
    }

    if (
      fast.candle.bullishEngulfing
    ) {
      score += 3;
    }
  }

  if (direction === "SELL") {
    if (fast.candle.bearish)
      score += 3;

    if (
      fast.candle.bodyRatio >= 0.45
    ) {
      score += 2;
    }

    if (
      fast.candle.closeLocation <=
      0.40
    ) {
      score += 2;
    }

    if (
      fast.candle.bearishEngulfing
    ) {
      score += 3;
    }
  }

  return clamp(
    Math.round(score),
    0,
    100
  );
}

// ============================================================
// MOMENTUM
// ============================================================

function momentumPercent(candles, lookback = 5) {
  if (
    candles.length <= lookback
  ) {
    return 0;
  }

  const current =
    candles[candles.length - 1]
      .close;

  const previous =
    candles[candles.length - 1 - lookback]
      .close;

  if (!previous) return 0;

  return (
    (current - previous) /
    previous
  ) * 100;
}

// ============================================================
// PULLBACK / ANTI-CHASE
// ============================================================

function pullbackState(a, direction) {
  const price = a.price;
  const atrValue =
    Math.max(a.atr, 0.0001);

  if (direction === "BUY") {
    const distance =
      price - a.ema20;

    const distanceAbs =
      Math.abs(distance);

    const nearEma =
      distanceAbs <=
      atrValue *
      CONFIG.EMA_TOLERANCE_ATR;

    const aboveEma =
      price >= a.ema20;

    return {
      nearEma,
      aboveEma,
      distanceATR:
        distanceAbs / atrValue
    };
  }

  const distance =
    price - a.ema20;

  const distanceAbs =
    Math.abs(distance);

  const nearEma =
    distanceAbs <=
    atrValue *
    CONFIG.EMA_TOLERANCE_ATR;

  const belowEma =
    price <= a.ema20;

  return {
    nearEma,
    belowEma,
    distanceATR:
      distanceAbs / atrValue
  };
}

function antiChase(a, direction) {
  const atrValue =
    Math.max(a.atr, 0.0001);

  if (direction === "BUY") {
    const distance =
      a.price - a.ema20;

    return (
      distance >
      atrValue *
      CONFIG.ANTI_CHASE_ATR
    );
  }

  const distance =
    a.ema20 - a.price;

  return (
    distance >
    atrValue *
    CONFIG.ANTI_CHASE_ATR
  );
}

// ============================================================
// SIGNAL GENERATION
// ============================================================

function generateSignal(
  fastCandles,
  slowCandles
) {
  const fast =
    analyzeCandles(fastCandles);

  const slow =
    analyzeCandles(slowCandles);

  fast.__candles =
    fastCandles;

  slow.__candles =
    slowCandles;

  const buyScore =
    calculateDirectionScore(
      fast,
      slow,
      "BUY"
    );

  const sellScore =
    calculateDirectionScore(
      fast,
      slow,
      "SELL"
    );

  const direction =
    buyScore > sellScore
      ? "BUY"
      : sellScore > buyScore
        ? "SELL"
        : "WAIT";

  const topScore =
    Math.max(
      buyScore,
      sellScore
    );

  const otherScore =
    Math.min(
      buyScore,
      sellScore
    );

  const lead =
    topScore -
    otherScore;

  const momentum =
    momentumPercent(
      fastCandles,
      5
    );

  const slowTrend =
    trendDirection(slow);

  const fastTrend =
    trendDirection(fast);

  let status =
    direction;

  const reasons = [];

  // ----------------------------------------------------------
  // SESSION
  // ----------------------------------------------------------

  if (!sessionOpen()) {
    status = "WAIT";

    reasons.push(
      "خارج از سشن معاملاتی"
    );
  }

  // ----------------------------------------------------------
  // DATA QUALITY
  // ----------------------------------------------------------

  // handled before this function normally,
  // but keep a safety check here.

  // ----------------------------------------------------------
  // ADX
  // ----------------------------------------------------------

  if (
    fast.adx <
    CONFIG.MIN_ADX
  ) {
    status = "WAIT";

    reasons.push(
      "ADX تایم 15 دقیقه ضعیف است"
    );
  }

  if (
    slow.adx <
    CONFIG.MIN_SLOW_ADX
  ) {
    status = "WAIT";

    reasons.push(
      "ADX تایم 1 ساعت ضعیف است"
    );
  }

  // ----------------------------------------------------------
  // DIRECTION LEAD
  // ----------------------------------------------------------

  if (
    lead <
    CONFIG.MIN_DIRECTION_LEAD
  ) {
    status = "WAIT";

    reasons.push(
      "اختلاف BUY/SELL کافی نیست"
    );
  }

  // ----------------------------------------------------------
  // SCORE
  // ----------------------------------------------------------

  if (
    topScore <
    CONFIG.MIN_SCORE
  ) {
    status = "WAIT";

    reasons.push(
      `امتیاز کمتر از ${CONFIG.MIN_SCORE}`
    );
  }

  // ----------------------------------------------------------
  // SLOW CONFLUENCE
  // ----------------------------------------------------------

  if (
    slowTrend.direction !==
    direction
  ) {
    status = "WAIT";

    reasons.push(
      "تایم 1 ساعته هم‌جهت نیست"
    );
  }

  // ----------------------------------------------------------
  // DI
  // ----------------------------------------------------------

  if (
    fast.diSpread <
    CONFIG.MIN_DI_SPREAD
  ) {
    status = "WAIT";

    reasons.push(
      "DI Spread کافی نیست"
    );
  }

  if (
    slow.diSpread <
    CONFIG.MIN_SLOW_DI_SPREAD
  ) {
    status = "WAIT";

    reasons.push(
      "DI Spread تایم 1H کافی نیست"
    );
  }

  // ----------------------------------------------------------
  // MOMENTUM
  // ----------------------------------------------------------

  const momentumAbs =
    Math.abs(momentum);

  if (
    momentumAbs <
    CONFIG.MIN_MOMENTUM
  ) {
    status = "WAIT";

    reasons.push(
      "Momentum کافی نیست"
    );
  }

  // ----------------------------------------------------------
  // DIRECTION MOMENTUM
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (
      momentum < 0
    ) {
      status = "WAIT";

      reasons.push(
        "Momentum خلاف BUY است"
      );
    }
  }

  if (direction === "SELL") {
    if (
      momentum > 0
    ) {
      status = "WAIT";

      reasons.push(
        "Momentum خلاف SELL است"
      );
    }
  }

  // ----------------------------------------------------------
  // ANTI CHASE
  // ----------------------------------------------------------

  const chased =
    antiChase(
      fast,
      direction
    );

  if (
    direction !== "WAIT" &&
    chased
  ) {
    status = "WAIT";

    reasons.push(
      "قیمت بیش از حد از EMA فاصله گرفته"
    );
  }

  // ----------------------------------------------------------
  // CANDLE
  // ----------------------------------------------------------

  if (direction === "BUY") {
    if (
      !fast.candle.bullish &&
      !fast.candle.bullishEngulfing
    ) {
      status = "WAIT";

      reasons.push(
        "تأیید کندلی BUY ضعیف است"
      );
    }
  }

  if (direction === "SELL") {
    if (
      !fast.candle.bearish &&
      !fast.candle.bearishEngulfing
    ) {
      status = "WAIT";

      reasons.push(
        "تأیید کندلی SELL ضعیف است"
      );
    }
  }

  // ----------------------------------------------------------
  // PULLBACK
  // ----------------------------------------------------------

  const pullback =
    pullbackState(
      fast,
      direction
    );

  // We don't require a perfect EMA touch,
  // but avoid extremely extended entries.

  if (
    direction !== "WAIT" &&
    pullback.distanceATR >
    CONFIG.MAX_PULLBACK_ATR
  ) {
    reasons.push(
      "ورود نزدیک EMA نیست؛ احتیاط"
    );
  }

  if (
    !reasons.length
  ) {
    reasons.push(
      "تمام فیلترهای اصلی تأیید شدند"
    );
  }

  return {
    status,

    direction,

    buyScore,
    sellScore,

    score: topScore,
    lead,

    price:
      fast.price,

    momentum:
      round(momentum, 4),

    fast,
    slow,

    fastTrend:
      fastTrend.direction,

    slowTrend:
      slowTrend.direction,

    reasons,

    pullback,

    chased,

    timestamp:
      new Date().toISOString()
  };
}

// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(signal) {
  if (
    signal.status !== "BUY" &&
    signal.status !== "SELL"
  ) {
    return null;
  }

  const fast =
    signal.fast;

  const candles =
    fast.__candles;

  const price =
    fast.price;

  const atrValue =
    Math.max(
      fast.atr,
      0.01
    );

  const structureBuffer =
    atrValue *
    CONFIG.STRUCTURE_BUFFER_ATR;

  let sl;
  let risk;

  if (signal.status === "BUY") {
    const structureLow =
      recentLow(
        candles,
        10
      );

    const atrStop =
      price -
      atrValue *
      CONFIG.SL_ATR;

    const structureStop =
      structureLow -
      structureBuffer;

    sl =
      Math.min(
        atrStop,
        structureStop
      );

    risk =
      price - sl;

    if (
      risk <= 0 ||
      !Number.isFinite(risk)
    ) {
      return null;
    }

    const tp1 =
      price +
      risk *
      CONFIG.TP1_R;

    const tp2 =
      price +
      risk *
      CONFIG.TP2_R;

    const tp3 =
      price +
      risk *
      CONFIG.TP3_R;

    return {
      side: "BUY",
      entry: round(price, 2),
      sl: round(sl, 2),
      tp1: round(tp1, 2),
      tp2: round(tp2, 2),
      tp3: round(tp3, 2),
      risk: round(risk, 2),
      rr1: CONFIG.TP1_R,
      rr2: CONFIG.TP2_R,
      rr3: CONFIG.TP3_R,
      breakEven:
        round(
          price +
          risk *
          CONFIG.BREAK_EVEN_R,
          2
        ),
      profitLock:
        round(
          price +
          risk *
          CONFIG.PROFIT_LOCK_R,
          2
        )
    };
  }

  const structureHigh =
    recentHigh(
      candles,
      10
    );

  const atrStop =
    price +
    atrValue *
    CONFIG.SL_ATR;

  const structureStop =
    structureHigh +
    structureBuffer;

  sl =
    Math.max(
      atrStop,
      structureStop
    );

  risk =
    sl - price;

  if (
    risk <= 0 ||
    !Number.isFinite(risk)
  ) {
    return null;
  }

  const tp1 =
    price -
    risk *
    CONFIG.TP1_R;

  const tp2 =
    price -
    risk *
    CONFIG.TP2_R;

  const tp3 =
    price -
    risk *
    CONFIG.TP3_R;

  return {
    side: "SELL",
    entry: round(price, 2),
    sl: round(sl, 2),
    tp1: round(tp1, 2),
    tp2: round(tp2, 2),
    tp3: round(tp3, 2),
    risk: round(risk, 2),
    rr1: CONFIG.TP1_R,
    rr2: CONFIG.TP2_R,
    rr3: CONFIG.TP3_R,
    breakEven:
      round(
        price -
        risk *
        CONFIG.BREAK_EVEN_R,
        2
      ),
    profitLock:
      round(
        price -
        risk *
        CONFIG.PROFIT_LOCK_R,
        2
      )
  };
}

// ============================================================
// TELEGRAM
// ============================================================

async function telegramRequest(
  method,
  env,
  body
) {
  const token =
    getTelegramToken(env);

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing"
    );
  }

  const url =
    `https://api.telegram.org/bot${token}/${method}`;

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type":
          "application/json"
      },
      body: JSON.stringify(body)
    });

  const data =
    await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram error: ${
        data.description ||
        response.status
      }`
    );
  }

  return data;
}

async function sendTelegram(
  env,
  message
) {
  if (
    !CONFIG.TELEGRAM_ENABLED
  ) {
    return {
      ok: false,
      skipped: true
    };
  }

  const chatId =
    getTelegramChatId(env);

  if (!chatId) {
    throw new Error(
      "TELEGRAM_CHAT_ID is missing"
    );
  }

  return telegramRequest(
    "sendMessage",
    env,
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }
  );
}

// ============================================================
// TELEGRAM FORMAT
// ============================================================

function signalEmoji(status) {
  if (status === "BUY")
    return "🟢";

  if (status === "SELL")
    return "🔴";

  return "⏸";
}

function formatSignalMessage(
  signal,
  plan
) {
  const emoji =
    signalEmoji(signal.status);

  let message =
`💎 <b>HAKIM GOLD SIGNALS ${CONFIG.VERSION}</b>

${emoji} <b>${signal.status}</b>
<b>${safeString(CONFIG.SYMBOL)}</b>

⭐ <b>Score:</b> ${signal.score}/100
🟢 <b>Buy Score:</b> ${signal.buyScore}
🔴 <b>Sell Score:</b> ${signal.sellScore}
📐 <b>Direction Lead:</b> ${signal.lead}

💰 <b>Price:</b> ${round(signal.price, 2)}
📊 <b>15M:</b> ${safeString(signal.fastTrend)}
🕐 <b>1H:</b> ${safeString(signal.slowTrend)}

📈 <b>15M ADX:</b> ${round(signal.fast.adx, 1)}
↔️ <b>15M DI Spread:</b> ${round(signal.fast.diSpread, 1)}
📉 <b>RSI:</b> ${round(signal.fast.rsi, 1)}
📊 <b>ATR:</b> ${round(signal.fast.atr, 2)}

⚡ <b>Momentum:</b> ${round(signal.momentum, 4)}%`;

  if (plan) {
    message += `

━━━━━━━━━━━━━━
🎯 <b>TRADE PLAN</b>

📍 <b>Entry:</b> ${plan.entry}
🛑 <b>SL:</b> ${plan.sl}

🥇 <b>TP1:</b> ${plan.tp1}
🥈 <b>TP2:</b> ${plan.tp2}
🥉 <b>TP3:</b> ${plan.tp3}

⚖️ <b>Risk:</b> ${plan.risk}
📐 <b>RR:</b> ${plan.rr1} / ${plan.rr2} / ${plan.rr3}

🔒 <b>BE:</b> ${plan.breakEven}
💰 <b>Profit Lock:</b> ${plan.profitLock}`;
  }

  message += `

━━━━━━━━━━━━━━
🧠 <b>Reason:</b>
${signal.reasons
  .slice(0, 5)
  .map(x => `• ${safeString(x)}`)
  .join("\n")}

⏱ <b>UTC:</b> ${new Date()
    .toISOString()
    .replace("T", " ")
    .slice(0, 19)}

🤖 <b>FOREX SIGNAL ENGINE</b>`;

  return message;
}

// ============================================================
// DUPLICATE PROTECTION
// ============================================================

async function signalFingerprint(
  signal,
  plan
) {
  return [
    CONFIG.SYMBOL,
    signal.status,
    round(signal.price, 1),
    signal.score,
    signal.lead,
    plan
      ? plan.sl
      : "",
    plan
      ? plan.tp1
      : ""
  ].join("|");
}

async function shouldSendSignal(
  env,
  signal,
  plan
) {
  if (!env.SIGNAL_KV) {
    return true;
  }

  const fingerprint =
    await signalFingerprint(
      signal,
      plan
    );

  const key =
    `signal:${fingerprint}`;

  const existing =
    await env.SIGNAL_KV.get(key);

  if (existing) {
    return false;
  }

  await env.SIGNAL_KV.put(
    key,
    new Date().toISOString(),
    {
      expirationTtl:
        CONFIG.DUPLICATE_TTL_SECONDS
    }
  );

  return true;
}

// ============================================================
// DATABASE LOGGING
// ============================================================

async function logSignal(
  env,
  signal,
  plan,
  sent
) {
  if (!env.DB) return;

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        status TEXT,
        score REAL,
        buy_score REAL,
        sell_score REAL,
        lead REAL,
        price REAL,
        sl REAL,
        tp1 REAL,
        tp2 REAL,
        tp3 REAL,
        telegram_sent INTEGER,
        created_at TEXT
      )
    `).run();

    await env.DB.prepare(`
      INSERT INTO signal_events (
        symbol,
        status,
        score,
        buy_score,
        sell_score,
        lead,
        price,
        sl,
        tp1,
        tp2,
        tp3,
        telegram_sent,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        CONFIG.SYMBOL,
        signal.status,
        signal.score,
        signal.buyScore,
        signal.sellScore,
        signal.lead,
        signal.price,
        plan?.sl ?? null,
        plan?.tp1 ?? null,
        plan?.tp2 ?? null,
        plan?.tp3 ?? null,
        sent ? 1 : 0,
        new Date().toISOString()
      )
      .run();
  } catch (error) {
    console.log(
      "DB log error:",
      error.message
    );
  }
}

// ============================================================
// ENGINE RUN
// ============================================================

async function runEngine(
  env,
  options = {}
) {
  const fastCandles =
    await loadCandles(
      CONFIG.FAST_INTERVAL,
      CONFIG.FAST_OUTPUTSIZE,
      env
    );

  const slowCandles =
    await loadCandles(
      CONFIG.SLOW_INTERVAL,
      CONFIG.SLOW_OUTPUTSIZE,
      env
    );

  const fastFresh =
    freshnessInfo(
      fastCandles,
      CONFIG.FAST_INTERVAL
    );

  const slowFresh =
    freshnessInfo(
      slowCandles,
      CONFIG.SLOW_INTERVAL
    );

  if (!fastFresh.fresh) {
    throw new Error(
      `15M data stale: ${fastFresh.age}s`
    );
  }

  if (!slowFresh.fresh) {
    throw new Error(
      `1H data stale: ${slowFresh.age}s`
    );
  }

  const signal =
    generateSignal(
      fastCandles,
      slowCandles
    );

  const plan =
    buildTradePlan(signal);

  const message =
    formatSignalMessage(
      signal,
      plan
    );

  let telegramSent =
    false;

  let duplicate =
    false;

  const shouldNotify =
    options.forceTelegram ||
    signal.status !== "WAIT" ||
    options.sendWait === true;

  if (
    shouldNotify &&
    CONFIG.TELEGRAM_ENABLED
  ) {
    const allowed =
      options.forceTelegram
        ? true
        : await shouldSendSignal(
            env,
            signal,
            plan
          );

    if (allowed) {
      await sendTelegram(
        env,
        message
      );

      telegramSent = true;
    } else {
      duplicate = true;
    }
  }

  await logSignal(
    env,
    signal,
    plan,
    telegramSent
  );

  return {
    ok: true,
    version: CONFIG.VERSION,
    symbol: CONFIG.SYMBOL,

    signal,

    plan,

    telegramSent,
    duplicate,

    data: {
      fast: {
        candles:
          fastCandles.length,
        age:
          fastFresh.age,
        bucketFresh:
          fastFresh.bucketFresh
      },

      slow: {
        candles:
          slowCandles.length,
        age:
          slowFresh.age,
        bucketFresh:
          slowFresh.bucketFresh
      }
    },

    generatedAt:
      new Date().toISOString()
  };
}

// ============================================================
// STATUS
// ============================================================

async function getStatus(env) {
  const telegram =
    Boolean(
      getTelegramToken(env) &&
      getTelegramChatId(env)
    );

  const twelve =
    Boolean(
      getTwelveDataKey(env)
    );

  return {
    ok: true,

    version:
      CONFIG.VERSION,

    project:
      "موتور سیگنال فارکس",

    symbol:
      CONFIG.SYMBOL,

    telegram:
      telegram
        ? "CONNECTED"
        : "NOT_CONFIGURED",

    twelveData:
      twelve
        ? "CONFIGURED"
        : "NOT_CONFIGURED",

    session:
      sessionOpen()
        ? "OPEN"
        : "CLOSED",

    utc:
      new Date().toISOString(),

    configuration: {
      minScore:
        CONFIG.MIN_SCORE,

      minDirectionLead:
        CONFIG.MIN_DIRECTION_LEAD,

      minADX:
        CONFIG.MIN_ADX,

      minSlowADX:
        CONFIG.MIN_SLOW_ADX,

      minRR:
        CONFIG.MIN_RR,

      session:
        `${CONFIG.SESSION_START_UTC}:00-${CONFIG.SESSION_END_UTC}:00 UTC`,

      fast:
        CONFIG.FAST_INTERVAL,

      slow:
        CONFIG.SLOW_INTERVAL
    }
  };
}

// ============================================================
// TELEGRAM TEST
// ============================================================

async function telegramTest(env) {
  const message =
`✅ <b>HAKIM GOLD SIGNALS</b>

🟢 Telegram connection OK

🤖 Engine:
${CONFIG.VERSION}

💰 Symbol:
${CONFIG.SYMBOL}

⏱ UTC:
${new Date()
  .toISOString()
  .replace("T", " ")
  .slice(0, 19)}`;

  const result =
    await sendTelegram(
      env,
      message
    );

  return {
    ok: true,
    telegram: result
  };
}

// ============================================================
// TELEGRAM STATUS
// ============================================================

async function telegramStatus(env) {
  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  if (!token) {
    return {
      ok: false,
      configured: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing"
    };
  }

  try {
    const result =
      await telegramRequest(
        "getMe",
        env,
        {}
      );

    return {
      ok: true,
      configured: true,
      chatIdConfigured:
        Boolean(chatId),
      bot:
        result.result
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      chatIdConfigured:
        Boolean(chatId),
      error:
        error.message
    };
  }
}

// ============================================================
// TELEGRAM WEBHOOK INFO
// ============================================================

async function telegramWebhookInfo(
  env
) {
  return telegramRequest(
    "getWebhookInfo",
    env,
    {}
  );
}

// ============================================================
// TELEGRAM SET WEBHOOK
// ============================================================

async function telegramSetWebhook(
  request,
  env
) {
  const body =
    await request.json()
      .catch(() => ({}));

  const url =
    String(
      body.url ||
      new URL(request.url)
        .origin +
        "/telegram-webhook"
    );

  return telegramRequest(
    "setWebhook",
    env,
    {
      url
    }
  );
}

// ============================================================
// TELEGRAM COMMAND PARSER
// ============================================================

async function telegramWebhook(
  request,
  env
) {
  const update =
    await request.json()
      .catch(() => null);

  if (!update) {
    return json({
      ok: false
    }, 400);
  }

  const message =
    update.message;

  if (!message) {
    return json({
      ok: true
    });
  }

  const chatId =
    message.chat?.id;

  const incoming =
    String(
      message.text || ""
    )
      .trim()
      .toLowerCase();

  if (!chatId) {
    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // /start
  // ----------------------------------------------------------

  if (
    incoming === "/start"
  ) {
    await telegramRequest(
      "sendMessage",
      env,
      {
        chat_id: chatId,
        text:
`💎 <b>HAKIM GOLD SIGNALS</b>

ربات تحلیل XAU/USD فعال است.

دستورات:

/status
/signal
/test
/news`,
        parse_mode: "HTML"
      }
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // /status
  // ----------------------------------------------------------

  if (
    incoming === "/status"
  ) {
    const status =
      await getStatus(env);

    await telegramRequest(
      "sendMessage",
      env,
      {
        chat_id: chatId,
        text:
`💎 <b>HAKIM GOLD SIGNALS</b>

📡 Telegram:
${status.telegram}

📊 Twelve Data:
${status.twelveData}

🟢 Session:
${status.session}

💰 Symbol:
${status.symbol}

⚙️ Version:
${status.version}

⏱ UTC:
${status.utc}`,
        parse_mode: "HTML"
      }
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // /signal
  // ----------------------------------------------------------

  if (
    incoming === "/signal"
  ) {
    try {
      const result =
        await runEngine(
          env,
          {
            forceTelegram: false,
            sendWait: false
          }
        );

      await telegramRequest(
        "sendMessage",
        env,
        {
          chat_id: chatId,
          text:
            formatSignalMessage(
              result.signal,
              result.plan
            ),
          parse_mode: "HTML"
        }
      );

      return json({
        ok: true
      });
    } catch (error) {
      await telegramRequest(
        "sendMessage",
        env,
        {
          chat_id: chatId,
          text:
`❌ <b>ENGINE ERROR</b>

${safeString(
  error.message
)}`,
          parse_mode: "HTML"
        }
      );

      return json({
        ok: false,
        error:
          error.message
      });
    }
  }

  // ----------------------------------------------------------
  // /test
  // ----------------------------------------------------------

  if (
    incoming === "/test"
  ) {
    await telegramRequest(
      "sendMessage",
      env,
      {
        chat_id: chatId,
        text:
`🧪 <b>TEST</b>

${CONFIG.VERSION}

XAU/USD

Telegram webhook فعال است.`,
        parse_mode: "HTML"
      }
    );

    return json({
      ok: true
    });
  }

  // ----------------------------------------------------------
  // /news
  // ----------------------------------------------------------

  if (
    incoming === "/news"
  ) {
    await telegramRequest(
      "sendMessage",
      env,
      {
        chat_id: chatId,
        text:
`📰 <b>NEWS</b>

News filter در نسخه فعلی غیرفعال است.

NEWS_ENABLED:
${CONFIG.NEWS_ENABLED}`,
        parse_mode: "HTML"
      }
    );

    return json({
      ok: true
    });
  }

  return json({
    ok: true
  });
}

// ============================================================
// API CONFIG
// ============================================================

async function configResponse() {
  return {
    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    timeframes: {
      fast:
        CONFIG.FAST_INTERVAL,
      slow:
        CONFIG.SLOW_INTERVAL
    },

    filters: {
      minScore:
        CONFIG.MIN_SCORE,

      minDirectionLead:
        CONFIG.MIN_DIRECTION_LEAD,

      minADX:
        CONFIG.MIN_ADX,

      minSlowADX:
        CONFIG.MIN_SLOW_ADX,

      minRR:
        CONFIG.MIN_RR,

      minMomentum:
        CONFIG.MIN_MOMENTUM
    },

    trade: {
      slATR:
        CONFIG.SL_ATR,

      tp1R:
        CONFIG.TP1_R,

      tp2R:
        CONFIG.TP2_R,

      tp3R:
        CONFIG.TP3_R,

      breakEvenR:
        CONFIG.BREAK_EVEN_R,

      profitLockR:
        CONFIG.PROFIT_LOCK_R
    },

    session: {
      startUTC:
        CONFIG.SESSION_START_UTC,

      endUTC:
        CONFIG.SESSION_END_UTC
    }
  };
}

// ============================================================
// HTTP HANDLER
// ============================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      const url =
        new URL(request.url);

      const path =
        url.pathname;

      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        path === "/" ||
        path === ""
      ) {
        return text(
`HAKIM GOLD SIGNALS ${CONFIG.VERSION}

XAU/USD Signal Engine

Endpoints:

/health
/status
/config
/api/signals
/signal
/run-now
/telegram-test
/telegram-status
/telegram-webhook-info
/telegram-set-webhook
/telegram-webhook`
        );
      }

      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        path === "/health"
      ) {
        return json({
          ok: true,
          service:
            "forex-signal-engine",
          version:
            CONFIG.VERSION,
          symbol:
            CONFIG.SYMBOL,
          time:
            new Date().toISOString()
        });
      }

      // ------------------------------------------------------
      // STATUS
      // ------------------------------------------------------

      if (
        path === "/status"
      ) {
        return json(
          await getStatus(env)
        );
      }

      // ------------------------------------------------------
      // CONFIG
      // ------------------------------------------------------

      if (
        path === "/config"
      ) {
        return json(
          await configResponse()
        );
      }

      // ------------------------------------------------------
      // API SIGNALS
      // ------------------------------------------------------

      if (
        path === "/api/signals" ||
        path === "/signal"
      ) {
        const result =
          await runEngine(
            env,
            {
              forceTelegram: false,
              sendWait: false
            }
          );

        return json(
          result
        );
      }

      // ------------------------------------------------------
      // RUN NOW
      // ------------------------------------------------------

      if (
        path === "/run-now"
      ) {
        const result =
          await runEngine(
            env,
            {
              forceTelegram: true,
              sendWait: true
            }
          );

        return json(
          result
        );
      }

      // ------------------------------------------------------
      // TELEGRAM TEST
      // ------------------------------------------------------

      if (
        path === "/telegram-test"
      ) {
        const result =
          await telegramTest(env);

        return json(
          result
        );
      }

      // ------------------------------------------------------
      // TELEGRAM STATUS
      // ------------------------------------------------------

      if (
        path === "/telegram-status"
      ) {
        return json(
          await telegramStatus(env)
        );
      }

      // ------------------------------------------------------
      // WEBHOOK INFO
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-webhook-info"
      ) {
        return json(
          await telegramWebhookInfo(
            env
          )
        );
      }

      // ------------------------------------------------------
      // SET WEBHOOK
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-set-webhook"
      ) {
        return json(
          await telegramSetWebhook(
            request,
            env
          )
        );
      }

      // ------------------------------------------------------
      // WEBHOOK
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-webhook"
      ) {
        return await telegramWebhook(
          request,
          env
        );
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      return json({
        ok: false,
        error: "Not found",
        path
      }, 404);

    } catch (error) {
      console.log(
        "Worker error:",
        error.message
      );

      return json({
        ok: false,
        error:
          error.message ||
          "Unknown error",
        version:
          CONFIG.VERSION
      }, 500);
    }
  },

  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          console.log(
            "FOREX SIGNAL ENGINE CRON:",
            controller.cron
          );

          const result =
            await runEngine(
              env,
              {
                forceTelegram: false,
                sendWait: true
              }
            );

          console.log(
            "CRON RESULT:",
            JSON.stringify({
              status:
                result.signal.status,
              score:
                result.signal.score,
              lead:
                result.signal.lead,
              telegramSent:
                result.telegramSent
            })
          );

        } catch (error) {
          console.log(
            "CRON ERROR:",
            error.message
          );

          // Do not spam Telegram on engine errors.
        }
      })()
    );
  }
};
