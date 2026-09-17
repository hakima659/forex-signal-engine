// ============================================================
// FOREX SIGNAL ENGINE V5.4 GOLD PRO
// Cloudflare Worker + Twelve Data + Telegram
// PRIMARY FOCUS: XAU/USD
//
// FEATURES
// - XAU/USD primary focus
// - 15m + 1h confirmation
// - EMA 20 / 50 / 200
// - MACD
// - RSI
// - ADX / DI
// - ATR
// - Momentum
// - Breakout
// - Closed candle confirmation
// - Strict BUY / SELL filtering
// - BUY LIMIT / SELL LIMIT guidance
// - ATR based SL / TP1 / TP2 / TP3
// - Telegram alerts
// - Telegram test endpoint
// - Manual /run endpoint
// - API endpoints
// - 30 minute signal cooldown
// - No guaranteed-profit claims
// ============================================================

const CONFIG = {
  version: "V5.4",
  name: "Gold Pro",

  symbols: [
    "XAU/USD",
    "EUR/USD",
    "GBP/USD",
    "USD/JPY"
  ],

  primarySymbol: "XAU/USD",

  interval: "15min",
  confirmationInterval: "1h",

  outputsize15m: 250,
  outputsize1h: 250,

  // Strict signal filters
  minScore: 85,
  strongScore: 92,
  eliteScore: 96,

  minADX: 25,
  minDISpread: 8,
  minMomentum: 0.15,

  breakoutLookback: 20,
  candleBodyMin: 0.50,

  // Risk / trade-plan calculations
  atrSLMultiplier: 0.70,
  tp1RiskReward: 1.50,
  tp2RiskReward: 2.50,
  tp3RiskReward: 3.50,

  // Pending limit distance
  limitATRMultiplier: 0.25,

  // Prevent repeated signals
  signalCooldownMinutes: 30,

  // Use completed candle
  useClosedCandle: true,

  timezone: "UTC"
};

// ============================================================
// RUNTIME STATE
// ============================================================

const signalCooldown = new Map();

let runtimeStats = {
  runs: 0,
  signals: 0,
  telegramSent: 0,
  telegramFailed: 0,
  lastRun: null,
  lastSignal: null,
  lastTelegram: null
};

// ============================================================
// ENVIRONMENT HELPERS
// ============================================================

function getEnvValue(env, names) {
  for (const name of names) {
    const value = env?.[name];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      return String(value).trim();
    }
  }

  return null;
}

function getTwelveDataKey(env) {
  return getEnvValue(env, [
    "TWELVE_DATA_API_KEY",
    "کلید API دوازده داده",
    "کلید_API_دوازده_داده",
    "TWELVE_DATA_KEY"
  ]);
}

function getTelegramToken(env) {
  return getEnvValue(env, [
    "TELEGRAM_BOT_TOKEN",
    "توکن_ربات_تلگرام",
    "توکن ربات تلگرام"
  ]);
}

function getTelegramChatId(env) {
  return getEnvValue(env, [
    "TELEGRAM_CHAT_ID",
    "شناسه_چت_تلگرام",
    "آیدی_چت_تلگرام",
    "TELEGRAM_CHATID"
  ]);
}

// ============================================================
// RESPONSE HELPERS
// ============================================================

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      }
    }
  );
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function round(value, decimals = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Number(n.toFixed(decimals));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// TWELVE DATA
// ============================================================

async function fetchTimeSeries(
  env,
  symbol,
  interval,
  outputsize
) {
  const apiKey = getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error("Twelve Data API key is missing");
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (
    data.status === "error" ||
    data.code ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      data.message ||
      "Invalid Twelve Data response"
    );
  }

  const candles = data.values
    .map(item => ({
      datetime: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume:
        item.volume !== undefined
          ? Number(item.volume)
          : null
    }))
    .filter(item =>
      Number.isFinite(item.open) &&
      Number.isFinite(item.high) &&
      Number.isFinite(item.low) &&
      Number.isFinite(item.close)
    )
    .reverse();

  if (candles.length < 50) {
    throw new Error(
      `Not enough candles for ${symbol} ${interval}`
    );
  }

  return candles;
}

// ============================================================
// DATA NORMALIZATION
// ============================================================

function getClosedCandles(candles) {
  if (!CONFIG.useClosedCandle) {
    return candles;
  }

  if (candles.length <= 2) {
    return candles;
  }

  // Twelve Data usually returns completed candles.
  // Remove the newest candle to avoid using a possibly open candle.
  return candles.slice(0, -1);
}

// ============================================================
// EMA
// ============================================================

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return [];
  }

  const result = [];

  const multiplier = 2 / (period + 1);

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  let previous = sum / period;

  result.push(previous);

  for (let i = period; i < values.length; i++) {
    previous =
      (values[i] - previous) * multiplier +
      previous;

    result.push(previous);
  }

  return result;
}

function latestEMA(values, period) {
  const result = ema(values, period);

  return result.length
    ? result[result.length - 1]
    : null;
}

// ============================================================
// RSI
// ============================================================

