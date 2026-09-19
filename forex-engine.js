// ============================================================
// FOREX SIGNAL ENGINE V6.9.1 — GOLD QUALITY
// Cloudflare Worker + Twelve Data + Telegram
//
// PRIMARY: XAU/USD
// TIMEFRAMES: 15M + 1H
//
// V6.9.1:
// - Twelve Data rate-limit protection
// - 15M memory cache: 60s
// - 1H memory cache: 5m
// - stale-cache fallback up to 15m
// - request locks to prevent duplicate concurrent calls
// - explicit HTTP 429 handling
// - Retry-After / API-credit headers exposed in health
// - Telegram webhook commands
// - Cron signal/news support
// - Strict Gold Quality filters
//
// Cloudflare secrets/vars:
// TWELVE_DATA_API_KEY
// TELEGRAM_BOT_TOKEN
// TELEGRAM_CHAT_ID
// TELEGRAM_WEBHOOK_SECRET (optional)
//
// Optional KV binding:
// KV
// ============================================================

const CONFIG = {
  VERSION: "V6.9.1",

  SYMBOL: "XAU/USD",
  INTERVAL_FAST: "15min",
  INTERVAL_SLOW: "1h",

  OUTPUT_SIZE_FAST: 100,
  OUTPUT_SIZE_SLOW: 100,

  MIN_SCORE: 90,
  MIN_DIRECTION_LEAD: 45,

  MIN_ADX: 23,
  MIN_ADX_SLOPE: 0.5,
  MIN_SLOW_ADX: 20,
  MIN_DI_SPREAD: 6,
  MIN_MOMENTUM: 0.03,
  MIN_RR: 1.30,

  MAX_EMA20_DISTANCE_ATR: 1.8,

  ATR_SL_MULTIPLIER: 1.20,
  ATR_ENTRY_MULTIPLIER: 0.55,

  MAX_ENTRY_DISTANCE_ATR: 1.20,
  MAX_ENTRY_DISTANCE_PERCENT: 0.55,
  MIN_ENTRY_DISTANCE_ATR: 0.08,

  RSI_BULL_MIN: 53,
  RSI_BULL_MAX: 67,

  RSI_BEAR_MIN: 33,
  RSI_BEAR_MAX: 47,

  NEWS_BEFORE_MINUTES: 45,
  NEWS_AFTER_MINUTES: 30,
  NEWS_ALERT_MINUTES: 30,
  NEWS_CACHE_SECONDS: 900,
  NEWS_LOOKAHEAD_HOURS: 48,

  SIGNAL_DEDUPE_SECONDS: 21600,
  NEWS_DEDUPE_SECONDS: 86400,

  SESSION_START_UTC: 7,
  SESSION_END_UTC: 20,

  FAST_CACHE_TTL_MS: 60_000,
  SLOW_CACHE_TTL_MS: 300_000,
  STALE_MAX_MS: 900_000,

  REQUEST_TIMEOUT_MS: 12_000,

  TELEGRAM_ENABLED: true,
  TELEGRAM_SEND_SIGNAL: true,
  TELEGRAM_SEND_NEWS: true,

  FOOTER: "عبدالحکیم داودی | ترید عالی"
};


// ============================================================
// MEMORY
// ============================================================

const memory = {
  candles: {
    fast: {
      data: null,
      fetchedAt: 0,
      creditsLeft: null,
      creditsUsed: null,
      lastError: null
    },

    slow: {
      data: null,
      fetchedAt: 0,
      creditsLeft: null,
      creditsUsed: null,
      lastError: null
    }
  },

  locks: {
    fast: null,
    slow: null
  },

  news: {
    data: null,
    fetchedAt: 0,
    lastError: null
  },

  rateLimitUntil: 0,
  rateLimitRetryAfter: null
};


// ============================================================
// HELPERS
// ============================================================

function getEnv(env, key, fallback = "") {
  const value = env?.[key];

  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value);
}


function num(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = 10 ** digits;

  return Math.round(n * p) / p;
}


function safeValue(value, fallback = "-") {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return fallback;
  }

  return String(value);
}


async function fetchWithTimeout(
  url,
  options = {},
  timeout = CONFIG.REQUEST_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}


function jsonResponse(
  data,
  status = 200,
  extraHeaders = {}
) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=UTF-8",

        ...extraHeaders
      }
    }
  );
}


// ============================================================
// KV DEDUPE
// ============================================================

async function alreadySent(env, key) {
  if (!env?.KV) {
    return false;
  }

  try {
    const value = await env.KV.get(key);

    return Boolean(value);
  } catch {
    return false;
  }
}


async function markSent(
  env,
  key,
  ttlSeconds
) {
  if (!env?.KV) {
    return;
  }

  try {
    await env.KV.put(
      key,
      "1",
      {
        expirationTtl: ttlSeconds
      }
    );
  } catch {}
}


// ============================================================
// TWELVE DATA
// ============================================================

function twelveDataUrl(
  env,
  interval,
  outputsize
) {
  const apiKey =
    getEnv(env, "TWELVE_DATA_API_KEY");

  const url =
    new URL(
      "https://api.twelvedata.com/time_series"
    );

  url.searchParams.set(
    "symbol",
    CONFIG.SYMBOL
  );

  url.searchParams.set(
    "interval",
    interval
  );

  url.searchParams.set(
    "outputsize",
    String(outputsize)
  );

  url.searchParams.set(
    "apikey",
    apiKey
  );

  url.searchParams.set(
    "format",
    "JSON"
  );

  url.searchParams.set(
    "order",
    "DESC"
  );

  return url;
}


function candleCacheKey(interval) {
  return interval === CONFIG.INTERVAL_FAST
    ? "fast"
    : "slow";
}


