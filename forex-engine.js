// ============================================================
// FOREX SIGNAL ENGINE V6.5
// GOLD QUALITY — XAU/USD
// 15M + 1H
//
// V6.5 GOALS:
// - Fewer but stronger setups
// - Mandatory 1H + 15M direction confirmation
// - ADX + DI strength filter
// - RSI direction filter
// - MACD histogram confirmation
// - Momentum strength filter
// - Structure-based pullback entry
// - ATR risk management
// - Entry distance protection
// - High-impact USD news protection
// - Telegram signal/news alerts
//
// Cloudflare Worker
//
// REQUIRED SECRETS:
// TWELVE_DATA_API_KEY
// TELEGRAM_BOT_TOKEN
// TELEGRAM_CHAT_ID
//
// OPTIONAL:
// TELEGRAM_NEWS_ENABLED
// ============================================================


const CONFIG = {

  VERSION: "V6.5",

  SYMBOL: "XAU/USD",

  INTERVAL_FAST: "15min",
  INTERVAL_SLOW: "1h",

  OUTPUT_SIZE_FAST: 150,
  OUTPUT_SIZE_SLOW: 150,


  // ==========================================================
  // QUALITY FILTERS
  // ==========================================================

  MIN_SCORE: 85,

  MIN_DIRECTION_LEAD: 15,

  MIN_ADX: 23,

  MIN_DI_SPREAD: 5,

  MIN_MOMENTUM: 0.03,

  MIN_RR: 1.30,


  // ==========================================================
  // ATR RISK
  // ==========================================================

  ATR_SL_MULTIPLIER: 1.20,

  ATR_ENTRY_MULTIPLIER: 0.55,

  MAX_ENTRY_DISTANCE_ATR: 1.20,

  MAX_ENTRY_DISTANCE_PERCENT: 0.55,

  MIN_ENTRY_DISTANCE_ATR: 0.08,


  // ==========================================================
  // RSI
  // ==========================================================

  BULL_RSI_MIN: 52,

  BULL_RSI_MAX: 68,

  BEAR_RSI_MIN: 32,

  BEAR_RSI_MAX: 48,


  // ==========================================================
  // NEWS
  // ==========================================================

  NEWS_FILTER_ENABLED: true,

  NEWS_FEED_ENABLED: true,

  NEWS_CURRENCY: "USD",

  NEWS_MIN_IMPACT: "High",

  NEWS_BEFORE_MINUTES: 45,

  NEWS_AFTER_MINUTES: 30,

  NEWS_ALERT_BEFORE_MINUTES: 30,

  NEWS_FETCH_TIMEOUT_MS: 10000,

  NEWS_FEED_URL:
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",

  NEWS_FAIL_CLOSED: true,

  NEWS_CACHE_SECONDS: 900,

  NEWS_LOOKAHEAD_HOURS: 48,


  // ==========================================================
  // TELEGRAM
  // ==========================================================

  TELEGRAM_ENABLED: true,

  TELEGRAM_SIGNAL_ENABLED: true,

  TELEGRAM_NEWS_ENABLED: true,

  TELEGRAM_NEWS_FOOTER:
    "💎 Hakim Gold Signals",


  // ==========================================================
  // API
  // ==========================================================

  API_TIMEOUT_MS: 15000,

  PRICE_DECIMALS: 2

};


// ============================================================
// MEMORY
// ============================================================

let memoryNewsCache = null;

let memoryNewsCacheTime = 0;

let memoryNewsDiagnostics = null;

let memorySentNews = new Set();

let memoryLastSignalKey = "";


// ============================================================
// ENV
// ============================================================

function getEnv(env, names) {

  for (const name of names) {

    const value = env[name];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return String(value).trim();
    }

  }

  return "";

}


// ============================================================
// NUMBER
// ============================================================

function num(value, fallback = 0) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;

}


function round(value, decimals = 2) {

  const factor =
    10 ** decimals;

  return Math.round(
    value * factor
  ) / factor;

}


function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}


// ============================================================
// FETCH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 15000
) {

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {

    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal
      }
    );

  } finally {

    clearTimeout(timer);

  }

}


// ============================================================
// TWELVE DATA
// ============================================================

async function getTimeSeries(
  env,
  interval,
  outputSize
) {

  const apiKey =
    getEnv(env, [
      "TWELVE_DATA_API_KEY",
      "کلید API دوازده داده"
    ]);

  if (!apiKey) {

    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );

  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(
      CONFIG.SYMBOL
    ) +
    "&interval=" +
    encodeURIComponent(
      interval
    ) +
    "&outputsize=" +
    encodeURIComponent(
      outputSize
    ) +
    "&format=JSON" +
    "&apikey=" +
    encodeURIComponent(
      apiKey
    );

  const response =
    await fetchWithTimeout(
      url,
      {
        headers: {
          "Accept":
            "application/json"
        }
      },
      CONFIG.API_TIMEOUT_MS
    );

  const text =
    await response.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      "Twelve Data returned invalid JSON"
    );

  }

  if (!response.ok) {

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );

  }

  if (
    data.status === "error" ||
    data.code
  ) {

    throw new Error(
      data.message ||
      `Twelve Data error ${data.code || ""}`
    );

  }

  if (
    !Array.isArray(
      data.values
    ) ||
    data.values.length < 60
  ) {

    throw new Error(
      "Not enough Twelve Data candles"
    );

  }

  return data.values

    .map(c => ({

      datetime:
        c.datetime,

      open:
        num(c.open),

      high:
        num(c.high),

      low:
        num(c.low),

      close:
        num(c.close),

      volume:
        num(c.volume)

    }))

    .filter(c =>

      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0

    )

    .reverse();

}


// ============================================================
// EMA
// ============================================================