function rsi(values, period = 14) {
  if (values.length <= period) {
    return [];
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  const result = [];

  let rs =
    averageLoss === 0
      ? Infinity
      : averageGain / averageLoss;

  result.push(
    averageLoss === 0
      ? 100
      : 100 - 100 / (1 + rs)
  );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    const gain =
      change > 0 ? change : 0;

    const loss =
      change < 0 ? Math.abs(change) : 0;

    averageGain =
      ((averageGain * (period - 1)) + gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) /
      period;

    rs =
      averageLoss === 0
        ? Infinity
        : averageGain / averageLoss;

    const current =
      averageLoss === 0
        ? 100
        : 100 - 100 / (1 + rs);

    result.push(current);
  }

  return result;
}

// ============================================================
// MACD
// ============================================================

function macd(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
  if (values.length < slowPeriod + signalPeriod) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const offset =
    slowPeriod - fastPeriod;

  const macdLine = [];

  for (let i = 0; i < slow.length; i++) {
    const fastValue =
      fast[i + offset];

    const slowValue =
      slow[i];

    macdLine.push(
      fastValue - slowValue
    );
  }

  const signalLine =
    ema(macdLine, signalPeriod);

  if (!signalLine.length) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const latestMacd =
    macdLine[macdLine.length - 1];

  const latestSignal =
    signalLine[signalLine.length - 1];

  return {
    macd: latestMacd,
    signal: latestSignal,
    histogram:
      latestMacd - latestSignal
  };
}

// ============================================================
// ATR
// ============================================================

function atr(candles, period = 14) {
  if (candles.length <= period) {
    return [];
  }

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const range1 =
      current.high - current.low;

    const range2 =
      Math.abs(
        current.high - previous.close
      );

    const range3 =
      Math.abs(
        current.low - previous.close
      );

    tr.push(
      Math.max(
        range1,
        range2,
        range3
      )
    );
  }

  if (tr.length < period) {
    return [];
  }

  let currentATR = 0;

  for (let i = 0; i < period; i++) {
    currentATR += tr[i];
  }

  currentATR /= period;

  const result = [currentATR];

  for (
    let i = period;
    i < tr.length;
    i++
  ) {
    currentATR =
      ((currentATR * (period - 1)) + tr[i]) /
      period;

    result.push(currentATR);
  }

  return result;
}

// ============================================================
// ADX / DI
// ============================================================

function adx(candles, period = 14) {
  if (candles.length <= period * 2) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const upMove =
      current.high - previous.high;

    const downMove =
      previous.low - current.low;

    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(
        current.high - previous.close
      ),
      Math.abs(
        current.low - previous.close
      )
    );

    tr.push(trueRange);

    plusDM.push(
      upMove > downMove && upMove > 0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove > upMove && downMove > 0
        ? downMove
        : 0
    );
  }

  if (tr.length < period * 2) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  function wilderAverage(values) {
    const output = [];

    let current = 0;

    for (let i = 0; i < period; i++) {
      current += values[i];
    }

    current /= period;
    output.push(current);

    for (
      let i = period;
      i < values.length;
      i++
    ) {
      current =
        ((current * (period - 1)) + values[i]) /
        period;

      output.push(current);
    }

    return output;
  }

  const smoothedTR =
    wilderAverage(tr);

  const smoothedPlusDM =
    wilderAverage(plusDM);

  const smoothedMinusDM =
    wilderAverage(minusDM);

  const dx = [];
  const plusValues = [];
  const minusValues = [];

  const length = Math.min(
    smoothedTR.length,
    smoothedPlusDM.length,
    smoothedMinusDM.length
  );

  for (let i = 0; i < length; i++) {
    const trValue =
      smoothedTR[i];

    const plus =
      trValue === 0
        ? 0
        : 100 *
          (smoothedPlusDM[i] / trValue);

    const minus =
      trValue === 0
        ? 0
        : 100 *
          (smoothedMinusDM[i] / trValue);

    const sum = plus + minus;

    const currentDX =
      sum === 0
        ? 0
        : 100 *
          Math.abs(plus - minus) /
          sum;

    plusValues.push(plus);
    minusValues.push(minus);
    dx.push(currentDX);
  }

  if (dx.length < period) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  const adxValues =
    wilderAverage(dx);

  return {
    adx:
      adxValues.length
        ? adxValues[adxValues.length - 1]
        : null,

    plusDI:
      plusValues.length
        ? plusValues[plusValues.length - 1]
        : null,

    minusDI:
      minusValues.length
        ? minusValues[minusValues.length - 1]
        : null
  };
}

// ============================================================
// MOMENTUM
// ============================================================

function momentumPercent(
  values,
  period = 10
) {
  if (values.length <= period) {
    return null;
  }

  const current =
    values[values.length - 1];

  const previous =
    values[values.length - 1 - period];

  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    ((current - previous) / previous) *
    100
  );
}

// ============================================================
// TREND
// ============================================================