function parseTwelveDataValues(json) {
  if (
    !json ||
    !Array.isArray(json.values) ||
    json.values.length < 30
  ) {
    throw new Error(
      json?.message ||
      "Twelve Data returned insufficient candle data."
    );
  }

  const candles =
    json.values
      .map(v => ({
        datetime: v.datetime,

        open: num(v.open, NaN),
        high: num(v.high, NaN),
        low: num(v.low, NaN),
        close: num(v.close, NaN),

        volume: num(v.volume, 0)
      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      );

  if (candles.length < 30) {
    throw new Error(
      "Not enough valid Twelve Data candles."
    );
  }

  return candles;
}


// ============================================================
// RATE-LIMIT SAFE DATA LOADER
// ============================================================

async function getTimeSeries(
  env,
  interval
) {
  const key =
    candleCacheKey(interval);

  const cache =
    memory.candles[key];

  const now = Date.now();

  const ttl =
    interval === CONFIG.INTERVAL_FAST
      ? CONFIG.FAST_CACHE_TTL_MS
      : CONFIG.SLOW_CACHE_TTL_MS;


  // ----------------------------------------------------------
  // FRESH CACHE
  // ----------------------------------------------------------

  if (
    cache.data &&
    now - cache.fetchedAt < ttl
  ) {
    return cache.data;
  }


  // ----------------------------------------------------------
  // GLOBAL RATE LIMIT BACKOFF
  // ----------------------------------------------------------

  if (
    now < memory.rateLimitUntil
  ) {
    if (
      cache.data &&
      now - cache.fetchedAt <=
        CONFIG.STALE_MAX_MS
    ) {
      return cache.data;
    }

    const wait =
      Math.ceil(
        (memory.rateLimitUntil - now) /
        1000
      );

    throw new Error(
      `Twelve Data rate limit active. Retry in ${wait}s.`
    );
  }


  // ----------------------------------------------------------
  // DUPLICATE REQUEST LOCK
  // ----------------------------------------------------------

  if (memory.locks[key]) {
    return await memory.locks[key];
  }


  memory.locks[key] =
    (async () => {

      try {

        const current =
          Date.now();


        // Another request may have filled cache
        if (
          cache.data &&
          current - cache.fetchedAt < ttl
        ) {
          return cache.data;
        }


        const apiKey =
          getEnv(
            env,
            "TWELVE_DATA_API_KEY"
          );


        if (!apiKey) {
          throw new Error(
            "TWELVE_DATA_API_KEY is missing."
          );
        }


        const outputsize =
          interval ===
          CONFIG.INTERVAL_FAST
            ? CONFIG.OUTPUT_SIZE_FAST
            : CONFIG.OUTPUT_SIZE_SLOW;


        const url =
          twelveDataUrl(
            env,
            interval,
            outputsize
          );


        const response =
          await fetchWithTimeout(
            url,
            {
              headers: {
                "accept":
                  "application/json"
              }
            }
          );


        const creditsUsed =
          response.headers.get(
            "api-credits-used"
          );

        const creditsLeft =
          response.headers.get(
            "api-credits-left"
          );

        const retryAfter =
          response.headers.get(
            "retry-after"
          );


        cache.creditsUsed =
          creditsUsed;

        cache.creditsLeft =
          creditsLeft;


        // ----------------------------------------------------
        // HTTP 429
        // ----------------------------------------------------

        if (
          response.status === 429
        ) {

          let retrySeconds =
            num(
              retryAfter,
              65
            );


          if (retrySeconds < 1) {
            retrySeconds = 65;
          }


          memory.rateLimitUntil =
            Date.now() +
            retrySeconds * 1000;


          memory.rateLimitRetryAfter =
            retrySeconds;


          const message =
            `Twelve Data HTTP 429. Rate limit reached. Retry in ${retrySeconds}s.`;


          cache.lastError =
            message;


          // Use previous good data
          if (
            cache.data &&
            Date.now() -
              cache.fetchedAt <=
              CONFIG.STALE_MAX_MS
          ) {
            return cache.data;
          }


          throw new Error(
            message
          );
        }


        const text =
          await response.text();


        let json;

        try {
          json =
            JSON.parse(text);
        } catch {
          throw new Error(
            `Twelve Data invalid JSON (HTTP ${response.status}).`
          );
        }


        // ----------------------------------------------------
        // OTHER HTTP ERRORS
        // ----------------------------------------------------

        if (!response.ok) {

          const message =
            json?.message ||
            json?.code ||
            `Twelve Data HTTP ${response.status}`;


          cache.lastError =
            message;


          if (
            cache.data &&
            Date.now() -
              cache.fetchedAt <=
              CONFIG.STALE_MAX_MS
          ) {
            return cache.data;
          }


          throw new Error(
            message
          );
        }


        // ----------------------------------------------------
        // API ERROR
        // ----------------------------------------------------

        if (
          json?.status === "error"
        ) {

          const message =
            json?.message ||
            "Twelve Data API error.";


          cache.lastError =
            message;


          if (
            cache.data &&
            Date.now() -
              cache.fetchedAt <=
              CONFIG.STALE_MAX_MS
          ) {
            return cache.data;
          }


          throw new Error(
            message
          );
        }


        // ----------------------------------------------------
        // PARSE DATA
        // ----------------------------------------------------

        const candles =
          parseTwelveDataValues(
            json
          );


        cache.data =
          candles;

        cache.fetchedAt =
          Date.now();

        cache.lastError =
          null;


        memory.rateLimitUntil =
          0;

        memory.rateLimitRetryAfter =
          null;


        return candles;

      } catch (error) {

        cache.lastError =
          String(
            error?.message ||
            error
          );


        // ----------------------------------------------------
        // STALE FALLBACK
        // ----------------------------------------------------

        if (
          cache.data &&
          Date.now() -
            cache.fetchedAt <=
            CONFIG.STALE_MAX_MS
        ) {
          return cache.data;
        }


        throw error;

      } finally {

        memory.locks[key] =
          null;
      }

    })();


  return await memory.locks[key];
}


// ============================================================
// CACHE STATUS
// ============================================================

function getTwelveDataCacheStatus() {

  const now =
    Date.now();


  function item(
    cache,
    ttl
  ) {

    return {

      cached:
        Boolean(cache.data),

      age_seconds:
        cache.data
          ? Math.max(
              0,
              Math.floor(
                (now -
                  cache.fetchedAt) /
                1000
              )
            )
          : null,

      fresh:
        Boolean(
          cache.data &&
          now -
            cache.fetchedAt <
            ttl
        ),

      stale_usable:
        Boolean(
          cache.data &&
          now -
            cache.fetchedAt <=
            CONFIG.STALE_MAX_MS
        ),

      api_credits_used:
        cache.creditsUsed,

      api_credits_left:
        cache.creditsLeft,

      last_error:
        cache.lastError
    };
  }


  return {

    rate_limit_active:
      now <
      memory.rateLimitUntil,

    rate_limit_seconds_left:
      now <
      memory.rateLimitUntil
        ? Math.ceil(
            (
              memory.rateLimitUntil -
              now
            ) / 1000
          )
        : 0,

    fast_15m:
      item(
        memory.candles.fast,
        CONFIG.FAST_CACHE_TTL_MS
      ),

    slow_1h:
      item(
        memory.candles.slow,
        CONFIG.SLOW_CACHE_TTL_MS
      )
  };
}


// ============================================================
// INDICATORS
// ============================================================

function ema(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const k =
    2 / (period + 1);

  let value =
    values[0];


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    value =
      values[i] * k +
      value * (1 - k);
  }


  return value;
}


function emaSeries(
  values,
  period
) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return [];
  }


  const k =
    2 / (period + 1);

  let value =
    values[0];

  const out =
    [value];


  for (
    let i = 1;
    i < values.length;
    i++
  ) {

    value =
      values[i] * k +
      value * (1 - k);

    out.push(value);
  }


  return out;
}


function rsi(
  values,
  period = 14
) {

  if (
    !Array.isArray(values) ||
    values.length <
      period + 1
  ) {
    return null;
  }


  let gains = 0;
  let losses = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];


    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }


  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;


  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];


    const gain =
      Math.max(
        diff,
        0
      );

    const loss =
      Math.max(
        -diff,
        0
      );


    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) / period;


    avgLoss =
      (
        avgLoss *
        (period - 1) +
        loss
      ) / period;
  }


  if (avgLoss === 0) {
    return 100;
  }


  const rs =
    avgGain /
    avgLoss;


  return (
    100 -
    100 /
      (1 + rs)
  );
}


function atr(
  candles,
  period = 14
) {

  if (
    !Array.isArray(candles) ||
    candles.length <
      period + 1
  ) {
    return null;
  }


  const trs = [];


  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const c =
      candles[i];

    const prev =
      candles[i - 1];


    const tr =
      Math.max(
        c.high - c.low,

        Math.abs(
          c.high -
          prev.close
        ),

        Math.abs(
          c.low -
          prev.close
        )
      );


    trs.push(tr);
  }


  if (
    trs.length < period
  ) {
    return null;
  }


  let value =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    value =
      (
        value *
          (period - 1) +
        trs[i]
      ) / period;
  }


  return value;
}