function ema(
  values,
  period
) {

  if (
    values.length < period
  ) {
    return [];
  }

  const result = [];

  const multiplier =
    2 / (period + 1);

  let previous = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const value =
      num(values[i]);

    if (
      i === period - 1
    ) {

      let sum = 0;

      for (
        let j = 0;
        j < period;
        j++
      ) {

        sum +=
          num(values[j]);

      }

      previous =
        sum / period;

      result.push(
        previous
      );

    } else if (
      i >= period
    ) {

      previous =
        (value - previous) *
        multiplier +
        previous;

      result.push(
        previous
      );

    }

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

  if (
    values.length <= period
  ) {
    return [];
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

      losses +=
        Math.abs(change);

    }

  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  const result = [];

  function calculate() {

    if (
      avgLoss === 0
    ) {
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

  result.push(
    calculate()
  );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? Math.abs(change)
        : 0;

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

    result.push(
      calculate()
    );

  }

  return result;

}


// ============================================================
// ATR
// ============================================================

function atr(
  candles,
  period = 14
) {

  if (
    candles.length <= period
  ) {
    return [];
  }

  const trs = [];

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {

    if (i === 0) {

      trs.push(
        candles[i].high -
        candles[i].low
      );

      continue;

    }

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
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

    trs.push(tr);

  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {

    sum += trs[i];

  }

  let previous =
    sum / period;

  const result = [
    previous
  ];

  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    previous =
      (
        previous *
        (period - 1) +
        trs[i]
      ) / period;

    result.push(
      previous
    );

  }

  return result;

}


// ============================================================
// MACD
// ============================================================

function macd(values) {

  const ema12 =
    ema(values, 12);

  const ema26 =
    ema(values, 26);

  if (
    !ema12.length ||
    !ema26.length
  ) {

    return {

      macd: 0,

      signal: 0,

      histogram: 0

    };

  }

  const offset =
    ema12.length -
    ema26.length;

  const macdLine = [];

  for (
    let i = 0;
    i < ema26.length;
    i++
  ) {

    macdLine.push(

      ema12[
        i + offset
      ] -
      ema26[i]

    );

  }

  const signalLine =
    ema(
      macdLine,
      9
    );

  if (
    !signalLine.length
  ) {

    const last =
      macdLine[
        macdLine.length - 1
      ] || 0;

    return {

      macd: last,

      signal: 0,

      histogram: 0

    };

  }

  const lastMacd =
    macdLine[
      macdLine.length - 1
    ];

  const lastSignal =
    signalLine[
      signalLine.length - 1
    ];

  return {

    macd:
      lastMacd,

    signal:
      lastSignal,

    histogram:
      lastMacd -
      lastSignal

  };

}


// ============================================================
// ADX + DI
// ============================================================

function adxDetails(
  candles,
  period = 14
) {

  if (
    candles.length <=
    period + 2
  ) {

    return {

      adx: 0,

      plusDI: 0,

      minusDI: 0,

      spread: 0

    };

  }

  const tr = [];

  const plusDM = [];

  const minusDM = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const upMove =
      current.high -
      previous.high;

    const downMove =
      previous.low -
      current.low;

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

    tr.push(

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

      )

    );

  }

  if (
    tr.length < period
  ) {

    return {

      adx: 0,

      plusDI: 0,

      minusDI: 0,

      spread: 0

    };

  }

  let atrValue = 0;

  let plus = 0;

  let minus = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {

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

  for (
    let i = period;
    i < tr.length;
    i++
  ) {

    atrValue =
      (
        atrValue *
        (period - 1) +
        tr[i]
      ) / period;

    plus =
      (
        plus *
        (period - 1) +
        plusDM[i]
      ) / period;

    minus =
      (
        minus *
        (period - 1) +
        minusDM[i]
      ) / period;

    latestPlusDI =
      atrValue === 0
        ? 0
        : 100 *
          plus /
          atrValue;

    latestMinusDI =
      atrValue === 0
        ? 0
        : 100 *
          minus /
          atrValue;

    const denominator =
      latestPlusDI +
      latestMinusDI;

    const dx =
      denominator === 0
        ? 0
        : 100 *
          Math.abs(
            latestPlusDI -
            latestMinusDI
          ) /
          denominator;

    dxValues.push(dx);

  }

  if (
    dxValues.length < period
  ) {

    const adx =
      dxValues[
        dxValues.length - 1
      ] || 0;

    return {

      adx,

      plusDI:
        latestPlusDI,

      minusDI:
        latestMinusDI,

      spread:
        Math.abs(
          latestPlusDI -
          latestMinusDI
        )

    };

  }

  let adxValue = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {

    adxValue +=
      dxValues[i];

  }

  adxValue /= period;

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {

    adxValue =
      (
        adxValue *
        (period - 1) +
        dxValues[i]
      ) / period;

  }

  return {

    adx:
      adxValue,

    plusDI:
      latestPlusDI,

    minusDI:
      latestMinusDI,

    spread:
      Math.abs(
        latestPlusDI -
        latestMinusDI
      )

  };

}


// ============================================================
// MOMENTUM
// ============================================================

function momentum(
  values,
  period = 10
) {

  if (
    values.length <= period
  ) {
    return 0;
  }

  const current =
    values[
      values.length - 1
    ];

  const previous =
    values[
      values.length -
      1 -
      period
    ];

  if (
    !previous
  ) {
    return 0;
  }

  return (
    (
      current -
      previous
    ) / previous
  ) * 100;

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
    ema(
      closes,
      20
    );

  const e50 =
    ema(
      closes,
      50
    );

  const e20Prev =
    e20.length >= 2
      ? e20[e20.length - 2]
      : 0;

  const e50Prev =
    e50.length >= 2
      ? e50[e50.length - 2]
      : 0;

  const last =
    closes[
      closes.length - 1
    ];

  const ema20 =
    e20[
      e20.length - 1
    ];

  const ema50 =
    e50[
      e50.length - 1
    ];

  const ema20Slope =
    ema20 -
    e20Prev;

  const ema50Slope =
    ema50 -
    e50Prev;

  if (

    last > ema20 &&
    ema20 > ema50 &&
    ema20Slope > 0 &&
    ema50Slope >= 0

  ) {

    return "BULLISH";

  }

  if (

    last < ema20 &&
    ema20 < ema50 &&
    ema20Slope < 0 &&
    ema50Slope <= 0

  ) {

    return "BEARISH";

  }

  return "NEUTRAL";

}


// ============================================================
// STRUCTURE
// ============================================================

function structureSignal(
  candles
) {

  if (
    candles.length < 20
  ) {

    return "NEUTRAL";

  }

  const recent =
    candles.slice(-6);

  const previous =
    candles.slice(-12, -6);

  const recentHigh =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        c => c.low
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
    recentLow >
      previousLow

  ) {

    return "BULLISH";

  }

  if (

    recentHigh <
      previousHigh &&
    recentLow <
      previousLow

  ) {

    return "BEARISH";

  }

  return "NEUTRAL";

}


// ============================================================
// BREAKOUT
// ============================================================