function determineTrend(
  price,
  ema20,
  ema50,
  ema200
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(ema20) ||
    !Number.isFinite(ema50) ||
    !Number.isFinite(ema200)
  ) {
    return "NEUTRAL";
  }

  if (
    price > ema20 &&
    ema20 > ema50 &&
    ema50 > ema200
  ) {
    return "BULLISH";
  }

  if (
    price < ema20 &&
    ema20 < ema50 &&
    ema50 < ema200
  ) {
    return "BEARISH";
  }

  if (
    price > ema50 &&
    ema20 > ema50
  ) {
    return "BULLISH";
  }

  if (
    price < ema50 &&
    ema20 < ema50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ============================================================
// CANDLE CONFIRMATION
// ============================================================

function candleConfirmation(candle) {
  if (!candle) {
    return {
      direction: "NEUTRAL",
      bodyRatio: 0,
      confirmed: false
    };
  }

  const range =
    candle.high - candle.low;

  if (range <= 0) {
    return {
      direction: "NEUTRAL",
      bodyRatio: 0,
      confirmed: false
    };
  }

  const body =
    Math.abs(
      candle.close - candle.open
    );

  const bodyRatio =
    body / range;

  const bullish =
    candle.close > candle.open;

  const bearish =
    candle.close < candle.open;

  return {
    direction:
      bullish
        ? "BULLISH"
        : bearish
        ? "BEARISH"
        : "NEUTRAL",

    bodyRatio,

    confirmed:
      bodyRatio >= CONFIG.candleBodyMin
  };
}

// ============================================================
// BREAKOUT
// ============================================================

function detectBreakout(
  candles,
  lookback = 20
) {
  if (candles.length <= lookback + 1) {
    return "NONE";
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      candles.length - 1 - lookback,
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

  if (current.close > highest) {
    return "BULLISH";
  }

  if (current.close < lowest) {
    return "BEARISH";
  }

  return "NONE";
}

// ============================================================
// ANALYZE TIMEFRAME
// ============================================================

function analyzeTimeframe(candles) {
  const closed =
    getClosedCandles(candles);

  const closes =
    closed.map(c => c.close);

  const current =
    closed[closed.length - 1];

  const ema20 =
    latestEMA(closes, 20);

  const ema50 =
    latestEMA(closes, 50);

  const ema200 =
    latestEMA(closes, 200);

  const rsiValues =
    rsi(closes, 14);

  const rsi14 =
    rsiValues.length
      ? rsiValues[rsiValues.length - 1]
      : null;

  const macdData =
    macd(closes);

  const atrValues =
    atr(closed, 14);

  const atr14 =
    atrValues.length
      ? atrValues[atrValues.length - 1]
      : null;

  const adxData =
    adx(closed, 14);

  const momentum =
    momentumPercent(
      closes,
      10
    );

  const trend =
    determineTrend(
      current.close,
      ema20,
      ema50,
      ema200
    );

  const candle =
    candleConfirmation(
      current
    );

  const breakout =
    detectBreakout(
      closed,
      CONFIG.breakoutLookback
    );

  return {
    price: current.close,

    ema20,
    ema50,
    ema200,

    rsi: rsi14,

    macd: macdData.macd,
    macdSignal: macdData.signal,
    macdHistogram: macdData.histogram,

    adx: adxData.adx,
    plusDI: adxData.plusDI,
    minusDI: adxData.minusDI,

    atr: atr14,

    momentum,

    trend,

    candleDirection:
      candle.direction,

    candleBodyRatio:
      candle.bodyRatio,

    candleConfirmed:
      candle.confirmed,

    breakout
  };
}

// ============================================================
// SIGNAL SCORE
// ============================================================

function calculateScore(
  analysis15,
  analysis1h
) {
  let score = 0;

  const reasons = [];

  // ----------------------------------------------------------
  // EMA STRUCTURE — 15
  // ----------------------------------------------------------

  if (
    analysis15.trend === "BULLISH"
  ) {
    score += 15;
    reasons.push(
      "EMA structure bullish"
    );
  } else if (
    analysis15.trend === "BEARISH"
  ) {
    score += 15;
    reasons.push(
      "EMA structure bearish"
    );
  }

  // ----------------------------------------------------------
  // 1H TREND — 20
  // ----------------------------------------------------------

  if (
    analysis1h.trend !== "NEUTRAL"
  ) {
    score += 20;

    reasons.push(
      `1H trend ${analysis1h.trend}`
    );
  }

  // ----------------------------------------------------------
  // 15M TREND — 10
  // ----------------------------------------------------------

  if (
    analysis15.trend !== "NEUTRAL"
  ) {
    score += 10;

    reasons.push(
      `15M trend ${analysis15.trend}`
    );
  }

  // ----------------------------------------------------------
  // MACD — 15
  // ----------------------------------------------------------

  if (
    Number.isFinite(analysis15.macd) &&
    Number.isFinite(
      analysis15.macdSignal
    )
  ) {
    if (
      analysis15.macd >
      analysis15.macdSignal
    ) {
      score += 15;

      reasons.push(
        "MACD bullish"
      );
    } else if (
      analysis15.macd <
      analysis15.macdSignal
    ) {
      score += 15;

      reasons.push(
        "MACD bearish"
      );
    }
  }

  // ----------------------------------------------------------
  // RSI — 10
  // ----------------------------------------------------------

  if (
    Number.isFinite(analysis15.rsi)
  ) {
    if (
      analysis15.rsi >= 50 &&
      analysis15.rsi < 70
    ) {
      score += 10;

      reasons.push(
        "RSI bullish zone"
      );
    } else if (
      analysis15.rsi <= 50 &&
      analysis15.rsi > 30
    ) {
      score += 10;

      reasons.push(
        "RSI bearish zone"
      );
    }
  }

  // ----------------------------------------------------------
  // ADX + DI — 10
  // ----------------------------------------------------------

  if (
    Number.isFinite(analysis15.adx) &&
    Number.isFinite(analysis15.plusDI) &&
    Number.isFinite(analysis15.minusDI)
  ) {
    const spread =
      Math.abs(
        analysis15.plusDI -
        analysis15.minusDI
      );

    if (
      analysis15.adx >= CONFIG.minADX &&
      spread >= CONFIG.minDISpread
    ) {
      score += 10;

      reasons.push(
        "ADX/DI confirms trend"
      );
    }
  }

  // ----------------------------------------------------------
  // MOMENTUM — 10
  // ----------------------------------------------------------

  if (
    Number.isFinite(
      analysis15.momentum
    )
  ) {
    if (
      Math.abs(
        analysis15.momentum
      ) >= CONFIG.minMomentum
    ) {
      score += 10;

      reasons.push(
        "Momentum confirmed"
      );
    }
  }

  // ----------------------------------------------------------
  // BREAKOUT — 5
  // ----------------------------------------------------------

  if (
    analysis15.breakout !== "NONE"
  ) {
    score += 5;

    reasons.push(
      `Breakout ${analysis15.breakout}`
    );
  }

  // ----------------------------------------------------------
  // CANDLE — 5
  // ----------------------------------------------------------

  if (
    analysis15.candleConfirmed
  ) {
    score += 5;

    reasons.push(
      "Candle confirmed"
    );
  }

  // ----------------------------------------------------------
  // 15M / 1H CONFLICT PENALTY
  // ----------------------------------------------------------

  if (
    analysis15.trend !== "NEUTRAL" &&
    analysis1h.trend !== "NEUTRAL" &&
    analysis15.trend !== analysis1h.trend
  ) {
    score *= 0.50;

    reasons.push(
      "Timeframe conflict penalty"
    );
  }

  return {
    score: Math.round(score),
    reasons
  };
}

// ============================================================
// SIGNAL DIRECTION
// ============================================================

function scoreToSignal(
  analysis15,
  analysis1h,
  scoreData
) {
  const score =
    scoreData.score;

  if (
    analysis1h.trend === "NEUTRAL"
  ) {
    return "WAIT";
  }

  if (
    analysis15.trend !==
    analysis1h.trend
  ) {
    return "WAIT";
  }

  if (
    score < CONFIG.minScore
  ) {
    return "WAIT";
  }

  const adx =
    analysis15.adx;

  const plusDI =
    analysis15.plusDI;

  const minusDI =
    analysis15.minusDI;

  if (
    !Number.isFinite(adx) ||
    !Number.isFinite(plusDI) ||
    !Number.isFinite(minusDI)
  ) {
    return "WAIT";
  }

  if (
    adx < CONFIG.minADX
  ) {
    return "WAIT";
  }

  const diSpread =
    Math.abs(
      plusDI - minusDI
    );

  if (
    diSpread < CONFIG.minDISpread
  ) {
    return "WAIT";
  }

  const momentum =
    analysis15.momentum;

  if (
    !Number.isFinite(momentum)
  ) {
    return "WAIT";
  }

  const candle =
    analysis15.candleDirection;

  if (
    analysis15.trend === "BULLISH"
  ) {
    if (
      analysis15.macd <=
      analysis15.macdSignal
    ) {
      return "WAIT";
    }

    if (
      momentum <
      CONFIG.minMomentum
    ) {
      return "WAIT";
    }

    if (
      candle !== "BULLISH"
    ) {
      return "WAIT";
    }

    if (
      plusDI <= minusDI
    ) {
      return "WAIT";
    }

    return "BUY";
  }

  if (
    analysis15.trend === "BEARISH"
  ) {
    if (
      analysis15.macd >=
      analysis15.macdSignal
    ) {
      return "WAIT";
    }

    if (
      momentum >
      -CONFIG.minMomentum
    ) {
      return "WAIT";
    }

    if (
      candle !== "BEARISH"
    ) {
      return "WAIT";
    }

    if (
      minusDI <= plusDI
    ) {
      return "WAIT";
    }

    return "SELL";
  }

  return "WAIT";
}

// ============================================================
// SIGNAL STRENGTH
// ============================================================

function getStrength(score) {
  if (
    score >= CONFIG.eliteScore
  ) {
    return "ELITE";
  }

  if (
    score >= CONFIG.strongScore
  ) {
    return "STRONG";
  }

  if (
    score >= CONFIG.minScore
  ) {
    return "CONFIRMED";
  }

  return "WEAK";
}

// ============================================================
// PRICE PRECISION
// ============================================================

function getPriceDecimals(symbol) {
  if (
    symbol === "XAU/USD"
  ) {
    return 2;
  }

  if (
    symbol === "USD/JPY"
  ) {
    return 3;
  }

  return 5;
}

// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(
  signal,
  analysis,
  symbol
) {
  const entry =
    safeNumber(
      analysis.price
    );

  const atrValue =
    safeNumber(
      analysis.atr
    );

  if (
    entry <= 0 ||
    atrValue <= 0
  ) {
    return null;
  }

  const decimals =
    getPriceDecimals(symbol);

  const slDistance =
    atrValue *
    CONFIG.atrSLMultiplier;

  const limitDistance =
    atrValue *
    CONFIG.limitATRMultiplier;

  // ----------------------------------------------------------
  // IMPORTANT:
// SL / TP are calculated from LIMIT ENTRY itself.
// This keeps Entry, SL and TP mathematically consistent.
// ----------------------------------------------------------

  const limitEntry =
    signal === "BUY"
      ? entry - limitDistance
      : entry + limitDistance;

  let stopLoss;
  let tp1;
  let tp2;
  let tp3;

  if (
    signal === "BUY"
  ) {
    stopLoss =
      limitEntry -
      slDistance;

    tp1 =
      limitEntry +
      slDistance *
      CONFIG.tp1RiskReward;

    tp2 =
      limitEntry +
      slDistance *
      CONFIG.tp2RiskReward;

    tp3 =
      limitEntry +
      slDistance *
      CONFIG.tp3RiskReward;
  } else {
    stopLoss =
      limitEntry +
      slDistance;

    tp1 =
      limitEntry -
      slDistance *
      CONFIG.tp1RiskReward;

    tp2 =
      limitEntry -
      slDistance *
      CONFIG.tp2RiskReward;

    tp3 =
      limitEntry -
      slDistance *
      CONFIG.tp3RiskReward;
  }

  return {
    marketPrice:
      round(entry, decimals),

    limitEntry:
      round(limitEntry, decimals),

    stopLoss:
      round(stopLoss, decimals),

    tp1:
      round(tp1, decimals),

    tp2:
      round(tp2, decimals),

    tp3:
      round(tp3, decimals),

    atr:
      round(atrValue, decimals),

    riskDistance:
      round(slDistance, decimals),

    signal
  };
}

// ============================================================
// COOLDOWN
// ============================================================

function cooldownKey(
  symbol,
  signal
) {
  return `${symbol}:${signal}`;
}

function isInCooldown(
  symbol,
  signal
) {
  const key =
    cooldownKey(
      symbol,
      signal
    );

  const last =
    signalCooldown.get(key);

  if (!last) {
    return false;
  }

  const elapsed =
    Date.now() - last;

  const cooldownMs =
    CONFIG.signalCooldownMinutes *
    60 *
    1000;

  if (
    elapsed >= cooldownMs
  ) {
    signalCooldown.delete(key);
    return false;
  }

  return true;
}

function markCooldown(
  symbol,
  signal
) {
  signalCooldown.set(
    cooldownKey(
      symbol,
      signal
    ),
    Date.now()
  );
}

// ============================================================
// TELEGRAM MESSAGE
// ============================================================

function formatTelegramMessage(
  symbol,
  signal,
  trade
) {
  const isGold =
    symbol === "XAU/USD";

  const title =
    isGold
      ? "💎 طلا (XAUUSD)"
      : `📊 ${symbol}`;

  const direction =
    signal === "BUY"
      ? "📈 BUY LIMIT | SCALP"
      : "📉 SELL LIMIT | SCALP";

  return [
    title,
    "",
    direction,
    "",
    `نقطه ورود: ${trade.limitEntry}`,
    "",
    `🛑 حد ضرر: ${trade.stopLoss}`,
    "",
    `🎯 تی پی اول: ${trade.tp1}`,
    "",
    `🎯 تی پی دوم: ${trade.tp2}`,
    "",
    "💰 مدیریت سرمایه",
    "",
    "Hakim Gold Signals"
  ].join("\n");
}

// ============================================================
// SEND TELEGRAM
// ============================================================

async function sendTelegramMessage(
  env,
  message
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
          chat_id: chatId,
          text: message,

          disable_web_page_preview:
            true
        })
      });

    const data =
      await response.json();

    if (!response.ok || !data.ok) {
      runtimeStats.telegramFailed++;

      return {
        ok: false,
        status: response.status,
        telegram: data
      };
    }

    runtimeStats.telegramSent++;
    runtimeStats.lastTelegram =
      new Date().toISOString();

    return {
      ok: true,
      telegram: data
    };

  } catch (error) {
    runtimeStats.telegramFailed++;

    return {
      ok: false,
      error: error.message
    };
  }
}

