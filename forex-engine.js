// ============================================================
// FOREX SIGNAL ENGINE V7.0.4 — ULTRA GOLD SIGNAL
// Cloudflare Worker + Twelve Data + Telegram
//
// PRIMARY: XAU/USD
// TIMEFRAMES: 15M + 1H
//
// V7.0.4:
// - Ultra quality signal filtering
// - Strong 15M + 1H confluence
// - 1H requires full confirmation
// - 15M requires strong confirmation
// - Minimum fast score 88/100
// - Minimum direction lead 40
// - Stronger ADX / DI filters
// - Stronger momentum filter
// - Pullback-first early-entry logic
// - Anti-chase protection
// - ATR + structure based SL/TP
// - RR minimum 1.50
// - Break-even management level
// - Profit-lock management level
// - Early invalidation / exit condition
// - Fixed candle freshness detection
// - Current 15M candle is not treated as stale
// - Current 1H candle is not treated as stale
// - Allows current candle + one previous candle
// - Telegram WAIT status
// - Telegram BUY/SELL alerts
// - Cron every 15 minutes
// - Manual /run-now endpoint
// ============================================================

const CONFIG = {
  VERSION: "V7.0.4",

  SYMBOL: "XAU/USD",

  INTERVAL_FAST: "15min",
  INTERVAL_SLOW: "1h",

  OUTPUTSIZE: 100,

  // ----------------------------------------------------------
  // ULTRA SIGNAL FILTERS
  // ----------------------------------------------------------

  MIN_SCORE: 88,

  MIN_DIRECTION_LEAD: 40,

  MIN_ADX: 22,

  MIN_ADX_SLOPE: -0.20,

  MIN_SLOW_ADX: 22,

  MIN_DI_SPREAD: 6,

  MIN_SLOW_DI_SPREAD: 6,

  MIN_MOMENTUM: 0.020,

  MIN_RR: 1.50,

  // 1H must also have a reasonably strong score.
  MIN_SLOW_SCORE: 72,

  // ----------------------------------------------------------
  // PULLBACK / ENTRY TIMING
  // ----------------------------------------------------------

  // Maximum distance from EMA20 for early pullback entry.
  PULLBACK_MAX_DISTANCE_ATR: 0.85,

  // Small EMA tolerance for a reclaiming candle.
  PULLBACK_EMA_TOLERANCE_ATR: 0.20,

  // ----------------------------------------------------------
  // TELEGRAM
  // ----------------------------------------------------------

  TELEGRAM_ENABLED: true,

  TELEGRAM_SEND_SIGNAL: true,

  TELEGRAM_SEND_WAIT_STATUS: true,

  TELEGRAM_SEND_NEWS: true,

  // ----------------------------------------------------------
  // SESSION
  // ----------------------------------------------------------

  SESSION_ENABLED: true,

  SESSION_START_UTC: 7,

  SESSION_END_UTC: 20,

  WEEKDAYS_ONLY: true,

  // ----------------------------------------------------------
  // DATA FRESHNESS
  //
  // Candle datetime is the OPEN time of the candle.
  // We therefore evaluate candle buckets instead of raw age.
  // ----------------------------------------------------------

  FRESHNESS: {
    "15min": {
      intervalSeconds: 900,
      maxBucketLag: 1
    },

    "1h": {
      intervalSeconds: 3600,
      maxBucketLag: 1
    }
  },

  // ----------------------------------------------------------
  // ATR / TRADE PLAN
  // ----------------------------------------------------------

  ATR_PERIOD: 14,

  SL_ATR_MULTIPLIER: 1.10,

  STRUCTURE_BUFFER_ATR: 0.10,

  TP1_R_MULTIPLIER: 1.50,

  TP2_R_MULTIPLIER: 2.20,

  // ----------------------------------------------------------
  // TRADE MANAGEMENT
  // ----------------------------------------------------------

  BREAK_EVEN_TRIGGER_R: 0.70,

  PROFIT_LOCK_TRIGGER_R: 1.00,

  PROFIT_LOCK_R: 0.20,

  // ----------------------------------------------------------
  // ANTI CHASE
  // ----------------------------------------------------------

  MAX_DISTANCE_FROM_EMA20_ATR: 1.10,

  // ----------------------------------------------------------
  // CACHE
  // ----------------------------------------------------------

  FAST_CACHE_SECONDS: 60,

  SLOW_CACHE_SECONDS: 300,

  // ----------------------------------------------------------
  // NEWS
  // ----------------------------------------------------------

  NEWS_ENABLED: false
};


// ============================================================
// GLOBAL MEMORY CACHE
// ============================================================

let MEMORY_CACHE = {
  fast: null,
  slow: null,
  fastAt: 0,
  slowAt: 0
};


// ============================================================
// BASIC HELPERS
// ============================================================

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0;
  }

  const p = 10 ** digits;

  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}