function breakoutSignal(
  candles
) {

  if (
    candles.length < 25
  ) {

    return "NEUTRAL";

  }

  const recent =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      -21,
      -1
    );

  const high =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const low =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  if (
    recent.close > high
  ) {

    return "BULLISH";

  }

  if (
    recent.close < low
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
    !candles.length
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
    c.high -
    c.low;

  if (
    range <= 0
  ) {

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
      c.close > c.open &&
      bodyRatio >= 0.45,

    bearish:
      c.close < c.open &&
      bodyRatio >= 0.45,

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

  const trend =
    analyzeTrend(
      candles
    );

  const structure =
    structureSignal(
      candles
    );

  const breakout =
    breakoutSignal(
      candles
    );

  const rsiValues =
    rsi(
      closes,
      14
    );

  const rsi14 =
    rsiValues[
      rsiValues.length - 1
    ] || 50;

  const previousRSI =
    rsiValues.length >= 2
      ? rsiValues[
          rsiValues.length - 2
        ]
      : rsi14;

  const macdData =
    macd(
      closes
    );

  const atrValues =
    atr(
      candles,
      14
    );

  const atr14 =
    atrValues[
      atrValues.length - 1
    ] || 0;

  const adxData =
    adxDetails(
      candles,
      14
    );

  const mom =
    momentum(
      closes,
      10
    );

  const candle =
    candleQuality(
      candles
    );

  return {

    trend,

    structure,

    breakout,

    rsi14,

    previousRSI,

    macd:
      macdData.macd,

    macdSignal:
      macdData.signal,

    macdHistogram:
      macdData.histogram,

    atr14,

    adx14:
      adxData.adx,

    plusDI:
      adxData.plusDI,

    minusDI:
      adxData.minusDI,

    diSpread:
      adxData.spread,

    momentum:
      mom,

    candleBodyRatio:
      candle.bodyRatio,

    candleBullish:
      candle.bullish,

    candleBearish:
      candle.bearish

  };

}


// ============================================================
// NEWS CURRENCY
// ============================================================

function normalizeNewsCurrency(
  value
) {

  const s =
    String(
      value ?? ""
    )
    .trim()
    .toUpperCase();

  if (

    s === "USD" ||
    s === "US DOLLAR" ||
    s === "UNITED STATES" ||
    s === "UNITED STATES DOLLAR" ||
    s === "USA"

  ) {

    return "USD";

  }

  return s;

}


// ============================================================
// NEWS IMPACT
// ============================================================

function normalizeNewsImpact(
  value
) {

  const s =
    String(
      value ?? ""
    )
    .trim()
    .toLowerCase();

  if (

    s === "high" ||
    s.includes("high") ||
    s === "3"

  ) {

    return "High";

  }

  if (

    s === "medium" ||
    s === "med" ||
    s.includes("medium") ||
    s === "2"

  ) {

    return "Medium";

  }

  if (

    s === "low" ||
    s.includes("low") ||
    s === "1"

  ) {

    return "Low";

  }

  return "";

}


// ============================================================
// NEWS TIMESTAMP
// ============================================================

function parseNewsTimestamp(
  item
) {

  if (

    item.timestamp !== undefined &&
    item.timestamp !== null &&
    item.timestamp !== ""

  ) {

    const numeric =
      Number(
        item.timestamp
      );

    if (
      Number.isFinite(
        numeric
      )
    ) {

      return numeric <
        10000000000

        ? numeric * 1000
        : numeric;

    }

  }

  const candidates = [

    item.date,

    item.datetime,

    item.datetime_utc,

    item.time

  ];

  for (
    const value of
    candidates
  ) {

    if (!value)
      continue;

    const parsed =
      Date.parse(
        String(value)
      );

    if (
      Number.isFinite(
        parsed
      )
    ) {

      return parsed;

    }

  }

  return null;

}


// ============================================================
// NORMALIZE NEWS
// ============================================================

function normalizeNewsEvents(
  data
) {

  const source =
    Array.isArray(data)

      ? data

      : Array.isArray(
          data?.events
        )

        ? data.events

        : [];

  return source

    .map(item => {

      const timestamp =
        parseNewsTimestamp(
          item
        );

      return {

        title:
          String(
            item.title ||
            item.event ||
            item.name ||
            "USD News"
          ),

        country:
          normalizeNewsCurrency(
            item.country ||
            item.currency ||
            item.curr
          ),

        impact:
          normalizeNewsImpact(
            item.impact ||
            item.importance
          ),

        timestamp,

        forecast:
          item.forecast ?? "",

        previous:
          item.previous ?? ""

      };

    })

    .filter(item =>

      item.country === "USD" &&
      item.impact === "High" &&
      Number.isFinite(
        item.timestamp
      )

    )

    .sort(
      (a, b) =>
        a.timestamp -
        b.timestamp
    );

}


// ============================================================
// LIVE NEWS
// ============================================================

async function getLiveNews() {

  const now =
    Date.now();

  if (

    memoryNewsCache &&
    now -
      memoryNewsCacheTime <
      CONFIG.NEWS_CACHE_SECONDS *
      1000

  ) {

    return memoryNewsCache;

  }

  const started =
    Date.now();

  try {

    const response =
      await fetchWithTimeout(

        CONFIG.NEWS_FEED_URL,

        {

          headers: {

            "Accept":
              "application/json",

            "User-Agent":
              "Mozilla/5.0 HakimGoldSignals/6.5"

          }

        },

        CONFIG.NEWS_FETCH_TIMEOUT_MS

      );

    const fetchMs =
      Date.now() -
      started;

    const text =
      await response.text();

    if (
      !response.ok
    ) {

      throw new Error(
        `News HTTP ${response.status}`
      );

    }

    let raw;

    try {

      raw =
        JSON.parse(
          text
        );

    } catch {

      throw new Error(
        "News feed returned invalid JSON"
      );

    }

    const rawEvents =
      Array.isArray(raw)
        ? raw
        : Array.isArray(
            raw?.events
          )
          ? raw.events
          : [];

    const events =
      normalizeNewsEvents(
        raw
      );

    const usdEvents =
      rawEvents.filter(
        item =>

          normalizeNewsCurrency(
            item.country ||
            item.currency ||
            item.curr
          ) === "USD"

      );

    const highImpactUsd =
      usdEvents.filter(
        item =>

          normalizeNewsImpact(
            item.impact ||
            item.importance
          ) === "High"

      );

    const beforeMs =
      CONFIG.NEWS_BEFORE_MINUTES *
      60 *
      1000;

    const afterMs =
      CONFIG.NEWS_AFTER_MINUTES *
      60 *
      1000;

    const lookaheadMs =
      CONFIG.NEWS_LOOKAHEAD_HOURS *
      60 *
      60 *
      1000;

    let blockedEvent =
      null;

    let nextEvent =
      null;

    for (
      const event of
      events
    ) {

      const diff =
        event.timestamp -
        now;

      if (

        diff >= -afterMs &&
        diff <= beforeMs

      ) {

        blockedEvent =
          event;

        break;

      }

      if (

        diff >= 0 &&
        diff <= lookaheadMs &&
        !nextEvent

      ) {

        nextEvent =
          event;

      }

    }

    const result = {

      enabled: true,

      feedStatus:
        "connected",

      httpStatus:
        response.status,

      fetchMs,

      rawEvents:
        rawEvents.length,

      usdEvents:
        usdEvents.length,

      highImpactUsd:
        highImpactUsd.length,

      events,

      blocked:
        Boolean(
          blockedEvent
        ),

      blockedEvent,

      nextEvent,

      message:

        blockedEvent

          ? "High impact USD news window is active."

          : "خبر مهمی در بازه بررسی‌شده پیدا نشد."

    };

    memoryNewsCache =
      result;

    memoryNewsCacheTime =
      now;

    memoryNewsDiagnostics =
      result;

    return result;

  } catch (error) {

    const result = {

      enabled: true,

      feedStatus:
        "error",

      httpStatus: 0,

      fetchMs:
        Date.now() -
        started,

      rawEvents: 0,

      usdEvents: 0,

      highImpactUsd: 0,

      events: [],

      blocked:
        CONFIG.NEWS_FAIL_CLOSED,

      blockedEvent:
        null,

      nextEvent:
        null,

      error:
        String(
          error?.message ||
          error
        ),

      message:

        CONFIG.NEWS_FAIL_CLOSED

          ? "News feed unavailable. New entries blocked."

          : "News feed unavailable."

    };

    memoryNewsDiagnostics =
      result;

    return result;

  }

}


// ============================================================
// SCORE
// ============================================================

function calculateScore(
  fast,
  slow
) {

  let bullish = 0;

  let bearish = 0;


  // ==========================================================
  // 1H TREND — HEAVIEST
  // ==========================================================

  if (
    slow.trend ===
    "BULLISH"
  ) {

    bullish += 25;

  }

  if (
    slow.trend ===
    "BEARISH"
  ) {

    bearish += 25;

  }


  // ==========================================================
  // 15M TREND
  // ==========================================================

  if (
    fast.trend ===
    "BULLISH"
  ) {

    bullish += 15;

  }

  if (
    fast.trend ===
    "BEARISH"
  ) {

    bearish += 15;

  }


  // ==========================================================
  // 1H STRUCTURE
  // ==========================================================

  if (
    slow.structure ===
    "BULLISH"
  ) {

    bullish += 10;

  }

  if (
    slow.structure ===
    "BEARISH"
  ) {

    bearish += 10;

  }


  // ==========================================================
  // 15M STRUCTURE
  // ==========================================================

  if (
    fast.structure ===
    "BULLISH"
  ) {

    bullish += 10;

  }

  if (
    fast.structure ===
    "BEARISH"
  ) {

    bearish += 10;

  }


  // ==========================================================
  // MACD
  // ==========================================================

  if (
    fast.macdHistogram >
      0 &&
    fast.macd >
      fast.macdSignal
  ) {

    bullish += 10;

  }

  if (
    fast.macdHistogram <
      0 &&
    fast.macd <
      fast.macdSignal
  ) {

    bearish += 10;

  }


  // ==========================================================
  // RSI
  // ==========================================================

  if (

    fast.rsi14 >=
      CONFIG.BULL_RSI_MIN &&

    fast.rsi14 <=
      CONFIG.BULL_RSI_MAX &&

    fast.rsi14 >=
      fast.previousRSI

  ) {

    bullish += 10;

  }

  if (

    fast.rsi14 >=
      CONFIG.BEAR_RSI_MIN &&

    fast.rsi14 <=
      CONFIG.BEAR_RSI_MAX &&

    fast.rsi14 <=
      fast.previousRSI

  ) {

    bearish += 10;

  }


  // ==========================================================
  // ADX + DI
  // ==========================================================

  if (
    fast.adx14 >=
      CONFIG.MIN_ADX
  ) {

    if (

      fast.plusDI >
        fast.minusDI &&

      fast.diSpread >=
        CONFIG.MIN_DI_SPREAD

    ) {

      bullish += 10;

    }

    if (

      fast.minusDI >
        fast.plusDI &&

      fast.diSpread >=
        CONFIG.MIN_DI_SPREAD

    ) {

      bearish += 10;

    }

  }


  // ==========================================================
  // MOMENTUM
  // ==========================================================

  if (
    fast.momentum >=
    CONFIG.MIN_MOMENTUM
  ) {

    bullish += 5;

  }

  if (
    fast.momentum <=
    -CONFIG.MIN_MOMENTUM
  ) {

    bearish += 5;

  }


  // ==========================================================
  // CANDLE QUALITY
  // ==========================================================

  if (
    fast.candleBullish
  ) {

    bullish += 5;

  }

  if (
    fast.candleBearish
  ) {

    bearish += 5;

  }


  const total =
    bullish +
    bearish;

  let direction =
    "WAIT";

  let score = 0;

  if (
    bullish >
    bearish
  ) {

    direction =
      "BULLISH";

    score =
      total > 0

        ? Math.round(
            (
              bullish /
              total
            ) * 100
          )

        : 0;

  } else if (
    bearish >
    bullish
  ) {

    direction =
      "BEARISH";

    score =
      total > 0

        ? Math.round(
            (
              bearish /
              total
            ) * 100
          )

        : 0;

  }

  return {

    bullish,

    bearish,

    direction,

    score,

    lead:
      Math.abs(
        bullish -
        bearish
      )

  };

}


// ============================================================
// REQUIRED DIRECTION CONFIRMATION
// ============================================================

function directionConfirmed(
  direction,
  fast,
  slow
) {

  if (
    direction ===
    "BULLISH"
  ) {

    return (

      fast.trend ===
        "BULLISH" &&

      slow.trend ===
        "BULLISH" &&

      fast.structure !==
        "BEARISH" &&

      slow.structure !==
        "BEARISH" &&

      fast.plusDI >
        fast.minusDI &&

      fast.diSpread >=
        CONFIG.MIN_DI_SPREAD &&

      fast.adx14 >=
        CONFIG.MIN_ADX &&

      fast.macdHistogram >
        0 &&

      fast.rsi14 >=
        CONFIG.BULL_RSI_MIN &&

      fast.rsi14 <=
        CONFIG.BULL_RSI_MAX &&

      fast.momentum >=
        CONFIG.MIN_MOMENTUM

    );

  }


  if (
    direction ===
    "BEARISH"
  ) {

    return (

      fast.trend ===
        "BEARISH" &&

      slow.trend ===
        "BEARISH" &&

      fast.structure !==
        "BULLISH" &&

      slow.structure !==
        "BULLISH" &&

      fast.minusDI >
        fast.plusDI &&

      fast.diSpread >=
        CONFIG.MIN_DI_SPREAD &&

      fast.adx14 >=
        CONFIG.MIN_ADX &&

      fast.macdHistogram <
        0 &&

      fast.rsi14 >=
        CONFIG.BEAR_RSI_MIN &&

      fast.rsi14 <=
        CONFIG.BEAR_RSI_MAX &&

      fast.momentum <=
        -CONFIG.MIN_MOMENTUM

    );

  }

  return false;

}


// ============================================================
// SWING LEVELS
// ============================================================

function recentLevels(
  candles
) {

  const sample =
    candles.slice(
      -20
    );

  return {

    high:
      Math.max(
        ...sample.map(
          c => c.high
        )
      ),

    low:
      Math.min(
        ...sample.map(
          c => c.low
        )
      )

  };

}


// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(
  direction,
  currentPrice,
  fast,
  slow,
  candles
) {

  const atrValue =
    fast.atr14;

  if (
    !Number.isFinite(
      atrValue
    ) ||
    atrValue <= 0
  ) {

    return {

      valid: false,

      reason:
        "Invalid ATR"

    };

  }


  const levels =
    recentLevels(
      candles
    );


  let entry;

  let sl;

  let tp1;

  let tp2;

  let tp3;


  // ==========================================================
  // BULLISH
  // ==========================================================

  if (
    direction ===
    "BULLISH"
  ) {

    const structuralEntry =
      Math.max(

        levels.low,

        currentPrice -
          atrValue *
          CONFIG.ATR_ENTRY_MULTIPLIER

      );

    entry =
      structuralEntry;

    sl =
      entry -
      atrValue *
      CONFIG.ATR_SL_MULTIPLIER;

    const risk =
      entry -
      sl;

    tp1 =
      entry +
      risk *
      1.50;

    tp2 =
      entry +
      risk *
      2.20;

    tp3 =
      entry +
      risk *
      3.00;

  }


  // ==========================================================
  // BEARISH
  // ==========================================================

  else if (
    direction ===
    "BEARISH"
  ) {

    const structuralEntry =
      Math.min(

        levels.high,

        currentPrice +
          atrValue *
          CONFIG.ATR_ENTRY_MULTIPLIER

      );

    entry =
      structuralEntry;

    sl =
      entry +
      atrValue *
      CONFIG.ATR_SL_MULTIPLIER;

    const risk =
      sl -
      entry;

    tp1 =
      entry -
      risk *
      1.50;

    tp2 =
      entry -
      risk *
      2.20;

    tp3 =
      entry -
      risk *
      3.00;

  }


  else {

    return {

      valid: false,

      reason:
        "No direction"

    };

  }


  const distance =
    Math.abs(
      currentPrice -
      entry
    );

  const distanceAtr =
    distance /
    atrValue;

  const distancePercent =
    (
      distance /
      currentPrice
    ) * 100;


  // ==========================================================
  // ENTRY DISTANCE
  // ==========================================================

  if (
    distanceAtr >
    CONFIG.MAX_ENTRY_DISTANCE_ATR
  ) {

    return {

      valid: false,

      reason:
        "Entry too far from market",

      currentPrice,

      entry,

      atr:
        atrValue,

      entryDistance:
        distance,

      entryDistanceATR:
        distanceAtr,

      entryDistancePercent:
        distancePercent

    };

  }


  if (
    distancePercent >
    CONFIG.MAX_ENTRY_DISTANCE_PERCENT
  ) {

    return {

      valid: false,

      reason:
        "Entry percentage distance too large",

      currentPrice,

      entry,

      atr:
        atrValue,

      entryDistance:
        distance,

      entryDistanceATR:
        distanceAtr,

      entryDistancePercent:
        distancePercent

    };

  }


  if (
    distanceAtr <
    CONFIG.MIN_ENTRY_DISTANCE_ATR
  ) {

    return {

      valid: false,

      reason:
        "Entry too close to market",

      currentPrice,

      entry,

      atr:
        atrValue,

      entryDistance:
        distance,

      entryDistanceATR:
        distanceAtr,

      entryDistancePercent:
        distancePercent

    };

  }


  // ==========================================================
  // RISK
  // ==========================================================

  const risk =
    Math.abs(
      entry -
      sl
    );

  const reward =
    Math.abs(
      tp1 -
      entry
    );

  const rr =
    risk > 0
      ? reward / risk
      : 0;


  if (
    rr <
    CONFIG.MIN_RR
  ) {

    return {

      valid: false,

      reason:
        "R:R below minimum",

      currentPrice,

      entry,

      sl,

      tp1,

      tp2,

      tp3,

      rr

    };

  }


  // ==========================================================
  // GEOMETRY
  // ==========================================================

  if (
    direction ===
    "BULLISH"
  ) {

    if (!(
      sl < entry &&
      entry < tp1 &&
      tp1 < tp2 &&
      tp2 < tp3
    )) {

      return {

        valid: false,

        reason:
          "Invalid bullish geometry"

      };

    }

  }


  if (
    direction ===
    "BEARISH"
  ) {

    if (!(
      sl > entry &&
      entry > tp1 &&
      tp1 > tp2 &&
      tp2 > tp3
    )) {

      return {

        valid: false,

        reason:
          "Invalid bearish geometry"

      };

    }

  }


  return {

    valid: true,

    currentPrice:

      round(
        currentPrice,
        CONFIG.PRICE_DECIMALS
      ),

    entry:

      round(
        entry,
        CONFIG.PRICE_DECIMALS
      ),

    sl:

      round(
        sl,
        CONFIG.PRICE_DECIMALS
      ),

    tp1:

      round(
        tp1,
        CONFIG.PRICE_DECIMALS
      ),

    tp2:

      round(
        tp2,
        CONFIG.PRICE_DECIMALS
      ),

    tp3:

      round(
        tp3,
        CONFIG.PRICE_DECIMALS
      ),

    rr:
      round(
        rr,
        2
      ),

    atr:
      round(
        atrValue,
        CONFIG.PRICE_DECIMALS
      ),

    entryDistance:
      round(
        distance,
        CONFIG.PRICE_DECIMALS
      ),

    entryDistanceATR:
      round(
        distanceAtr,
        2
      ),

    entryDistancePercent:
      round(
        distancePercent,
        3
      )

  };

}