function macd(
  values,
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {

  if (
    !Array.isArray(values) ||
    values.length <
      slow +
        signalPeriod
  ) {

    return {
      line: null,
      signal: null,
      histogram: null
    };
  }


  const fastSeries =
    emaSeries(
      values,
      fast
    );

  const slowSeries =
    emaSeries(
      values,
      slow
    );


  const offset =
    fastSeries.length -
    slowSeries.length;


  const lines =
    slowSeries.map(
      (v, i) =>
        fastSeries[
          i + offset
        ] - v
    );


  const signalSeries =
    emaSeries(
      lines,
      signalPeriod
    );


  const line =
    lines[
      lines.length - 1
    ];


  const signal =
    signalSeries[
      signalSeries.length - 1
    ];


  return {
    line,
    signal,
    histogram:
      line - signal
  };
}


// ============================================================
// ADX
// ============================================================

function adxDetails(
  candles,
  period = 14
) {

  if (
    !Array.isArray(candles) ||
    candles.length <
      period * 2 + 2
  ) {

    return {
      adx: null,
      plusDI: null,
      minusDI: null,
      spread: null,
      previousAdx: null
    };
  }


  const trs = [];
  const plusDM = [];
  const minusDM = [];


  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const c =
      candles[i];

    const p =
      candles[i - 1];


    const upMove =
      c.high -
      p.high;


    const downMove =
      p.low -
      c.low;


    plusDM.push(
      upMove >
        downMove &&
      upMove > 0
        ? upMove
        : 0
    );


    minusDM.push(
      downMove >
        upMove &&
      downMove > 0
        ? downMove
        : 0
    );


    trs.push(
      Math.max(
        c.high - c.low,

        Math.abs(
          c.high -
          p.close
        ),

        Math.abs(
          c.low -
          p.close
        )
      )
    );
  }


  if (
    trs.length <
      period * 2
  ) {

    return {
      adx: null,
      plusDI: null,
      minusDI: null,
      spread: null,
      previousAdx: null
    };
  }


  let tr =
    trs
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );


  let pdm =
    plusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );


  let mdm =
    minusDM
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      );


  const dx = [];
  const diPoints = [];


  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    tr =
      tr -
      tr / period +
      trs[i];


    pdm =
      pdm -
      pdm / period +
      plusDM[i];


    mdm =
      mdm -
      mdm / period +
      minusDM[i];


    const plus =
      tr === 0
        ? 0
        : 100 *
          (pdm / tr);


    const minus =
      tr === 0
        ? 0
        : 100 *
          (mdm / tr);


    const sum =
      plus + minus;


    const d =
      sum === 0
        ? 0
        : 100 *
          Math.abs(
            plus - minus
          ) /
          sum;


    dx.push(d);


    diPoints.push({
      plus,
      minus
    });
  }


  if (
    dx.length <
      period + 1
  ) {

    return {
      adx: null,
      plusDI: null,
      minusDI: null,
      spread: null,
      previousAdx: null
    };
  }


  let adxValue =
    dx
      .slice(0, period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period;


  let previousAdx =
    adxValue;


  for (
    let i = period;
    i < dx.length;
    i++
  ) {

    previousAdx =
      adxValue;


    adxValue =
      (
        adxValue *
          (period - 1) +
        dx[i]
      ) / period;
  }


  const latestDI =
    diPoints[
      diPoints.length - 1
    ];


  return {

    adx:
      adxValue,

    plusDI:
      latestDI.plus,

    minusDI:
      latestDI.minus,

    spread:
      Math.abs(
        latestDI.plus -
        latestDI.minus
      ),

    previousAdx
  };
}


// ============================================================
// MOMENTUM
// ============================================================

function momentum(
  values,
  lookback = 10
) {

  if (
    !Array.isArray(values) ||
    values.length <= lookback
  ) {
    return null;
  }


  const current =
    values[
      values.length - 1
    ];


  const old =
    values[
      values.length -
        1 -
        lookback
    ];


  if (!old) {
    return null;
  }


  return (
    (current - old) /
    old
  );
}


// ============================================================
// TREND
// ============================================================

function analyzeTrend(
  candles
) {

  const closes =
    candles.map(
      c => c.close
    );


  const e20 =
    ema(closes, 20);

  const e50 =
    ema(closes, 50);

  const e100 =
    ema(closes, 100);


  const price =
    closes[
      closes.length - 1
    ];


  let trend =
    "NEUTRAL";


  if (e20 && e50) {

    if (
      price > e20 &&
      e20 > e50
    ) {
      trend =
        "BULLISH";
    }

    else if (
      price < e20 &&
      e20 < e50
    ) {
      trend =
        "BEARISH";
    }
  }


  return {
    trend,
    price,
    ema20: e20,
    ema50: e50,
    ema100: e100
  };
}


// ============================================================
// MARKET STRUCTURE
// ============================================================

function structureSignal(
  candles,
  lookback = 12
) {

  if (
    candles.length <
      lookback + 3
  ) {
    return "NEUTRAL";
  }


  const recent =
    candles.slice(
      -lookback
    );


  const previous =
    candles.slice(
      -lookback * 2,
      -lookback
    );


  const recentHigh =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );


  const recentLow =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );


  const previousHigh =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );


  const previousLow =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );


  if (
    recentHigh >
      previousHigh &&
    recentLow >=
      previousLow
  ) {
    return "BULLISH";
  }


  if (
    recentLow <
      previousLow &&
    recentHigh <=
      previousHigh
  ) {
    return "BEARISH";
  }


  return "NEUTRAL";
}


// ============================================================
// CANDLE QUALITY
// ============================================================

function candleQuality(
  candles
) {

  if (
    candles.length < 3
  ) {

    return {
      bullish: false,
      bearish: false,
      bodyRatio: 0
    };
  }


  const c =
    candles[
      candles.length - 1
    ];


  const range =
    c.high - c.low;


  if (range <= 0) {

    return {
      bullish: false,
      bearish: false,
      bodyRatio: 0
    };
  }


  const body =
    Math.abs(
      c.close -
      c.open
    );


  const bodyRatio =
    body / range;


  return {

    bullish:
      c.close >
      c.open,

    bearish:
      c.close <
      c.open,

    bodyRatio
  };
}


// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function analyzeTimeframe(
  candles
) {

  const closes =
    candles.map(
      c => c.close
    );


  const trendData =
    analyzeTrend(
      candles
    );


  const structure =
    structureSignal(
      candles
    );


  const adx =
    adxDetails(
      candles,
      14
    );


  const rsiValue =
    rsi(
      closes,
      14
    );


  const rsiPrevious =
    rsi(
      closes.slice(0, -1),
      14
    );


  const atrValue =
    atr(
      candles,
      14
    );


  const macdValue =
    macd(closes);


  const mom =
    momentum(
      closes,
      10
    );


  const candle =
    candleQuality(
      candles
    );


  const rsiSlope =
    rsiPrevious !== null &&
    rsiValue !== null
      ? rsiValue -
        rsiPrevious
      : 0;


  return {

    trend:
      trendData.trend,

    structure,

    price:
      trendData.price,

    ema20:
      trendData.ema20,

    ema50:
      trendData.ema50,

    ema100:
      trendData.ema100,

    ema20DistanceAtr:
      atrValue
        ? Math.abs(
            trendData.price -
            trendData.ema20
          ) / atrValue
        : null,

    rsi:
      rsiValue,

    rsiSlope,

    atr:
      atrValue,

    adx:
      adx.adx,

    previousAdx:
      adx.previousAdx,

    adxSlope:
      adx.adx !== null &&
      adx.previousAdx !== null
        ? adx.adx -
          adx.previousAdx
        : null,

    plusDI:
      adx.plusDI,

    minusDI:
      adx.minusDI,

    diSpread:
      adx.spread,

    macd:
      macdValue,

    momentum:
      mom,

    candle
  };
}


// ============================================================
// NEWS
// ============================================================

function normalizeNewsCurrency(
  value
) {

  const s =
    String(
      value || ""
    ).toUpperCase();


  if (
    s === "USD" ||
    s === "US"
  ) {
    return "USD";
  }


  if (
    s === "XAU" ||
    s === "GOLD"
  ) {
    return "USD";
  }


  return s;
}


function normalizeNewsImpact(
  value
) {

  const s =
    String(
      value || ""
    ).toLowerCase();


  if (
    s.includes("high") ||
    s.includes("red") ||
    s === "3"
  ) {
    return "HIGH";
  }


  if (
    s.includes("medium") ||
    s.includes("orange") ||
    s === "2"
  ) {
    return "MEDIUM";
  }


  if (
    s.includes("low") ||
    s.includes("yellow") ||
    s === "1"
  ) {
    return "LOW";
  }


  return "UNKNOWN";
}


function parseNewsTimestamp(
  event
) {

  const candidates = [
    event?.timestamp,
    event?.date,
    event?.datetime,
    event?.time,
    event?.event_timestamp
  ];


  for (
    const value of candidates
  ) {

    if (!value) {
      continue;
    }


    const n =
      Number(value);


    if (
      Number.isFinite(n)
    ) {

      return n <
        10_000_000_000
        ? n * 1000
        : n;
    }


    const parsed =
      Date.parse(
        String(value)
      );


    if (
      Number.isFinite(parsed)
    ) {
      return parsed;
    }
  }


  return null;
}