function textResponse(
  text,
  status = 200
) {
  return new Response(
    String(text),
    {
      status,

      headers: {
        "content-type":
          "text/plain; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}


// ============================================================
// ENVIRONMENT
// ============================================================

function getEnvValue(
  env,
  names
) {
  for (
    const name of names
  ) {
    if (
      env &&
      env[name] !== undefined &&
      env[name] !== null &&
      String(env[name]).trim() !== ""
    ) {
      return String(
        env[name]
      ).trim();
    }
  }

  return "";
}

function getTwelveDataKey(env) {
  return getEnvValue(
    env,
    [
      "TWELVE_DATA_API_KEY",
      "TWELVEDATA_API_KEY",
      "TWELVE_DATA_KEY"
    ]
  );
}

function getTelegramToken(env) {
  return getEnvValue(
    env,
    [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_TOKEN",
      "BOT_TOKEN"
    ]
  );
}

function getTelegramChatId(env) {
  return getEnvValue(
    env,
    [
      "TELEGRAM_CHAT_ID",
      "CHAT_ID"
    ]
  );
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegramApi(
  env,
  method,
  body = null
) {
  const token =
    getTelegramToken(env);

  if (!token) {
    return {
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing"
    };
  }

  const url =
    `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;

  try {
    const response =
      await fetch(
        url,
        {
          method:
            body
              ? "POST"
              : "GET",

          headers:
            body
              ? {
                  "content-type":
                    "application/json"
                }
              : undefined,

          body:
            body
              ? JSON.stringify(body)
              : undefined
        }
      );

    const text =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      data = {
        ok: false,
        description: text
      };
    }

    if (!response.ok) {
      return {
        ok: false,

        httpStatus:
          response.status,

        telegram:
          data
      };
    }

    if (
      data &&
      data.ok === false
    ) {
      return {
        ok: false,
        telegram: data
      };
    }

    return data;

  } catch (error) {
    return {
      ok: false,

      error:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}


// ============================================================
// SEND TELEGRAM MESSAGE
// ============================================================

async function sendTelegramToChat(
  env,
  text,
  options = {}
) {
  if (
    !CONFIG.TELEGRAM_ENABLED
  ) {
    return {
      ok: false,

      skipped: true,

      reason:
        "Telegram disabled"
    };
  }

  const chatId =
    options.chatId ||
    getTelegramChatId(env);

  if (!chatId) {
    return {
      ok: false,

      error:
        "TELEGRAM_CHAT_ID is missing"
    };
  }

  const payload = {
    chat_id:
      String(chatId),

    text:
      String(text),

    disable_web_page_preview:
      true
  };

  if (options.parse_mode) {
    payload.parse_mode =
      options.parse_mode;
  }

  return await telegramApi(
    env,
    "sendMessage",
    payload
  );
}


// ============================================================
// TWELVE DATA
// ============================================================

async function twelveDataRequest(
  env,
  interval
) {
  const apiKey =
    getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const params =
    new URLSearchParams();

  params.set(
    "symbol",
    CONFIG.SYMBOL
  );

  params.set(
    "interval",
    interval
  );

  params.set(
    "outputsize",
    String(
      CONFIG.OUTPUTSIZE
    )
  );

  params.set(
    "apikey",
    apiKey
  );

  params.set(
    "format",
    "JSON"
  );

  params.set(
    "timezone",
    "UTC"
  );

  const url =
    `https://api.twelvedata.com/time_series?${params.toString()}`;

  const response =
    await fetch(
      url,
      {
        method: "GET",

        headers: {
          "accept":
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    throw new Error(
      `Twelve Data invalid JSON: ${text.slice(0, 300)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (
    data.status === "error"
  ) {
    throw new Error(
      data.message ||
      "Twelve Data returned error"
    );
  }

  if (
    !Array.isArray(
      data.values
    )
  ) {
    throw new Error(
      "Twelve Data returned no values"
    );
  }

  return data;
}


// ============================================================
// NORMALIZE CANDLES
// ============================================================

function normalizeCandles(
  values
) {
  return values
    .map(item => ({
      datetime:
        String(
          item.datetime || ""
        ),

      open:
        safeNumber(
          item.open
        ),

      high:
        safeNumber(
          item.high
        ),

      low:
        safeNumber(
          item.low
        ),

      close:
        safeNumber(
          item.close
        ),

      volume:
        safeNumber(
          item.volume
        )
    }))

    .filter(c =>
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )

    .sort(
      (a, b) =>
        parseCandleTimestamp(
          a.datetime
        ) -
        parseCandleTimestamp(
          b.datetime
        )
    );
}


// ============================================================
// CACHE HELPERS
// ============================================================

async function getCandles(
  env,
  interval,
  forceRefresh = false
) {
  const isFast =
    interval ===
    CONFIG.INTERVAL_FAST;

  const cacheKey =
    isFast
      ? "fast"
      : "slow";

  const cacheAge =
    isFast
      ? CONFIG.FAST_CACHE_SECONDS * 1000
      : CONFIG.SLOW_CACHE_SECONDS * 1000;

  const cached =
    MEMORY_CACHE[
      cacheKey
    ];

  const cachedAt =
    MEMORY_CACHE[
      isFast
        ? "fastAt"
        : "slowAt"
    ];

  if (
    !forceRefresh &&
    cached &&
    cachedAt &&
    nowMs() -
      cachedAt <
      cacheAge
  ) {
    return cached;
  }

  try {
    const raw =
      await twelveDataRequest(
        env,
        interval
      );

    const candles =
      normalizeCandles(
        raw.values
      );

    if (
      candles.length < 60
    ) {
      throw new Error(
        `Not enough ${interval} candles`
      );
    }

    MEMORY_CACHE[
      cacheKey
    ] =
      candles;

    MEMORY_CACHE[
      isFast
        ? "fastAt"
        : "slowAt"
    ] =
      nowMs();

    return candles;

  } catch (error) {
    if (
      cached &&
      cached.length >= 60
    ) {
      return cached;
    }

    throw error;
  }
}


// ============================================================
// TIME / FRESHNESS
// ============================================================

function candleTimestamp(
  candle
) {
  if (!candle) {
    return 0;
  }

  const t =
    parseCandleTimestamp(
      candle.datetime
    );

  return Number.isFinite(t)
    ? t
    : 0;
}

function getDataAgeSeconds(
  candles
) {
  if (
    !candles ||
    !candles.length
  ) {
    return Infinity;
  }

  const latest =
    candles[
      candles.length - 1
    ];

  const ts =
    candleTimestamp(
      latest
    );

  if (!ts) {
    return Infinity;
  }

  return Math.max(
    0,
    (
      nowMs() -
      ts
    ) / 1000
  );
}


// ============================================================
// PARSE CANDLE TIMESTAMP
// ============================================================

function parseCandleTimestamp(
  timestamp
) {
  if (
    timestamp === null ||
    timestamp === undefined
  ) {
    return NaN;
  }

  let value =
    String(
      timestamp
    ).trim();

  if (!value) {
    return NaN;
  }

  if (
    value.includes(" ") &&
    !value.includes("T")
  ) {
    value =
      value.replace(
        " ",
        "T"
      );
  }

  if (
    !/[zZ]$/.test(value) &&
    !/[+-]\d{2}:\d{2}$/.test(value)
  ) {
    value += "Z";
  }

  const parsed =
    Date.parse(value);

  return Number.isFinite(parsed)
    ? parsed
    : NaN;
}


// ============================================================
// INTERVAL SECONDS
// ============================================================

function getIntervalSeconds(
  interval
) {
  const config =
    CONFIG.FRESHNESS[
      interval
    ];

  if (
    config &&
    Number.isFinite(
      config.intervalSeconds
    )
  ) {
    return config.intervalSeconds;
  }

  if (
    interval === "1h"
  ) {
    return 3600;
  }

  return 900;
}


// ============================================================
// CANDLE FRESHNESS
// ============================================================

function freshnessForCandle(
  latestTimestamp,
  interval,
  currentMs = nowMs()
) {
  const intervalSeconds =
    getIntervalSeconds(
      interval
    );

  const tsMs =
    parseCandleTimestamp(
      latestTimestamp
    );

  if (
    !Number.isFinite(tsMs)
  ) {
    return {
      ok: false,

      reason:
        "Invalid candle timestamp",

      ageSeconds:
        null,

      bucketLag:
        null,

      intervalSeconds,

      candleTime:
        latestTimestamp || null
    };
  }

  const nowSeconds =
    Math.floor(
      currentMs / 1000
    );

  const candleSeconds =
    Math.floor(
      tsMs / 1000
    );

  const currentBucket =
    Math.floor(
      nowSeconds /
        intervalSeconds
    ) *
    intervalSeconds;

  const candleBucket =
    Math.floor(
      candleSeconds /
        intervalSeconds
    ) *
    intervalSeconds;

  const bucketLag =
    Math.floor(
      (
        currentBucket -
        candleBucket
      ) /
      intervalSeconds
    );

  const ageSeconds =
    Math.max(
      0,
      nowSeconds -
      candleSeconds
    );

  const maxBucketLag =
    CONFIG
      .FRESHNESS[
        interval
      ]?.maxBucketLag ??
    1;

  const ok =
    bucketLag >= 0 &&
    bucketLag <=
      maxBucketLag;

  return {
    ok,

    reason:
      ok
        ? "Current or recent candle"
        : "Candle bucket is stale",

    ageSeconds:
      round(
        ageSeconds,
        1
      ),

    bucketLag,

    intervalSeconds,

    maxBucketLag,

    candleTime:
      latestTimestamp,

    candleBucket:
      new Date(
        candleBucket * 1000
      ).toISOString(),

    currentBucket:
      new Date(
        currentBucket * 1000
      ).toISOString()
  };
}


// ============================================================
// FRESHNESS CHECK
// ============================================================

function freshnessCheck(
  fast,
  slow
) {
  const fastLatest =
    fast &&
    fast.length
      ? fast[
          fast.length - 1
        ]
      : null;

  const slowLatest =
    slow &&
    slow.length
      ? slow[
          slow.length - 1
        ]
      : null;

  const fastFreshness =
    freshnessForCandle(
      fastLatest?.datetime,
      CONFIG.INTERVAL_FAST
    );

  const slowFreshness =
    freshnessForCandle(
      slowLatest?.datetime,
      CONFIG.INTERVAL_SLOW
    );

  const fastRawAge =
    getDataAgeSeconds(
      fast
    );

  const slowRawAge =
    getDataAgeSeconds(
      slow
    );

  return {
    ok:
      fastFreshness.ok &&
      slowFreshness.ok,

    fastAgeSeconds:
      round(
        fastRawAge,
        1
      ),

    slowAgeSeconds:
      round(
        slowRawAge,
        1
      ),

    fastLimitSeconds:
      CONFIG.FRESHNESS[
        CONFIG.INTERVAL_FAST
      ].intervalSeconds,

    slowLimitSeconds:
      CONFIG.FRESHNESS[
        CONFIG.INTERVAL_SLOW
      ].intervalSeconds,

    fast:
      fastFreshness,

    slow:
      slowFreshness
  };
}


// ============================================================
// SESSION
// ============================================================

function sessionCheck(
  date = new Date()
) {
  if (
    !CONFIG.SESSION_ENABLED
  ) {
    return {
      ok: true,

      reason:
        "Session filter disabled"
    };
  }

  const hour =
    date.getUTCHours();

  const day =
    date.getUTCDay();

  if (
    CONFIG.WEEKDAYS_ONLY &&
    (
      day === 0 ||
      day === 6
    )
  ) {
    return {
      ok: false,

      reason:
        "Weekend"
    };
  }

  const start =
    CONFIG.SESSION_START_UTC;

  const end =
    CONFIG.SESSION_END_UTC;

  const ok =
    hour >= start &&
    hour < end;

  return {
    ok,

    reason:
      ok
        ? "Inside London/New York session"
        : "Outside London/New York session",

    utcHour:
      hour
  };
}


// ============================================================
// SMA
// ============================================================

function sma(
  values,
  period
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <
    period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    sum += values[i];

    if (
      i >= period
    ) {
      sum -=
        values[
          i - period
        ];
    }

    if (
      i >=
      period - 1
    ) {
      result[i] =
        sum / period;
    }
  }

  return result;
}


// ============================================================
// EMA
// ============================================================

function ema(
  values,
  period
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <
    period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    sum += values[i];
  }

  let previous =
    sum / period;

  result[
    period - 1
  ] =
    previous;

  const multiplier =
    2 /
    (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      (
        values[i] -
        previous
      ) *
        multiplier +
      previous;

    result[i] =
      previous;
  }

  return result;
}


// ============================================================
// TRUE RANGE
// ============================================================

function trueRange(
  candles
) {
  const tr =
    new Array(
      candles.length
    ).fill(null);

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {
    if (i === 0) {
      tr[i] =
        candles[i].high -
        candles[i].low;

      continue;
    }

    const current =
      candles[i];

    const previous =
      candles[
        i - 1
      ];

    tr[i] =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
            previous.close
        ),

        Math.abs(
          current.low -
            previous.close
        )
      );
  }

  return tr;
}


// ============================================================
// ATR
// ============================================================

function atr(
  candles,
  period = 14
) {
  const tr =
    trueRange(
      candles
    );

  const result =
    new Array(
      candles.length
    ).fill(null);

  if (
    candles.length <
    period + 1
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    sum += tr[i];
  }

  let previous =
    sum / period;

  result[
    period - 1
  ] =
    previous;

  for (
    let i = period;
    i < candles.length;
    i++
  ) {
    previous =
      (
        previous *
          (period - 1) +
        tr[i]
      ) / period;

    result[i] =
      previous;
  }

  return result;
}


// ============================================================
// RSI
// ============================================================

function rsi(
  values,
  period = 14
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <=
    period
  ) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (
      change >= 0
    ) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  if (
    avgLoss === 0
  ) {
    result[period] =
      100;
  } else {
    const rs =
      avgGain /
      avgLoss;

    result[period] =
      100 -
      100 /
        (1 + rs);
  }

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      Math.max(
        change,
        0
      );

    const loss =
      Math.max(
        -change,
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

    if (
      avgLoss === 0
    ) {
      result[i] =
        100;
    } else {
      const rs =
        avgGain /
        avgLoss;

      result[i] =
        100 -
        100 /
          (1 + rs);
    }
  }

  return result;
}


// ============================================================
// MACD
// ============================================================

function macd(
  values
) {
  const fast =
    ema(
      values,
      12
    );

  const slow =
    ema(
      values,
      26
    );

  const line =
    new Array(
      values.length
    ).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      fast[i] !== null &&
      slow[i] !== null
    ) {
      line[i] =
        fast[i] -
        slow[i];
    }
  }

  const valid =
    line.map(v =>
      v === null
        ? 0
        : v
    );

  const signal =
    ema(
      valid,
      9
    );

  const histogram =
    new Array(
      values.length
    ).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      line[i] !== null &&
      signal[i] !== null
    ) {
      histogram[i] =
        line[i] -
        signal[i];
    }
  }

  return {
    line,
    signal,
    histogram
  };
}


// ============================================================
// ADX / DI
// ============================================================

function adx(
  candles,
  period = 14
) {
  const length =
    candles.length;

  const plusDM =
    new Array(
      length
    ).fill(0);

  const minusDM =
    new Array(
      length
    ).fill(0);

  const tr =
    new Array(
      length
    ).fill(0);

  for (
    let i = 1;
    i < length;
    i++
  ) {
    const upMove =
      candles[i].high -
      candles[
        i - 1
      ].high;

    const downMove =
      candles[
        i - 1
      ].low -
      candles[i].low;

    plusDM[i] =
      upMove >
        downMove &&
      upMove > 0
        ? upMove
        : 0;

    minusDM[i] =
      downMove >
        upMove &&
      downMove > 0
        ? downMove
        : 0;

    tr[i] =
      Math.max(
        candles[i].high -
          candles[i].low,

        Math.abs(
          candles[i].high -
            candles[
              i - 1
            ].close
        ),

        Math.abs(
          candles[i].low -
            candles[
              i - 1
            ].close
        )
      );
  }

  const smoothedTR =
    new Array(
      length
    ).fill(null);

  const smoothedPlus =
    new Array(
      length
    ).fill(null);

  const smoothedMinus =
    new Array(
      length
    ).fill(null);

  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }

  smoothedTR[
    period
  ] =
    trSum;

  smoothedPlus[
    period
  ] =
    plusSum;

  smoothedMinus[
    period
  ] =
    minusSum;

  for (
    let i = period + 1;
    i < length;
    i++
  ) {
    smoothedTR[i] =
      smoothedTR[
        i - 1
      ] -
      smoothedTR[
        i - 1
      ] / period +
      tr[i];

    smoothedPlus[i] =
      smoothedPlus[
        i - 1
      ] -
      smoothedPlus[
        i - 1
      ] / period +
      plusDM[i];

    smoothedMinus[i] =
      smoothedMinus[
        i - 1
      ] -
      smoothedMinus[
        i - 1
      ] / period +
      minusDM[i];
  }

  const plusDI =
    new Array(
      length
    ).fill(null);

  const minusDI =
    new Array(
      length
    ).fill(null);

  const dx =
    new Array(
      length
    ).fill(null);

  for (
    let i = period;
    i < length;
    i++
  ) {
    if (
      !smoothedTR[i]
    ) {
      continue;
    }

    plusDI[i] =
      100 *
      smoothedPlus[i] /
      smoothedTR[i];

    minusDI[i] =
      100 *
      smoothedMinus[i] /
      smoothedTR[i];

    const denominator =
      plusDI[i] +
      minusDI[i];

    if (
      denominator !== 0
    ) {
      dx[i] =
        100 *
        Math.abs(
          plusDI[i] -
            minusDI[i]
        ) /
        denominator;
    }
  }

  const adxValues =
    new Array(
      length
    ).fill(null);

  let dxSum = 0;
  let dxCount = 0;

  for (
    let i = period;
    i < length;
    i++
  ) {
    if (
      dx[i] !== null
    ) {
      dxSum += dx[i];

      dxCount++;

      if (
        dxCount ===
        period
      ) {
        adxValues[i] =
          dxSum /
          period;

        break;
      }
    }
  }

  for (
    let i = period * 2;
    i < length;
    i++
  ) {
    if (
      adxValues[
        i - 1
      ] !== null &&
      dx[i] !== null
    ) {
      adxValues[i] =
        (
          adxValues[
            i - 1
          ] *
            (period - 1) +
          dx[i]
        ) / period;
    }
  }

  return {
    plusDI,
    minusDI,
    adx:
      adxValues
  };
}


// ============================================================
// CANDLE FEATURES
// ============================================================

function candleFeatures(
  candles,
  index
) {
  const c =
    candles[index];

  if (!c) {
    return {
      bullish: false,
      bearish: false,
      body: 0,
      range: 0,
      bodyRatio: 0,
      upperWick: 0,
      lowerWick: 0
    };
  }

  const range =
    Math.max(
      c.high -
        c.low,
      0.000001
    );

  const body =
    Math.abs(
      c.close -
        c.open
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
      c.close >
      c.open,

    bearish:
      c.close <
      c.open,

    body,

    range,

    bodyRatio:
      body / range,

    upperWick,

    lowerWick
  };
}


// ============================================================
// MARKET STRUCTURE
// ============================================================

function structureDirection(
  candles,
  lookback = 8
) {
  const n =
    candles.length;

  if (
    n <
    lookback + 2
  ) {
    return "NEUTRAL";
  }

  const recent =
    candles.slice(
      n -
        lookback,
      n
    );

  const highs =
    recent.map(
      c => c.high
    );

  const lows =
    recent.map(
      c => c.low
    );

  const closes =
    recent.map(
      c => c.close
    );

  const firstHalf =
    Math.floor(
      lookback / 2
    );

  const oldHigh =
    Math.max(
      ...highs.slice(
        0,
        firstHalf
      )
    );

  const newHigh =
    Math.max(
      ...highs.slice(
        firstHalf
      )
    );

  const oldLow =
    Math.min(
      ...lows.slice(
        0,
        firstHalf
      )
    );

  const newLow =
    Math.min(
      ...lows.slice(
        firstHalf
      )
    );

  const oldClose =
    closes[
      firstHalf - 1
    ];

  const newClose =
    closes[
      closes.length - 1
    ];

  if (
    newHigh > oldHigh &&
    newLow >= oldLow &&
    newClose > oldClose
  ) {
    return "BUY";
  }

  if (
    newLow < oldLow &&
    newHigh <= oldHigh &&
    newClose < oldClose
  ) {
    return "SELL";
  }

  if (
    newClose > oldClose &&
    newHigh >= oldHigh
  ) {
    return "BUY";
  }

  if (
    newClose < oldClose &&
    newLow <= oldLow
  ) {
    return "SELL";
  }

  return "NEUTRAL";
}


// ============================================================
// INDICATOR SNAPSHOT
// ============================================================

function buildIndicators(
  candles
) {
  const closes =
    candles.map(
      c => c.close
    );

  const ema20 =
    ema(
      closes,
      20
    );

  const ema50 =
    ema(
      closes,
      50
    );

  const ema100 =
    ema(
      closes,
      100
    );

  const rsiValues =
    rsi(
      closes,
      14
    );

  const macdValues =
    macd(
      closes
    );

  const adxValues =
    adx(
      candles,
      14
    );

  const atrValues =
    atr(
      candles,
      CONFIG.ATR_PERIOD
    );

  const i =
    candles.length -
    1;

  const previous =
    Math.max(
      0,
      i - 1
    );

  const currentClose =
    closes[i];

  const previousClose =
    closes[previous];

  const currentEma20 =
    ema20[i];

  const previousEma20 =
    ema20[previous];

  const currentEma50 =
    ema50[i];

  const currentEma100 =
    ema100[i];

  const currentRSI =
    rsiValues[i];

  const previousRSI =
    rsiValues[
      previous
    ];

  const currentATR =
    atrValues[i];

  const previousATR =
    atrValues[
      previous
    ];

  const currentMACD =
    macdValues.line[i];

  const previousMACD =
    macdValues.line[
      previous
    ];

  const currentSignal =
    macdValues.signal[i];

  const previousSignal =
    macdValues.signal[
      previous
    ];

  const currentHistogram =
    macdValues.histogram[i];

  const previousHistogram =
    macdValues.histogram[
      previous
    ];

  const currentADX =
    adxValues.adx[i];

  const previousADX =
    adxValues.adx[
      previous
    ];

  const currentPlusDI =
    adxValues.plusDI[i];

  const currentMinusDI =
    adxValues.minusDI[i];

  const previousPlusDI =
    adxValues.plusDI[
      previous
    ];

  const previousMinusDI =
    adxValues.minusDI[
      previous
    ];

  const structure =
    structureDirection(
      candles,
      8
    );

  const candle =
    candleFeatures(
      candles,
      i
    );

  const momentum =
    currentATR &&
    currentATR > 0
      ? (
          currentClose -
          closes[
            Math.max(
              0,
              i - 3
            )
          ]
        ) /
        currentATR
      : 0;

  return {
    price:
      currentClose,

    previousClose,

    ema20:
      currentEma20,

    previousEma20,

    ema50:
      currentEma50,

    ema100:
      currentEma100,

    rsi:
      currentRSI,

    previousRSI,

    rsiSlope:
      safeNumber(
        currentRSI,
        50
      ) -
      safeNumber(
        previousRSI,
        50
      ),

    macd:
      currentMACD,

    macdSignal:
      currentSignal,

    macdHistogram:
      currentHistogram,

    previousMACD,

    previousSignal,

    previousHistogram,

    adx:
      currentADX,

    previousADX,

    adxSlope:
      safeNumber(
        currentADX
      ) -
      safeNumber(
        previousADX
      ),

    plusDI:
      currentPlusDI,

    minusDI:
      currentMinusDI,

    previousPlusDI,

    previousMinusDI,

    diSpread:
      safeNumber(
        currentPlusDI
      ) -
      safeNumber(
        currentMinusDI
      ),

    atr:
      currentATR,

    previousATR,

    momentum,

    structure,

    candle,

    candleTime:
      candles[i].datetime,

    candleOpen:
      candles[i].open,

    candleHigh:
      candles[i].high,

    candleLow:
      candles[i].low,

    candleClose:
      candles[i].close
  };
}


// ============================================================
// TREND DIRECTION
// ============================================================

function trendDirection(
  ind
) {
  if (
    !ind ||
    !Number.isFinite(
      ind.ema20
    ) ||
    !Number.isFinite(
      ind.ema50
    ) ||
    !Number.isFinite(
      ind.ema100
    )
  ) {
    return "NEUTRAL";
  }

  if (
    ind.price >
      ind.ema20 &&
    ind.ema20 >
      ind.ema50 &&
    ind.ema50 >
      ind.ema100
  ) {
    return "BUY";
  }

  if (
    ind.price <
      ind.ema20 &&
    ind.ema20 <
      ind.ema50 &&
    ind.ema50 <
      ind.ema100
  ) {
    return "SELL";
  }

  if (
    ind.price >
      ind.ema20 &&
    ind.ema20 >
      ind.ema50
  ) {
    return "BUY";
  }

  if (
    ind.price <
      ind.ema20 &&
    ind.ema20 <
      ind.ema50
  ) {
    return "SELL";
  }

  return "NEUTRAL";
}


// ============================================================
// SCORE MODEL
//
// TOTAL = 100
//
// Trend       24
// Structure   16
// DI          14
// MACD        12
// RSI          8
// RSI Slope    4
// Momentum     8
// Candle       6
// ADX          5
// ADX Slope    3
// ============================================================

function scoreDirection(
  ind,
  direction
) {
  const isBuy =
    direction === "BUY";

  const isSell =
    direction === "SELL";

  if (
    !isBuy &&
    !isSell
  ) {
    return {
      total: 0,
      breakdown: {},
      reasons: []
    };
  }

  let score = 0;

  const breakdown = {};

  const reasons = [];

  // ----------------------------------------------------------
  // TREND 24
  // ----------------------------------------------------------

  let trendScore = 0;

  if (
    isBuy &&
    ind.price >
      ind.ema20
  ) {
    trendScore += 8;
  }

  if (
    isSell &&
    ind.price <
      ind.ema20
  ) {
    trendScore += 8;
  }

  if (
    isBuy &&
    ind.ema20 >
      ind.ema50
  ) {
    trendScore += 8;
  }

  if (
    isSell &&
    ind.ema20 <
      ind.ema50
  ) {
    trendScore += 8;
  }

  if (
    isBuy &&
    ind.ema50 >
      ind.ema100
  ) {
    trendScore += 8;
  }

  if (
    isSell &&
    ind.ema50 <
      ind.ema100
  ) {
    trendScore += 8;
  }

  trendScore =
    Math.min(
      trendScore,
      24
    );

  score +=
    trendScore;

  breakdown.trend =
    trendScore;

  // ----------------------------------------------------------
  // STRUCTURE 16
  // ----------------------------------------------------------

  let structureScore = 0;

  if (
    ind.structure ===
    direction
  ) {
    structureScore = 16;

    reasons.push(
      `${direction} structure`
    );
  } else if (
    ind.structure ===
    "NEUTRAL"
  ) {
    structureScore = 7;
  }

  score +=
    structureScore;

  breakdown.structure =
    structureScore;

  // ----------------------------------------------------------
  // DI 14
  // ----------------------------------------------------------

  const diSpread =
    ind.diSpread;

  let diScore = 0;

  if (
    isBuy &&
    diSpread >= 10
  ) {
    diScore = 14;

  } else if (
    isBuy &&
    diSpread >=
      CONFIG.MIN_DI_SPREAD
  ) {
    diScore = 10;

  } else if (
    isBuy &&
    diSpread > 0
  ) {
    diScore = 6;
  }

  if (
    isSell &&
    diSpread <= -10
  ) {
    diScore = 14;

  } else if (
    isSell &&
    diSpread <=
      -CONFIG.MIN_DI_SPREAD
  ) {
    diScore = 10;

  } else if (
    isSell &&
    diSpread < 0
  ) {
    diScore = 6;
  }

  score +=
    diScore;

  breakdown.di =
    diScore;

  // ----------------------------------------------------------
  // MACD 12
  // ----------------------------------------------------------

  let macdScore = 0;

  if (
    isBuy &&
    ind.macd >
      ind.macdSignal &&
    ind.macdHistogram > 0
  ) {
    macdScore = 12;

  } else if (
    isSell &&
    ind.macd <
      ind.macdSignal &&
    ind.macdHistogram < 0
  ) {
    macdScore = 12;

  } else if (
    isBuy &&
    ind.macd >
      ind.macdSignal
  ) {
    macdScore = 8;

  } else if (
    isSell &&
    ind.macd <
      ind.macdSignal
  ) {
    macdScore = 8;
  }

  score +=
    macdScore;

  breakdown.macd =
    macdScore;

  // ----------------------------------------------------------
  // RSI 8
  // ----------------------------------------------------------

  let rsiScore = 0;

  if (
    isBuy &&
    ind.rsi >= 53 &&
    ind.rsi <= 67
  ) {
    rsiScore = 8;

  } else if (
    isSell &&
    ind.rsi <= 47 &&
    ind.rsi >= 33
  ) {
    rsiScore = 8;

  } else if (
    isBuy &&
    ind.rsi > 50
  ) {
    rsiScore = 5;

  } else if (
    isSell &&
    ind.rsi < 50
  ) {
    rsiScore = 5;
  }

  score +=
    rsiScore;

  breakdown.rsi =
    rsiScore;

  // ----------------------------------------------------------
  // RSI SLOPE 4
  // ----------------------------------------------------------

  let rsiSlopeScore = 0;

  if (
    isBuy &&
    ind.rsiSlope > 0
  ) {
    rsiSlopeScore = 4;
  }

  if (
    isSell &&
    ind.rsiSlope < 0
  ) {
    rsiSlopeScore = 4;
  }

  score +=
    rsiSlopeScore;

  breakdown.rsiSlope =
    rsiSlopeScore;

  // ----------------------------------------------------------
  // MOMENTUM 8
  // ----------------------------------------------------------

  let momentumScore = 0;

  if (
    isBuy &&
    ind.momentum >= 0.10
  ) {
    momentumScore = 8;

  } else if (
    isBuy &&
    ind.momentum >=
      CONFIG.MIN_MOMENTUM
  ) {
    momentumScore = 5;

  } else if (
    isSell &&
    ind.momentum <= -0.10
  ) {
    momentumScore = 8;

  } else if (
    isSell &&
    ind.momentum <=
      -CONFIG.MIN_MOMENTUM
  ) {
    momentumScore = 5;
  }

  score +=
    momentumScore;

  breakdown.momentum =
    momentumScore;

  // ----------------------------------------------------------
  // CANDLE 6
  // ----------------------------------------------------------

  let candleScore = 0;

  if (
    isBuy &&
    ind.candle.bullish &&
    ind.candle.bodyRatio >=
      0.50
  ) {
    candleScore = 6;

  } else if (
    isSell &&
    ind.candle.bearish &&
    ind.candle.bodyRatio >=
      0.50
  ) {
    candleScore = 6;

  } else if (
    isBuy &&
    ind.candle.bullish
  ) {
    candleScore = 4;

  } else if (
    isSell &&
    ind.candle.bearish
  ) {
    candleScore = 4;
  }

  score +=
    candleScore;

  breakdown.candle =
    candleScore;

  // ----------------------------------------------------------
  // ADX 5
  // ----------------------------------------------------------

  let adxScore = 0;

  if (
    Number.isFinite(
      ind.adx
    ) &&
    ind.adx >= 30
  ) {
    adxScore = 5;

  } else if (
    Number.isFinite(
      ind.adx
    ) &&
    ind.adx >=
      CONFIG.MIN_ADX
  ) {
    adxScore = 3;
  }

  score +=
    adxScore;

  breakdown.adx =
    adxScore;

  // ----------------------------------------------------------
  // ADX SLOPE 3
  // ----------------------------------------------------------

  let adxSlopeScore = 0;

  if (
    Number.isFinite(
      ind.adxSlope
    ) &&
    ind.adxSlope >= 0.75
  ) {
    adxSlopeScore = 3;

  } else if (
    Number.isFinite(
      ind.adxSlope
    ) &&
    ind.adxSlope >=
      CONFIG.MIN_ADX_SLOPE
  ) {
    adxSlopeScore = 2;
  }

  score +=
    adxSlopeScore;

  breakdown.adxSlope =
    adxSlopeScore;

  return {
    total:
      Math.round(
        clamp(
          score,
          0,
          100
        )
      ),

    breakdown,

    reasons
  };
}


// ============================================================
// PULLBACK / EARLY ENTRY CHECK
// ============================================================

function pullbackEntryCheck(
  fast,
  direction
) {
  if (
    !fast ||
    !Number.isFinite(
      fast.price
    ) ||
    !Number.isFinite(
      fast.ema20
    ) ||
    !Number.isFinite(
      fast.atr
    ) ||
    fast.atr <= 0
  ) {
    return {
      ok: false,

      reason:
        "Invalid pullback data"
    };
  }

  const distance =
    Math.abs(
      fast.price -
      fast.ema20
    );

  const distanceATR =
    distance /
    fast.atr;

  if (
    distanceATR >
    CONFIG.PULLBACK_MAX_DISTANCE_ATR
  ) {
    return {
      ok: false,

      reason:
        `Entry too far from EMA20: ${round(distanceATR, 2)} ATR`,

      distanceATR:
        round(
          distanceATR,
          2
        )
    };
  }

  const tolerance =
    fast.atr *
    CONFIG.PULLBACK_EMA_TOLERANCE_ATR;

  const candleAligned =
    direction === "BUY"
      ? fast.candle?.bullish === true
      : fast.candle?.bearish === true;

  const currentSideOk =
    direction === "BUY"
      ? fast.price >=
        fast.ema20 -
          tolerance
      : fast.price <=
        fast.ema20 +
          tolerance;

  if (!currentSideOk) {
    return {
      ok: false,

      reason:
        `Price is on the wrong side of EMA20 for ${direction}`,

      distanceATR:
        round(
          distanceATR,
          2
        )
    };
  }

  const reclaimedEMA =
    direction === "BUY"
      ? safeNumber(
          fast.previousClose
        ) <=
          safeNumber(
            fast.previousEma20
          ) &&
        fast.price >
          fast.ema20
      : safeNumber(
          fast.previousClose
        ) >=
          safeNumber(
            fast.previousEma20
          ) &&
        fast.price <
          fast.ema20;

  if (
    !reclaimedEMA &&
    !candleAligned
  ) {
    return {
      ok: false,

      reason:
        "No clean pullback/reclaim confirmation",

      distanceATR:
        round(
          distanceATR,
          2
        )
    };
  }

  return {
    ok: true,

    reason:
      reclaimedEMA
        ? "EMA20 reclaim / early pullback entry"
        : "Price inside early pullback zone",

    distanceATR:
      round(
        distanceATR,
        2
      ),

    reclaimedEMA,

    candleAligned,

    ema20:
      round(
        fast.ema20,
        2
      ),

    atr:
      round(
        fast.atr,
        2
      )
  };
}


// ============================================================
// DIRECTION CHECK
//
// V7.0.4
//
// 1H:
// - Trend must agree
// - Structure must agree
// - DI must agree
// - MACD must agree
// - ADX must be strong
//
// 15M:
// - Requires strong multi-factor confirmation
// - Pullback entry is checked separately
// ============================================================

function directionCheck(
  fast,
  slow,
  direction
) {
  const reasons = [];

  const slowTrend =
    trendDirection(
      slow
    );

  const fastTrend =
    trendDirection(
      fast
    );

  // ----------------------------------------------------------
  // 1H CORE
  // ----------------------------------------------------------

  if (
    slowTrend !==
    direction
  ) {
    return {
      ok: false,

      confirmations: 0,

      minimumConfirmations: 5,

      reasons: [
        `1H trend is ${slowTrend}, expected ${direction}`
      ]
    };
  }

  const slowChecks = [
    {
      name:
        "1H trend",

      ok:
        slowTrend ===
        direction
    },

    {
      name:
        "1H structure",

      ok:
        slow.structure ===
        direction
    },

    {
      name:
        "1H DI",

      ok:
        direction === "BUY"
          ? slow.diSpread >=
            CONFIG.MIN_SLOW_DI_SPREAD
          : slow.diSpread <=
            -CONFIG.MIN_SLOW_DI_SPREAD
    },

    {
      name:
        "1H MACD",

      ok:
        direction === "BUY"
          ? slow.macd >
              slow.macdSignal &&
            slow.macdHistogram > 0
          : slow.macd <
              slow.macdSignal &&
            slow.macdHistogram < 0
    },

    {
      name:
        "1H ADX",

      ok:
        Number.isFinite(
          slow.adx
        ) &&
        slow.adx >=
          CONFIG.MIN_SLOW_ADX
    }
  ];

  let slowConfirmations = 0;

  for (
    const check of slowChecks
  ) {
    if (check.ok) {
      slowConfirmations++;

      reasons.push(
        `${check.name} confirmed`
      );
    }
  }

  // ALL 5 of 5 for ultra signal.
  if (
    slowConfirmations <
    5
  ) {
    return {
      ok: false,

      confirmations:
        slowConfirmations,

      minimumConfirmations:
        5,

      slowConfirmations,

      fastConfirmations:
        0,

      reasons
    };
  }

  // ----------------------------------------------------------
  // 15M CONFIRMATIONS
  // ----------------------------------------------------------

  const fastChecks = [
    {
      name:
        "15M trend",

      ok:
        fastTrend ===
        direction
    },

    {
      name:
        "15M structure",

      ok:
        fast.structure ===
          direction ||
        fast.structure ===
          "NEUTRAL"
    },

    {
      name:
        "15M DI",

      ok:
        direction === "BUY"
          ? fast.diSpread >=
            CONFIG.MIN_DI_SPREAD
          : fast.diSpread <=
            -CONFIG.MIN_DI_SPREAD
    },

    {
      name:
        "15M MACD",

      ok:
        direction === "BUY"
          ? fast.macd >
              fast.macdSignal &&
            fast.macdHistogram > 0
          : fast.macd <
              fast.macdSignal &&
            fast.macdHistogram < 0
    },

    {
      name:
        "15M momentum",

      ok:
        direction === "BUY"
          ? fast.momentum >=
            CONFIG.MIN_MOMENTUM
          : fast.momentum <=
            -CONFIG.MIN_MOMENTUM
    },

    {
      name:
        "15M RSI",

      ok:
        direction === "BUY"
          ? fast.rsi >= 52
          : fast.rsi <= 48
    },

    {
      name:
        "15M candle",

      ok:
        direction === "BUY"
          ? fast.candle.bullish
          : fast.candle.bearish
    },

    {
      name:
        "15M ADX",

      ok:
        Number.isFinite(
          fast.adx
        ) &&
        fast.adx >=
          CONFIG.MIN_ADX
    },

    {
      name:
        "15M ADX slope",

      ok:
        Number.isFinite(
          fast.adxSlope
        ) &&
        fast.adxSlope >=
          CONFIG.MIN_ADX_SLOPE
    }
  ];

  let fastConfirmations = 0;

  for (
    const check of fastChecks
  ) {
    if (check.ok) {
      fastConfirmations++;

      reasons.push(
        `${check.name} confirmed`
      );
    }
  }

  const minimumFast =
    6;

  if (
    fastConfirmations <
    minimumFast
  ) {
    return {
      ok: false,

      confirmations:
        slowConfirmations +
        fastConfirmations,

      slowConfirmations,

      fastConfirmations,

      minimumConfirmations:
        minimumFast,

      reasons
    };
  }

  // ----------------------------------------------------------
  // ANTI CHASE
  // ----------------------------------------------------------

  if (
    fast.atr &&
    fast.ema20
  ) {
    const distance =
      Math.abs(
        fast.price -
        fast.ema20
      );

    const distanceATR =
      distance /
      fast.atr;

    if (
      distanceATR >
      CONFIG.MAX_DISTANCE_FROM_EMA20_ATR
    ) {
      return {
        ok: false,

        confirmations:
          slowConfirmations +
          fastConfirmations,

        slowConfirmations,

        fastConfirmations,

        minimumConfirmations:
          minimumFast,

        reasons: [
          ...reasons,

          `Anti-chase: price is ${round(distanceATR, 2)} ATR from EMA20`
        ]
      };
    }
  }

  return {
    ok: true,

    confirmations:
      slowConfirmations +
      fastConfirmations,

    slowConfirmations,

    fastConfirmations,

    minimumConfirmations:
      minimumFast,

    reasons
  };
}


// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(
  fast,
  slow,
  direction
) {
  if (
    direction !== "BUY" &&
    direction !== "SELL"
  ) {
    return {
      ok: false,

      reason:
        "Invalid direction"
    };
  }

  const entry =
    fast.price;

  const atrValue =
    fast.atr;

  if (
    !Number.isFinite(
      entry
    ) ||
    !Number.isFinite(
      atrValue
    ) ||
    atrValue <= 0
  ) {
    return {
      ok: false,

      reason:
        "Invalid price or ATR"
    };
  }

  // ----------------------------------------------------------
  // STRUCTURE LEVELS
  // ----------------------------------------------------------

  const recentCandles =
    12;

  const recent =
    fast.__candles
      ? fast.__candles.slice(
          -recentCandles
        )
      : [];

  let structureHigh =
    entry;

  let structureLow =
    entry;

  if (
    recent.length
  ) {
    structureHigh =
      Math.max(
        ...recent.map(
          c => c.high
        )
      );

    structureLow =
      Math.min(
        ...recent.map(
          c => c.low
        )
      );
  }

  // ----------------------------------------------------------
  // ATR STOP
  // ----------------------------------------------------------

  const atrStopDistance =
    atrValue *
    CONFIG.SL_ATR_MULTIPLIER;

  const structureBuffer =
    atrValue *
    CONFIG.STRUCTURE_BUFFER_ATR;

  let stopLoss;

  if (
    direction === "BUY"
  ) {
    stopLoss =
      Math.min(
        entry -
          atrStopDistance,

        structureLow -
          structureBuffer
      );

  } else {
    stopLoss =
      Math.max(
        entry +
          atrStopDistance,

        structureHigh +
          structureBuffer
      );
  }

  const risk =
    Math.abs(
      entry -
      stopLoss
    );

  if (
    !Number.isFinite(
      risk
    ) ||
    risk <= 0
  ) {
    return {
      ok: false,

      reason:
        "Invalid risk"
    };
  }

  // ----------------------------------------------------------
  // TAKE PROFITS
  // ----------------------------------------------------------

  const tp1Distance =
    risk *
    CONFIG.TP1_R_MULTIPLIER;

  const tp2Distance =
    risk *
    CONFIG.TP2_R_MULTIPLIER;

  let tp1;
  let tp2;

  if (
    direction === "BUY"
  ) {
    tp1 =
      entry +
      tp1Distance;

    tp2 =
      entry +
      tp2Distance;

  } else {
    tp1 =
      entry -
      tp1Distance;

    tp2 =
      entry -
      tp2Distance;
  }

  const rr1 =
    Math.abs(
      tp1 -
      entry
    ) / risk;

  const rr2 =
    Math.abs(
      tp2 -
      entry
    ) / risk;

  if (
    rr1 <
    CONFIG.MIN_RR
  ) {
    return {
      ok: false,

      reason:
        `RR ${round(rr1, 2)} below minimum ${CONFIG.MIN_RR}`
    };
  }

  // ----------------------------------------------------------
  // BREAK EVEN
  // ----------------------------------------------------------

  const breakEvenTriggerDistance =
    risk *
    CONFIG.BREAK_EVEN_TRIGGER_R;

  let breakEvenTrigger;

  if (
    direction === "BUY"
  ) {
    breakEvenTrigger =
      entry +
      breakEvenTriggerDistance;
  } else {
    breakEvenTrigger =
      entry -
      breakEvenTriggerDistance;
  }

  // ----------------------------------------------------------
  // PROFIT LOCK
  // ----------------------------------------------------------

  const profitLockTriggerDistance =
    risk *
    CONFIG.PROFIT_LOCK_TRIGGER_R;

  const profitLockAmount =
    risk *
    CONFIG.PROFIT_LOCK_R;

  let profitLockTrigger;
  let profitLockStop;

  if (
    direction === "BUY"
  ) {
    profitLockTrigger =
      entry +
      profitLockTriggerDistance;

    profitLockStop =
      entry +
      profitLockAmount;
  } else {
    profitLockTrigger =
      entry -
      profitLockTriggerDistance;

    profitLockStop =
      entry -
      profitLockAmount;
  }

  // ----------------------------------------------------------
  // EARLY INVALIDATION
  // ----------------------------------------------------------

  const invalidation =
    direction === "BUY"
      ? "15M candle closes below EMA20 AND MACD histogram turns negative"
      : "15M candle closes above EMA20 AND MACD histogram turns positive";

  return {
    ok: true,

    direction,

    entry:
      round(
        entry,
        2
      ),

    stopLoss:
      round(
        stopLoss,
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

    risk:
      round(
        risk,
        2
      ),

    rr1:
      round(
        rr1,
        2
      ),

    rr2:
      round(
        rr2,
        2
      ),

    atr:
      round(
        atrValue,
        2
      ),

    structureHigh:
      round(
        structureHigh,
        2
      ),

    structureLow:
      round(
        structureLow,
        2
      ),

    management: {
      breakEvenTriggerR:
        CONFIG.BREAK_EVEN_TRIGGER_R,

      breakEvenTrigger:
        round(
          breakEvenTrigger,
          2
        ),

      breakEvenStop:
        round(
          entry,
          2
        ),

      profitLockTriggerR:
        CONFIG.PROFIT_LOCK_TRIGGER_R,

      profitLockTrigger:
        round(
          profitLockTrigger,
          2
        ),

      profitLockR:
        CONFIG.PROFIT_LOCK_R,

      profitLockStop:
        round(
          profitLockStop,
          2
        ),

      invalidation
    }
  };
}


// ============================================================
// SIGNAL GENERATOR
// ============================================================

function generateSignal(
  fastCandles,
  slowCandles
) {
  const fast =
    buildIndicators(
      fastCandles
    );

  const slow =
    buildIndicators(
      slowCandles
    );

  // Attach candles for trade-plan structure.
  fast.__candles =
    fastCandles;

  slow.__candles =
    slowCandles;

  const freshness =
    freshnessCheck(
      fastCandles,
      slowCandles
    );

  if (
    !freshness.ok
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score: 0,

      slowScore: 0,

      buyScore: 0,

      sellScore: 0,

      reason:
        "Market data is stale",

      freshness,

      fast,

      slow,

      tradePlan:
        null
    };
  }

  const session =
    sessionCheck();

  if (
    !session.ok
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score: 0,

      slowScore: 0,

      buyScore: 0,

      sellScore: 0,

      reason:
        session.reason,

      session,

      freshness,

      fast,

      slow,

      tradePlan:
        null
    };
  }

  const buy =
    scoreDirection(
      fast,
      "BUY"
    );

  const sell =
    scoreDirection(
      fast,
      "SELL"
    );

  const slowBuy =
    scoreDirection(
      slow,
      "BUY"
    );

  const slowSell =
    scoreDirection(
      slow,
      "SELL"
    );

  const buyScore =
    buy.total;

  const sellScore =
    sell.total;

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

  const slowScore =
    direction === "BUY"
      ? slowBuy.total
      : slowSell.total;

  const losingScore =
    Math.min(
      buyScore,
      sellScore
    );

  const directionLead =
    score -
    losingScore;

  const selected =
    direction === "BUY"
      ? buy
      : sell;

  // ----------------------------------------------------------
  // SCORE CHECK
  // ----------------------------------------------------------

  if (
    score <
    CONFIG.MIN_SCORE
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        `Score ${score} below minimum ${CONFIG.MIN_SCORE}`,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan:
        null
    };
  }

  // ----------------------------------------------------------
  // 1H SCORE CHECK
  // ----------------------------------------------------------

  if (
    slowScore <
    CONFIG.MIN_SLOW_SCORE
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        `1H score ${slowScore} below minimum ${CONFIG.MIN_SLOW_SCORE}`,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan:
        null
    };
  }

  // ----------------------------------------------------------
  // DIRECTION LEAD
  // ----------------------------------------------------------

  if (
    directionLead <
    CONFIG.MIN_DIRECTION_LEAD
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        `Direction lead ${directionLead} below minimum ${CONFIG.MIN_DIRECTION_LEAD}`,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan:
        null
    };
  }

  // ----------------------------------------------------------
  // STRONG DIRECTION CONFIRMATION
  // ----------------------------------------------------------

  const confirmation =
    directionCheck(
      fast,
      slow,
      direction
    );

  if (
    !confirmation.ok
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        "Multi-timeframe strong confirmation failed",

      confirmation,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan:
        null
    };
  }

  // ----------------------------------------------------------
  // EARLY PULLBACK ENTRY CHECK
  // ----------------------------------------------------------

  const pullback =
    pullbackEntryCheck(
      fast,
      direction
    );

  if (
    !pullback.ok
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        pullback.reason,

      confirmation,

      pullback,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan:
        null
    };
  }

  // ----------------------------------------------------------
  // TRADE PLAN
  // ----------------------------------------------------------

  const tradePlan =
    buildTradePlan(
      fast,
      slow,
      direction
    );

  if (
    !tradePlan.ok
  ) {
    return {
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      signal:
        "WAIT",

      score,

      slowScore,

      buyScore,

      sellScore,

      directionLead,

      reason:
        tradePlan.reason,

      confirmation,

      pullback,

      session,

      freshness,

      fast,

      slow,

      scoreBreakdown:
        selected.breakdown,

      tradePlan
    };
  }

  // ----------------------------------------------------------
  // FINAL ULTRA SIGNAL
  // ----------------------------------------------------------

  return {
    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    signal:
      direction,

    score,

    slowScore,

    buyScore,

    sellScore,

    directionLead,

    reason:
      `${direction} ULTRA confirmed by 15M + 1H + Pullback`,

    confirmation,

    pullback,

    session,

    freshness,

    fast,

    slow,

    scoreBreakdown:
      selected.breakdown,

    tradePlan,

    generatedAt:
      nowIso()
  };
}


// ============================================================
// FORMAT NUMBER
// ============================================================

function fmt(
  value,
  digits = 2
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return "-";
  }

  return Number(
    value
  ).toFixed(
    digits
  );
}


// ============================================================
// TELEGRAM SIGNAL MESSAGE
// ============================================================

function formatSignalMessage(
  signal
) {
  const p =
    signal.tradePlan;

  const m =
    p?.management ||
    {};

  const f =
    signal.fast;

  const s =
    signal.slow;

  const emoji =
    signal.signal === "BUY"
      ? "🟢"
      : "🔴";

  const title =
    signal.signal === "BUY"
      ? "BUY"
      : "SELL";

  return [
    `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

    ``,

    `${emoji} ${title} — ULTRA`,

    `XAU/USD`,

    ``,

    `⭐ 15M Score: ${signal.score}/100`,

    `⭐ 1H Score: ${signal.slowScore}/100`,

    `📊 Buy Score: ${signal.buyScore}/100`,

    `📊 Sell Score: ${signal.sellScore}/100`,

    `📐 Direction Lead: ${signal.directionLead}`,

    ``,

    `💰 Entry: ${fmt(p.entry)}`,

    `🛑 Stop Loss: ${fmt(p.stopLoss)}`,

    `🎯 TP1: ${fmt(p.tp1)}`,

    `🎯 TP2: ${fmt(p.tp2)}`,

    `📏 Risk: ${fmt(p.risk)}`,

    `📈 RR1: ${fmt(p.rr1)}`,

    `📈 RR2: ${fmt(p.rr2)}`,

    ``,

    `⚡ Break-even: ${fmt(m.breakEvenTrigger)} (${m.breakEvenTriggerR ?? "-"}R)`,

    `🔒 Profit Lock: ${fmt(m.profitLockTrigger)} → SL ${fmt(m.profitLockStop)}`,

    ``,

    `⏱ 15M Price: ${fmt(f.price)}`,

    `📉 15M RSI: ${fmt(f.rsi, 1)}`,

    `📊 15M ADX: ${fmt(f.adx, 1)}`,

    `↔️ 15M DI Spread: ${fmt(f.diSpread, 1)}`,

    `📐 15M Structure: ${f.structure}`,

    ``,

    `⏱ 1H Price: ${fmt(s.price)}`,

    `📉 1H RSI: ${fmt(s.rsi, 1)}`,

    `📊 1H ADX: ${fmt(s.adx, 1)}`,

    `↔️ 1H DI Spread: ${fmt(s.diSpread, 1)}`,

    `📐 1H Structure: ${s.structure}`,

    ``,

    `🎯 Entry Timing: ${signal.pullback?.reason || "-"}`,

    `📏 Pullback Distance: ${fmt(signal.pullback?.distanceATR, 2)} ATR`,

    ``,

    `🚨 Invalidation: ${m.invalidation || "-"}`,

    ``,

    `🧠 Reason: ${signal.reason}`,

    ``,

    `⚠️ این موتور تحلیل و مدیریت پیشنهادی معامله را ارائه می‌کند و سود یا موفقیت معامله را تضمین نمی‌کند.`,

    ``,

    `🕒 ${signal.generatedAt || nowIso()}`
  ].join("\n");
}


// ============================================================
// FORMAT WAIT MESSAGE
// ============================================================

function formatWaitStatusMessage(
  signal
) {
  const f =
    signal.fast ||
    {};

  const s =
    signal.slow ||
    {};

  const session =
    signal.session ||
    {};

  const freshness =
    signal.freshness ||
    {};

  return [
    `💎 HAKIM GOLD SIGNALS ${CONFIG.VERSION}`,

    ``,

    `⏸ WAIT`,

    `XAU/USD`,

    ``,

    `⭐ Score: ${signal.score ?? "-"}/100`,

    `⭐ 1H Score: ${signal.slowScore ?? "-"}/100`,

    `🟢 Buy Score: ${signal.buyScore ?? "-"}`,

    `🔴 Sell Score: ${signal.sellScore ?? "-"}`,

    `📐 Direction Lead: ${signal.directionLead ?? "-"}`,

    ``,

    `💰 Price: ${fmt(f.price)}`,

    `📊 15M ADX: ${fmt(f.adx, 1)}`,

    `↔️ 15M DI: ${fmt(f.diSpread, 1)}`,

    `📉 15M RSI: ${fmt(f.rsi, 1)}`,

    `📐 15M Structure: ${f.structure || "-"}`,

    ``,

    `📊 1H ADX: ${fmt(s.adx, 1)}`,

    `↔️ 1H DI: ${fmt(s.diSpread, 1)}`,

    `📉 1H RSI: ${fmt(s.rsi, 1)}`,

    `📐 1H Structure: ${s.structure || "-"}`,

    ``,

    `⛔ ${signal.reason || "No valid signal"}`,

    ``,

    `📡 Data 15M: ${freshness.fastAgeSeconds ?? "-"}s`,

    `📡 Data 1H: ${freshness.slowAgeSeconds ?? "-"}s`,

    `🕒 Session: ${session.reason || "-"}`,

    ``,

    `سیگنال قوی فقط زمانی ارسال می‌شود که امتیاز، روند 1H، تأیید 15M و نقطه ورود همگی مناسب باشند.`,

    ``,

    `🕒 ${nowIso()}`
  ].join("\n");
}


// ============================================================
// NEWS
// ============================================================

async function getNews(
  env
) {
  if (
    !CONFIG.NEWS_ENABLED
  ) {
    return [];
  }

  // Intentionally conservative.
  // Signal engine continues working if no news provider exists.

  return [];
}

function formatNewsMessage(
  news
) {
  if (
    !Array.isArray(news) ||
    !news.length
  ) {
    return "";
  }

  const lines = [
    `📰 GOLD NEWS ALERT`,
    ``
  ];

  for (
    const item of news.slice(
      0,
      5
    )
  ) {
    lines.push(
      `• ${item.title || "News"}`
    );
  }

  return lines.join(
    "\n"
  );
}


// ============================================================
// DUPLICATE PROTECTION
// ============================================================

async function getLastSignal(
  env
) {
  if (
    !env ||
    !env.SIGNAL_KV
  ) {
    return null;
  }

  try {
    const raw =
      await env.SIGNAL_KV.get(
        "last_signal"
      );

    if (!raw) {
      return null;
    }

    return JSON.parse(
      raw
    );

  } catch {
    return null;
  }
}

async function saveLastSignal(
  env,
  signal
) {
  if (
    !env ||
    !env.SIGNAL_KV
  ) {
    return false;
  }

  try {
    await env.SIGNAL_KV.put(
      "last_signal",

      JSON.stringify({
        signal:
          signal.signal,

        score:
          signal.score,

        slowScore:
          signal.slowScore,

        entry:
          signal.tradePlan?.entry,

        tp1:
          signal.tradePlan?.tp1,

        tp2:
          signal.tradePlan?.tp2,

        generatedAt:
          signal.generatedAt
      }),

      {
        expirationTtl:
          86400
      }
    );

    return true;

  } catch {
    return false;
  }
}

function isDuplicateSignal(
  previous,
  current
) {
  if (!previous) {
    return false;
  }

  if (
    previous.signal !==
    current.signal
  ) {
    return false;
  }

  const previousEntry =
    safeNumber(
      previous.entry
    );

  const currentEntry =
    safeNumber(
      current.tradePlan?.entry
    );

  if (
    !previousEntry ||
    !currentEntry
  ) {
    return false;
  }

  const difference =
    Math.abs(
      currentEntry -
      previousEntry
    );

  return (
    difference <=
    Math.max(
      1,
      current.tradePlan?.risk ||
        1
    )
  );
}


// ============================================================
// SEND SIGNAL
// ============================================================

async function maybeSendSignal(
  env,
  signal
) {
  if (
    !CONFIG.TELEGRAM_ENABLED
  ) {
    return {
      sent: false,

      reason:
        "Telegram disabled"
    };
  }

  // ----------------------------------------------------------
  // WAIT
  // ----------------------------------------------------------

  if (
    signal.signal ===
    "WAIT"
  ) {
    if (
      !CONFIG.TELEGRAM_SEND_WAIT_STATUS
    ) {
      return {
        sent: false,

        reason:
          "WAIT status sending disabled"
      };
    }

    const result =
      await sendTelegramToChat(
        env,

        formatWaitStatusMessage(
          signal
        )
      );

    return {
      sent:
        result.ok === true,

      type:
        "WAIT",

      telegram:
        result
    };
  }

  // ----------------------------------------------------------
  // BUY / SELL
  // ----------------------------------------------------------

  if (
    !CONFIG.TELEGRAM_SEND_SIGNAL
  ) {
    return {
      sent: false,

      reason:
        "Signal sending disabled"
    };
  }

  const previous =
    await getLastSignal(
      env
    );

  if (
    isDuplicateSignal(
      previous,
      signal
    )
  ) {
    return {
      sent: false,

      reason:
        "Duplicate signal blocked",

      previous
    };
  }

  const result =
    await sendTelegramToChat(
      env,

      formatSignalMessage(
        signal
      )
    );

  if (
    result.ok
  ) {
    await saveLastSignal(
      env,
      signal
    );
  }

  return {
    sent:
      result.ok === true,

    type:
      signal.signal,

    telegram:
      result
  };
}


// ============================================================
// ENGINE RUN
// ============================================================

async function runEngine(
  env,
  options = {}
) {
  const started =
    nowMs();

  const forceRefresh =
    options.forceRefresh ===
    true;

  const fast =
    await getCandles(
      env,

      CONFIG.INTERVAL_FAST,

      forceRefresh
    );

  const slow =
    await getCandles(
      env,

      CONFIG.INTERVAL_SLOW,

      forceRefresh
    );

  const signal =
    generateSignal(
      fast,
      slow
    );

  let telegram =
    null;

  if (
    options.sendTelegram !==
    false
  ) {
    telegram =
      await maybeSendSignal(
        env,
        signal
      );
  }

  return {
    ok: true,

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    generatedAt:
      nowIso(),

    durationMs:
      nowMs() -
      started,

    signal,

    telegram
  };
}


// ============================================================
// TELEGRAM TEST
// ============================================================

async function telegramTest(
  env
) {
  const chatId =
    getTelegramChatId(
      env
    );

  if (!chatId) {
    return {
      ok: false,

      error:
        "TELEGRAM_CHAT_ID is missing"
    };
  }

  const result =
    await sendTelegramToChat(
      env,

      [
        `✅ HAKIM GOLD SIGNALS`,
        ``,
        `Telegram connection test`,
        ``,
        `Version: ${CONFIG.VERSION}`,
        `Symbol: ${CONFIG.SYMBOL}`,
        ``,
        `Time: ${nowIso()}`
      ].join("\n")
    );

  return {
    ok:
      result.ok === true,

    chatId:
      String(chatId),

    telegram:
      result
  };
}


// ============================================================
// TELEGRAM STATUS
// ============================================================

async function telegramStatus(
  env
) {
  const token =
    getTelegramToken(
      env
    );

  const chatId =
    getTelegramChatId(
      env
    );

  if (!token) {
    return {
      ok: false,

      error:
        "TELEGRAM_BOT_TOKEN is missing"
    };
  }

  const me =
    await telegramApi(
      env,
      "getMe"
    );

  return {
    ok:
      me.ok === true,

    botTokenConfigured:
      true,

    chatIdConfigured:
      Boolean(chatId),

    chatId:
      chatId
        ? String(chatId)
        : null,

    bot:
      me
  };
}


// ============================================================
// TELEGRAM WEBHOOK INFO
// ============================================================

async function telegramWebhookInfo(
  env
) {
  const result =
    await telegramApi(
      env,
      "getWebhookInfo"
    );

  return {
    ok:
      result.ok === true,

    telegram:
      result
  };
}


// ============================================================
// SET TELEGRAM WEBHOOK
// ============================================================

async function telegramSetWebhook(
  env,
  requestUrl
) {
  const webhookUrl =
    new URL(
      "/telegram-webhook",
      requestUrl
    ).toString();

  const result =
    await telegramApi(
      env,
      "setWebhook",
      {
        url:
          webhookUrl
      }
    );

  return {
    ok:
      result.ok === true,

    webhookUrl,

    telegram:
      result
  };
}


// ============================================================
// WEBHOOK HANDLER
// ============================================================

async function handleTelegramWebhook(
  request,
  env
) {
  let update;

  try {
    update =
      await request.json();

  } catch {
    return jsonResponse(
      {
        ok: false,

        error:
          "Invalid JSON"
      },

      400
    );
  }

  const message =
    update?.message;

  if (
    message &&
    message.text
  ) {
    const text =
      String(
        message.text
      ).trim();

    const chatId =
      message.chat?.id;

    if (
      chatId !== undefined &&
      chatId !== null
    ) {
      if (
        text === "/start"
      ) {
        await sendTelegramToChat(
          env,

          [
            `💎 HAKIM GOLD SIGNALS`,
            ``,
            `ربات فعال است.`,
            ``,
            `نسخه: ${CONFIG.VERSION}`,
            `نماد: ${CONFIG.SYMBOL}`,
            ``,
            `برای بررسی وضعیت از /status استفاده کنید.`
          ].join("\n"),

          {
            chatId:
              String(chatId)
          }
        );
      }

      if (
        text === "/status"
      ) {
        await sendTelegramToChat(
          env,

          [
            `💎 HAKIM GOLD SIGNALS`,
            ``,
            `🟢 Worker فعال است.`,
            `Version: ${CONFIG.VERSION}`,
            `Symbol: ${CONFIG.SYMBOL}`,
            ``,
            `Time: ${nowIso()}`
          ].join("\n"),

          {
            chatId:
              String(chatId)
          }
        );
      }
    }
  }

  return jsonResponse({
    ok: true
  });
}


// ============================================================
// HTTP ROUTER
// ============================================================

async function handleRequest(
  request,
  env,
  ctx
) {
  const url =
    new URL(
      request.url
    );

  const pathname =
    url.pathname;

  // ----------------------------------------------------------
  // HOME
  // ----------------------------------------------------------

  if (
    pathname === "/" ||
    pathname === ""
  ) {
    return jsonResponse({
      ok: true,

      service:
        "FOREX SIGNAL ENGINE",

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      timeframes:
        [
          CONFIG.INTERVAL_FAST,
          CONFIG.INTERVAL_SLOW
        ],

      status:
        "online",

      time:
        nowIso()
    });
  }

  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  if (
    pathname === "/health"
  ) {
    return jsonResponse({
      ok: true,

      version:
        CONFIG.VERSION,

      time:
        nowIso()
    });
  }

  // ----------------------------------------------------------
  // RUN NOW
  // ----------------------------------------------------------

  if (
    pathname === "/run-now"
  ) {
    try {
      const result =
        await runEngine(
          env,
          {
            forceRefresh:
              url.searchParams.get(
                "refresh"
              ) === "1",

            sendTelegram:
              url.searchParams.get(
                "send"
              ) !== "0"
          }
        );

      return jsonResponse(
        result
      );

    } catch (error) {
      return jsonResponse(
        {
          ok: false,

          version:
            CONFIG.VERSION,

          error:
            error instanceof Error
              ? error.message
              : String(error),

          time:
            nowIso()
        },

        500
      );
    }
  }

  // ----------------------------------------------------------
  // API SIGNAL
  // ----------------------------------------------------------

  if (
    pathname ===
    "/api/signals"
  ) {
    try {
      const send =
        url.searchParams.get(
          "send"
        ) !== "0";

      const result =
        await runEngine(
          env,
          {
            forceRefresh:
              true,

            sendTelegram:
              send
          }
        );

      return jsonResponse(
        result
      );

    } catch (error) {
      return jsonResponse(
        {
          ok: false,

          version:
            CONFIG.VERSION,

          error:
            error instanceof Error
              ? error.message
              : String(error)
        },

        500
      );
    }
  }

  // ----------------------------------------------------------
  // TELEGRAM TEST
  // ----------------------------------------------------------

  if (
    pathname ===
    "/telegram-test"
  ) {
    const result =
      await telegramTest(
        env
      );

    return jsonResponse(
      result,

      result.ok
        ? 200
        : 500
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM STATUS
  // ----------------------------------------------------------

  if (
    pathname ===
    "/telegram-status"
  ) {
    const result =
      await telegramStatus(
        env
      );

    return jsonResponse(
      result,

      result.ok
        ? 200
        : 500
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM WEBHOOK INFO
  // ----------------------------------------------------------

  if (
    pathname ===
    "/telegram-webhook-info"
  ) {
    const result =
      await telegramWebhookInfo(
        env
      );

    return jsonResponse(
      result,

      result.ok
        ? 200
        : 500
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM SET WEBHOOK
  // ----------------------------------------------------------

  if (
    pathname ===
    "/telegram-set-webhook"
  ) {
    const result =
      await telegramSetWebhook(
        env,
        request.url
      );

    return jsonResponse(
      result,

      result.ok
        ? 200
        : 500
    );
  }

  // ----------------------------------------------------------
  // TELEGRAM WEBHOOK
  // ----------------------------------------------------------

  if (
    pathname ===
    "/telegram-webhook"
  ) {
    return await handleTelegramWebhook(
      request,
      env
    );
  }

  // ----------------------------------------------------------
  // CONFIG STATUS
  // ----------------------------------------------------------

  if (
    pathname ===
    "/config"
  ) {
    return jsonResponse({
      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      intervalFast:
        CONFIG.INTERVAL_FAST,

      intervalSlow:
        CONFIG.INTERVAL_SLOW,

      outputsize:
        CONFIG.OUTPUTSIZE,

      minScore:
        CONFIG.MIN_SCORE,

      minSlowScore:
        CONFIG.MIN_SLOW_SCORE,

      minDirectionLead:
        CONFIG.MIN_DIRECTION_LEAD,

      minADX:
        CONFIG.MIN_ADX,

      minADXSlope:
        CONFIG.MIN_ADX_SLOPE,

      minSlowADX:
        CONFIG.MIN_SLOW_ADX,

      minDISpread:
        CONFIG.MIN_DI_SPREAD,

      minSlowDISpread:
        CONFIG.MIN_SLOW_DI_SPREAD,

      minMomentum:
        CONFIG.MIN_MOMENTUM,

      minRR:
        CONFIG.MIN_RR,

      pullback:
        {
          maxDistanceATR:
            CONFIG.PULLBACK_MAX_DISTANCE_ATR,

          emaToleranceATR:
            CONFIG.PULLBACK_EMA_TOLERANCE_ATR
        },

      tradeManagement:
        {
          breakEvenTriggerR:
            CONFIG.BREAK_EVEN_TRIGGER_R,

          profitLockTriggerR:
            CONFIG.PROFIT_LOCK_TRIGGER_R,

          profitLockR:
            CONFIG.PROFIT_LOCK_R
        },

      freshness:
        CONFIG.FRESHNESS,

      telegramEnabled:
        CONFIG.TELEGRAM_ENABLED,

      telegramSendSignal:
        CONFIG.TELEGRAM_SEND_SIGNAL,

      telegramSendWait:
        CONFIG.TELEGRAM_SEND_WAIT_STATUS,

      session:
        {
          enabled:
            CONFIG.SESSION_ENABLED,

          startUTC:
            CONFIG.SESSION_START_UTC,

          endUTC:
            CONFIG.SESSION_END_UTC
        }
    });
  }

  // ----------------------------------------------------------
  // NOT FOUND
  // ----------------------------------------------------------

  return jsonResponse(
    {
      ok: false,

      error:
        "Not Found",

      path:
        pathname,

      version:
        CONFIG.VERSION
    },

    404
  );
}


// ============================================================
// SCHEDULED
// ============================================================

async function scheduled(
  event,
  env,
  ctx
) {
  const job =
    runEngine(
      env,
      {
        forceRefresh:
          true,

        sendTelegram:
          true
      }
    )

    .then(result => {
      console.log(
        "FOREX ENGINE RESULT:",

        JSON.stringify(
          result
        )
      );

      return result;
    })

    .catch(
      async error => {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          "FOREX ENGINE ERROR:",
          message
        );

        try {
          await sendTelegramToChat(
            env,

            [
              `🚨 FOREX ENGINE ERROR`,
              ``,
              `Version: ${CONFIG.VERSION}`,
              `Symbol: ${CONFIG.SYMBOL}`,
              ``,
              message,
              ``,
              nowIso()
            ].join("\n")
          );

        } catch (
          telegramError
        ) {
          console.error(
            "Telegram error:",
            telegramError
          );
        }

        return {
          ok: false,

          error:
            message
        };
      }
    );

  ctx.waitUntil(
    job
  );
}


// ============================================================
// EXPORT WORKER
// ============================================================

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      return await handleRequest(
        request,
        env,
        ctx
      );

    } catch (error) {
      console.error(
        "FETCH ERROR:",
        error
      );

      return jsonResponse(
        {
          ok: false,

          version:
            CONFIG.VERSION,

          error:
            error instanceof Error
              ? error.message
              : String(error),

          time:
            nowIso()
        },

        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    await scheduled(
      event,
      env,
      ctx
    );
  }
};