// ============================================================
// SIGNAL ENGINE
// ============================================================

async function generateSignal(
  env
) {

  const started =
    Date.now();


  const fastCandles =
    await getTimeSeries(
      env,
      CONFIG.INTERVAL_FAST,
      CONFIG.OUTPUT_SIZE_FAST
    );


  const slowCandles =
    await getTimeSeries(
      env,
      CONFIG.INTERVAL_SLOW,
      CONFIG.OUTPUT_SIZE_SLOW
    );


  const currentPrice =
    fastCandles[
      fastCandles.length - 1
    ].close;


  const fast =
    analyzeTimeframe(
      fastCandles
    );


  const slow =
    analyzeTimeframe(
      slowCandles
    );


  const scoring =
    calculateScore(
      fast,
      slow
    );


  const news =
    CONFIG.NEWS_FILTER_ENABLED

      ? await getLiveNews()

      : {

          feedStatus:
            "disabled",

          blocked:
            false,

          message:
            "News filter disabled."

        };


  // ==========================================================
  // NEWS
  // ==========================================================

  if (

    CONFIG.NEWS_FILTER_ENABLED &&
    news.blocked

  ) {

    return {

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      generatedAt:
        new Date().toISOString(),

      price:
        round(
          currentPrice,
          4
        ),

      signal:
        "WAIT",

      reason:
        news.message,

      score:
        scoring.score,

      direction:
        scoring.direction,

      directionLead:
        scoring.lead,

      fast,

      slow,

      news,

      tradePlan:
        null,

      executionMs:
        Date.now() -
        started

    };

  }


  // ==========================================================
  // SCORE
  // ==========================================================

  if (
    scoring.score <
    CONFIG.MIN_SCORE
  ) {

    return {

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      generatedAt:
        new Date().toISOString(),

      price:
        round(
          currentPrice,
          4
        ),

      signal:
        "WAIT",

      reason:
        `Score ${scoring.score} below minimum ${CONFIG.MIN_SCORE}`,

      score:
        scoring.score,

      direction:
        scoring.direction,

      directionLead:
        scoring.lead,

      fast,

      slow,

      news,

      tradePlan:
        null,

      executionMs:
        Date.now() -
        started

    };

  }


  // ==========================================================
  // LEAD
  // ==========================================================

  if (
    scoring.lead <
    CONFIG.MIN_DIRECTION_LEAD
  ) {

    return {

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      generatedAt:
        new Date().toISOString(),

      price:
        round(
          currentPrice,
          4
        ),

      signal:
        "WAIT",

      reason:
        "Direction confirmation is too weak.",

      score:
        scoring.score,

      direction:
        scoring.direction,

      directionLead:
        scoring.lead,

      fast,

      slow,

      news,

      tradePlan:
        null,

      executionMs:
        Date.now() -
        started

    };

  }


  // ==========================================================
  // MANDATORY DIRECTION CONFIRMATION
  // ==========================================================

  if (!directionConfirmed(
    scoring.direction,
    fast,
    slow
  )) {

    return {

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      generatedAt:
        new Date().toISOString(),

      price:
        round(
          currentPrice,
          4
        ),

      signal:
        "WAIT",

      reason:
        "15M + 1H technical confirmation is incomplete.",

      score:
        scoring.score,

      direction:
        scoring.direction,

      directionLead:
        scoring.lead,

      fast,

      slow,

      news,

      tradePlan:
        null,

      executionMs:
        Date.now() -
        started

    };

  }


  // ==========================================================
  // TRADE PLAN
  // ==========================================================

  const tradePlan =
    buildTradePlan(
      scoring.direction,
      currentPrice,
      fast,
      slow,
      fastCandles
    );


  if (
    !tradePlan.valid
  ) {

    return {

      version:
        CONFIG.VERSION,

      symbol:
        CONFIG.SYMBOL,

      generatedAt:
        new Date().toISOString(),

      price:
        round(
          currentPrice,
          4
        ),

      signal:
        "WAIT",

      reason:
        tradePlan.reason,

      score:
        scoring.score,

      direction:
        scoring.direction,

      directionLead:
        scoring.lead,

      fast,

      slow,

      news,

      tradePlan,

      executionMs:
        Date.now() -
        started

    };

  }


  const signal =
    scoring.direction ===
    "BULLISH"

      ? "BUY LIMIT"

      : "SELL LIMIT";


  return {

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    generatedAt:
      new Date().toISOString(),

    price:
      round(
        currentPrice,
        4
      ),

    signal,

    score:
      scoring.score,

    direction:
      scoring.direction,

    directionLead:
      scoring.lead,

    fast,

    slow,

    news,

    tradePlan,

    riskMessage:
      "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\n" +
      "📊 این سیگنال تضمین سود نیست و اعتبار آن با تغییر شرایط بازار ممکن است از بین برود.",

    executionMs:
      Date.now() -
      started

  };

}


