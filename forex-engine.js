// ============================================================
// FOREX SIGNAL ENGINE V5.5 GOLD PRIORITY
// Cloudflare Worker + Twelve Data + Telegram
//
// PRIMARY FOCUS:
// XAU/USD
//
// TELEGRAM:
// - Automatic GOLD signals
// - /start
// - /status
// - Incoming message replies
// - Secure webhook by configured Chat ID
//
// IMPORTANT:
// - Telegram token remains in Cloudflare Secret
// - Twelve Data key remains in Cloudflare Secret
// - Telegram Chat ID remains in Cloudflare Variable
// - No profit guarantee
// ============================================================

const CONFIG = {
  version: "V5.5",
  name: "Gold Priority",

  primarySymbol: "XAU/USD",

  symbols: [
    "XAU/USD",
    "EUR/USD",
    "GBP/USD",
    "USD/JPY"
  ],

  primaryInterval: "15min",
  confirmationInterval: "1h",

  outputsize: 200,

  // -----------------------------
  // GOLD FILTER
  // -----------------------------
  goldMinScore: 70,
  strongScore: 85,
  eliteScore: 92,

  minADX: 22,
  minDISpread: 5,
  minMomentum: 0.05,
  candleBodyMin: 0.35,

  // -----------------------------
  // TRADE PLAN
  // -----------------------------
  atrSLMultiplier: 0.70,
  tp1RiskReward: 1.50,
  tp2RiskReward: 2.50,
  tp3RiskReward: 3.50,

  limitATRMultiplier: 0.20,

  // -----------------------------
  // TELEGRAM
  // -----------------------------
  signalCooldownMinutes: 30,

  // -----------------------------
  // API CACHE
  // -----------------------------
  goldCacheSeconds: 50,
  goldRefreshSeconds: 55,
  secondaryCacheSeconds: 300,

  // -----------------------------
  // CLOSED CANDLE
  // -----------------------------
  useClosedCandle: true
};

// ============================================================
// SECRET HELPERS
// ============================================================

function getTelegramToken(env) {
  return (
    env.TELEGRAM_BOT_TOKEN ||
    env["توکن_ربات_تلگرام"] ||
    env["توکن ربات تلگرام"] ||
    ""
  );
}

function getTelegramChatId(env) {
  return (
    env.TELEGRAM_CHAT_ID ||
    env["شناسه_چت_تلگرام"] ||
    env["آیدی_چت_تلگرام"] ||
    env["TELEGRAM_CHATID"] ||
    ""
  );
}

function getTwelveDataKey(env) {
  return (
    env.TWELVE_DATA_API_KEY ||
    env["کلید API دوازده داده"] ||
    env["کلید_API_دوازده_داده"] ||
    env.TWELVE_DATA_KEY ||
    ""
  );
}

// ============================================================
// BASIC HELPERS
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store"
      }
    }
  );
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;

  const p = Math.pow(10, decimals);
  return Math.round(value * p) / p;
}

