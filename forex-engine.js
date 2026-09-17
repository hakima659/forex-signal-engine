// ============================================================
// FOREX SIGNAL ENGINE V5.4 GOLD PRO
// Cloudflare Worker + Twelve Data + Telegram
// PRIMARY FOCUS: XAU/USD
//
// Features:
// - XAU/USD primary focus
// - 15m + 1h confirmation
// - Strict signal filtering
// - BUY / SELL
// - BUY LIMIT / SELL LIMIT guidance
// - ATR based SL / TP1 / TP2 / TP3
// - Telegram detailed alerts
// - 5-minute scheduled execution
// - Duplicate signal cooldown
// - Closed-candle analysis
//
// IMPORTANT:
// This engine does NOT guarantee profit.
// Score is an internal confirmation score, not a probability.
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

  // Strict filtering
  minScore: 85,
  strongScore: 92,
  eliteScore: 96,

  minADX: 25,
  minDISpread: 8,

  minMomentum: 0.15,

  breakoutLookback: 20,

  candleBodyMin: 0.50,

  // Risk management
  atrSLMultiplier: 0.70,

  tp1RiskReward: 1.50,
  tp2RiskReward: 2.50,
  tp3RiskReward: 3.50,

  // Limit order distance
  limitATRMultiplier: 0.25,

  signalCooldownMinutes: 30,

  // Only closed candles for technical analysis
  useClosedCandle: true,

  timezone: "UTC"
};


// ============================================================
// TELEGRAM / API HELPERS
// ============================================================

function getTelegramToken(env) {
  return (
    env.TELEGRAM_BOT_TOKEN ||
    env["توکن_ربات_تلگرام"] ||
    env.TELEGRAM_TOKEN ||
    ""
  );
}

function getTelegramChatId(env) {
  return (
    env.TELEGRAM_CHAT_ID ||
    env["شناسه_چت_تلگرام"] ||
    env["آیدی_چت_تلگرام"] ||
    env["TELEGRAM_CHATID"] ||
    env.TELEGRAM_CHATID ||
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
// IN-MEMORY TELEGRAM COOLDOWN
// ============================================================

const lastTelegramSignals = new Map();

function canSendTelegram(signal) {
  const previous = lastTelegramSignals.get(signal.symbol);

  if (!previous) return true;

  // Different direction = send immediately
  if (previous.signal !== signal.signal) {
    return true;
  }

  const elapsed = Date.now() - previous.timestamp;
  const cooldown =
    CONFIG.signalCooldownMinutes * 60 * 1000;

  return elapsed >= cooldown;
}

function markTelegramSent(signal) {
  lastTelegramSignals.set(signal.symbol, {
    signal: signal.signal,
    timestamp: Date.now()
  });
}


// ============================================================
// MAIN WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    const url = new URL(request.url);
    const path = url.pathname;

    try {

      if (request.method === "OPTIONS") {
        return corsResponse("", 204);
      }

      // Dashboard
      if (path === "/") {
        return htmlResponse(DASHBOARD_HTML);
      }

      // Health
      if (path === "/health") {
        return jsonResponse(
          await getHealth(env)
        );
      }

      // All signals
      if (path === "/api/signals") {

        const signals =
          await generateAllSignals(env);

        return jsonResponse({
          ok: true,
          version: CONFIG.version,
          engine: CONFIG.name,
          focus: CONFIG.primarySymbol,
          count: signals.length,
          signals,
          timestamp: new Date().toISOString()
        });
      }

      // Statistics
      if (path === "/api/stats") {

        return jsonResponse(
          await getStats(env)
        );
      }

      // Manual engine run
      if (path === "/run") {

        return jsonResponse(
          await runEngine(env)
        );
      }

      // Telegram test
      if (path === "/telegram-test") {

        return jsonResponse(
          await testTelegram(env)
        );
      }

      return jsonResponse({
        ok: false,
        error: "Not Found",
        path
      }, 404);

    } catch (error) {

      console.error(error);

      return jsonResponse({
        ok: false,
        error: error.message || String(error),
        version: CONFIG.version,
        timestamp: new Date().toISOString()
      }, 500);
    }
  },


  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runEngine(env).catch(error => {
        console.error(
          "Scheduled engine error:",
          error
        );
      })
    );
  }
};


// ============================================================
// ENGINE
// ============================================================

async function runEngine(env) {

  const started = Date.now();

  const signals =
    await generateAllSignals(env);

  const telegramResults = [];

  // XAU/USD first
  for (const signal of signals) {

    // Primary gold gets priority
    if (
      signal.symbol === CONFIG.primarySymbol ||
      signal.signal !== "WAIT"
    ) {

      const result =
        await processSignal(
          signal,
          env
        );

      telegramResults.push(result);
    }
  }

  return {
    ok: true,
    version: CONFIG.version,
    focus: CONFIG.primarySymbol,
    generated: signals.length,
    signals,
    telegram: telegramResults,
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString()
  };
}


// ============================================================
// GENERATE ALL
// ============================================================

async function generateAllSignals(env) {

  const orderedSymbols = [
    CONFIG.primarySymbol,
    ...CONFIG.symbols.filter(
      s => s !== CONFIG.primarySymbol
    )
  ];

  const settled =
    await Promise.allSettled(
      orderedSymbols.map(
        symbol => analyzeSymbol(
          symbol,
          env
        )
      )
    );

  return settled.map(
    (result, index) => {

      if (result.status === "fulfilled") {
        return result.value;
      }

      return {
        symbol: orderedSymbols[index],
        signal: "WAIT",
        strength: "WEAK",
        score: 0,
        error:
          result.reason?.message ||
          "Analysis failed"
      };
    }
  );
}


// ============================================================
// SYMBOL ANALYSIS
// ============================================================