// ============================================================
// TELEGRAM
// ============================================================

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


  const token =
    getEnv(
      env,
      [
        "TELEGRAM_BOT_TOKEN",
        "توکن_ربات_تلگرام"
      ]
    );


  const chatId =
    getEnv(
      env,
      [
        "TELEGRAM_CHAT_ID"
      ]
    );


  if (
    !token ||
    !chatId
  ) {

    return {

      ok: false,

      error:
        "Telegram credentials missing"

    };

  }


  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;


  const response =
    await fetchWithTimeout(

      url,

      {

        method:
          "POST",

        headers: {

          "Content-Type":
            "application/json"

        },

        body:
          JSON.stringify({

            chat_id:
              chatId,

            text:
              message

          })

      },

      CONFIG.API_TIMEOUT_MS

    );


  const data =
    await response.json();


  return {

    ok:
      response.ok &&
      data.ok === true,

    status:
      response.status,

    data

  };

}


// ============================================================
// TELEGRAM SIGNAL MESSAGE
// ============================================================

function formatSignalMessage(
  signal
) {

  if (
    !signal ||
    signal.signal ===
      "WAIT"
  ) {

    return null;

  }


  const p =
    signal.tradePlan;


  return [

    "💎 HAKIM GOLD SIGNALS V6.5",

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

    `💪 ADX: ${round(signal.fast.adx14, 1)}`,

    `📊 DI Spread: ${round(signal.fast.diSpread, 1)}`,

    `📉 RSI: ${round(signal.fast.rsi14, 1)}`,

    `📰 News: ${
      signal.news.blocked
        ? "BLOCKED"
        : "CLEAR"
    }`,

    "",

    signal.riskMessage,

    "",

    "💎 Hakim Gold Signals"

  ].join("\n");

}