// ============================================================
// PROCESS SIGNAL
// ============================================================

async function processSignal(
  env,
  symbol,
  analysis15,
  analysis1h,
  scoreData
) {
  const signal =
    scoreToSignal(
      analysis15,
      analysis1h,
      scoreData
    );

  const strength =
    getStrength(
      scoreData.score
    );

  const result = {
    symbol,
    signal,
    strength,
    score:
      scoreData.score,

    trend15m:
      analysis15.trend,

    trend1h:
      analysis1h.trend,

    reasons:
      scoreData.reasons,

    trade: null,

    telegram: null
  };

  if (
    signal !== "BUY" &&
    signal !== "SELL"
  ) {
    return result;
  }

  if (
    isInCooldown(
      symbol,
      signal
    )
  ) {
    result.cooldown = true;
    return result;
  }

  const trade =
    buildTradePlan(
      signal,
      analysis15,
      symbol
    );

  if (!trade) {
    return result;
  }

  result.trade = trade;

  const message =
    formatTelegramMessage(
      symbol,
      signal,
      trade
    );

  const telegram =
    await sendTelegramMessage(
      env,
      message
    );

  result.telegram =
    telegram;

  if (telegram.ok) {
    markCooldown(
      symbol,
      signal
    );

    runtimeStats.signals++;

    runtimeStats.lastSignal = {
      symbol,
      signal,
      score: scoreData.score,
      time:
        new Date().toISOString()
    };
  }

  return result;
}

// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(
  env,
  symbol
) {
  const candles15 =
    await fetchTimeSeries(
      env,
      symbol,
      CONFIG.interval,
      CONFIG.outputsize15m
    );

  const candles1h =
    await fetchTimeSeries(
      env,
      symbol,
      CONFIG.confirmationInterval,
      CONFIG.outputsize1h
    );

  const analysis15 =
    analyzeTimeframe(
      candles15
    );

  const analysis1h =
    analyzeTimeframe(
      candles1h
    );

  const scoreData =
    calculateScore(
      analysis15,
      analysis1h
    );

  const signal =
    scoreToSignal(
      analysis15,
      analysis1h,
      scoreData
    );

  const strength =
    getStrength(
      scoreData.score
    );

  return {
    symbol,

    signal,

    strength,

    score:
      scoreData.score,

    trend15m:
      analysis15.trend,

    trend1h:
      analysis1h.trend,

    alignment:
      analysis15.trend ===
      analysis1h.trend
        ? analysis15.trend
        : "MIXED",

    analysis15,
    analysis1h,

    reasons:
      scoreData.reasons
  };
}

// ============================================================
// RUN ENGINE
// ============================================================

async function runEngine(env) {
  runtimeStats.runs++;
  runtimeStats.lastRun =
    new Date().toISOString();

  const results = [];

  // Gold first
  const orderedSymbols = [
    CONFIG.primarySymbol,

    ...CONFIG.symbols.filter(
      s =>
        s !==
        CONFIG.primarySymbol
    )
  ];

  for (
    const symbol of orderedSymbols
  ) {
    try {
      const analyzed =
        await analyzeSymbol(
          env,
          symbol
        );

      const processed =
        await processSignal(
          env,
          symbol,
          analyzed.analysis15,
          analyzed.analysis1h,
          {
            score:
              analyzed.score,

            reasons:
              analyzed.reasons
          }
        );

      results.push({
        ...analyzed,
        trade:
          processed.trade,

        telegram:
          processed.telegram,

        cooldown:
          processed.cooldown || false
      });

    } catch (error) {
      results.push({
        symbol,
        signal: "ERROR",
        error:
          error.message
      });
    }

    // Small pause between Twelve Data calls
    await sleep(150);
  }

  return {
    ok: true,

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    primarySymbol:
      CONFIG.primarySymbol,

    generatedAt:
      new Date().toISOString(),

    results,

    stats:
      runtimeStats
  };
}