function nowMs() {
  return Date.now();
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

// ============================================================
// CLOUDflare CACHE
// ============================================================

const CACHE = caches.default;

async function cacheGet(key) {
  try {
    return await CACHE.match(
      new Request(key)
    );
  } catch {
    return null;
  }
}

async function cachePut(key, data, seconds) {
  try {
    const response = new Response(
      JSON.stringify(data),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${seconds}`
        }
      }
    );

    await CACHE.put(
      new Request(key),
      response
    );
  } catch {
    // Cache failure must never stop the engine.
  }
}

// ============================================================
// TWELVE DATA
// ============================================================

async function twelveDataTimeSeries(
  symbol,
  interval,
  env,
  options = {}
) {
  const apiKey = getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error(
      "Twelve Data API key is missing"
    );
  }

  const outputsize =
    options.outputsize ||
    CONFIG.outputsize;

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${encodeURIComponent(apiKey)}` +
    `&format=JSON`;

  const response = await fetch(url);

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Twelve Data invalid response: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  if (data.status === "error") {
    throw new Error(
      data.message ||
      data.code ||
      "Twelve Data API error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle data"
    );
  }

  return data;
}

// ============================================================
// PARSE CANDLES
// ============================================================

function parseCandles(data) {
  const values = Array.isArray(data?.values)
    ? data.values
    : [];

  const candles = values
    .map(v => ({
      datetime: v.datetime,

      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),

      volume:
        v.volume !== undefined
          ? Number(v.volume)
          : null
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    );

  candles.reverse();

  return candles;
}

// ============================================================
// LOCAL INDICATORS
// ============================================================

function emaSeries(values, period) {
  if (values.length < period) return [];

  const result = [];

  const multiplier =
    2 / (period + 1);

  let emaValue =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  result.push(emaValue);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    emaValue =
      ((values[i] - emaValue) * multiplier) +
      emaValue;

    result.push(emaValue);
  }

  return result;
}

function ema(values, period) {
  const series =
    emaSeries(values, period);

  if (!series.length) return null;

  return series[series.length - 1];
}

// ============================================================
// RSI
// ============================================================

function rsi(values, period = 14) {
  if (values.length < period + 1) {
    return null;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gain += diff;
    } else {
      loss += Math.abs(diff);
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const diff =
      values[i] - values[i - 1];

    const currentGain =
      diff > 0 ? diff : 0;

    const currentLoss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) +
        currentGain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) +
        currentLoss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

// ============================================================
// MACD
// ============================================================

function macd(values) {
  if (values.length < 35) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const ema12 =
    emaSeries(values, 12);

  const ema26 =
    emaSeries(values, 26);

  const macdSeries = [];

  for (
    let i = 0;
    i < ema26.length;
    i++
  ) {
    const ema12Index =
      i + (26 - 12);

    if (
      ema12[ema12Index] !== undefined
    ) {
      macdSeries.push(
        ema12[ema12Index] -
        ema26[i]
      );
    }
  }

  if (macdSeries.length < 9) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const signalSeries =
    emaSeries(macdSeries, 9);

  const macdValue =
    macdSeries[
      macdSeries.length - 1
    ];

  const signalValue =
    signalSeries[
      signalSeries.length - 1
    ];

  return {
    macd: macdValue,
    signal: signalValue,
    histogram:
      macdValue - signalValue
  };
}

// ============================================================
// ATR
// ============================================================

function atr(candles, period = 14) {
  if (candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high - current.low,

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

  if (trs.length < period) {
    return null;
  }

  let value =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    value =
      ((value * (period - 1)) +
        trs[i]) / period;
  }

  return value;
}

// ============================================================
// ADX / DI
// ============================================================

function adx(candles, period = 14) {
  if (
    candles.length <
    period * 2 + 2
  ) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
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

    let pDM = 0;
    let mDM = 0;

    if (
      upMove > downMove &&
      upMove > 0
    ) {
      pDM = upMove;
    }

    if (
      downMove > upMove &&
      downMove > 0
    ) {
      mDM = downMove;
    }

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
    plusDM.push(pDM);
    minusDM.push(mDM);
  }

  if (
    trs.length <
    period * 2
  ) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  let trSmooth =
    trs
      .slice(0, period)
      .reduce((a, b) => a + b, 0);

  let plusSmooth =
    plusDM
      .slice(0, period)
      .reduce((a, b) => a + b, 0);

  let minusSmooth =
    minusDM
      .slice(0, period)
      .reduce((a, b) => a + b, 0);

  const dxValues = [];

  let lastPlusDI = 0;
  let lastMinusDI = 0;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {
    if (i > period) {
      trSmooth =
        trSmooth -
        (trSmooth / period) +
        trs[i];

      plusSmooth =
        plusSmooth -
        (plusSmooth / period) +
        plusDM[i];

      minusSmooth =
        minusSmooth -
        (minusSmooth / period) +
        minusDM[i];
    }

    lastPlusDI =
      trSmooth === 0
        ? 0
        : 100 *
          plusSmooth /
          trSmooth;

    lastMinusDI =
      trSmooth === 0
        ? 0
        : 100 *
          minusSmooth /
          trSmooth;

    const denominator =
      lastPlusDI +
      lastMinusDI;

    const dx =
      denominator === 0
        ? 0
        : 100 *
          Math.abs(
            lastPlusDI -
            lastMinusDI
          ) /
          denominator;

    dxValues.push(dx);
  }

  if (
    dxValues.length <
    period
  ) {
    return {
      adx: null,
      plusDI: lastPlusDI,
      minusDI: lastMinusDI
    };
  }

  let adxValue =
    dxValues
      .slice(0, period)
      .reduce((a, b) => a + b, 0) /
    period;

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {
    adxValue =
      ((adxValue * (period - 1)) +
        dxValues[i]) / period;
  }

  return {
    adx: adxValue,
    plusDI: lastPlusDI,
    minusDI: lastMinusDI
  };
}

// ============================================================
// MOMENTUM
// ============================================================

function momentumPercent(
  values,
  lookback = 10
) {
  if (
    values.length <= lookback
  ) {
    return null;
  }

  const current =
    values[values.length - 1];

  const previous =
    values[
      values.length -
      1 -
      lookback
    ];

  if (!previous) {
    return null;
  }

  return (
    ((current - previous) /
      previous) *
    100
  );
}

// ============================================================
// BREAKOUT
// ============================================================

function breakout(
  candles,
  lookback = 20
) {
  if (
    candles.length <= lookback
  ) {
    return "NONE";
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      candles.length -
        1 -
        lookback,

      candles.length - 1
    );

  const highest =
    Math.max(
      ...previous.map(
        c => c.high
      )
    );

  const lowest =
    Math.min(
      ...previous.map(
        c => c.low
      )
    );

  if (
    current.close >
    highest
  ) {
    return "BULLISH";
  }

  if (
    current.close <
    lowest
  ) {
    return "BEARISH";
  }

  return "NONE";
}

// ============================================================
// CANDLE
// ============================================================

function candleDirection(candle) {
  if (!candle) {
    return "NEUTRAL";
  }

  if (
    candle.close >
    candle.open
  ) {
    return "BULLISH";
  }

  if (
    candle.close <
    candle.open
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function candleBodyRatio(candle) {
  if (!candle) {
    return 0;
  }

  const range =
    candle.high -
    candle.low;

  if (range <= 0) {
    return 0;
  }

  return (
    Math.abs(
      candle.close -
      candle.open
    ) / range
  );
}

// ============================================================
// TREND
// ============================================================

function getTrend(
  candles,
  fastPeriod = 20,
  slowPeriod = 50
) {
  if (
    candles.length <
    slowPeriod + 5
  ) {
    return "NEUTRAL";
  }

  const closes =
    candles.map(
      c => c.close
    );

  const fast =
    ema(
      closes,
      fastPeriod
    );

  const slow =
    ema(
      closes,
      slowPeriod
    );

  if (
    fast === null ||
    slow === null
  ) {
    return "NEUTRAL";
  }

  const last =
    closes[
      closes.length - 1
    ];

  if (
    fast > slow &&
    last > fast
  ) {
    return "BULLISH";
  }

  if (
    fast < slow &&
    last < fast
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ============================================================
// ANALYZE TIMEFRAME
// ============================================================

function analyzeTimeframe(candles) {
  if (
    !candles ||
    candles.length < 60
  ) {
    throw new Error(
      "Not enough candle data"
    );
  }

  const working =
    CONFIG.useClosedCandle &&
    candles.length > 3
      ? candles.slice(0, -1)
      : candles;

  const closes =
    working.map(
      c => c.close
    );

  const last =
    working[
      working.length - 1
    ];

  const trend =
    getTrend(working);

  const rsiValue =
    rsi(closes, 14);

  const macdValue =
    macd(closes);

  const adxValue =
    adx(working, 14);

  const atrValue =
    atr(working, 14);

  const momentum =
    momentumPercent(
      closes,
      10
    );

  const breakoutValue =
    breakout(
      working,
      20
    );

  const candle =
    candleDirection(last);

  const bodyRatio =
    candleBodyRatio(last);

  return {
    price: last.close,

    trend,

    rsi: rsiValue,

    macd:
      macdValue.macd,

    macdSignal:
      macdValue.signal,

    macdHistogram:
      macdValue.histogram,

    adx:
      adxValue.adx,

    plusDI:
      adxValue.plusDI,

    minusDI:
      adxValue.minusDI,

    atr:
      atrValue,

    momentum,

    breakout:
      breakoutValue,

    candle,

    candleBodyRatio:
      bodyRatio,

    datetime:
      last.datetime
  };
}

// ============================================================
// GOLD ANALYSIS
// ============================================================

function analyzeGold(
  candles15m,
  candles1h
) {
  const tf15 =
    analyzeTimeframe(
      candles15m
    );

  const tf1h =
    analyzeTimeframe(
      candles1h
    );

  const alignment =
    tf15.trend ===
    tf1h.trend
      ? tf15.trend
      : "MIXED";

  let score = 0;

  // 15M TREND
  if (
    tf15.trend === "BULLISH"
  ) {
    score += 15;
  }

  if (
    tf15.trend === "BEARISH"
  ) {
    score += 15;
  }

  // 1H CONFIRMATION
  if (
    tf1h.trend === "BULLISH" ||
    tf1h.trend === "BEARISH"
  ) {
    score += 20;
  }

  // ALIGNMENT
  if (
    alignment === "BULLISH" ||
    alignment === "BEARISH"
  ) {
    score += 10;
  }

  // MACD
  if (
    tf15.macd !== null &&
    tf15.macdSignal !== null
  ) {
    if (
      tf15.trend === "BULLISH" &&
      tf15.macd >
        tf15.macdSignal
    ) {
      score += 15;
    }

    if (
      tf15.trend === "BEARISH" &&
      tf15.macd <
        tf15.macdSignal
    ) {
      score += 15;
    }
  }

  // RSI
  if (
    tf15.rsi !== null
  ) {
    if (
      tf15.trend === "BULLISH" &&
      tf15.rsi >= 50 &&
      tf15.rsi <= 75
    ) {
      score += 10;
    }

    if (
      tf15.trend === "BEARISH" &&
      tf15.rsi <= 50 &&
      tf15.rsi >= 25
    ) {
      score += 10;
    }
  }

  // ADX / DI
  if (
    tf15.adx !== null &&
    tf15.plusDI !== null &&
    tf15.minusDI !== null
  ) {
    const spread =
      Math.abs(
        tf15.plusDI -
        tf15.minusDI
      );

    if (
      tf15.adx >= CONFIG.minADX &&
      spread >= CONFIG.minDISpread
    ) {
      score += 10;
    }
  }

  // MOMENTUM
  if (
    tf15.momentum !== null
  ) {
    if (
      tf15.trend === "BULLISH" &&
      tf15.momentum >=
        CONFIG.minMomentum
    ) {
      score += 10;
    }

    if (
      tf15.trend === "BEARISH" &&
      tf15.momentum <=
        -CONFIG.minMomentum
    ) {
      score += 10;
    }
  }

  // BREAKOUT
  if (
    tf15.breakout ===
    tf15.trend
  ) {
    score += 5;
  }

  // CANDLE
  if (
    tf15.candle ===
      tf15.trend &&
    tf15.candleBodyRatio >=
      CONFIG.candleBodyMin
  ) {
    score += 5;
  }

  // CONFLICT PENALTY
  if (
    tf1h.trend !== "NEUTRAL" &&
    tf15.trend !==
      tf1h.trend
  ) {
    score *= 0.60;
  }

  score =
    Math.round(
      Math.min(100, score)
    );

  // SIGNAL CONDITIONS

  let signal = "WAIT";

  const strong15m =
    tf15.adx !== null &&
    tf15.adx >=
      CONFIG.minADX;

  const diBull =
    tf15.plusDI !== null &&
    tf15.minusDI !== null &&
    tf15.plusDI >
      tf15.minusDI;

  const diBear =
    tf15.plusDI !== null &&
    tf15.minusDI !== null &&
    tf15.minusDI >
      tf15.plusDI;

  const macdBull =
    tf15.macd !== null &&
    tf15.macdSignal !== null &&
    tf15.macd >
      tf15.macdSignal;

  const macdBear =
    tf15.macd !== null &&
    tf15.macdSignal !== null &&
    tf15.macd <
      tf15.macdSignal;

  const momentumBull =
    tf15.momentum !== null &&
    tf15.momentum >=
      CONFIG.minMomentum;

  const momentumBear =
    tf15.momentum !== null &&
    tf15.momentum <=
      -CONFIG.minMomentum;

  const candleBull =
    tf15.candle ===
    "BULLISH";

  const candleBear =
    tf15.candle ===
    "BEARISH";

  // BUY
  const buySetup =
    tf15.trend === "BULLISH" &&
    macdBull &&
    diBull &&
    strong15m &&
    momentumBull &&
    candleBull;

  // SELL
  const sellSetup =
    tf15.trend === "BEARISH" &&
    macdBear &&
    diBear &&
    strong15m &&
    momentumBear &&
    candleBear;

  if (
    buySetup &&
    score >=
      CONFIG.goldMinScore
  ) {
    signal =
      "BUY LIMIT";
  }

  if (
    sellSetup &&
    score >=
      CONFIG.goldMinScore
  ) {
    signal =
      "SELL LIMIT";
  }

  const result = {
    symbol: "XAU/USD",

    signal,

    price:
      tf15.price,

    trend15m:
      tf15.trend,

    trend1h:
      tf1h.trend,

    alignment,

    score,

    rsi:
      tf15.rsi,

    macd:
      tf15.macd,

    macdSignal:
      tf15.macdSignal,

    adx:
      tf15.adx,

    plusDI:
      tf15.plusDI,

    minusDI:
      tf15.minusDI,

    atr:
      tf15.atr,

    momentum:
      tf15.momentum,

    breakout:
      tf15.breakout,

    candle:
      tf15.candle,

    candleBodyRatio:
      tf15.candleBodyRatio,

    candleTime15m:
      tf15.datetime,

    candleTime1h:
      tf1h.datetime
  };

  if (
    signal === "BUY LIMIT" ||
    signal === "SELL LIMIT"
  ) {
    result.tradePlan =
      buildTradePlan(
        signal,
        tf15.price,
        tf15.atr
      );
  }

  return result;
}

// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(
  signal,
  currentPrice,
  atrValue
) {
  if (
    !Number.isFinite(
      currentPrice
    ) ||
    !Number.isFinite(
      atrValue
    ) ||
    atrValue <= 0
  ) {
    return null;
  }

  const limitDistance =
    atrValue *
    CONFIG.limitATRMultiplier;

  const risk =
    atrValue *
    CONFIG.atrSLMultiplier;

  let entry;
  let stopLoss;
  let tp1;
  let tp2;
  let tp3;

  if (
    signal === "BUY LIMIT"
  ) {
    entry =
      currentPrice -
      limitDistance;

    stopLoss =
      entry - risk;

    tp1 =
      entry +
      risk *
      CONFIG.tp1RiskReward;

    tp2 =
      entry +
      risk *
      CONFIG.tp2RiskReward;

    tp3 =
      entry +
      risk *
      CONFIG.tp3RiskReward;

  } else {

    entry =
      currentPrice +
      limitDistance;

    stopLoss =
      entry + risk;

    tp1 =
      entry -
      risk *
      CONFIG.tp1RiskReward;

    tp2 =
      entry -
      risk *
      CONFIG.tp2RiskReward;

    tp3 =
      entry -
      risk *
      CONFIG.tp3RiskReward;
  }

  return {
    entry:
      round(entry, 2),

    stopLoss:
      round(stopLoss, 2),

    tp1:
      round(tp1, 2),

    tp2:
      round(tp2, 2),

    tp3:
      round(tp3, 2),

    risk:
      round(risk, 2),

    atr:
      round(atrValue, 2)
  };
}

// ============================================================
// TELEGRAM OUTGOING
// ============================================================

function formatGoldTelegram(result) {
  const plan =
    result.tradePlan;

  if (!plan) {
    return null;
  }

  const isBuy =
    result.signal ===
    "BUY LIMIT";

  const icon =
    isBuy ? "📈" : "📉";

  return (
`💎 طلا (XAUUSD)

${icon} ${result.signal} | SCALP

نقطه ورود: ${plan.entry}

🛑 حد ضرر: ${plan.stopLoss}

🎯 تی پی اول: ${plan.tp1}

🎯 تی پی دوم: ${plan.tp2}

💰 مدیریت سرمایه

Hakim Gold Signals`
  );
}

async function sendTelegram(
  text,
  env
) {
  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  if (!token) {
    return {
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing"
    };
  }

  if (!chatId) {
    return {
      ok: false,
      error:
        "TELEGRAM_CHAT_ID is missing"
    };
  }

  return await sendTelegramToChat(
    chatId,
    text,
    env
  );
}

async function sendTelegramToChat(
  chatId,
  text,
  env
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

  if (!chatId) {
    return {
      ok: false,
      error:
        "Telegram chat_id is missing"
    };
  }

  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response =
      await fetch(url, {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          chat_id:
            chatId,

          text,

          disable_web_page_preview:
            true
        })
      });

    let data;

    try {
      data =
        await response.json();
    } catch {
      data = {
        ok: false,
        error:
          "Invalid Telegram response"
      };
    }

    return {
      ok:
        response.ok &&
        data.ok === true,

      response:
        data
    };

  } catch (error) {

    return {
      ok: false,
      error:
        error?.message ||
        String(error)
    };
  }
}

// ============================================================
// TELEGRAM /START
// ============================================================

async function telegramStart(
  chatId,
  env
) {
  const text =
`🟢 Hakim Gold Signals

به ربات سیگنال فارکس خوش آمدید.

💎 تمرکز اصلی:
XAU/USD GOLD

⏱ تایم‌فریم:
15M + 1H

📊 موتور:
FOREX SIGNAL ENGINE V5.5

دستورات:

/start
شروع و معرفی ربات

/status
وضعیت موتور و اتصال تلگرام

سیگنال‌های معتبر طلا به‌صورت خودکار ارسال می‌شوند.

⚠️ سیگنال‌ها تضمین سود نیستند.
مدیریت سرمایه و ریسک بر عهده معامله‌گر است.

Hakim Gold Signals`;

  return await sendTelegramToChat(
    chatId,
    text,
    env
  );
}

// ============================================================
// TELEGRAM /STATUS
// ============================================================

async function telegramStatus(
  chatId,
  env
) {
  const state =
    await getSignalState();

  const telegramConfigured =
    Boolean(
      getTelegramToken(env)
    ) &&
    Boolean(
      getTelegramChatId(env)
    );

  const twelveDataConfigured =
    Boolean(
      getTwelveDataKey(env)
    );

  let lastSignal =
    "ندارد";

  if (state?.signal) {
    lastSignal =
      state.signal;
  }

  const text =
`📊 وضعیت Hakim Gold Signals

🟢 موتور: فعال

⚙️ نسخه: ${CONFIG.version}

💎 تمرکز: XAU/USD

⏱ تایم‌فریم:
15M + 1H

📡 Telegram:
${telegramConfigured ? "🟢 متصل" : "🔴 تنظیم نشده"}

📈 Twelve Data:
${twelveDataConfigured ? "🟢 متصل" : "🔴 تنظیم نشده"}

📨 آخرین سیگنال:
${lastSignal}

🔄 ارسال خودکار:
فعال

⏱ فاصله سیگنال تکراری:
${CONFIG.signalCooldownMinutes} دقیقه

⚠️ سیگنال‌ها تضمین سود نیستند.`;

  return await sendTelegramToChat(
    chatId,
    text,
    env
  );
}

// ============================================================
// TELEGRAM INCOMING WEBHOOK
// ============================================================

async function handleTelegramWebhook(
  request,
  env
) {
  if (
    request.method !== "POST"
  ) {
    return json({
      ok: false,
      error:
        "POST only"
    }, 405);
  }

  let update;

  try {
    update =
      await request.json();
  } catch {
    return json({
      ok: false,
      error:
        "Invalid JSON"
    }, 400);
  }

  const message =
    update?.message;

  if (!message) {
    return json({
      ok: true,
      ignored: true
    });
  }

  const chatId =
    String(
      message.chat?.id ||
      ""
    );

  const configuredChatId =
    String(
      getTelegramChatId(env) ||
      ""
    );

  // -----------------------------------------
  // SECURITY
  // Only configured Chat ID can control bot.
  // -----------------------------------------

  if (
    !chatId ||
    !configuredChatId ||
    chatId !==
      configuredChatId
  ) {
    return json({
      ok: true,
      ignored: true
    });
  }

  const text =
    String(
      message.text || ""
    )
      .trim()
      .toLowerCase();

  // -----------------------------------------
  // /START
  // -----------------------------------------

  if (
    text === "/start" ||
    text.startsWith("/start ")
  ) {
    await telegramStart(
      chatId,
      env
    );

    return json({
      ok: true,
      command:
        "/start"
    });
  }

  // -----------------------------------------
  // /STATUS
  // -----------------------------------------

  if (
    text === "/status" ||
    text.startsWith("/status ")
  ) {
    await telegramStatus(
      chatId,
      env
    );

    return json({
      ok: true,
      command:
        "/status"
    });
  }

  // -----------------------------------------
  // OTHER MESSAGES
  // -----------------------------------------

  const reply =
`🤖 Hakim Gold Signals

پیام دریافت شد.

دستورات فعال:

/start
/status

💎 تمرکز اصلی: XAU/USD`;

  await sendTelegramToChat(
    chatId,
    reply,
    env
  );

  return json({
    ok: true,
    command:
      "message"
  });
}

// ============================================================
// TELEGRAM WEBHOOK SETUP
// ============================================================

async function setTelegramWebhook(
  request,
  env
) {
  const token =
    getTelegramToken(env);

  if (!token) {
    return json({
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing"
    }, 500);
  }

  const origin =
    new URL(
      request.url
    ).origin;

  const webhookUrl =
    `${origin}/telegram-webhook`;

  const url =
    `https://api.telegram.org/bot${token}/setWebhook`;

  try {

    const response =
      await fetch(url, {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          url:
            webhookUrl
        })
      });

    const data =
      await response.json();

    return json({
      ok:
        response.ok &&
        data.ok === true,

      webhook:
        webhookUrl,

      telegram:
        data
    });

  } catch (error) {

    return json({
      ok: false,
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}

// ============================================================
// SIGNAL COOLDOWN
// ============================================================

const SIGNAL_STATE_KEY =
  "https://forex-signal-engine.local/state/gold-signal";

async function getSignalState() {
  const response =
    await cacheGet(
      SIGNAL_STATE_KEY
    );

  if (!response) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function setSignalState(
  state
) {
  await cachePut(
    SIGNAL_STATE_KEY,
    state,
    CONFIG.signalCooldownMinutes *
      60
  );
}

async function canSendSignal(
  signal
) {
  const state =
    await getSignalState();

  if (!state) {
    return true;
  }

  if (
    state.signal !==
    signal
  ) {
    return true;
  }

  const elapsed =
    nowMs() -
    Number(
      state.time || 0
    );

  return (
    elapsed >=
    CONFIG.signalCooldownMinutes *
      60 *
      1000
  );
}

// ============================================================
// GOLD DATA CACHE
// ============================================================

function goldCacheKey(
  interval
) {
  return (
    "https://forex-signal-engine.local/" +
    `gold/${interval}`
  );
}

async function getGoldCandles(
  interval,
  env,
  force = false
) {
  const key =
    goldCacheKey(
      interval
    );

  if (!force) {

    const cached =
      await cacheGet(key);

    if (cached) {

      try {

        const data =
          await cached.json();

        return {
          candles:
            data.candles,

          cached: true,

          fetchedAt:
            data.fetchedAt
        };

      } catch {
        // Ignore corrupt cache.
      }
    }
  }

  const data =
    await twelveDataTimeSeries(
      CONFIG.primarySymbol,
      interval,
      env,
      {
        outputsize:
          CONFIG.outputsize
      }
    );

  const candles =
    parseCandles(data);

  if (
    candles.length < 60
  ) {
    throw new Error(
      `${interval}: insufficient candles`
    );
  }

  const payload = {
    candles,

    fetchedAt:
      new Date().toISOString()
  };

  await cachePut(
    key,
    payload,
    CONFIG.goldCacheSeconds
  );

  return {
    candles,

    cached: false,

    fetchedAt:
      payload.fetchedAt
  };
}

// ============================================================
// PRIMARY GOLD ENGINE
// ============================================================

async function analyzeGoldEngine(
  env,
  options = {}
) {
  const force =
    options.force === true;

  const data15 =
    await getGoldCandles(
      CONFIG.primaryInterval,
      env,
      force
    );

  const data1h =
    await getGoldCandles(
      CONFIG.confirmationInterval,
      env,
      force
    );

  const result =
    analyzeGold(
      data15.candles,
      data1h.candles
    );

  return {
    ...result,

    cache: {
      interval15m:
        data15.cached
          ? "CACHE"
          : "FRESH",

      interval1h:
        data1h.cached
          ? "CACHE"
          : "FRESH",

      fetched15m:
        data15.fetchedAt,

      fetched1h:
        data1h.fetchedAt
    }
  };
}

// ============================================================
// RUN ENGINE
// ============================================================

async function runEngine(
  env
) {
  const generatedAt =
    new Date().toISOString();

  const result = {
    ok: true,

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    generatedAt,

    priority:
      "XAU/USD",

    results: [],

    stats: {
      runs: 1,

      signals: 0,

      telegramSent: 0,

      telegramFailed: 0,

      lastRun:
        generatedAt,

      lastSignal:
        null
    }
  };

  try {

    // GOLD FIRST

    const gold =
      await analyzeGoldEngine(
        env,
        {
          force: false
        }
      );

    result.results.push(
      gold
    );

    // SEND TELEGRAM

    if (
      gold.signal ===
        "BUY LIMIT" ||
      gold.signal ===
        "SELL LIMIT"
    ) {

      result.stats.signals =
        1;

      result.stats.lastSignal =
        gold.signal;

      const allowed =
        await canSendSignal(
          gold.signal
        );

      if (allowed) {

        const message =
          formatGoldTelegram(
            gold
          );

        const telegram =
          await sendTelegram(
            message,
            env
          );

        if (
          telegram.ok
        ) {

          result.stats.telegramSent =
            1;

          await setSignalState({
            signal:
              gold.signal,

            time:
              nowMs(),

            entry:
              gold.tradePlan?.entry
          });

        } else {

          result.stats.telegramFailed =
            1;

          result.telegramError =
            telegram.error ||
            telegram.response;
        }

      } else {

        result.telegram =
          "COOLDOWN";
      }
    }

    // SECONDARY SYMBOLS

    for (
      const symbol of
      CONFIG.symbols
    ) {

      if (
        symbol ===
        CONFIG.primarySymbol
      ) {
        continue;
      }

      result.results.push({
        symbol,

        signal:
          "WAIT",

        status:
          "GOLD_PRIORITY",

        message:
          "Secondary symbols are not refreshed during the Gold Priority cycle."
      });
    }

    return result;

  } catch (error) {

    result.ok = false;

    result.error =
      error?.message ||
      String(error);

    if (
      !result.results.length
    ) {

      result.results.push({
        symbol:
          CONFIG.primarySymbol,

        signal:
          "ERROR",

        error:
          result.error
      });
    }

    return result;
  }
}

// ============================================================
// TELEGRAM TEST
// ============================================================

async function telegramTest(
  env
) {
  const text =
`🟢 Hakim Gold Signals

Telegram connection test

FOREX SIGNAL ENGINE V5.5
Gold Priority`;

  return await sendTelegram(
    text,
    env
  );
}

// ============================================================
// HEALTH
// ============================================================

function health(env) {
  return {
    ok: true,

    service:
      "Forex Signal Engine",

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    primary:
      CONFIG.primarySymbol,

    focus:
      "GOLD",

    timeframes: [
      CONFIG.primaryInterval,
      CONFIG.confirmationInterval
    ],

    architecture:
      "2 Twelve Data requests per fresh GOLD cycle",

    telegramConfigured:
      Boolean(
        getTelegramToken(env)
      ) &&
      Boolean(
        getTelegramChatId(env)
      ),

    twelveDataConfigured:
      Boolean(
        getTwelveDataKey(env)
      ),

    webhookPath:
      "/telegram-webhook",

    commands: [
      "/start",
      "/status"
    ],

    timestamp:
      new Date().toISOString()
  };
}

// ============================================================
// STATS
// ============================================================

async function stats() {
  const state =
    await getSignalState();

  return {
    version:
      CONFIG.version,

    name:
      CONFIG.name,

    primary:
      CONFIG.primarySymbol,

    lastSignalState:
      state || null,

    cache: {
      strategy:
        "Gold 15M + 1H cached",

      goldRefreshSeconds:
        CONFIG.goldRefreshSeconds,

      goldCacheSeconds:
        CONFIG.goldCacheSeconds
    },

    timestamp:
      new Date().toISOString()
  };
}

// ============================================================
// REQUEST HANDLER
// ============================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    // HOME

    if (
      path === "/" ||
      path === ""
    ) {

      return new Response(
        dashboardHTML(),
        {
          headers: {
            "content-type":
              "text/html; charset=UTF-8"
          }
        }
      );
    }

    // HEALTH

    if (
      path === "/health"
    ) {

      return json(
        health(env)
      );
    }

    // API SIGNALS

    if (
      path === "/api/signals"
    ) {

      try {

        const result =
          await analyzeGoldEngine(
            env,
            {
              force: false
            }
          );

        const secondary =
          CONFIG.symbols
            .filter(
              s =>
                s !==
                CONFIG.primarySymbol
            )
            .map(
              symbol => ({
                symbol,

                signal:
                  "WAIT",

                status:
                  "GOLD_PRIORITY"
              })
            );

        return json({
          ok: true,

          version:
            CONFIG.version,

          name:
            CONFIG.name,

          generatedAt:
            new Date().toISOString(),

          results: [
            result,
            ...secondary
          ]
        });

      } catch (error) {

        return json({
          ok: false,

          version:
            CONFIG.version,

          name:
            CONFIG.name,

          results: [{
            symbol:
              CONFIG.primarySymbol,

            signal:
              "ERROR",

            error:
              error?.message ||
              String(error)
          }]
        });
      }
    }

    // RUN

    if (
      path === "/run"
    ) {

      const result =
        await runEngine(
          env
        );

      return json(
        result
      );
    }

    // TELEGRAM TEST

    if (
      path === "/telegram-test"
    ) {

      const result =
        await telegramTest(
          env
        );

      return json(
        result
      );
    }

    // TELEGRAM WEBHOOK

    if (
      path ===
      "/telegram-webhook"
    ) {

      return await
        handleTelegramWebhook(
          request,
          env
        );
    }

    // SET TELEGRAM WEBHOOK

    if (
      path ===
      "/telegram-set-webhook"
    ) {

      return await
        setTelegramWebhook(
          request,
          env
        );
    }

    // STATS

    if (
      path === "/api/stats"
    ) {

      return json(
        await stats()
      );
    }

    // NOT FOUND

    return json({
      error:
        "مسیر یافت نشد"
    }, 404);
  },

  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(
      runEngine(env)
    );
  }
};

// ============================================================
// DASHBOARD
// ============================================================

function dashboardHTML() {

  return `<!doctype html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
موتور سیگنال فارکس V5.5 · Gold Priority
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  font-family:
    Arial,
    Tahoma,
    sans-serif;

  background:
    #0b1020;

  color:
    #f4f6fb;
}

.container {
  max-width: 900px;

  margin: auto;

  padding: 18px;
}

.header {
  padding: 20px;

  border-radius: 18px;

  background:
    linear-gradient(
      135deg,
      #141b35,
      #0f172a
    );

  margin-bottom: 16px;
}

h1 {
  margin: 0 0 8px;

  font-size: 22px;
}

.subtitle {
  color:
    #aab3c5;
}

.card {
  background:
    #121a2d;

  border-radius: 18px;

  padding: 18px;

  margin-bottom: 14px;

  border:
    1px solid #26314a;
}

.gold {
  border:
    1px solid #c7a84b;
}

.symbol {
  font-size: 20px;

  font-weight: bold;
}

.price {
  font-size: 30px;

  margin: 12px 0;
}

.signal {
  display: inline-block;

  padding: 8px 14px;

  border-radius: 12px;

  background:
    #26314a;

  font-weight: bold;
}

.grid {
  display: grid;

  grid-template-columns:
    repeat(2, 1fr);

  gap: 10px;

  margin-top: 14px;
}

.metric {
  background:
    #0d1425;

  border-radius: 12px;

  padding: 10px;
}

.label {
  color:
    #8f9bb3;

  font-size: 12px;
}

.value {
  font-size: 16px;

  margin-top: 5px;
}

.plan {
  margin-top: 15px;

  padding: 14px;

  background:
    #0d1425;

  border-radius: 14px;
}

.footer {
  text-align: center;

  color:
    #75819a;

  margin-top: 18px;

  font-size: 12px;
}

@media(max-width:600px) {

  .grid {
    grid-template-columns:
      1fr 1fr;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="header">

<h1>
FX · موتور سیگنال فارکس V5.5
</h1>

<div class="subtitle">
Gold Priority · XAU/USD · 15M + 1H
</div>

</div>

<div id="app">
در حال دریافت داده...
</div>

<div class="footer">
رفرش خودکار هر 30 ثانیه
<br>
تمرکز اصلی: XAU/USD
</div>

</div>

<script>

function value(
  v,
  decimals = 2
) {

  if (
    v === null ||
    v === undefined ||
    !Number.isFinite(
      Number(v)
    )
  ) {

    return "-";
  }

  return Number(v)
    .toFixed(decimals);
}

function metric(
  label,
  val
) {

  return \`
    <div class="metric">

      <div class="label">
        \${label}
      </div>

      <div class="value">
        \${val}
      </div>

    </div>
  \`;
}

function renderGold(r) {

  const plan =
    r.tradePlan;

  let planHTML = "";

  if (plan) {

    planHTML = \`
      <div class="plan">

        <b>
          برنامه معامله
        </b>

        \${metric(
          "نقطه ورود",
          value(plan.entry)
        )}

        \${metric(
          "حد ضرر",
          value(plan.stopLoss)
        )}

        \${metric(
          "TP1",
          value(plan.tp1)
        )}

        \${metric(
          "TP2",
          value(plan.tp2)
        )}

      </div>
    \`;
  }

  return \`

    <div class="card gold">

      <div class="symbol">
        XAU/USD
      </div>

      <div class="price">
        \${value(r.price)}
      </div>

      <div class="signal">
        \${r.signal || "WAIT"}
      </div>

      <div class="grid">

        \${metric(
          "روند ۱۵ دقیقه",
          r.trend15m || "-"
        )}

        \${metric(
          "روند ۱ ساعته",
          r.trend1h || "-"
        )}

        \${metric(
          "هم‌راستایی",
          r.alignment || "-"
        )}

        \${metric(
          "امتیاز",
          (r.score ?? "-") +
          "/100"
        )}

        \${metric(
          "RSI 14",
          value(r.rsi)
        )}

        \${metric(
          "MACD",
          value(r.macd, 4)
        )}

        \${metric(
          "ADX 14",
          value(r.adx)
        )}

        \${metric(
          "+DI",
          value(r.plusDI)
        )}

        \${metric(
          "-DI",
          value(r.minusDI)
        )}

        \${metric(
          "ATR",
          value(r.atr)
        )}

        \${metric(
          "Momentum",
          value(r.momentum) +
          "%"
        )}

        \${metric(
          "Breakout",
          r.breakout || "-"
        )}

      </div>

      \${planHTML}

    </div>
  \`;
}

function renderSecondary(r) {

  return \`

    <div class="card">

      <div class="symbol">
        \${r.symbol}
      </div>

      <div class="signal">
        GOLD PRIORITY
      </div>

      <div style="
        margin-top:10px;
        color:#8f9bb3;
      ">

        این نماد در چرخه اصلی API
        برای کاهش مصرف اعتبار
        Twelve Data به‌روزرسانی نمی‌شود.

      </div>

    </div>
  \`;
}

async function load() {

  try {

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

    if (
      !data.results ||
      !data.results.length
    ) {

      throw new Error(
        "No results"
      );
    }

    const gold =
      data.results.find(
        r =>
          r.symbol ===
          "XAU/USD"
      );

    const secondary =
      data.results.filter(
        r =>
          r.symbol !==
          "XAU/USD"
      );

    let html = "";

    if (gold) {

      html +=
        renderGold(gold);
    }

    for (
      const r of secondary
    ) {

      html +=
        renderSecondary(r);
    }

    document
      .getElementById("app")
      .innerHTML =
        html;

  } catch (error) {

    document
      .getElementById("app")
      .innerHTML = \`

        <div class="card">

          <b>
            خطا در دریافت اطلاعات
          </b>

          <div style="
            margin-top:10px;
            color:#aab3c5;
          ">

            \${error.message}

          </div>

        </div>
      \`;
  }
}

load();

setInterval(
  load,
  30000
);

</script>

</body>

</html>`;
    }