// ============================================================
// TELEGRAM NEWS
// ============================================================

async function sendNewsAlert(
  env,
  news
) {

  if (
    !CONFIG.TELEGRAM_NEWS_ENABLED
  ) {

    return;

  }


  if (
    !news ||
    !news.nextEvent
  ) {

    return;

  }


  const event =
    news.nextEvent;


  const key =
    `${event.title}-${event.timestamp}`;


  if (
    memorySentNews.has(key)
  ) {

    return;

  }


  const diff =
    event.timestamp -
    Date.now();


  if (

    diff < 0 ||
    diff >
      CONFIG.NEWS_ALERT_BEFORE_MINUTES *
      60 *
      1000

  ) {

    return;

  }


  const minutes =
    Math.max(

      0,

      Math.round(
        diff / 60000
      )

    );


  const message = [

    "📰 USD HIGH IMPACT NEWS",

    "",

    `🇺🇸 ${event.title}`,

    `⏰ حدود ${minutes} دقیقه دیگر`,

    `📊 Impact: ${event.impact}`,

    "",

    "⚠️ در محدوده خبر مهم، از ورود عجولانه خودداری کنید.",

    "",

    CONFIG.TELEGRAM_NEWS_FOOTER

  ].join("\n");


  const result =
    await sendTelegram(
      env,
      message
    );


  if (
    result.ok
  ) {

    memorySentNews.add(
      key
    );

    if (
      memorySentNews.size >
      100
    ) {

      const first =
        memorySentNews
          .values()
          .next()
          .value;

      memorySentNews.delete(
        first
      );

    }

  }

}