// ============================================================
// TELEGRAM TEST
// ============================================================

async function telegramTest(env) {
  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  if (!token) {
    return {
      ok: false,
      telegram: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing"
    };
  }

  if (!chatId) {
    return {
      ok: false,
      telegram: false,
      error:
        "TELEGRAM_CHAT_ID is missing"
    };
  }

  const message = [
    "🟢 Hakim Gold Signals",
    "",
    "Telegram connection test",
    "",
    "FOREX SIGNAL ENGINE V5.4",
    "XAU/USD Gold Pro",
    "",
    "اتصال تلگرام با موفقیت تست شد."
  ].join("\n");

  const result =
    await sendTelegramMessage(
      env,
      message
    );

  return {
    ok:
      result.ok,

    telegram:
      result.ok,

    result
  };
}

// ============================================================
// DASHBOARD
// ============================================================

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
Forex Signal Engine V5.4 Gold Pro
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background:
    linear-gradient(
      135deg,
      #05070d,
      #101522
    );

  color: #f5f5f5;

  font-family:
    Arial,
    Tahoma,
    sans-serif;

  min-height: 100vh;
}

.container {
  max-width: 900px;
  margin: auto;
  padding: 18px;
}

.header {
  background:
    rgba(255,255,255,.05);

  border:
    1px solid
    rgba(255,255,255,.1);

  border-radius: 20px;

  padding: 20px;

  margin-bottom: 16px;

  text-align: center;
}

.header h1 {
  margin: 0 0 8px;

  font-size: 25px;
}

.version {
  color: #aaa;

  font-size: 13px;
}

.card {
  background:
    rgba(255,255,255,.055);

  border:
    1px solid
    rgba(255,255,255,.09);

  border-radius: 18px;

  padding: 18px;

  margin-bottom: 14px;

  box-shadow:
    0 10px 30px
    rgba(0,0,0,.18);
}