function normalizeNewsEvents(
  raw
) {

  const source =
    Array.isArray(raw)
      ? raw
      : Array.isArray(
          raw?.events
        )
        ? raw.events
        : Array.isArray(
            raw?.data
          )
          ? raw.data
          : [];


  return source

    .map(event => ({

      title:
        event?.title ||
        event?.event ||
        event?.name ||
        "Economic event",

      currency:
        normalizeNewsCurrency(
          event?.currency ||
          event?.country ||
          event?.ccy
        ),

      impact:
        normalizeNewsImpact(
          event?.impact ||
          event?.importance ||
          event?.impact_name
        ),

      timestamp:
        parseNewsTimestamp(
          event
        ),

      raw:
        event
    }))

    .filter(
      e => e.timestamp
    );
}


async function getLiveNews(
  env
) {

  const now =
    Date.now();


  if (
    memory.news.data &&
    now -
      memory.news.fetchedAt <
      CONFIG.NEWS_CACHE_SECONDS *
        1000
  ) {
    return memory.news.data;
  }


  try {

    const response =
      await fetchWithTimeout(

        "https://nfs.faireconomy.media/ff_calendar_thisweek.json",

        {
          headers: {
            "accept":
              "application/json"
          }
        },

        10_000
      );


    if (!response.ok) {

      throw new Error(
        `News HTTP ${response.status}`
      );
    }


    const raw =
      await response.json();


    const events =
      normalizeNewsEvents(
        raw
      );


    memory.news.data =
      events;

    memory.news.fetchedAt =
      Date.now();

    memory.news.lastError =
      null;


    return events;

  } catch (error) {

    memory.news.lastError =
      String(
        error?.message ||
        error
      );


    return (
      memory.news.data ||
      []
    );
  }
}


function relevantNews(
  events
) {

  const now =
    Date.now();


  return events

    .filter(
      event =>
        event.currency ===
        "USD"
    )

    .filter(
      event =>
        [
          "HIGH",
          "MEDIUM"
        ].includes(
          event.impact
        )
    )

    .filter(
      event => {

        const diffMinutes =
          (
            event.timestamp -
            now
          ) / 60000;


        return (
          diffMinutes <=
            CONFIG.NEWS_LOOKAHEAD_HOURS *
              60 &&

          diffMinutes >=
            -CONFIG.NEWS_AFTER_MINUTES
        );
      }
    )

    .sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );
}


function newsState(
  events
) {

  const relevant =
    relevantNews(
      events
    );


  const now =
    Date.now();


  const blocked =
    relevant.find(
      event => {

        const diff =
          (
            event.timestamp -
            now
          ) / 60000;


        return (
          diff <=
            CONFIG.NEWS_BEFORE_MINUTES &&

          diff >=
            -CONFIG.NEWS_AFTER_MINUTES
        );
      }
    );


  return {

    blocked:
      Boolean(blocked),

    blockedEvent:
      blocked || null,

    upcoming:
      relevant[0] ||
      null,

    events:
      relevant
  };
}


// ============================================================
// SCORE
// ============================================================

function calculateScore(
  fast,
  slow,
  direction
) {

  let score = 0;


  if (
    direction === "BUY"
  ) {

    if (
      fast.trend ===
      "BULLISH"
    ) {
      score += 15;
    }


    if (
      slow.trend ===
      "BULLISH"
    ) {
      score += 15;
    }


    if (
      fast.structure ===
      "BULLISH"
    ) {
      score += 10;
    }


    if (
      slow.structure ===
      "BULLISH"
    ) {
      score += 8;
    }


    if (
      fast.plusDI >
      fast.minusDI
    ) {
      score += 8;
    }


    if (
      slow.plusDI >
      slow.minusDI
    ) {
      score += 5;
    }


    if (
      fast.macd.histogram >
      0
    ) {
      score += 8;
    }


    if (
      slow.macd.histogram >
      0
    ) {
      score += 5;
    }


    if (
      fast.rsi >=
        CONFIG.RSI_BULL_MIN &&
      fast.rsi <=
        CONFIG.RSI_BULL_MAX
    ) {
      score += 8;
    }


    if (
      fast.rsiSlope >
      0
    ) {
      score += 4;
    }


    if (
      fast.momentum >=
      CONFIG.MIN_MOMENTUM
    ) {
      score += 8;
    }


    if (
      fast.candle.bullish &&
      fast.candle.bodyRatio >=
        0.35
    ) {
      score += 8;
    }


    if (
      fast.adx >= 25
    ) {
      score += 8;

    } else if (
      fast.adx >= 23
    ) {
      score += 5;
    }
  }


  if (
    direction === "SELL"
  ) {

    if (
      fast.trend ===
      "BEARISH"
    ) {
      score += 15;
    }


    if (
      slow.trend ===
      "BEARISH"
    ) {
      score += 15;
    }


    if (
      fast.structure ===
      "BEARISH"
    ) {
      score += 10;
    }


    if (
      slow.structure ===
      "BEARISH"
    ) {
      score += 8;
    }


    if (
      fast.minusDI >
      fast.plusDI
    ) {
      score += 8;
    }


    if (
      slow.minusDI >
      slow.plusDI
    ) {
      score += 5;
    }


    if (
      fast.macd.histogram <
      0
    ) {
      score += 8;
    }


    if (
      slow.macd.histogram <
      0
    ) {
      score += 5;
    }


    if (
      fast.rsi >=
        CONFIG.RSI_BEAR_MIN &&
      fast.rsi <=
        CONFIG.RSI_BEAR_MAX
    ) {
      score += 8;
    }


    if (
      fast.rsiSlope <
      0
    ) {
      score += 4;
    }


    if (
      fast.momentum <=
      -CONFIG.MIN_MOMENTUM
    ) {
      score += 8;
    }


    if (
      fast.candle.bearish &&
      fast.candle.bodyRatio >=
        0.35
    ) {
      score += 8;
    }


    if (
      fast.adx >= 25
    ) {
      score += 8;

    } else if (
      fast.adx >= 23
    ) {
      score += 5;
    }
  }


  // ------------------------------------------
  // LOW ADX SCORE CAP
  // ------------------------------------------

  if (
    fast.adx !== null
  ) {

    if (
      fast.adx < 18
    ) {

      score =
        Math.min(
          score,
          59
        );

    } else if (
      fast.adx < 23
    ) {

      score =
        Math.min(
          score,
          74
        );

    } else if (
      fast.adx < 25
    ) {

      score =
        Math.min(
          score,
          84
        );
    }
  }


  return Math.max(
    0,
    Math.min(
      100,
      Math.round(score)
    )
  );
}


// ============================================================
// SESSION
// ============================================================

function inSession(
  date = new Date()
) {

  const day =
    date.getUTCDay();

  const hour =
    date.getUTCHours();


  if (
    day === 0 ||
    day === 6
  ) {
    return false;
  }


  return (
    hour >=
      CONFIG.SESSION_START_UTC &&
    hour <
      CONFIG.SESSION_END_UTC
  );
}


// ============================================================
// DIRECTION CHECK
// ============================================================