// ============================================================
// HEALTH
// ============================================================

async function healthResponse() {

  return Response.json({

    ok: true,

    service:
      "FOREX SIGNAL ENGINE",

    version:
      CONFIG.VERSION,

    symbol:
      CONFIG.SYMBOL,

    intervals: [

      CONFIG.INTERVAL_FAST,

      CONFIG.INTERVAL_SLOW

    ],

    time:
      new Date().toISOString()

  });

}


// ============================================================
// NEWS RESPONSE
// ============================================================

async function newsResponse() {

  const news =
    await getLiveNews();

  return Response.json({

    version:
      CONFIG.VERSION,

    ...news

  });

}


// ============================================================
// SIGNAL RESPONSE
// ============================================================

async function signalResponse(
  env
) {

  try {

    const signal =
      await generateSignal(
        env
      );


    if (
      signal.news
    ) {

      await sendNewsAlert(
        env,
        signal.news
      );

    }


    if (

      signal.signal !==
        "WAIT" &&

      CONFIG.TELEGRAM_SIGNAL_ENABLED

    ) {

      const message =
        formatSignalMessage(
          signal
        );


      const signalKey =
        [

          signal.signal,

          signal.tradePlan?.entry,

          signal.tradePlan?.sl,

          signal.tradePlan?.tp1

        ].join("|");


      if (

        message &&

        signalKey !==
          memoryLastSignalKey

      ) {

        const result =
          await sendTelegram(
            env,
            message
          );


        if (
          result.ok
        ) {

          memoryLastSignalKey =
            signalKey;

        }

      }

    }


    return Response.json(
      signal
    );

  } catch (
    error
  ) {

    return Response.json({

      version:
        CONFIG.VERSION,

      signal:
        "WAIT",

      error:
        String(
          error?.message ||
          error
        ),

      time:
        new Date().toISOString()

    }, {

      status: 500

    });

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

<meta name="viewport"
content="width=device-width,initial-scale=1">

<meta name="theme-color"
content="#12163a">

<title>
FX · موتور سیگنال فارکس V6.5
</title>

<style>

*{
  box-sizing:border-box;
}

body{

  margin:0;

  font-family:
    Tahoma,
    Arial,
    sans-serif;

  background:
    #0b1020;

  color:
    #f5f7ff;

}

.wrap{

  max-width:
    900px;

  margin:
    auto;

  padding:
    20px;

}

header{

  padding:
    25px 0;

}

h1{

  margin:
    0;

  font-size:
    27px;

}

.sub{

  opacity:
    .75;

  margin-top:
    8px;

}

.card{

  background:
    #121a30;

  border:
    1px solid #263250;

  border-radius:
    18px;

  padding:
    20px;

  margin-top:
    18px;

}

.grid{

  display:
    grid;

  grid-template-columns:
    repeat(
      auto-fit,
      minmax(
        210px,
        1fr
      )
    );

  gap:
    12px;

}

.item{

  background:
    #0e1629;

  border-radius:
    14px;

  padding:
    14px;

}

.label{

  font-size:
    13px;

  opacity:
    .65;

}

.value{

  font-size:
    19px;

  font-weight:
    bold;

  margin-top:
    5px;

}

button{

  width:
    100%;

  padding:
    13px;

  border:
    0;

  border-radius:
    12px;

  background:
    #2563eb;

  color:
    white;

  font-size:
    16px;

  font-weight:
    bold;

}

pre{

  white-space:
    pre-wrap;

  word-break:
    break-word;

  line-height:
    1.9;

}

.good{

  color:
    #65e6a5;

}

.wait{

  color:
    #ffd166;

}

.bad{

  color:
    #ff8585;

}

</style>

</head>

<body>

<div class="wrap">

<header>

<h1>
FX · موتور سیگنال فارکس V6.5
</h1>

<div class="sub">
Gold Quality · XAU/USD · 15M + 1H
</div>

</header>

<div class="card">

<button
onclick="loadSignal()"
>
🔄 بروزرسانی سیگنال
</button>

</div>

<div id="result"
class="card">

در حال دریافت اطلاعات...

</div>

</div>

<script>

async function loadSignal(){

  const box =
    document.getElementById(
      "result"
    );

  box.innerHTML =
    "⏳ در حال بررسی بازار...";

  try{

    const response =
      await fetch(
        "/api/signals",
        {
          cache:
            "no-store"
        }
      );

    const data =
      await response.json();

    render(data);

  }catch(error){

    box.innerHTML =
      "<div class='bad'>" +
      "خطا در دریافت سیگنال" +
      "</div>";

  }

}


function esc(value){

  return String(
    value ?? "-"
  )

  .replace(
    /&/g,
    "&amp;"
  )

  .replace(
    /</g,
    "&lt;"
  )

  .replace(
    />/g,
    "&gt;"
  );

}


function render(data){

  const box =
    document.getElementById(
      "result"
    );


  if(
    data.signal ===
    "WAIT"
  ){

    box.innerHTML =

      "<h2 class='wait'>" +
      "⏸ WAIT" +
      "</h2>" +

      "<p>" +
      esc(
        data.reason ||
        "شرایط مناسب نیست."
      ) +
      "</p>" +

      "<div class='grid'>" +

      item(
        "قیمت",
        data.price
      ) +

      item(
        "Score",
        data.score
      ) +

      item(
        "15M",
        data.fast?.trend
      ) +

      item(
        "1H",
        data.slow?.trend
      ) +

      item(
        "ADX",
        data.fast?.adx14
      ) +

      "</div>";

    return;

  }


  const p =
    data.tradePlan;


  box.innerHTML =

    "<h2 class='good'>" +
    "💎 " +
    esc(data.signal) +
    "</h2>" +

    "<div class='grid'>" +

    item(
      "قیمت فعلی",
      data.price
    ) +

    item(
      "Score",
      data.score +
      "/100"
    ) +

    item(
      "15M",
      data.fast?.trend
    ) +

    item(
      "1H",
      data.slow?.trend
    ) +

    item(
      "ADX",
      data.fast?.adx14
    ) +

    item(
      "DI Spread",
      data.fast?.diSpread
    ) +

    item(
      "RSI",
      data.fast?.rsi14
    ) +

    item(
      "News",
      data.news?.blocked
        ? "BLOCKED"
        : "CLEAR"
    ) +

    item(
      "R:R",
      p?.rr
    ) +

    "</div>" +

    "<div class='card'>" +

    "<h3>Trade Plan</h3>" +

    "<pre>" +

    "📍 Entry: " +
    esc(p?.entry) +

    "\\n🛑 SL: " +
    esc(p?.sl) +

    "\\n🎯 TP1: " +
    esc(p?.tp1) +

    "\\n🎯 TP2: " +
    esc(p?.tp2) +

    "\\n🎯 TP3: " +
    esc(p?.tp3) +

    "\\n📏 Entry Distance: " +
    esc(p?.entryDistance) +

    " (" +
    esc(p?.entryDistanceATR) +
    " ATR)" +

    "</pre>" +

    "</div>" +

    "<div class='card'>" +

    "<pre>" +

    "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید." +

    "\\n📊 این سیگنال تضمین سود نیست و با تغییر شرایط بازار ممکن است اعتبار آن از بین برود." +

    "</pre>" +

    "</div>";

}


function item(
  label,
  value
){

  return (

    "<div class='item'>" +

    "<div class='label'>" +
    esc(label) +
    "</div>" +

    "<div class='value'>" +
    esc(value) +
    "</div>" +

    "</div>"

  );

}


loadSignal();


setInterval(
  loadSignal,
  30000
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
    "Access-Control-Allow-Origin",
    "*"
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  headers.set(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
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


      // ======================================================
      // HOME
      // ======================================================

      if (

        url.pathname === "/" ||
        url.pathname === ""

      ) {

        return new Response(

          renderHomepage(),

          {

            headers: {

              "Content-Type":
                "text/html; charset=UTF-8"

            }

          }

        );

      }


      // ======================================================
      // HEALTH
      // ======================================================

      if (
        url.pathname ===
        "/health"
      ) {

        return withCors(
          await healthResponse()
        );

      }


      // ======================================================
      // NEWS
      // ======================================================

      if (
        url.pathname ===
        "/api/news"
      ) {

        return withCors(
          await newsResponse()
        );

      }


      // ======================================================
      // SIGNAL
      // ======================================================

      if (
        url.pathname ===
        "/api/signals"
      ) {

        return withCors(
          await signalResponse(
            env
          )
        );

      }


      // ======================================================
      // TELEGRAM TEST
      // ======================================================

      if (
        url.pathname ===
        "/telegram-test"
      ) {

        const result =
          await sendTelegram(

            env,

            "💎 Hakim Gold Signals V6.5\n\n✅ Telegram connection test successful."

          );

        return withCors(
          Response.json(
            result
          )
        );

      }


      // ======================================================
      // TELEGRAM STATUS
      // ======================================================

      if (
        url.pathname ===
        "/telegram-status"
      ) {

        const token =
          getEnv(
            env,
            [
              "TELEGRAM_BOT_TOKEN",
              "توکن_ربات_تلگرام"
            ]
          );

        const chatId =
          getEnv(
            env,
            [
              "TELEGRAM_CHAT_ID"
            ]
          );

        return withCors(

          Response.json({

            telegram:
              Boolean(
                CONFIG.TELEGRAM_ENABLED
              ),

            tokenConfigured:
              Boolean(token),

            chatIdConfigured:
              Boolean(chatId)

          })

        );

      }


      // ======================================================
      // 404
      // ======================================================

      return withCors(

        Response.json(

          {

            ok: false,

            error:
              "Not found",

            routes: [

              "/",

              "/health",

              "/api/signals",

              "/api/news",

              "/telegram-test",

              "/telegram-status"

            ]

          },

          {
            status: 404
          }

        )

      );


    } catch (
      error
    ) {

      return withCors(

        Response.json(

          {

            ok: false,

            error:
              String(
                error?.message ||
                error
              )

          },

          {
            status: 500
          }

        )

      );

    }

  }

};