async function analyzeSymbol(symbol, env) {

  const [candles15m, candles1h] =
    await Promise.all([

      getCandles(
        symbol,
        CONFIG.interval,
        CONFIG.outputsize15m,
        env
      ),

      getCandles(
        symbol,
        CONFIG.confirmationInterval,
        CONFIG.outputsize1h,
        env
      )
    ]);


  if (
    candles15m.length < 220 ||
    candles1h.length < 220
  ) {

    throw new Error(
      `Insufficient candle data for ${symbol}`
    );
  }


  // ----------------------------------------------------------
  // Latest/live candles
  // ----------------------------------------------------------

  const live15m =
    candles15m[candles15m.length - 1];

  const live1h =
    candles1h[candles1h.length - 1];


  // ----------------------------------------------------------
  // Closed candle analysis
  // ----------------------------------------------------------

  const analysis15m =
    CONFIG.useClosedCandle
      ? candles15m.slice(0, -1)
      : candles15m;

  const analysis1h =
    CONFIG.useClosedCandle
      ? candles1h.slice(0, -1)
      : candles1h;


  const indicators15m =
    calculateIndicators(
      analysis15m
    );

  const indicators1h =
    calculateIndicators(
      analysis1h
    );


  const trend15m =
    determineTrend(
      indicators15m
    );

  const trend1h =
    determineTrend(
      indicators1h
    );


  const candle =
    getCandleConfirmation(
      analysis15m
    );


  const breakout =
    detectBreakout(
      analysis15m,
      indicators15m.atr
    );


  const momentum =
    indicators15m.momentum;


  const scoreData =
    calculateSignalScore({
      indicators15m,
      indicators1h,
      trend15m,
      trend1h,
      candle,
      breakout,
      momentum
    });


  const score =
    scoreData.score;


  const signal =
    scoreToSignal({
      score,
      trend15m,
      trend1h,
      indicators15m,
      candle,
      breakout,
      scoreData
    });


  const strength =
    getStrength(score);


  const alignment =
    getAlignment(
      trend15m,
      trend1h
    );


  const trade =
    buildTradePlan({
      symbol,
      signal,
      price: live15m.close,
      indicators: indicators15m,
      candle,
      breakout
    });


  return {

    symbol,

    signal,

    strength,

    score,

    confidenceScore: score,

    price: round(
      live15m.close,
      symbol === "XAU/USD"
        ? 2
        : 5
    ),

    analysisPrice:
      round(
        analysis15m[
          analysis15m.length - 1
        ].close,
        symbol === "XAU/USD"
          ? 2
          : 5
      ),

    trend15m,
    trend1h,

    alignment,

    signalReady:
      signal === "BUY" ||
      signal === "SELL" ||
      signal === "BUY_LIMIT" ||
      signal === "SELL_LIMIT",

    closedCandle:
      CONFIG.useClosedCandle,

    indicators: {

      rsi: round(
        indicators15m.rsi,
        2
      ),

      macd: round(
        indicators15m.macd,
        4
      ),

      macdSignal: round(
        indicators15m.macdSignal,
        4
      ),

      macdHistogram: round(
        indicators15m.macdHistogram,
        4
      ),

      adx: round(
        indicators15m.adx,
        2
      ),

      plusDI: round(
        indicators15m.plusDI,
        2
      ),

      minusDI: round(
        indicators15m.minusDI,
        2
      ),

      diSpread: round(
        Math.abs(
          indicators15m.plusDI -
          indicators15m.minusDI
        ),
        2
      ),

      atr: round(
        indicators15m.atr,
        4
      ),

      momentum: round(
        indicators15m.momentum,
        3
      ),

      ema20: round(
        indicators15m.ema20,
        4
      ),

      ema50: round(
        indicators15m.ema50,
        4
      ),

      ema200: round(
        indicators15m.ema200,
        4
      )
    },

    candle,

    breakout,

    confirmations:
      scoreData.confirmations,

    reasons:
      scoreData.reasons,

    trade,

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// CANDLES
// ============================================================

async function getCandles(
  symbol,
  interval,
  outputsize,
  env
) {

  const apiKey =
    getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }


  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&format=JSON` +
    `&apikey=${encodeURIComponent(apiKey)}`;


  const response =
    await fetch(url);


  if (!response.ok) {

    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }


  const data =
    await response.json();


  if (data.status === "error") {

    throw new Error(
      data.message ||
      "Twelve Data error"
    );
  }


  if (!Array.isArray(data.values)) {

    throw new Error(
      `No candle data for ${symbol} ${interval}`
    );
  }


  return data.values
    .map(item => ({
      datetime:
        item.datetime,

      open:
        Number(item.open),

      high:
        Number(item.high),

      low:
        Number(item.low),

      close:
        Number(item.close),

      volume:
        Number(item.volume || 0)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}


// ============================================================
// INDICATORS
// ============================================================

function calculateIndicators(candles) {

  const closes =
    candles.map(c => c.close);

  const highs =
    candles.map(c => c.high);

  const lows =
    candles.map(c => c.low);


  const ema20Series =
    EMA_series(
      closes,
      20
    );

  const ema50Series =
    EMA_series(
      closes,
      50
    );

  const ema200Series =
    EMA_series(
      closes,
      200
    );


  const ema20 =
    last(ema20Series);

  const ema50 =
    last(ema50Series);

  const ema200 =
    last(ema200Series);


  const ema20Prev =
    valueAgo(
      ema20Series,
      5
    );

  const ema50Prev =
    valueAgo(
      ema50Series,
      5
    );


  const ema20Slope =
    percentChange(
      ema20Prev,
      ema20
    );

  const ema50Slope =
    percentChange(
      ema50Prev,
      ema50
    );


  const rsi =
    RSI(closes, 14);


  const macd =
    MACD(closes);


  const atr =
    ATR(candles, 14);


  const adxData =
    ADX(candles, 14);


  const momentum =
    calculateMomentum(
      closes,
      10
    );


  return {

    ema20,
    ema50,
    ema200,

    ema20Slope,
    ema50Slope,

    rsi,

    macd:
      macd.macd,

    macdSignal:
      macd.signal,

    macdHistogram:
      macd.histogram,

    macdHistogramPrev:
      macd.histogramPrev,

    atr,

    adx:
      adxData.adx,

    plusDI:
      adxData.plusDI,

    minusDI:
      adxData.minusDI,

    momentum
  };
}


// ============================================================
// EMA
// ============================================================

function EMA(values, period) {

  if (!values.length) return 0;

  const p =
    Math.min(
      period,
      values.length
    );

  const multiplier =
    2 / (p + 1);

  let ema =
    average(
      values.slice(0, p)
    );


  for (
    let i = p;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] - ema
      ) * multiplier + ema;
  }

  return ema;
}


function EMA_series(
  values,
  period
) {

  if (!values.length) return [];

  const p =
    Math.min(
      period,
      values.length
    );

  const multiplier =
    2 / (p + 1);

  const result =
    new Array(values.length)
      .fill(null);

  let ema =
    average(
      values.slice(0, p)
    );

  result[p - 1] = ema;


  for (
    let i = p;
    i < values.length;
    i++
  ) {

    ema =
      (
        values[i] - ema
      ) * multiplier + ema;

    result[i] = ema;
  }


  return result;
}


// ============================================================
// RSI
// ============================================================

function RSI(
  closes,
  period = 14
) {

  if (
    closes.length <
    period + 1
  ) {
    return 50;
  }


  let gains = 0;
  let losses = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      closes[i] -
      closes[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }


  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;


  for (
    let i = period + 1;
    i < closes.length;
    i++
  ) {

    const change =
      closes[i] -
      closes[i - 1];

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
        avgGain * (period - 1) +
        gain
      ) / period;


    avgLoss =
      (
        avgLoss * (period - 1) +
        loss
      ) / period;
  }


  if (avgLoss === 0) {
    return 100;
  }


  const rs =
    avgGain / avgLoss;


  return 100 -
    (100 / (1 + rs));
}


// ============================================================
// MACD
// ============================================================

function MACD(closes) {

  const ema12 =
    EMA_series(
      closes,
      12
    );

  const ema26 =
    EMA_series(
      closes,
      26
    );


  const macdSeries =
    closes.map(
      (_, i) => {

        if (
          ema12[i] == null ||
          ema26[i] == null
        ) {
          return null;
        }

        return (
          ema12[i] -
          ema26[i]
        );
      }
    );


  const valid =
    macdSeries.filter(
      v => v != null
    );


  const signalSeries =
    EMA_series(
      valid,
      9
    );


  const macd =
    last(valid) || 0;

  const signal =
    last(signalSeries) || 0;


  const prevMacd =
    valueAgo(
      valid,
      1
    ) || 0;

  const prevSignal =
    valueAgo(
      signalSeries,
      1
    ) || 0;


  return {

    macd,

    signal,

    histogram:
      macd - signal,

    histogramPrev:
      prevMacd - prevSignal
  };
}


// ============================================================
// ATR
// ============================================================

function ATR(
  candles,
  period = 14
) {

  if (
    candles.length <
    period + 1
  ) {
    return 0;
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


  let atr =
    average(
      trs.slice(0, period)
    );


  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    atr =
      (
        atr * (period - 1) +
        trs[i]
      ) / period;
  }


  return atr;
}


// ============================================================
// ADX / DI
// ============================================================

function ADX(
  candles,
  period = 14
) {

  if (
    candles.length <
    period * 2
  ) {

    return {
      adx: 0,
      plusDI: 0,
      minusDI: 0
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
      upMove > downMove &&
      upMove > 0
        ? upMove
        : 0
    );


    minusDM.push(
      downMove > upMove &&
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


  let smTR =
    average(
      tr.slice(0, period)
    );

  let smPlus =
    average(
      plusDM.slice(0, period)
    );

  let smMinus =
    average(
      minusDM.slice(0, period)
    );


  const dx = [];


  for (
    let i = period;
    i < tr.length;
    i++
  ) {

    if (i > period) {

      smTR =
        smTR -
        smTR / period +
        tr[i];

      smPlus =
        smPlus -
        smPlus / period +
        plusDM[i];

      smMinus =
        smMinus -
        smMinus / period +
        minusDM[i];
    }


    const plusDI =
      smTR === 0
        ? 0
        : 100 * smPlus / smTR;

    const minusDI =
      smTR === 0
        ? 0
        : 100 * smMinus / smTR;


    const sum =
      plusDI +
      minusDI;


    const currentDX =
      sum === 0
        ? 0
        : 100 *
          Math.abs(
            plusDI -
            minusDI
          ) /
          sum;


    dx.push({
      dx: currentDX,
      plusDI,
      minusDI
    });
  }


  if (!dx.length) {

    return {
      adx: 0,
      plusDI: 0,
      minusDI: 0
    };
  }


  let adx =
    average(
      dx
        .slice(
          0,
          Math.min(
            period,
            dx.length
          )
        )
        .map(x => x.dx)
    );


  for (
    let i = period;
    i < dx.length;
    i++
  ) {

    adx =
      (
        adx * (period - 1) +
        dx[i].dx
      ) / period;
  }


  const latest =
    last(dx);


  return {

    adx,

    plusDI:
      latest.plusDI,

    minusDI:
      latest.minusDI
  };
}


// ============================================================
// MOMENTUM
// ============================================================

function calculateMomentum(
  closes,
  period = 10
) {

  if (
    closes.length <= period
  ) {
    return 0;
  }


  const current =
    last(closes);

  const previous =
    closes[
      closes.length -
      1 -
      period
    ];


  if (!previous) return 0;


  return (
    (current - previous) /
    previous
  ) * 100;
}


// ============================================================
// TREND
// ============================================================

function determineTrend(
  indicators
) {

  let bullish = 0;
  let bearish = 0;


  // EMA structure
  if (
    indicators.ema20 >
    indicators.ema50 &&
    indicators.ema50 >
    indicators.ema200
  ) {
    bullish++;
  }


  if (
    indicators.ema20 <
    indicators.ema50 &&
    indicators.ema50 <
    indicators.ema200
  ) {
    bearish++;
  }


  // MACD
  if (
    indicators.macd >
      indicators.macdSignal &&
    indicators.macdHistogram > 0
  ) {
    bullish++;
  }


  if (
    indicators.macd <
      indicators.macdSignal &&
    indicators.macdHistogram < 0
  ) {
    bearish++;
  }


  // DI
  if (
    indicators.plusDI >
      indicators.minusDI &&
    (
      indicators.plusDI -
      indicators.minusDI
    ) >= 2
  ) {
    bullish++;
  }


  if (
    indicators.minusDI >
      indicators.plusDI &&
    (
      indicators.minusDI -
      indicators.plusDI
    ) >= 2
  ) {
    bearish++;
  }


  // EMA slope
  if (
    indicators.ema20Slope > 0 &&
    indicators.ema50Slope > 0
  ) {
    bullish++;
  }


  if (
    indicators.ema20Slope < 0 &&
    indicators.ema50Slope < 0
  ) {
    bearish++;
  }


  if (
    bullish >= 3 &&
    bullish > bearish
  ) {
    return "BULLISH";
  }


  if (
    bearish >= 3 &&
    bearish > bullish
  ) {
    return "BEARISH";
  }


  return "NEUTRAL";
}


// ============================================================
// CANDLE CONFIRMATION
// ============================================================

function getCandleConfirmation(
  candles
) {

  if (!candles.length) {

    return {
      direction: "NEUTRAL",
      bodyRatio: 0,
      closePosition: 0,
      confirmed: false
    };
  }


  const c =
    last(candles);


  const range =
    c.high - c.low;


  if (range <= 0) {

    return {
      direction: "NEUTRAL",
      bodyRatio: 0,
      closePosition: 0,
      confirmed: false
    };
  }


  const body =
    Math.abs(
      c.close -
      c.open
    );


  const bodyRatio =
    body / range;


  const closePosition =
    (
      c.close -
      c.low
    ) / range;


  const bullish =
    c.close > c.open &&
    bodyRatio >=
      CONFIG.candleBodyMin &&
    closePosition >= 0.65;


  const bearish =
    c.close < c.open &&
    bodyRatio >=
      CONFIG.candleBodyMin &&
    closePosition <= 0.35;


  return {

    direction:
      bullish
        ? "BULLISH"
        : bearish
        ? "BEARISH"
        : "NEUTRAL",

    bodyRatio:
      round(bodyRatio * 100, 1),

    closePosition:
      round(closePosition * 100, 1),

    confirmed:
      bullish || bearish
  };
}


// ============================================================
// BREAKOUT
// ============================================================

function detectBreakout(
  candles,
  atr
) {

  if (
    candles.length <
    CONFIG.breakoutLookback + 2
  ) {

    return {
      direction: "NONE",
      confirmed: false,
      distanceATR: 0
    };
  }


  const current =
    last(candles);


  const previous =
    candles.slice(
      -CONFIG.breakoutLookback - 1,
      -1
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


  const range =
    current.high -
    current.low;


  const body =
    Math.abs(
      current.close -
      current.open
    );


  const bodyRatio =
    range > 0
      ? body / range
      : 0;


  const bullishDistance =
    atr > 0
      ? (
          current.close -
          highest
        ) / atr
      : 0;


  const bearishDistance =
    atr > 0
      ? (
          lowest -
          current.close
        ) / atr
      : 0;


  const bullish =
    current.close >
      highest &&
    current.close >
      current.open &&
    bodyRatio >= 0.50 &&
    bullishDistance >= 0.10;


  const bearish =
    current.close <
      lowest &&
    current.close <
      current.open &&
    bodyRatio >= 0.50 &&
    bearishDistance >= 0.10;


  return {

    direction:
      bullish
        ? "BULLISH"
        : bearish
        ? "BEARISH"
        : "NONE",

    confirmed:
      bullish || bearish,

    distanceATR:
      round(
        bullish
          ? bullishDistance
          : bearish
          ? bearishDistance
          : 0,
        2
      ),

    high:
      round(highest, 5),

    low:
      round(lowest, 5)
  };
}


// ============================================================
// SCORE
// ============================================================

function calculateSignalScore({
  indicators15m,
  indicators1h,
  trend15m,
  trend1h,
  candle,
  breakout,
  momentum
}) {

  let bullish = 0;
  let bearish = 0;

  const confirmations = [];
  const reasons = [];


  // ----------------------------------------------------------
  // EMA structure = 15
  // ----------------------------------------------------------

  if (
    indicators15m.ema20 >
      indicators15m.ema50 &&
    indicators15m.ema50 >
      indicators15m.ema200
  ) {

    bullish += 15;

    confirmations.push(
      "EMA_BULLISH"
    );

    reasons.push(
      "ساختار EMA صعودی است"
    );

  } else if (
    indicators15m.ema20 <
      indicators15m.ema50 &&
    indicators15m.ema50 <
      indicators15m.ema200
  ) {

    bearish += 15;

    confirmations.push(
      "EMA_BEARISH"
    );

    reasons.push(
      "ساختار EMA نزولی است"
    );
  }


  // ----------------------------------------------------------
  // 1H trend = 20
  // ----------------------------------------------------------

  if (
    trend1h === "BULLISH"
  ) {

    bullish += 20;

    confirmations.push(
      "1H_BULLISH"
    );

    reasons.push(
      "روند 1 ساعته صعودی تأیید شده"
    );

  } else if (
    trend1h === "BEARISH"
  ) {

    bearish += 20;

    confirmations.push(
      "1H_BEARISH"
    );

    reasons.push(
      "روند 1 ساعته نزولی تأیید شده"
    );
  }


  // ----------------------------------------------------------
  // 15m trend = 10
  // ----------------------------------------------------------

  if (
    trend15m === "BULLISH"
  ) {

    bullish += 10;

    confirmations.push(
      "15M_BULLISH"
    );

  } else if (
    trend15m === "BEARISH"
  ) {

    bearish += 10;

    confirmations.push(
      "15M_BEARISH"
    );
  }


  // ----------------------------------------------------------
  // MACD = 15
  // ----------------------------------------------------------

  if (
    indicators15m.macd >
      indicators15m.macdSignal &&
    indicators15m.macdHistogram > 0
  ) {

    bullish += 15;

    confirmations.push(
      "MACD_BULLISH"
    );

    reasons.push(
      "MACD و Histogram صعودی هستند"
    );

  } else if (
    indicators15m.macd <
      indicators15m.macdSignal &&
    indicators15m.macdHistogram < 0
  ) {

    bearish += 15;

    confirmations.push(
      "MACD_BEARISH"
    );

    reasons.push(
      "MACD و Histogram نزولی هستند"
    );
  }


  // ----------------------------------------------------------
  // RSI = 10
  // ----------------------------------------------------------

  if (
    indicators15m.rsi >= 52 &&
    indicators15m.rsi <= 68
  ) {

    bullish += 10;

    confirmations.push(
      "RSI_BULLISH_ZONE"
    );

    reasons.push(
      "RSI در محدوده صعودی کنترل‌شده است"
    );

  } else if (
    indicators15m.rsi >= 32 &&
    indicators15m.rsi <= 48
  ) {

    bearish += 10;

    confirmations.push(
      "RSI_BEARISH_ZONE"
    );

    reasons.push(
      "RSI در محدوده نزولی کنترل‌شده است"
    );
  }


  // ----------------------------------------------------------
  // ADX + DI = 10
  // ----------------------------------------------------------

  const diSpread =
    Math.abs(
      indicators15m.plusDI -
      indicators15m.minusDI
    );


  if (
    indicators15m.adx >=
      CONFIG.minADX &&
    diSpread >=
      CONFIG.minDISpread
  ) {

    if (
      indicators15m.plusDI >
      indicators15m.minusDI
    ) {

      bullish += 10;

      confirmations.push(
        "ADX_DI_BULLISH"
      );

      reasons.push(
        "قدرت روند و فشار خریداران تأیید شده"
      );

    } else {

      bearish += 10;

      confirmations.push(
        "ADX_DI_BEARISH"
      );

      reasons.push(
        "قدرت روند و فشار فروشندگان تأیید شده"
      );
    }
  }


  // ----------------------------------------------------------
  // Momentum = 10
  // ----------------------------------------------------------

  if (
    momentum >=
    CONFIG.minMomentum
  ) {

    bullish += 10;

    confirmations.push(
      "MOMENTUM_BULLISH"
    );

    reasons.push(
      "مومنتوم صعودی تأیید شده"
    );

  } else if (
    momentum <=
    -CONFIG.minMomentum
  ) {

    bearish += 10;

    confirmations.push(
      "MOMENTUM_BEARISH"
    );

    reasons.push(
      "مومنتوم نزولی تأیید شده"
    );
  }


  // ----------------------------------------------------------
  // Breakout = 5
  // ----------------------------------------------------------

  if (
    breakout.direction ===
    "BULLISH" &&
    breakout.confirmed
  ) {

    bullish += 5;

    confirmations.push(
      "BREAKOUT_BULLISH"
    );

    reasons.push(
      "شکست صعودی تأیید شده"
    );

  } else if (
    breakout.direction ===
    "BEARISH" &&
    breakout.confirmed
  ) {

    bearish += 5;

    confirmations.push(
      "BREAKOUT_BEARISH"
    );

    reasons.push(
      "شکست نزولی تأیید شده"
    );
  }


  // ----------------------------------------------------------
  // Candle = 5
  // ----------------------------------------------------------

  if (
    candle.direction ===
    "BULLISH" &&
    candle.confirmed
  ) {

    bullish += 5;

    confirmations.push(
      "CANDLE_BULLISH"
    );

    reasons.push(
      "کندل بسته‌شده صعود را تأیید می‌کند"
    );

  } else if (
    candle.direction ===
    "BEARISH" &&
    candle.confirmed
  ) {

    bearish += 5;

    confirmations.push(
      "CANDLE_BEARISH"
    );

    reasons.push(
      "کندل بسته‌شده نزول را تأیید می‌کند"
    );
  }


  const rawScore =
    Math.max(
      bullish,
      bearish
    );


  const conflict =
    Math.min(
      bullish,
      bearish
    );


  // Conflict penalty
  const finalScore =
    Math.max(
      0,
      Math.min(
        100,
        rawScore -
        Math.floor(conflict * 0.50)
      )
    );


  return {

    score: finalScore,

    bullish,

    bearish,

    confirmations,

    reasons
  };
}


// ============================================================
// SIGNAL DECISION
// ============================================================

function scoreToSignal({
  score,
  trend15m,
  trend1h,
  indicators15m,
  candle,
  breakout
}) {

  // No 1H confirmation
  if (
    trend1h === "NEUTRAL"
  ) {
    return "WAIT";
  }


  // Opposite timeframes
  if (
    trend15m !== trend1h
  ) {
    return "WAIT";
  }


  // ADX gate
  if (
    indicators15m.adx <
    CONFIG.minADX
  ) {
    return "WAIT";
  }


  // DI gate
  const diSpread =
    Math.abs(
      indicators15m.plusDI -
      indicators15m.minusDI
    );


  if (
    diSpread <
    CONFIG.minDISpread
  ) {
    return "WAIT";
  }


  // Hard score gate
  if (
    score <
    CONFIG.minScore
  ) {
    return "WAIT";
  }


  // Candle confirmation
  if (
    !candle.confirmed
  ) {
    return "WAIT";
  }


  if (
    trend15m === "BULLISH" &&
    trend1h === "BULLISH"
  ) {

    // MACD
    if (
      !(
        indicators15m.macd >
        indicators15m.macdSignal &&
        indicators15m.macdHistogram > 0
      )
    ) {
      return "WAIT";
    }


    // Momentum
    if (
      indicators15m.momentum <
      CONFIG.minMomentum
    ) {
      return "WAIT";
    }


    if (
      candle.direction !==
      "BULLISH"
    ) {
      return "WAIT";
    }


    return "BUY";
  }


  if (
    trend15m === "BEARISH" &&
    trend1h === "BEARISH"
  ) {

    if (
      !(
        indicators15m.macd <
        indicators15m.macdSignal &&
        indicators15m.macdHistogram < 0
      )
    ) {
      return "WAIT";
    }


    if (
      indicators15m.momentum >
      -CONFIG.minMomentum
    ) {
      return "WAIT";
    }


    if (
      candle.direction !==
      "BEARISH"
    ) {
      return "WAIT";
    }


    return "SELL";
  }


  return "WAIT";
}


// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan({
  symbol,
  signal,
  price,
  indicators,
  candle,
  breakout
}) {

  if (
    signal !== "BUY" &&
    signal !== "SELL"
  ) {

    return {
      type: "NONE",
      entry: null,
      limitEntry: null,
      stopLoss: null,
      tp1: null,
      tp2: null,
      tp3: null,
      risk: null,
      riskReward: null
    };
  }


  const atr =
    indicators.atr;


  if (
    !atr ||
    !Number.isFinite(atr)
  ) {

    return {
      type: "NONE",
      entry: null,
      limitEntry: null,
      stopLoss: null,
      tp1: null,
      tp2: null,
      tp3: null,
      risk: null,
      riskReward: null
    };
  }


  const slDistance =
    atr *
    CONFIG.atrSLMultiplier;


  const limitDistance =
    atr *
    CONFIG.limitATRMultiplier;


  let entry =
    price;

  let limitEntry;

  let stopLoss;

  let tp1;

  let tp2;

  let tp3;


  if (
    signal === "BUY"
  ) {

    stopLoss =
      entry -
      slDistance;


    tp1 =
      entry +
      slDistance *
      CONFIG.tp1RiskReward;


    tp2 =
      entry +
      slDistance *
      CONFIG.tp2RiskReward;


    tp3 =
      entry +
      slDistance *
      CONFIG.tp3RiskReward;


    limitEntry =
      entry -
      limitDistance;

  } else {

    stopLoss =
      entry +
      slDistance;


    tp1 =
      entry -
      slDistance *
      CONFIG.tp1RiskReward;


    tp2 =
      entry -
      slDistance *
      CONFIG.tp2RiskReward;


    tp3 =
      entry -
      slDistance *
      CONFIG.tp3RiskReward;


    limitEntry =
      entry +
      limitDistance;
  }


  const decimals =
    symbol === "XAU/USD"
      ? 2
      : 5;


  return {

    type:
      signal === "BUY"
        ? "BUY / BUY LIMIT"
        : "SELL / SELL LIMIT",

    entry:
      round(entry, decimals),

    limitEntry:
      round(
        limitEntry,
        decimals
      ),

    stopLoss:
      round(
        stopLoss,
        decimals
      ),

    tp1:
      round(
        tp1,
        decimals
      ),

    tp2:
      round(
        tp2,
        decimals
      ),

    tp3:
      round(
        tp3,
        decimals
      ),

    risk:
      round(
        slDistance,
        decimals
      ),

    riskReward: {

      tp1:
        `1:${CONFIG.tp1RiskReward}`,

      tp2:
        `1:${CONFIG.tp2RiskReward}`,

      tp3:
        `1:${CONFIG.tp3RiskReward}`
    },

    atr:
      round(
        atr,
        decimals
      )
  };
}


// ============================================================
// STRENGTH
// ============================================================

function getStrength(score) {

  if (
    score >=
    CONFIG.eliteScore
  ) {
    return "ELITE";
  }

  if (
    score >=
    CONFIG.strongScore
  ) {
    return "STRONG";
  }

  if (
    score >=
    CONFIG.minScore
  ) {
    return "CONFIRMED";
  }

  return "WEAK";
}


// ============================================================
// ALIGNMENT
// ============================================================

function getAlignment(
  trend15m,
  trend1h
) {

  if (
    trend15m ===
      trend1h &&
    trend15m !==
      "NEUTRAL"
  ) {
    return "CONFIRMED";
  }


  if (
    trend15m !==
      "NEUTRAL" &&
    trend1h !==
      "NEUTRAL" &&
    trend15m !==
      trend1h
  ) {
    return "OPPOSED";
  }


  return "MIXED";
}


// ============================================================
// TELEGRAM PROCESS
// ============================================================

async function processSignal(
  signal,
  env
) {

  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {

    return {

      symbol:
        signal.symbol,

      sent: false,

      reason:
        "WAIT"
    };
  }


  const token =
    getTelegramToken(env);


  const chatId =
    getTelegramChatId(env);


  if (!token) {

    return {

      symbol:
        signal.symbol,

      sent: false,

      error:
        "Telegram bot token missing"
    };
  }


  if (!chatId) {

    return {

      symbol:
        signal.symbol,

      sent: false,

      error:
        "Telegram Chat ID missing"
    };
  }


  if (
    !canSendTelegram(
      signal
    )
  ) {

    return {

      symbol:
        signal.symbol,

      sent: false,

      reason:
        "Cooldown active"
    };
  }


  const message =
    formatTelegramMessage(
      signal
    );


  const result =
    await sendTelegram(
      message,
      env
    );


  if (result.ok) {

    markTelegramSent(
      signal
    );
  }


  return {

    symbol:
      signal.symbol,

    sent:
      result.ok,

    telegram:
      result
  };
}


// ============================================================
// TELEGRAM MESSAGE
// ============================================================

function formatTelegramMessage(
  signal
) {

  const isGold =
    signal.symbol ===
    CONFIG.primarySymbol;


  const emoji =
    signal.signal === "BUY"
      ? "🟢"
      : "🔴";


  const direction =
    signal.signal === "BUY"
      ? "خرید"
      : "فروش";


  const strength =
    signal.strength ===
    "ELITE"
      ? "🔥 ELITE"
      : signal.strength ===
        "STRONG"
      ? "💪 STRONG"
      : "✅ CONFIRMED";


  const i =
    signal.indicators;


  const t =
    signal.trade;


  const reasons =
    signal.reasons
      .slice(0, 8)
      .map(
        x => `• ${x}`
      )
      .join("\n");


  let message =

`${emoji} ${isGold ? "🥇 GOLD PRO" : "FOREX SIGNAL"}

📌 نماد: ${signal.symbol}

📢 سیگنال: ${signal.signal} — ${direction}

💪 قدرت: ${strength}

📊 امتیاز: ${signal.score}/100

💰 قیمت فعلی:
${signal.price}

━━━━━━━━━━━━━━

📍 ENTRY:
${t.entry}

📌 ${signal.signal === "BUY"
  ? "BUY LIMIT"
  : "SELL LIMIT"}:
${t.limitEntry}

🛡 STOP LOSS:
${t.stopLoss}

🎯 TP1:
${t.tp1}

🎯 TP2:
${t.tp2}

🎯 TP3:
${t.tp3}

📐 R:R
TP1 = ${t.riskReward.tp1}
TP2 = ${t.riskReward.tp2}
TP3 = ${t.riskReward.tp3}

━━━━━━━━━━━━━━

📈 تأیید تکنیکال

⏱ 15M:
${signal.trend15m}

⏱ 1H:
${signal.trend1h}

🔗 Alignment:
${signal.alignment}

RSI: ${i.rsi}

MACD: ${i.macd}
MACD Signal: ${i.macdSignal}

ADX: ${i.adx}

+DI: ${i.plusDI}
-DI: ${i.minusDI}

DI Spread:
${i.diSpread}

ATR:
${i.atr}

Momentum:
${i.momentum}%

💥 Breakout:
${signal.breakout.direction}

🕯 Candle:
${signal.candle.direction}

━━━━━━━━━━━━━━

📝 دلیل صدور:

${reasons}

━━━━━━━━━━━━━━

🤖 موتور:
Forex Signal Engine ${CONFIG.version}

⚠️ امتیاز و سیگنال موتور تضمین سود یا احتمال قطعی موفقیت نیستند.
`;

  return message;
}


// ============================================================
// SEND TELEGRAM
// ============================================================

async function sendTelegram(
  message,
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
        "Telegram token missing"
    };
  }


  if (!chatId) {

    return {
      ok: false,
      error:
        "Telegram Chat ID missing"
    };
  }


  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;


  const response =
    await fetch(url, {

      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({

        chat_id:
          chatId,

        text:
          message,

        disable_web_page_preview:
          true
      })
    });


  const data =
    await response.json();


  if (!response.ok) {

    return {

      ok: false,

      status:
        response.status,

      error:
        data?.description ||
        "Telegram HTTP error"
    };
  }


  if (!data.ok) {

    return {

      ok: false,

      error:
        data.description ||
        "Telegram API error"
    };
  }


  return {

    ok: true,

    messageId:
      data.result?.message_id
  };
}


// ============================================================
// TELEGRAM TEST
// ============================================================

async function testTelegram(
  env
) {

  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);


  if (!token) {

    return {

      ok: false,

      telegram: false,

      error:
        "Telegram token missing"
    };
  }


  if (!chatId) {

    return {

      ok: false,

      telegram: false,

      error:
        "Telegram Chat ID missing"
    };
  }


  const message =

`🧪 تست Telegram

🤖 Forex Signal Engine ${CONFIG.version}

🥇 Gold Focus: XAU/USD

✅ اتصال Telegram فعال است.

⏱ ${new Date().toISOString()}`;


  const result =
    await sendTelegram(
      message,
      env
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
// HEALTH
// ============================================================

async function getHealth(env) {

  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  const twelveKey =
    getTwelveDataKey(env);


  let twelveData =
    false;


  let twelveError =
    null;


  if (twelveKey) {

    try {

      await getCandles(
        CONFIG.primarySymbol,
        "15min",
        5,
        env
      );

      twelveData = true;

    } catch (error) {

      twelveError =
        error.message;
    }
  }


  return {

    ok: true,

    version:
      CONFIG.version,

    engine:
      CONFIG.name,

    focus:
      CONFIG.primarySymbol,

    telegram: {

      token:
        Boolean(token),

      chatId:
        Boolean(chatId)
    },

    twelveData: {

      key:
        Boolean(twelveKey),

      connected:
        twelveData,

      error:
        twelveError
    },

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// STATS
// ============================================================

async function getStats(env) {

  return {

    ok: true,

    version:
      CONFIG.version,

    engine:
      CONFIG.name,

    primarySymbol:
      CONFIG.primarySymbol,

    symbols:
      CONFIG.symbols,

    timeframes: {

      primary:
        CONFIG.interval,

      confirmation:
        CONFIG.confirmationInterval
    },

    filters: {

      minScore:
        CONFIG.minScore,

      strongScore:
        CONFIG.strongScore,

      eliteScore:
        CONFIG.eliteScore,

      minADX:
        CONFIG.minADX,

      minDISpread:
        CONFIG.minDISpread,

      minMomentum:
        CONFIG.minMomentum
    },

    risk: {

      atrSLMultiplier:
        CONFIG.atrSLMultiplier,

      tp1:
        CONFIG.tp1RiskReward,

      tp2:
        CONFIG.tp2RiskReward,

      tp3:
        CONFIG.tp3RiskReward
    },

    telegramConfigured:
      Boolean(
        getTelegramToken(env)
      ) &&
      Boolean(
        getTelegramChatId(env)
      ),

    timestamp:
      new Date().toISOString()
  };
}


// ============================================================
// MATH HELPERS
// ============================================================

function average(values) {

  const valid =
    values.filter(
      Number.isFinite
    );

  if (!valid.length) {
    return 0;
  }

  return (
    valid.reduce(
      (a, b) => a + b,
      0
    ) /
    valid.length
  );
}


function last(array) {

  return array[
    array.length - 1
  ];
}


function valueAgo(
  array,
  ago
) {

  const index =
    array.length -
    1 -
    ago;

  if (index < 0) {
    return 0;
  }

  return array[index];
}


function percentChange(
  oldValue,
  newValue
) {

  if (
    !Number.isFinite(oldValue) ||
    oldValue === 0
  ) {
    return 0;
  }

  return (
    (newValue - oldValue) /
    Math.abs(oldValue)
  ) * 100;
}


function round(
  value,
  decimals = 2
) {

  if (
    !Number.isFinite(value)
  ) {
    return 0;
  }

  const factor =
    10 ** decimals;

  return (
    Math.round(
      value * factor
    ) / factor
  );
}


// ============================================================
// HTTP HELPERS
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

        "Content-Type":
          "application/json; charset=UTF-8",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "*"
      }
    }
  );
}


function htmlResponse(
  html
) {

  return new Response(
    html,
    {

      status: 200,

      headers: {

        "Content-Type":
          "text/html; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


function corsResponse(
  body,
  status = 200
) {

  return new Response(
    body,
    {

      status,

      headers: {

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS",

        "Access-Control-Allow-Headers":
          "*"
      }
    }
  );
}


// ============================================================
// DASHBOARD
// ============================================================

const DASHBOARD_HTML = `<!DOCTYPE html>

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

  font-family:
    Tahoma,
    Arial,
    sans-serif;

  background:
    #090d16;

  color:
    #f3f5f7;
}

.container {

  max-width:
    1100px;

  margin:
    auto;

  padding:
    18px;
}

.header {

  background:
    linear-gradient(
      135deg,
      #111827,
      #172033
    );

  border:
    1px solid #263247;

  border-radius:
    18px;

  padding:
    20px;

  margin-bottom:
    15px;
}

.title {

  font-size:
    22px;

  font-weight:
    800;
}

.subtitle {

  color:
    #aab4c5;

  margin-top:
    7px;
}

.live {

  display:
    inline-block;

  margin-top:
    12px;

  padding:
    6px 10px;

  border-radius:
    10px;

  background:
    #12251d;

  color:
    #55e69b;

  font-size:
    12px;
}

.card {

  background:
    #111827;

  border:
    1px solid #263247;

  border-radius:
    18px;

  padding:
    18px;

  margin-bottom:
    15px;
}

.gold {

  border-color:
    #a77b18;

  box-shadow:
    0 0 30px
    rgba(255,190,0,.06);
}

.symbol {

  font-size:
    24px;

  font-weight:
    900;
}

.price {

  font-size:
    30px;

  font-weight:
    900;

  margin:
    8px 0;
}

.signal {

  font-size:
    19px;

  font-weight:
    900;
}

.wait {

  color:
    #f5c451;
}

.buy {

  color:
    #42e695;
}

.sell {

  color:
    #ff6868;
}

.grid {

  display:
    grid;

  grid-template-columns:
    repeat(
      auto-fit,
      minmax(
        150px,
        1fr
      )
    );

  gap:
    10px;
}

.metric {

  background:
    #0c1220;

  border-radius:
    12px;

  padding:
    12px;
}

.metric-name {

  color:
    #8e9bb0;

  font-size:
    12px;
}

.metric-value {

  font-size:
    17px;

  font-weight:
    800;

  margin-top:
    5px;
}

.score {

  height:
    13px;

  background:
    #252d3b;

  border-radius:
    20px;

  overflow:
    hidden;

  margin-top:
    10px;
}

.scorebar {

  height:
    100%;

  background:
    linear-gradient(
      90deg,
      #eab308,
      #22c55e
    );

  width:
    0%;
}

.trade {

  border:
    1px solid #324057;

  border-radius:
    14px;

  padding:
    14px;

  margin-top:
    15px;
}

.trade-row {

  display:
    flex;

  justify-content:
    space-between;

  padding:
    7px 0;

  border-bottom:
    1px solid #202a3a;
}

.trade-row:last-child {
  border-bottom: 0;
}

.refresh {

  color:
    #8e9bb0;

  text-align:
    center;

  margin:
    20px 0;
}

.small {

  font-size:
    12px;

  color:
    #7f8ba0;
}

</style>

</head>

<body>

<div class="container">

  <div class="header">

    <div class="title">
      🥇 موتور سیگنال فارکس V5.4 · Gold Pro
    </div>

    <div class="subtitle">
      تمرکز اصلی: XAU/USD · تحلیل 15M + تأیید 1H
    </div>

    <div class="live">
      ● زنده — بررسی مکرر بازار
    </div>

  </div>


  <div id="gold"></div>

  <div class="card">

    <div class="symbol">
      سایر نمادها
    </div>

    <div
      id="others"
      class="grid"
      style="margin-top:12px"
    ></div>

  </div>


  <div class="refresh">
    بروزرسانی خودکار:
    <span id="timer">60</span>
    ثانیه
  </div>

</div>


<script>

let countdown = 60;


function money(
  value,
  symbol
) {

  if (
    value === null ||
    value === undefined
  ) {
    return "-";
  }

  return Number(value)
    .toFixed(
      symbol === "XAU/USD"
        ? 2
        : 5
    );
}


function signalClass(
  signal
) {

  if (
    signal === "BUY"
  ) {
    return "buy";
  }

  if (
    signal === "SELL"
  ) {
    return "sell";
  }

  return "wait";
}


function strengthText(
  strength
) {

  if (
    strength === "ELITE"
  ) {
    return "🔥 فوق‌قوی";
  }

  if (
    strength === "STRONG"
  ) {
    return "💪 قوی";
  }

  if (
    strength === "CONFIRMED"
  ) {
    return "✅ تأییدشده";
  }

  return "ضعیف";
}


function renderGold(
  s
) {

  const i =
    s.indicators || {};

  const t =
    s.trade || {};


  document.getElementById(
    "gold"
  ).innerHTML = `

  <div class="card gold">

    <div class="symbol">
      🥇 ${s.symbol}
    </div>

    <div class="price">
      ${money(
        s.price,
        s.symbol
      )}
    </div>

    <div class="signal ${signalClass(s.signal)}">
      ${s.signal === "BUY"
        ? "🟢 BUY · خرید"
        : s.signal === "SELL"
        ? "🔴 SELL · فروش"
        : "⏳ صبر کن"} ·
      ${strengthText(s.strength)}
    </div>


    <div class="grid"
         style="margin-top:15px">

      <div class="metric">

        <div class="metric-name">
          روند 15 دقیقه
        </div>

        <div class="metric-value">
          ${s.trend15m}
        </div>

      </div>


      <div class="metric">

        <div class="metric-name">
          روند 1 ساعت
        </div>

        <div class="metric-value">
          ${s.trend1h}
        </div>

      </div>


      <div class="metric">

        <div class="metric-name">
          هم‌راستایی
        </div>

        <div class="metric-value">
          ${s.alignment}
        </div>

      </div>


      <div class="metric">

        <div class="metric-name">
          امتیاز
        </div>

        <div class="metric-value">
          ${s.score}/100
        </div>

      </div>

    </div>


    <div class="score">

      <div
        class="scorebar"
        style="width:${Math.min(
          100,
          s.score || 0
        )}%"
      ></div>

    </div>


    <div class="grid"
         style="margin-top:12px">

      <div class="metric">
        <div class="metric-name">
          RSI 14
        </div>
        <div class="metric-value">
          ${i.rsi ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          MACD
        </div>
        <div class="metric-value">
          ${i.macd ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          ADX 14
        </div>
        <div class="metric-value">
          ${i.adx ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          +DI
        </div>
        <div class="metric-value">
          ${i.plusDI ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          -DI
        </div>
        <div class="metric-value">
          ${i.minusDI ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          ATR 14
        </div>
        <div class="metric-value">
          ${i.atr ?? "-"}
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          Momentum
        </div>
        <div class="metric-value">
          ${i.momentum ?? "-"}%
        </div>
      </div>


      <div class="metric">
        <div class="metric-name">
          Breakout
        </div>
        <div class="metric-value">
          ${s.breakout?.direction ?? "NONE"}
        </div>
      </div>

    </div>


    ${
      s.signal === "BUY" ||
      s.signal === "SELL"

      ? `

      <div class="trade">

        <strong>
          📌 Trade Plan
        </strong>


        <div class="trade-row">
          <span>Entry</span>
          <strong>${t.entry}</strong>
        </div>


        <div class="trade-row">
          <span>
            ${s.signal === "BUY"
              ? "BUY LIMIT"
              : "SELL LIMIT"}
          </span>

          <strong>
            ${t.limitEntry}
          </strong>
        </div>


        <div class="trade-row">
          <span>Stop Loss</span>
          <strong>${t.stopLoss}</strong>
        </div>


        <div class="trade-row">
          <span>TP1</span>
          <strong>${t.tp1}</strong>
        </div>


        <div class="trade-row">
          <span>TP2</span>
          <strong>${t.tp2}</strong>
        </div>


        <div class="trade-row">
          <span>TP3</span>
          <strong>${t.tp3}</strong>
        </div>


        <div class="trade-row">
          <span>Risk / Reward</span>

          <strong>
            ${t.riskReward?.tp2 || "-"}
          </strong>
        </div>

      </div>

      `

      : `

      <div class="trade">

        <strong>
          ⏳ سیگنال هنوز تأیید نشده
        </strong>

        <div class="small"
             style="margin-top:8px">

          موتور فقط در صورت تکمیل فیلترهای
          15M + 1H + ADX + DI + MACD +
          Momentum + Candle سیگنال می‌دهد.

        </div>

      </div>

      `
    }


    <div class="small"
         style="margin-top:12px">

      کندل بسته‌شده:
      ${s.closedCandle
        ? "فعال"
        : "غیرفعال"}

      ·
      سیگنال آماده:
      ${s.signalReady
        ? "بله"
        : "خیر"}

    </div>

  </div>
  `;
}


function renderOthers(
  signals
) {

  const others =
    signals.filter(
      s =>
        s.symbol !==
        "XAU/USD"
    );


  document.getElementById(
    "others"
  ).innerHTML =
    others.map(
      s => `

      <div class="metric">

        <div
          style="font-weight:800"
        >
          ${s.symbol}
        </div>

        <div
          class="${signalClass(s.signal)}"
          style="margin-top:7px"
        >
          ${s.signal}
        </div>

        <div
          style="margin-top:6px"
        >
          امتیاز:
          ${s.score ?? 0}
        </div>

        <div
          class="small"
          style="margin-top:5px"
        >
          RSI:
          ${s.indicators?.rsi ?? "-"}
        </div>

        <div
          class="small"
          style="margin-top:4px"
        >
          ${s.trend15m || "NEUTRAL"}
        </div>

      </div>

      `
    ).join("");
}


async function loadData() {

  try {

    const response =
      await fetch(
        "/api/signals?ts=" +
        Date.now()
      );


    const data =
      await response.json();


    if (
      !data.ok
    ) {
      throw new Error(
        "API error"
      );
    }


    const gold =
      data.signals.find(
        s =>
          s.symbol ===
          "XAU/USD"
      );


    if (gold) {
      renderGold(gold);
    }


    renderOthers(
      data.signals
    );


    countdown = 60;


  } catch (error) {

    document.getElementById(
      "gold"
    ).innerHTML = `

      <div class="card">

        <div class="sell">
          خطا در دریافت اطلاعات
        </div>

        <div class="small"
             style="margin-top:8px">

          ${error.message}

        </div>

      </div>

    `;
  }
}


loadData();


setInterval(
  () => {

    countdown--;

    if (
      countdown <= 0
    ) {

      loadData();

    }

    document.getElementById(
      "timer"
    ).textContent =
      countdown;

  },
  1000
);

</script>

</body>

</html>`;