function directionCheck(
  fast,
  slow,
  direction
) {

  if (
    !fast ||
    !slow
  ) {

    return {
      ok: false,
      reasons: [
        "Missing timeframe data"
      ]
    };
  }


  const reasons = [];


  if (
    fast.adx === null ||
    fast.adx <
      CONFIG.MIN_ADX
  ) {
    reasons.push(
      "15M ADX below minimum"
    );
  }


  if (
    fast.adxSlope === null ||
    fast.adxSlope <
      CONFIG.MIN_ADX_SLOPE
  ) {
    reasons.push(
      "15M ADX slope below minimum"
    );
  }


  if (
    slow.adx === null ||
    slow.adx <
      CONFIG.MIN_SLOW_ADX
  ) {
    reasons.push(
      "1H ADX below minimum"
    );
  }


  if (
    fast.diSpread === null ||
    fast.diSpread <
      CONFIG.MIN_DI_SPREAD
  ) {
    reasons.push(
      "15M DI spread below minimum"
    );
  }


  if (
    fast.ema20DistanceAtr !== null &&
    fast.ema20DistanceAtr >
      CONFIG.MAX_EMA20_DISTANCE_ATR
  ) {

    reasons.push(
      "Price too far from EMA20"
    );
  }


  if (
    direction === "BUY"
  ) {

    if (
      fast.trend !==
      "BULLISH"
    ) {
      reasons.push(
        "15M trend not bullish"
      );
    }


    if (
      slow.trend !==
      "BULLISH"
    ) {
      reasons.push(
        "1H trend not bullish"
      );
    }


    if (
      fast.structure !==
      "BULLISH"
    ) {
      reasons.push(
        "15M structure not bullish"
      );
    }


    if (
      slow.structure !==
      "BULLISH"
    ) {
      reasons.push(
        "1H structure not bullish"
      );
    }


    if (
      !(
        fast.plusDI >
        fast.minusDI
      )
    ) {
      reasons.push(
        "15M DI not bullish"
      );
    }


    if (
      !(
        slow.plusDI >
        slow.minusDI
      )
    ) {
      reasons.push(
        "1H DI not bullish"
      );
    }


    if (
      !(
        fast.macd.histogram >
        0
      )
    ) {
      reasons.push(
        "15M MACD not bullish"
      );
    }


    if (
      !(
        slow.macd.histogram >
        0
      )
    ) {
      reasons.push(
        "1H MACD not bullish"
      );
    }


    if (
      fast.rsi === null ||
      fast.rsi <
        CONFIG.RSI_BULL_MIN ||
      fast.rsi >
        CONFIG.RSI_BULL_MAX
    ) {
      reasons.push(
        "15M RSI outside bullish zone"
      );
    }


    if (
      !(
        fast.rsiSlope >
        0
      )
    ) {
      reasons.push(
        "RSI slope not bullish"
      );
    }


    if (
      fast.momentum === null ||
      fast.momentum <
        CONFIG.MIN_MOMENTUM
    ) {
      reasons.push(
        "Momentum below minimum"
      );
    }


    if (
      !fast.candle.bullish ||
      fast.candle.bodyRatio <
        0.35
    ) {
      reasons.push(
        "Last 15M candle not strong bullish"
      );
    }
  }


  if (
    direction === "SELL"
  ) {

    if (
      fast.trend !==
      "BEARISH"
    ) {
      reasons.push(
        "15M trend not bearish"
      );
    }


    if (
      slow.trend !==
      "BEARISH"
    ) {
      reasons.push(
        "1H trend not bearish"
      );
    }


    if (
      fast.structure !==
      "BEARISH"
    ) {
      reasons.push(
        "15M structure not bearish"
      );
    }


    if (
      slow.structure !==
      "BEARISH"
    ) {
      reasons.push(
        "1H structure not bearish"
      );
    }


    if (
      !(
        fast.minusDI >
        fast.plusDI
      )
    ) {
      reasons.push(
        "15M DI not bearish"
      );
    }


    if (
      !(
        slow.minusDI >
        slow.plusDI
      )
    ) {
      reasons.push(
        "1H DI not bearish"
      );
    }


    if (
      !(
        fast.macd.histogram <
        0
      )
    ) {
      reasons.push(
        "15M MACD not bearish"
      );
    }


    if (
      !(
        slow.macd.histogram <
        0
      )
    ) {
      reasons.push(
        "1H MACD not bearish"
      );
    }


    if (
      fast.rsi === null ||
      fast.rsi <
        CONFIG.RSI_BEAR_MIN ||
      fast.rsi >
        CONFIG.RSI_BEAR_MAX
    ) {
      reasons.push(
        "15M RSI outside bearish zone"
      );
    }


    if (
      !(
        fast.rsiSlope <
        0
      )
    ) {
      reasons.push(
        "RSI slope not bearish"
      );
    }


    if (
      fast.momentum === null ||
      fast.momentum >
        -CONFIG.MIN_MOMENTUM
    ) {
      reasons.push(
        "Momentum below minimum"
      );
    }


    if (
      !fast.candle.bearish ||
      fast.candle.bodyRatio <
        0.35
    ) {
      reasons.push(
        "Last 15M candle not strong bearish"
      );
    }
  }


  return {
    ok:
      reasons.length === 0,

    reasons
  };
}


// ============================================================
// TRADE PLAN
// ============================================================

function recentLevels(
  candles,
  lookback = 24
) {

  const recent =
    candles.slice(
      -lookback
    );


  return {

    support:
      Math.min(
        ...recent.map(
          c => c.low
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          c => c.high
        )
      )
  };
}


function buildTradePlan(
  candles,
  fast,
  direction
) {

  const price =
    fast.price;

  const atrValue =
    fast.atr;


  if (
    !Number.isFinite(price) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {
    return null;
  }


  const levels =
    recentLevels(
      candles
    );


  let entry;
  let sl;


  if (
    direction === "BUY"
  ) {

    const atrEntry =
      price -
      atrValue *
        CONFIG.ATR_ENTRY_MULTIPLIER;


    const structureEntry =
      levels.support +
      atrValue *
        0.20;


    entry =
      Math.max(
        atrEntry,
        structureEntry
      );


    entry =
      Math.min(
        entry,
        price
      );


    sl =
      Math.min(

        entry -
          atrValue *
            CONFIG.ATR_SL_MULTIPLIER,

        levels.support -
          atrValue *
            0.10
      );

  } else {

    const atrEntry =
      price +
      atrValue *
        CONFIG.ATR_ENTRY_MULTIPLIER;


    const structureEntry =
      levels.resistance -
      atrValue *
        0.20;


    entry =
      Math.min(
        atrEntry,
        structureEntry
      );


    entry =
      Math.max(
        entry,
        price
      );


    sl =
      Math.max(

        entry +
          atrValue *
            CONFIG.ATR_SL_MULTIPLIER,

        levels.resistance +
          atrValue *
            0.10
      );
  }


  const risk =
    Math.abs(
      entry - sl
    );


  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }


  const distanceAtr =
    Math.abs(
      price - entry
    ) /
    atrValue;


  const distancePercent =
    Math.abs(
      price - entry
    ) /
    price *
    100;


  if (
    distanceAtr >
    CONFIG.MAX_ENTRY_DISTANCE_ATR
  ) {
    return null;
  }


  if (
    distancePercent >
    CONFIG.MAX_ENTRY_DISTANCE_PERCENT
  ) {
    return null;
  }


  if (
    distanceAtr <
    CONFIG.MIN_ENTRY_DISTANCE_ATR
  ) {
    entry = price;
  }


  const finalRisk =
    Math.abs(
      entry - sl
    );


  const tp1 =
    direction === "BUY"
      ? entry +
        finalRisk *
          1.5
      : entry -
        finalRisk *
          1.5;


  const tp2 =
    direction === "BUY"
      ? entry +
        finalRisk *
          2.2
      : entry -
        finalRisk *
          2.2;


  const tp3 =
    direction === "BUY"
      ? entry +
        finalRisk *
          3.0
      : entry -
        finalRisk *
          3.0;


  const rr =
    Math.abs(
      tp1 - entry
    ) /
    finalRisk;


  if (
    rr <
    CONFIG.MIN_RR
  ) {
    return null;
  }


  return {

    type:
      direction === "BUY"
        ? "BUY LIMIT"
        : "SELL LIMIT",

    direction,

    entry:
      round(
        entry,
        2
      ),

    sl:
      round(
        sl,
        2
      ),

    tp1:
      round(
        tp1,
        2
      ),

    tp2:
      round(
        tp2,
        2
      ),

    tp3:
      round(
        tp3,
        2
      ),

    rr:
      round(
        rr,
        2
      ),

    atr:
      round(
        atrValue,
        2
      ),

    distanceAtr:
      round(
        distanceAtr,
        2
      ),

    distancePercent:
      round(
        distancePercent,
        3
      )
  };
}


// ============================================================
// WAIT
// ============================================================