.gold {
  border:
    1px solid
    rgba(255,190,0,.35);
}

.symbol {
  font-size: 14px;

  color: #aaa;

  margin-bottom: 8px;
}

.price {
  font-size: 34px;

  font-weight: 700;

  direction: ltr;

  text-align: center;

  margin: 10px 0;
}

.status {
  text-align: center;

  font-size: 20px;

  font-weight: 700;

  margin: 12px 0;
}

.wait {
  color: #ffd166;
}

.buy {
  color: #42d392;
}

.sell {
  color: #ff667a;
}

.grid {
  display: grid;

  grid-template-columns:
    repeat(2,1fr);

  gap: 10px;
}

.metric {
  background:
    rgba(255,255,255,.04);

  border-radius: 12px;

  padding: 11px;
}

.metric .label {
  color: #999;

  font-size: 12px;

  margin-bottom: 5px;
}

.metric .value {
  font-size: 16px;

  font-weight: 700;

  direction: ltr;

  text-align: right;
}

.score {
  font-size: 32px;

  font-weight: 800;

  text-align: center;

  margin: 15px 0;
}

.refresh {
  text-align: center;

  color: #999;

  font-size: 12px;

  margin-top: 12px;
}

button {
  border: 0;

  border-radius: 12px;

  padding: 12px 18px;

  font-weight: 700;

  cursor: pointer;

  background: #ffffff;

  color: #111;

  margin: 4px;
}

pre {
  white-space: pre-wrap;

  word-break: break-word;

  direction: ltr;

  text-align: left;

  font-size: 12px;

  color: #ccc;
}

@media(max-width:600px) {

  .grid {
    grid-template-columns:
      1fr 1fr;
  }

  .price {
    font-size: 28px;
  }

  .header h1 {
    font-size: 21px;
  }
}

</style>
</head>

<body>

<div class="container">

<div class="header">

<h1>
FX
</h1>

<div>
موتور سیگنال فارکس
V5.4 · Gold Pro
</div>

<div class="version">
XAU/USD Focus · 15M + 1H
</div>

</div>

<div id="content">

<div class="card">
در حال دریافت اطلاعات...
</div>

</div>

<div class="refresh">
رفرش خودکار: <span id="count">60</span> ثانیه
</div>

</div>

<script>

let countdown = 60;

function esc(value) {

  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");

}

function formatValue(value) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "-";
  }

  return Number(value).toFixed(2);

}

function signalClass(signal) {

  if (signal === "BUY")
    return "buy";

  if (signal === "SELL")
    return "sell";

  return "wait";

}

function signalText(signal) {

  if (signal === "BUY")
    return "BUY";

  if (signal === "SELL")
    return "SELL";

  return "صبر کن";

}

function renderSymbol(item, primary=false) {

  const a = item.analysis15 || {};

  const h = item.analysis1h || {};

  const cls =
    signalClass(item.signal);

  const alignment =
    item.alignment || "MIXED";

  return \`
  <div class="card \${primary ? "gold" : ""}">

    <div class="symbol">
      \${esc(item.symbol)}
      \${primary ? " — نماد اصلی" : ""}
    </div>

    <div class="price">
      \${formatValue(a.price)}
    </div>

    <div class="status \${cls}">
      \${signalText(item.signal)}
      ·
      \${esc(item.strength || "WEAK")}
    </div>

    <div class="grid">

      <div class="metric">
        <div class="label">
          روند ۱۵ دقیقه
        </div>
        <div class="value">
          \${esc(a.trend)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          روند ۱ ساعته
        </div>
        <div class="value">
          \${esc(h.trend)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          هم‌راستایی
        </div>
        <div class="value">
          \${esc(alignment)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          امتیاز تحلیل
        </div>
        <div class="value">
          \${esc(item.score)}/100
        </div>
      </div>

      <div class="metric">
        <div class="label">
          RSI 14
        </div>
        <div class="value">
          \${formatValue(a.rsi)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          MACD
        </div>
        <div class="value">
          \${formatValue(a.macd)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          ADX 14
        </div>
        <div class="value">
          \${formatValue(a.adx)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          +DI
        </div>
        <div class="value">
          \${formatValue(a.plusDI)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          -DI
        </div>
        <div class="value">
          \${formatValue(a.minusDI)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          ATR 14
        </div>
        <div class="value">
          \${formatValue(a.atr)}
        </div>
      </div>

      <div class="metric">
        <div class="label">
          Momentum
        </div>
        <div class="value">
          \${formatValue(a.momentum)}%
        </div>
      </div>

      <div class="metric">
        <div class="label">
          شکست قیمت
        </div>
        <div class="value">
          \${esc(a.breakout)}
        </div>
      </div>

    </div>

    \${item.trade ? \`

      <div style="margin-top:15px">

        <div class="metric">
          نقطه ورود:
          \${formatValue(item.trade.limitEntry)}
        </div>

        <div class="metric">
          حد ضرر:
          \${formatValue(item.trade.stopLoss)}
        </div>

        <div class="metric">
          TP1:
          \${formatValue(item.trade.tp1)}
        </div>

        <div class="metric">
          TP2:
          \${formatValue(item.trade.tp2)}
        </div>

      </div>

    \` : ""}

  </div>
  \`;

}

async function loadData() {

  try {

    const response =
      await fetch(
        "/api/signals?t=" +
        Date.now()
      );

    const data =
      await response.json();

    if (
      !data.ok
    ) {

      document.getElementById(
        "content"
      ).innerHTML =
        \`
        <div class="card">
          خطا در دریافت اطلاعات
          <pre>\${esc(
            data.error || ""
          )}</pre>
        </div>
        \`;

      return;

    }

    const results =
      data.results || [];

    let html = "";

    results.forEach(
      (item,index) => {

        html += renderSymbol(
          item,
          index === 0
        );

      }
    );

    document.getElementById(
      "content"
    ).innerHTML = html;

    countdown = 60;

  } catch(error) {

    document.getElementById(
      "content"
    ).innerHTML =
      \`
      <div class="card">
        خطا در اتصال
        <pre>\${esc(
          error.message
        )}</pre>
      </div>
      \`;

  }

}

loadData();

setInterval(
  loadData,
  60000
);

setInterval(
  () => {

    countdown--;

    if (
      countdown < 0
    ) {
      countdown = 60;
    }

    document.getElementById(
      "count"
    ).textContent =
      countdown;

  },
  1000
);

</script>

</body>
</html>
`;

// ============================================================
// API SIGNALS
// NOTE:
// /api/signals DOES NOT SEND TELEGRAM.
// It only analyzes.
// ============================================================

async function apiSignals(env) {
  const results = [];

  const orderedSymbols = [
    CONFIG.primarySymbol,

    ...CONFIG.symbols.filter(
      s =>
        s !==
        CONFIG.primarySymbol
    )
  ];

  for (
    const symbol of orderedSymbols
  ) {
    try {
      const result =
        await analyzeSymbol(
          env,
          symbol
        );

      results.push(
        result
      );

    } catch (error) {

      results.push({
        symbol,
        signal: "ERROR",
        error:
          error.message
      });

    }

    await sleep(150);
  }

  return {
    ok: true,

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    generatedAt:
      new Date().toISOString(),

    results
  };
}

// ============================================================
// HEALTH
// ============================================================

function health(env) {
  return {
    ok: true,

    service:
      "FOREX SIGNAL ENGINE",

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    primarySymbol:
      CONFIG.primarySymbol,

    telegramConfigured:
      Boolean(
        getTelegramToken(env) &&
        getTelegramChatId(env)
      ),

    twelveDataConfigured:
      Boolean(
        getTwelveDataKey(env)
      ),

    time:
      new Date().toISOString()
  };
}

// ============================================================
// STATS
// ============================================================

function getStats() {
  return {
    ok: true,

    version:
      CONFIG.version,

    config: {
      primarySymbol:
        CONFIG.primarySymbol,

      minScore:
        CONFIG.minScore,

      minADX:
        CONFIG.minADX,

      minDISpread:
        CONFIG.minDISpread,

      minMomentum:
        CONFIG.minMomentum,

      cooldownMinutes:
        CONFIG.signalCooldownMinutes
    },

    runtime:
      runtimeStats
  };
}

// ============================================================
// WORKER FETCH
// ============================================================

export default {

  async fetch(request, env, ctx) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    // --------------------------------------------------------
    // HOME
    // --------------------------------------------------------

    if (
      path === "/" ||
      path === ""
    ) {

      return htmlResponse(
        DASHBOARD_HTML
      );

    }

    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (
      path === "/health"
    ) {

      return jsonResponse(
        health(env)
      );

    }

    // --------------------------------------------------------
    // STATS
    // --------------------------------------------------------

    if (
      path === "/api/stats"
    ) {

      return jsonResponse(
        getStats()
      );

    }

    // --------------------------------------------------------
    // API SIGNALS
    // --------------------------------------------------------

    if (
      path === "/api/signals"
    ) {

      try {

        const result =
          await apiSignals(
            env
          );

        return jsonResponse(
          result
        );

      } catch(error) {

        return jsonResponse(
          {
            ok: false,
            error:
              error.message
          },
          500
        );

      }

    }

    // --------------------------------------------------------
    // TELEGRAM TEST
    // --------------------------------------------------------

    if (
      path === "/telegram-test"
    ) {

      const result =
        await telegramTest(
          env
        );

      return jsonResponse(
        result,
        result.ok ? 200 : 500
      );

    }

    // --------------------------------------------------------
    // MANUAL RUN
    // This endpoint analyzes AND sends valid signals.
    // --------------------------------------------------------

    if (
      path === "/run"
    ) {

      try {

        const result =
          await runEngine(
            env
          );

        return jsonResponse(
          result
        );

      } catch(error) {

        return jsonResponse(
          {
            ok: false,
            error:
              error.message
          },
          500
        );

      }

    }

    // --------------------------------------------------------
    // 404
    // --------------------------------------------------------

    return jsonResponse(
      {
        ok: false,
        error: "Not Found",
        available: [
          "/",
          "/health",
          "/api/signals",
          "/api/stats",
          "/run",
          "/telegram-test"
        ]
      },
      404
    );
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
      runEngine(env)
    );

  }

};