function waitResponse(
  reason,
  details = {}
) {

  return {

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    signal:
      "WAIT",

    score:
      details.score ??
      null,

    reason,

    session:
      inSession()
        ? "OPEN"
        : "CLOSED",

    price:
      details.price ??
      null,

    fast:
      details.fast ??
      null,

    slow:
      details.slow ??
      null,

    news:
      details.news ??
      null,

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// SIGNAL ENGINE
// ============================================================

async function generateSignal(
  env
) {

  // Session filter
  if (!inSession()) {

    return waitResponse(
      "Outside trading session (London + New York only)."
    );
  }


  const [
    fastCandles,
    slowCandles,
    newsEvents
  ] =
    await Promise.all([

      getTimeSeries(
        env,
        CONFIG.INTERVAL_FAST
      ),

      getTimeSeries(
        env,
        CONFIG.INTERVAL_SLOW
      ),

      getLiveNews(env)

    ]);


  const fast =
    analyzeTimeframe(
      fastCandles
    );


  const slow =
    analyzeTimeframe(
      slowCandles
    );


  const news =
    newsState(
      newsEvents
    );


  // News block
  if (
    news.blocked
  ) {

    return waitResponse(

      `High/medium USD news window: ${news.blockedEvent.title}`,

      {
        price:
          fast.price,

        fast,

        slow,

        news
      }
    );
  }


  const buyScore =
    calculateScore(
      fast,
      slow,
      "BUY"
    );


  const sellScore =
    calculateScore(
      fast,
      slow,
      "SELL"
    );


  const direction =
    buyScore >=
      sellScore
      ? "BUY"
      : "SELL";


  const score =
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
    score -
    otherScore;


  const check =
    directionCheck(
      fast,
      slow,
      direction
    );


  // Minimum score
  if (
    score <
    CONFIG.MIN_SCORE
  ) {

    return waitResponse(

      `Score ${score} below minimum ${CONFIG.MIN_SCORE}.`,

      {
        score,

        price:
          fast.price,

        fast,

        slow,

        news
      }
    );
  }


  // Direction lead
  if (
    lead <
    CONFIG.MIN_DIRECTION_LEAD
  ) {

    return waitResponse(

      `Direction lead ${lead} below minimum ${CONFIG.MIN_DIRECTION_LEAD}.`,

      {
        score,

        price:
          fast.price,

        fast,

        slow,

        news
      }
    );
  }


  // Strict confirmation
  if (
    !check.ok
  ) {

    return waitResponse(

      check.reasons
        .slice(0, 4)
        .join(" | "),

      {
        score,

        price:
          fast.price,

        fast,

        slow,

        news
      }
    );
  }


  const plan =
    buildTradePlan(
      fastCandles,
      fast,
      direction
    );


  if (!plan) {

    return waitResponse(

      "Trade plan failed risk/entry-distance filters.",

      {
        score,

        price:
          fast.price,

        fast,

        slow,

        news
      }
    );
  }


  return {

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    signal:
      direction,

    setup:
      plan.type,

    score,

    buyScore,

    sellScore,

    directionLead:
      lead,

    price:
      round(
        fast.price,
        2
      ),

    fast,

    slow,

    news,

    trade:
      plan,

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// TELEGRAM API
// ============================================================

function telegramApiUrl(
  env,
  method
) {

  const token =
    getEnv(
      env,
      "TELEGRAM_BOT_TOKEN"
    );


  return `https://api.telegram.org/bot${token}/${method}`;
}


async function telegramApi(
  env,
  method,
  payload = {}
) {

  const token =
    getEnv(
      env,
      "TELEGRAM_BOT_TOKEN"
    );


  if (!token) {

    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing."
    );
  }


  const response =
    await fetchWithTimeout(

      telegramApiUrl(
        env,
        method
      ),

      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      },

      12_000
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data.ok
  ) {

    throw new Error(
      data?.description ||
      `Telegram HTTP ${response.status}`
    );
  }


  return data;
}


async function sendTelegram(
  env,
  text
) {

  const chatId =
    getEnv(
      env,
      "TELEGRAM_CHAT_ID"
    );


  if (!chatId) {

    throw new Error(
      "TELEGRAM_CHAT_ID is missing."
    );
  }


  return sendTelegramToChat(
    env,
    chatId,
    text
  );
}


async function sendTelegramToChat(
  env,
  chatId,
  text
) {

  return telegramApi(
    env,
    "sendMessage",
    {
      chat_id:
        chatId,

      text,

      disable_web_page_preview:
        true
    }
  );
}


// ============================================================
// TELEGRAM SIGNAL MESSAGE
// ============================================================

function formatSignalMessage(
  signal
) {

  const t =
    signal.trade;


  return [

    `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

    "",

    `🥇 ${CONFIG.SYMBOL.replace("/", "")}`,

    `📊 ${t.type}`,

    `⭐ Score: ${signal.score}/100`,

    "",

    `📍 Entry: ${safeValue(t.entry)}`,

    `🛑 SL: ${safeValue(t.sl)}`,

    `🎯 TP1: ${safeValue(t.tp1)}`,

    `🎯 TP2: ${safeValue(t.tp2)}`,

    `🎯 TP3: ${safeValue(t.tp3)}`,

    "",

    `📊 R:R: ${safeValue(t.rr)}`,

    `📈 15M: ${signal.fast.trend}`,

    `📈 1H: ${signal.slow.trend}`,

    `💪 ADX 15M: ${safeValue(round(signal.fast.adx, 2))}`,

    `📊 DI Spread: ${safeValue(round(signal.fast.diSpread, 2))}`,

    `📉 RSI: ${safeValue(round(signal.fast.rsi, 2))}`,

    "",

    `💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.`,

    `📊 این سیگنال بر اساس شرایط فعلی بازار است و با تغییر شرایط ممکن است اعتبار آن از بین برود.`,

    "",

    CONFIG.FOOTER

  ].join("\n");
}


// ============================================================
// TELEGRAM WAIT MESSAGE
// ============================================================

function formatWaitMessage(
  result
) {

  return [

    `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

    "",

    `🥇 XAUUSD`,

    `⏸ WAIT`,

    `⭐ Score: ${safeValue(result.score)}/100`,

    "",

    `📡 Session: ${result.session}`,

    `💵 Price: ${safeValue(result.price)}`,

    "",

    `📈 15M: ${result.fast?.trend || "-"}`,

    `📈 1H: ${result.slow?.trend || "-"}`,

    `💪 ADX 15M: ${safeValue(round(result.fast?.adx, 2))}`,

    `📊 DI Spread: ${safeValue(round(result.fast?.diSpread, 2))}`,

    `📉 RSI: ${safeValue(round(result.fast?.rsi, 2))}`,

    "",

    `ℹ️ ${result.reason || "شرایط ورود کامل نشده است."}`,

    "",

    CONFIG.FOOTER

  ].join("\n");
}


// ============================================================
// NEWS TELEGRAM
// ============================================================

async function sendNewsAlert(
  env,
  event
) {

  if (
    !CONFIG.TELEGRAM_ENABLED ||
    !CONFIG.TELEGRAM_SEND_NEWS
  ) {
    return;
  }


  const id =
    `news:${event.title}:${event.timestamp}`;


  if (
    await alreadySent(
      env,
      id
    )
  ) {
    return;
  }


  const when =
    new Date(
      event.timestamp
    ).toISOString();


  const message =
    [

      `📰 HAKIM GOLD SIGNALS`,

      "",

      `⚠️ USD NEWS`,

      `📌 ${event.title}`,

      `🔥 Impact: ${event.impact}`,

      `💵 Currency: ${event.currency}`,

      `🕐 ${when}`,

      "",

      `⏸ در محدوده خبر مهم، موتور از ارسال سیگنال جدید خودداری می‌کند.`,

      "",

      CONFIG.FOOTER

    ].join("\n");


  try {

    await sendTelegram(
      env,
      message
    );


    await markSent(
      env,
      id,
      CONFIG.NEWS_DEDUPE_SECONDS
    );

  } catch {}
}


// ============================================================
// SEND SIGNAL
// ============================================================

async function maybeSendSignal(
  env,
  signal
) {

  if (
    !CONFIG.TELEGRAM_ENABLED ||
    !CONFIG.TELEGRAM_SEND_SIGNAL
  ) {

    return {
      sent: false,
      reason:
        "Telegram signal sending disabled."
    };
  }


  // WAIT is not automatically sent
  if (
    signal.signal ===
    "WAIT"
  ) {

    return {
      sent: false,
      reason:
        "WAIT signals are not automatically sent."
    };
  }


  const t =
    signal.trade;


  const key =
    [
      "signal",
      CONFIG.SYMBOL,
      signal.signal,
      t.entry,
      t.sl,
      signal.score
    ].join(":");


  if (
    await alreadySent(
      env,
      key
    )
  ) {

    return {
      sent: false,
      reason:
        "Duplicate signal blocked."
    };
  }


  await sendTelegram(
    env,
    formatSignalMessage(
      signal
    )
  );


  await markSent(
    env,
    key,
    CONFIG.SIGNAL_DEDUPE_SECONDS
  );


  return {
    sent: true,
    reason:
      "Signal sent."
  };
}


// ============================================================
// SCHEDULED RUN
// ============================================================

async function runScheduled(
  env
) {

  const newsEvents =
    await getLiveNews(
      env
    );


  const state =
    newsState(
      newsEvents
    );


  if (
    state.upcoming
  ) {

    const diff =
      (
        state.upcoming.timestamp -
        Date.now()
      ) / 60000;


    if (
      diff >= 0 &&
      diff <=
        CONFIG.NEWS_ALERT_MINUTES
    ) {

      await sendNewsAlert(
        env,
        state.upcoming
      );
    }
  }


  const signal =
    await generateSignal(
      env
    );


  const send =
    await maybeSendSignal(
      env,
      signal
    );


  return {

    signal,

    telegram:
      send,

    cache:
      getTwelveDataCacheStatus(),

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

function getWebhookSecret(
  env
) {

  return getEnv(
    env,
    "TELEGRAM_WEBHOOK_SECRET"
  );
}


function verifyTelegramWebhook(
  request,
  env
) {

  const expected =
    getWebhookSecret(
      env
    );


  if (!expected) {
    return true;
  }


  const received =
    request.headers.get(
      "x-telegram-bot-api-secret-token"
    );


  return (
    received ===
    expected
  );
}


async function handleTelegramUpdate(
  request,
  env
) {

  if (
    !verifyTelegramWebhook(
      request,
      env
    )
  ) {

    return jsonResponse(
      {
        ok: false,
        error:
          "Invalid Telegram webhook secret."
      },
      403
    );
  }


  const update =
    await request.json();


  const message =
    update?.message;


  const chatId =
    message?.chat?.id;


  const text =
    String(
      message?.text ||
      ""
    ).trim();


  if (!chatId) {
    return jsonResponse({
      ok: true
    });
  }


  try {

    // --------------------------------------------------------
    // /start
    // --------------------------------------------------------

    if (
      text.startsWith(
        "/start"
      )
    ) {

      await sendTelegramToChat(

        env,

        chatId,

        [

          `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

          "",

          "🥇 XAU/USD Gold Signal Engine",

          "",

          "/status — وضعیت موتور",

          "/signal — بررسی سیگنال",

          "/news — اخبار مهم",

          "",

          CONFIG.FOOTER

        ].join("\n")
      );


      return jsonResponse({
        ok: true
      });
    }


    // --------------------------------------------------------
    // /status
    // --------------------------------------------------------

    if (
      text.startsWith(
        "/status"
      )
    ) {

      const cache =
        getTwelveDataCacheStatus();


      await sendTelegramToChat(

        env,

        chatId,

        [

          `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

          "",

          `🟢 Telegram: CONNECTED`,

          `🟢 Twelve Data: ${getEnv(env, "TWELVE_DATA_API_KEY") ? "CONFIGURED" : "MISSING"}`,

          `📡 Session: ${inSession() ? "OPEN" : "CLOSED"}`,

          `🥇 Symbol: ${CONFIG.SYMBOL}`,

          "",

          `⚡ 15M cache: ${cache.fast_15m.cached ? cache.fast_15m.age_seconds + "s" : "-"}`,

          `⚡ 1H cache: ${cache.slow_1h.cached ? cache.slow_1h.age_seconds + "s" : "-"}`,

          `💳 Credits left: ${cache.fast_15m.api_credits_left ?? "-"}`,

          `⏱ Rate limit: ${cache.rate_limit_active ? cache.rate_limit_seconds_left + "s" : "OFF"}`,

          "",

          CONFIG.FOOTER

        ].join("\n")
      );


      return jsonResponse({
        ok: true
      });
    }


    // --------------------------------------------------------
    // /signal
    // --------------------------------------------------------

    if (
      text.startsWith(
        "/signal"
      )
    ) {

      const signal =
        await generateSignal(
          env
        );


      await sendTelegramToChat(

        env,

        chatId,

        signal.signal ===
          "WAIT"

          ? formatWaitMessage(
              signal
            )

          : formatSignalMessage(
              signal
            )
      );


      return jsonResponse({
        ok: true
      });
    }


    // --------------------------------------------------------
    // /news
    // --------------------------------------------------------

    if (
      text.startsWith(
        "/news"
      )
    ) {

      const events =
        await getLiveNews(
          env
        );


      const state =
        newsState(
          events
        );


      const lines = [

        `📰 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

        ""

      ];


      if (
        !state.events.length
      ) {

        lines.push(
          "✅ خبر مهم USD در بازه بررسی‌شده پیدا نشد."
        );

      } else {

        for (
          const event of
          state.events.slice(
            0,
            5
          )
        ) {

          lines.push(
            `• ${event.impact} | ${event.currency} | ${event.title}`
          );
        }
      }


      lines.push(
        "",
        CONFIG.FOOTER
      );


      await sendTelegramToChat(
        env,
        chatId,
        lines.join("\n")
      );


      return jsonResponse({
        ok: true
      });
    }


    // --------------------------------------------------------
    // UNKNOWN COMMAND
    // --------------------------------------------------------

    await sendTelegramToChat(

      env,

      chatId,

      [

        `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

        "",

        "دستور نامعتبر است.",

        "",

        "/start",

        "/status",

        "/signal",

        "/news"

      ].join("\n")
    );


    return jsonResponse({
      ok: true
    });


  } catch (error) {

    try {

      await sendTelegramToChat(

        env,

        chatId,

        `❌ Error: ${String(
          error?.message ||
          error
        )}`
      );

    } catch {}


    return jsonResponse(

      {
        ok: false,

        error:
          String(
            error?.message ||
            error
          )
      },

      500
    );
  }
}


async function telegramWebhook(
  request,
  env
) {

  return handleTelegramUpdate(
    request,
    env
  );
}


// ============================================================
// TELEGRAM WEBHOOK SET
// ============================================================

async function setTelegramWebhook(
  env,
  request
) {

  const url =
    new URL(
      request.url
    );


  const webhookUrl =
    `${url.origin}/telegram-webhook`;


  const secret =
    getWebhookSecret(
      env
    );


  const payload = {

    url:
      webhookUrl,

    allowed_updates:
      ["message"]
  };


  if (secret) {

    payload.secret_token =
      secret;
  }


  const result =
    await telegramApi(

      env,

      "setWebhook",

      payload
    );


  return jsonResponse({

    ok: true,

    webhook:
      webhookUrl,

    telegram:
      result

  });
}


// ============================================================
// WEBHOOK INFO
// ============================================================

async function getTelegramWebhookInfo(
  env
) {

  const result =
    await telegramApi(

      env,

      "getWebhookInfo",

      {}
    );


  return jsonResponse({

    ok: true,

    telegram:
      result

  });
}


// ============================================================
// HEALTH
// ============================================================

async function healthResponse(
  env
) {

  const apiKey =
    getEnv(
      env,
      "TWELVE_DATA_API_KEY"
    );


  const botToken =
    getEnv(
      env,
      "TELEGRAM_BOT_TOKEN"
    );


  const chatId =
    getEnv(
      env,
      "TELEGRAM_CHAT_ID"
    );


  return jsonResponse({

    ok: true,

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    twelve_data:
      Boolean(apiKey),

    telegram:
      Boolean(
        botToken &&
        chatId
      ),

    telegram_bot_token:
      Boolean(botToken),

    telegram_chat_id:
      Boolean(chatId),

    session:
      inSession()
        ? "OPEN"
        : "CLOSED",

    cache:
      getTwelveDataCacheStatus(),

    news_cache: {

      cached:
        Boolean(
          memory.news.data
        ),

      age_seconds:
        memory.news.data
          ? Math.floor(
              (
                Date.now() -
                memory.news.fetchedAt
              ) / 1000
            )
          : null,

      last_error:
        memory.news.lastError
    },

    timestamp:
      new Date().toISOString()

  });
}


// ============================================================
// NEWS RESPONSE
// ============================================================

async function newsResponse(
  env
) {

  const events =
    await getLiveNews(
      env
    );


  const state =
    newsState(
      events
    );


  return jsonResponse({

    ok: true,

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    blocked:
      state.blocked,

    blocked_event:
      state.blockedEvent,

    upcoming:
      state.upcoming,

    events:
      state.events,

    timestamp:
      new Date().toISOString()

  });
}


// ============================================================
// SIGNAL RESPONSE
// ============================================================

async function signalResponse(
  env,
  request
) {

  const signal =
    await generateSignal(
      env
    );


  const url =
    new URL(
      request.url
    );


  const shouldSend =
    url.searchParams.get(
      "send"
    ) === "1";


  let telegram = {

    sent: false,

    reason:
      "send=1 not requested."
  };


  if (
    shouldSend
  ) {

    telegram =
      await maybeSendSignal(
        env,
        signal
      );
  }


  return jsonResponse({

    ok: true,

    ...signal,

    telegram,

    cache:
      getTwelveDataCacheStatus()

  });
}


// ============================================================
// HOMEPAGE
// ============================================================

function renderHomepage() {

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<meta
name="theme-color"
content="#111827"
>

<title>
Hakim Gold Signals — Gold Signal Engine
</title>

<style>

body{
margin:0;
font-family:Arial,sans-serif;
background:#0f172a;
color:#e5e7eb
}

main{
max-width:760px;
margin:40px auto;
padding:20px
}

.card{
background:#111827;
border:1px solid #334155;
border-radius:18px;
padding:22px;
margin-bottom:16px
}

h1{
margin-top:0
}

pre{
white-space:pre-wrap;
word-break:break-word;
background:#020617;
padding:16px;
border-radius:12px
}

button{
border:0;
border-radius:10px;
padding:12px 16px;
cursor:pointer
}

</style>

</head>

<body>

<main>

<div class="card">

<h1>
💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}
</h1>

<p>
Gold Quality · XAU/USD · 15M + 1H
</p>

<button
onclick="loadSignal()"
>
🔄 بروزرسانی
</button>

</div>


<div class="card">

<pre id="output">
در حال دریافت اطلاعات...
</pre>

</div>


<div class="card">

<p>
این موتور صرفاً شرایط فعلی بازار را تحلیل می‌کند.
سیگنال تضمین سود نیست.
</p>

<p>
${CONFIG.FOOTER}
</p>

</div>

</main>


<script>

async function loadSignal(){

const out =
document.getElementById(
"output"
);

out.textContent =
"در حال بررسی...";

try{

const r =
await fetch(
"/api/signals"
);

const d =
await r.json();


if(
d.signal === "WAIT"
){

out.textContent = [

"⏸ WAIT",

"Score: " +
(d.score ?? "-") +
"/100",

"Price: " +
(d.price ?? "-"),

"15M: " +
(d.fast?.trend ?? "-"),

"1H: " +
(d.slow?.trend ?? "-"),

"ADX 15M: " +
(d.fast?.adx ?? "-"),

"DI Spread: " +
(d.fast?.diSpread ?? "-"),

"RSI: " +
(d.fast?.rsi ?? "-"),

"",

d.reason || ""

].join("\\n");


}else{

out.textContent =
JSON.stringify(
d,
null,
2
);

}

}catch(e){

out.textContent =
"❌ Error: " +
e.message;

}

}

loadSignal();

setInterval(
loadSignal,
60000
);

</script>

</body>
</html>`;
}


// ============================================================
// CORS
// ============================================================

function withCors(
  response
) {

  const headers =
    new Headers(
      response.headers
    );


  headers.set(
    "access-control-allow-origin",
    "*"
  );


  headers.set(
    "access-control-allow-methods",
    "GET,POST,OPTIONS"
  );


  headers.set(
    "access-control-allow-headers",
    "content-type,x-telegram-bot-api-secret-token"
  );


  return new Response(

    response.body,

    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers
    }

  );
}


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );


    const path =
      url.pathname;


    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

    if (
      request.method ===
      "OPTIONS"
    ) {

      return withCors(

        new Response(
          null,
          {
            status: 204
          }
        )

      );
    }


    try {

      // ------------------------------------------------------
      // HOME
      // ------------------------------------------------------

      if (
        path === "/"
      ) {

        return withCors(

          new Response(
            renderHomepage(),

            {
              headers: {
                "content-type":
                  "text/html; charset=UTF-8"
              }
            }
          )

        );
      }


      // ------------------------------------------------------
      // HEALTH
      // ------------------------------------------------------

      if (
        path === "/health"
      ) {

        return withCors(
          await healthResponse(
            env
          )
        );
      }


      // ------------------------------------------------------
      // SIGNALS
      // ------------------------------------------------------

      if (
        path ===
        "/api/signals"
      ) {

        return withCors(

          await signalResponse(
            env,
            request
          )

        );
      }


      // ------------------------------------------------------
      // NEWS
      // ------------------------------------------------------

      if (
        path === "/api/news"
      ) {

        return withCors(

          await newsResponse(
            env
          )

        );
      }


      // ------------------------------------------------------
      // TELEGRAM TEST
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-test"
      ) {

        const result =
          await sendTelegram(

            env,

            [

              `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

              "",

              "🟢 Telegram connection test successful.",

              `🥇 ${CONFIG.SYMBOL}`,

              "",

              CONFIG.FOOTER

            ].join("\n")

          );


        return withCors(

          jsonResponse({

            ok: true,

            telegram:
              result

          })

        );
      }


      // ------------------------------------------------------
      // TELEGRAM STATUS
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-status"
      ) {

        const result =
          await telegramApi(

            env,

            "getMe",

            {}

          );


        return withCors(

          jsonResponse({

            ok: true,

            telegram:
              result

          })

        );
      }


      // ------------------------------------------------------
      // SET WEBHOOK
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-set-webhook"
      ) {

        return withCors(

          await setTelegramWebhook(
            env,
            request
          )

        );
      }


      // ------------------------------------------------------
      // WEBHOOK INFO
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-webhook-info"
      ) {

        return withCors(

          await getTelegramWebhookInfo(
            env
          )

        );
      }


      // ------------------------------------------------------
      // TELEGRAM WEBHOOK
      // ------------------------------------------------------

      if (
        path ===
        "/telegram-webhook"
      ) {

        return withCors(

          await telegramWebhook(
            request,
            env
          )

        );
      }


      // ------------------------------------------------------
      // RUN NOW
      // ------------------------------------------------------

      if (
        path === "/run-now"
      ) {

        const result =
          await runScheduled(
            env
          );


        return withCors(

          jsonResponse({

            ok: true,

            ...result

          })

        );
      }


      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      return withCors(

        jsonResponse(

          {
            ok: false,

            error:
              "Not found",

            version:
              CONFIG.VERSION
          },

          404

        )

      );


    } catch (error) {

      return withCors(

        jsonResponse(

          {
            ok: false,

            version:
              CONFIG.VERSION,

            error:
              String(
                error?.message ||
                error
              ),

            cache:
              getTwelveDataCacheStatus()
          },

          500

        )

      );
    }
  },


  // ========================================================
  // CLOUDFLARE CRON
  // ========================================================

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(
      runScheduled(
        env
      ).catch(
        () => {}
      )
    );
  }

};
