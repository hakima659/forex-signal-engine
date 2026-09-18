// ============================================================
// FOREX SIGNAL ENGINE V6.0
// GOLD PRIORITY — XAU/USD
// Cloudflare Worker + Twelve Data + Telegram
//
// TIMEFRAMES:
// - 15M
// - 1H
//
// FEATURES:
// - XAU/USD primary focus
// - 15M + 1H trend confirmation
// - EMA 20 / 50
// - RSI 14
// - MACD
// - ADX / DI
// - ATR
// - Momentum
// - Market Structure
// - BOS / CHoCH approximation
// - Liquidity Sweep
// - Breakout / Retest
// - Pullback
// - Risk / Reward
// - Strict scoring
// - Conservative news blackout windows
// - BUY LIMIT / SELL LIMIT
// - WAIT when conditions are weak
// - Telegram
// - No weak signal generation
// ============================================================

const CONFIG = {
  SYMBOL: "XAU/USD",

  INTERVAL_FAST: "15min",
  INTERVAL_SLOW: "1h",

  OUTPUT_SIZE_FAST: 120,
  OUTPUT_SIZE_SLOW: 120,

  MIN_SCORE: 80,

  MIN_RR: 1.30,

  ATR_SL_MULTIPLIER: 1.20,

  ATR_ENTRY_MULTIPLIER: 0.90,

  NEWS_BEFORE_MINUTES: 45,
  NEWS_AFTER_MINUTES: 30,

  TELEGRAM_ENABLED: true,

  // اگر خبر فیلتر باشد، سیگنال جدید ساخته نمی‌شود.
  NEWS_FILTER_ENABLED: true
};

// ============================================================
// MAIN
// ============================================================

export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // ----------------------------------------------------------
    // CORS
    // ----------------------------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    // ----------------------------------------------------------
    // API
    // ----------------------------------------------------------

    if (url.pathname === "/api/signals") {

      try {

        const result =
          await buildGoldSignal(env);

        return jsonResponse(
          result,
          200
        );

      } catch (error) {

        console.error(
          "ENGINE ERROR:",
          error
        );

        return jsonResponse(
          {
            status: "error",
            message: "Signal engine error",
            error: String(error)
          },
          500
        );
      }
    }

    // ----------------------------------------------------------
    // HEALTH
    // ----------------------------------------------------------

    if (url.pathname === "/health") {

      return jsonResponse({
        status: "ok",
        engine: "Hakim Gold Signal Engine V6.0",
        symbol: CONFIG.SYMBOL,
        timestamp: new Date().toISOString()
      });
    }

    // ----------------------------------------------------------
    // HOME
    // ----------------------------------------------------------

    return new Response(
      renderHomepage(),
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8"
        }
      }
    );
  }
};


// ============================================================
// GOLD ENGINE
// ============================================================

async function buildGoldSignal(env) {

  if (!env.TWELVE_DATA_API_KEY) {

    throw new Error(
      "TWELVE_DATA_API_KEY secret is missing."
    );
  }

  // ----------------------------------------------------------
  // NEWS FILTER
  // ----------------------------------------------------------

  const news =
    getNewsFilter();

  // ----------------------------------------------------------
  // GET DATA
  // ----------------------------------------------------------

  const fast =
    await getTimeSeries(
      env,
      CONFIG.SYMBOL,
      CONFIG.INTERVAL_FAST,
      CONFIG.OUTPUT_SIZE_FAST
    );

  const slow =
    await getTimeSeries(
      env,
      CONFIG.SYMBOL,
      CONFIG.INTERVAL_SLOW,
      CONFIG.OUTPUT_SIZE_SLOW
    );

  if (
    !fast ||
    !slow ||
    fast.length < 60 ||
    slow.length < 60
  ) {

    return {
      status: "ok",
      symbol: CONFIG.SYMBOL,
      price: null,
      signal: "WAIT",
      score: 0,
      reason:
        "Insufficient market data",
      newsFilter: news
    };
  }

  // ----------------------------------------------------------
  // CURRENT PRICE
  // ----------------------------------------------------------

  const price =
    Number(
      fast[0].close
    );

  // ----------------------------------------------------------
  // INDICATORS — 15M
  // ----------------------------------------------------------

  const fastCloses =
    fast.map(
      x => Number(x.close)
    );

  const fastHighs =
    fast.map(
      x => Number(x.high)
    );

  const fastLows =
    fast.map(
      x => Number(x.low)
    );

  const rsi15 =
    calculateRSI(
      fastCloses,
      14
    );

  const ema20_15 =
    calculateEMA(
      fastCloses,
      20
    );

  const ema50_15 =
    calculateEMA(
      fastCloses,
      50
    );

  const macd15 =
    calculateMACD(
      fastCloses
    );

  const adx15 =
    calculateADX(
      fast,
      14
    );

  const atr15 =
    calculateATR(
      fast,
      14
    );

  const momentum15 =
    calculateMomentum(
      fastCloses,
      10
    );

  // ----------------------------------------------------------
  // INDICATORS — 1H
  // ----------------------------------------------------------

  const slowCloses =
    slow.map(
      x => Number(x.close)
    );

  const slowHighs =
    slow.map(
      x => Number(x.high)
    );

  const slowLows =
    slow.map(
      x => Number(x.low)
    );

  const ema20_1h =
    calculateEMA(
      slowCloses,
      20
    );

  const ema50_1h =
    calculateEMA(
      slowCloses,
      50
    );

  const rsi1h =
    calculateRSI(
      slowCloses,
      14
    );

  const adx1h =
    calculateADX(
      slow,
      14
    );

  // ----------------------------------------------------------
  // TREND
  // ----------------------------------------------------------

  const trend15 =
    getTrend(
      price,
      ema20_15,
      ema50_15
    );

  const trend1h =
    getTrend(
      slowCloses[0],
      ema20_1h,
      ema50_1h
    );

  // ----------------------------------------------------------
  // MARKET STRUCTURE
  // ----------------------------------------------------------

  const structure15 =
    detectStructure(
      fastHighs,
      fastLows,
      fastCloses
    );

  const structure1h =
    detectStructure(
      slowHighs,
      slowLows,
      slowCloses
    );

  // ----------------------------------------------------------
  // BOS / CHOCH
  // ----------------------------------------------------------

  const bos15 =
    detectBOS(
      fast
    );

  const bos1h =
    detectBOS(
      slow
    );

  const choch15 =
    detectCHoCH(
      fast
    );

  const choch1h =
    detectCHoCH(
      slow
    );

  // ----------------------------------------------------------
  // LIQUIDITY SWEEP
  // ----------------------------------------------------------

  const liquidity =
    detectLiquiditySweep(
      fast
    );

  // ----------------------------------------------------------
  // BREAKOUT
  // ----------------------------------------------------------

  const breakout =
    detectBreakout(
      fast
    );

  // ----------------------------------------------------------
  // RETEST
  // ----------------------------------------------------------

  const retest =
    detectRetest(
      fast
    );

  // ----------------------------------------------------------
  // PULLBACK
  // ----------------------------------------------------------

  const pullback =
    detectPullback(
      fast,
      ema20_15
    );

  // ----------------------------------------------------------
  // SCORING
  // ----------------------------------------------------------

  let buyScore = 0;
  let sellScore = 0;

  const reasonsBuy = [];
  const reasonsSell = [];

  // ----------------------------------------------------------
  // 1H TREND
  // ----------------------------------------------------------

  if (trend1h === "BULLISH") {

    buyScore += 20;

    reasonsBuy.push(
      "1H bullish trend"
    );

  } else if (trend1h === "BEARISH") {

    sellScore += 20;

    reasonsSell.push(
      "1H bearish trend"
    );
  }

  // ----------------------------------------------------------
  // 15M TREND
  // ----------------------------------------------------------

  if (trend15 === "BULLISH") {

    buyScore += 15;

    reasonsBuy.push(
      "15M bullish trend"
    );

  } else if (trend15 === "BEARISH") {

    sellScore += 15;

    reasonsSell.push(
      "15M bearish trend"
    );
  }

  // ----------------------------------------------------------
  // EMA ALIGNMENT
  // ----------------------------------------------------------

  if (
    ema20_15 > ema50_15 &&
    ema20_1h > ema50_1h
  ) {

    buyScore += 10;

    reasonsBuy.push(
      "EMA alignment bullish"
    );

  } else if (
    ema20_15 < ema50_15 &&
    ema20_1h < ema50_1h
  ) {

    sellScore += 10;

    reasonsSell.push(
      "EMA alignment bearish"
    );
  }

  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  if (
    rsi15 >= 50 &&
    rsi15 <= 68 &&
    rsi1h >= 50 &&
    rsi1h <= 70
  ) {

    buyScore += 8;

    reasonsBuy.push(
      "RSI bullish zone"
    );
  }

  if (
    rsi15 <= 50 &&
    rsi15 >= 32 &&
    rsi1h <= 50 &&
    rsi1h >= 30
  ) {

    sellScore += 8;

    reasonsSell.push(
      "RSI bearish zone"
    );
  }

  // جلوگیری از خرید در اشباع شدید
  if (rsi15 > 72) {

    buyScore -= 10;

    reasonsBuy.push(
      "RSI overheated"
    );
  }

  // جلوگیری از فروش در اشباع شدید
  if (rsi15 < 28) {

    sellScore -= 10;

    reasonsSell.push(
      "RSI oversold"
    );
  }

  // ----------------------------------------------------------
  // ADX
  // ----------------------------------------------------------

  if (adx15 >= 25) {

    if (trend15 === "BULLISH") {

      buyScore += 10;

      reasonsBuy.push(
        "ADX confirms trend"
      );

    } else if (trend15 === "BEARISH") {

      sellScore += 10;

      reasonsSell.push(
        "ADX confirms trend"
      );
    }
  }

  // ----------------------------------------------------------
  // MACD
  // ----------------------------------------------------------

  if (macd15 > 0) {

    buyScore += 7;

    reasonsBuy.push(
      "MACD bullish"
    );

  } else if (macd15 < 0) {

    sellScore += 7;

    reasonsSell.push(
      "MACD bearish"
    );
  }

  // ----------------------------------------------------------
  // STRUCTURE
  // ----------------------------------------------------------

  if (
    structure15 === "BULLISH" &&
    structure1h === "BULLISH"
  ) {

    buyScore += 10;

    reasonsBuy.push(
      "Market structure bullish"
    );

  } else if (
    structure15 === "BEARISH" &&
    structure1h === "BEARISH"
  ) {

    sellScore += 10;

    reasonsSell.push(
      "Market structure bearish"
    );
  }

  // ----------------------------------------------------------
  // BOS
  // ----------------------------------------------------------

  if (bos15 === "BULLISH") {

    buyScore += 8;

    reasonsBuy.push(
      "15M bullish BOS"
    );

  } else if (bos15 === "BEARISH") {

    sellScore += 8;

    reasonsSell.push(
      "15M bearish BOS"
    );
  }

  if (bos1h === "BULLISH") {

    buyScore += 7;

    reasonsBuy.push(
      "1H bullish BOS"
    );

  } else if (bos1h === "BEARISH") {

    sellScore += 7;

    reasonsSell.push(
      "1H bearish BOS"
    );
  }

  // ----------------------------------------------------------
  // CHOCH
  // ----------------------------------------------------------

  if (choch15 === "BULLISH") {

    buyScore += 5;

    reasonsBuy.push(
      "15M bullish CHoCH"
    );

  } else if (choch15 === "BEARISH") {

    sellScore += 5;

    reasonsSell.push(
      "15M bearish CHoCH"
    );
  }

  // ----------------------------------------------------------
  // LIQUIDITY
  // ----------------------------------------------------------

  if (liquidity === "BULLISH") {

    buyScore += 7;

    reasonsBuy.push(
      "Bullish liquidity sweep"
    );

  } else if (liquidity === "BEARISH") {

    sellScore += 7;

    reasonsSell.push(
      "Bearish liquidity sweep"
    );
  }

  // ----------------------------------------------------------
  // BREAKOUT
  // ----------------------------------------------------------

  if (breakout === "BULLISH") {

    buyScore += 5;

    reasonsBuy.push(
      "Bullish breakout"
    );

  } else if (breakout === "BEARISH") {

    sellScore += 5;

    reasonsSell.push(
      "Bearish breakout"
    );
  }

  // ----------------------------------------------------------
  // RETEST
  // ----------------------------------------------------------

  if (retest === "BULLISH") {

    buyScore += 5;

    reasonsBuy.push(
      "Bullish retest"
    );

  } else if (retest === "BEARISH") {

    sellScore += 5;

    reasonsSell.push(
      "Bearish retest"
    );
  }

  // ----------------------------------------------------------
  // PULLBACK
  // ----------------------------------------------------------

  if (pullback === "BULLISH") {

    buyScore += 5;

    reasonsBuy.push(
      "Bullish pullback"
    );

  } else if (pullback === "BEARISH") {

    sellScore += 5;

    reasonsSell.push(
      "Bearish pullback"
    );
  }

  // ----------------------------------------------------------
  // NEWS BLOCK
  // ----------------------------------------------------------

  if (
    CONFIG.NEWS_FILTER_ENABLED &&
    news.blocked
  ) {

    return buildWaitResponse({

      price,
      rsi15,
      macd15,
      adx15,
      atr15,
      momentum15,
      trend15,
      trend1h,
      structure15,
      structure1h,
      breakout,
      news,

      reason:
        "Major-news blackout window"
    });
  }

  // ----------------------------------------------------------
  // SCORE NORMALIZATION
  // ----------------------------------------------------------

  buyScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(buyScore)
      )
    );

  sellScore =
    Math.max(
      0,
      Math.min(
        100,
        Math.round(sellScore)
      )
    );

  // ----------------------------------------------------------
  // SIGNAL
  // ----------------------------------------------------------

  let direction = "WAIT";
  let score = Math.max(
    buyScore,
    sellScore
  );

  if (
    buyScore >= CONFIG.MIN_SCORE &&
    buyScore >= sellScore + 8
  ) {

    direction = "BUY";

  } else if (
    sellScore >= CONFIG.MIN_SCORE &&
    sellScore >= buyScore + 8
  ) {

    direction = "SELL";
  }

  // ----------------------------------------------------------
  // ATR / PLAN
  // ----------------------------------------------------------

  if (
    direction === "WAIT"
  ) {

    return buildFullResponse({
      price,
      signal: "WAIT",
      score,
      buyScore,
      sellScore,
      rsi15,
      macd15,
      adx15,
      atr15,
      momentum15,
      trend15,
      trend1h,
      alignment:
        trend15 === trend1h
          ? trend15
          : "NEUTRAL",
      structure15,
      structure1h,
      bos15,
      bos1h,
      choch15,
      choch1h,
      liquidity,
      breakout,
      retest,
      pullback,
      news,
      reasonsBuy,
      reasonsSell
    });
  }

  // ----------------------------------------------------------
  // ENTRY / SL / TP
  // ----------------------------------------------------------

  const plan =
    buildTradePlan(
      direction,
      price,
      atr15,
      fast
    );

  if (!plan) {

    return buildFullResponse({
      price,
      signal: "WAIT",
      score: 0,
      buyScore,
      sellScore,
      rsi15,
      macd15,
      adx15,
      atr15,
      momentum15,
      trend15,
      trend1h,
      alignment:
        trend15 === trend1h
          ? trend15
          : "NEUTRAL",
      structure15,
      structure1h,
      bos15,
      bos1h,
      choch15,
      choch1h,
      liquidity,
      breakout,
      retest,
      pullback,
      news,
      reasonsBuy,
      reasonsSell,
      reason:
        "Trade plan could not be constructed"
    });
  }

  // ----------------------------------------------------------
  // RR
  // ----------------------------------------------------------

  const rr =
    calculateRR(
      direction,
      plan.entry,
      plan.stopLoss,
      plan.tp1
    );

  if (
    rr < CONFIG.MIN_RR
  ) {

    return buildFullResponse({
      price,
      signal: "WAIT",
      score: Math.max(
        buyScore,
        sellScore
      ),
      buyScore,
      sellScore,
      rsi15,
      macd15,
      adx15,
      atr15,
      momentum15,
      trend15,
      trend1h,
      alignment:
        trend15 === trend1h
          ? trend15
          : "NEUTRAL",
      structure15,
      structure1h,
      bos15,
      bos1h,
      choch15,
      choch1h,
      liquidity,
      breakout,
      retest,
      pullback,
      news,
      reasonsBuy,
      reasonsSell,
      reason:
        "Risk / Reward below minimum"
    });
  }

  // ----------------------------------------------------------
  // FINAL SIGNAL
  // ----------------------------------------------------------

  const finalSignal =
    direction === "BUY"
      ? "BUY LIMIT"
      : "SELL LIMIT";

  return buildFullResponse({

    price,

    signal:
      finalSignal,

    score:
      Math.max(
        buyScore,
        sellScore
      ),

    buyScore,
    sellScore,

    entry:
      roundPrice(
        plan.entry
      ),

    stopLoss:
      roundPrice(
        plan.stopLoss
      ),

    tp1:
      roundPrice(
        plan.tp1
      ),

    tp2:
      roundPrice(
        plan.tp2
      ),

    tp3:
      roundPrice(
        plan.tp3
      ),

    rr,

    rsi15,
    macd15,
    adx15,
    atr15,
    momentum15,

    trend15,
    trend1h,

    alignment:
      trend15 === trend1h
        ? trend15
        : "NEUTRAL",

    structure15,
    structure1h,

    bos15,
    bos1h,

    choch15,
    choch1h,

    liquidity,
    breakout,
    retest,
    pullback,

    news,

    reasonsBuy,
    reasonsSell
  });
}


// ============================================================
// TWELVE DATA
// ============================================================

async function getTimeSeries(
  env,
  symbol,
  interval,
  outputsize
) {

  const endpoint =
    "https://api.twelvedata.com/time_series" +
    "?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputsize +
    "&timezone=UTC" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(
      endpoint,
      {
        headers: {
          "User-Agent":
            "HakimGoldSignalEngine/6.0"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      "Twelve Data HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

  if (
    data.status === "error"
  ) {

    throw new Error(
      data.message ||
      "Twelve Data error"
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

  return data.values;
}


// ============================================================
// EMA
// ============================================================

function calculateEMA(
  values,
  period
) {

  if (
    values.length <
    period
  ) {
    return 0;
  }

  const chronological =
    [...values]
      .reverse();

  const k =
    2 /
    (period + 1);

  let ema =
    chronological
      .slice(
        0,
        period
      )
      .reduce(
        (a,b) => a + b,
        0
      ) /
    period;

  for (
    let i = period;
    i < chronological.length;
    i++
  ) {

    ema =
      chronological[i] * k +
      ema * (1-k);
  }

  return ema;
}


// ============================================================
// RSI
// ============================================================

function calculateRSI(
  values,
  period
) {

  if (
    values.length <= period
  ) {
    return 50;
  }

  const chronological =
    [...values]
      .reverse();

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      chronological[i] -
      chronological[i-1];

    if (change >= 0)
      gains += change;
    else
      losses -= change;
  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < chronological.length;
    i++
  ) {

    const change =
      chronological[i] -
      chronological[i-1];

    const gain =
      Math.max(
        0,
        change
      );

    const loss =
      Math.max(
        0,
        -change
      );

    avgGain =
      (
        avgGain *
        (period-1) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (period-1) +
        loss
      ) /
      period;
  }

  if (
    avgLoss === 0
  ) {
    return 100;
  }

  const rs =
    avgGain /
    avgLoss;

  return 100 -
    100 /
    (1 + rs);
}


// ============================================================
// MACD
// ============================================================

function calculateMACD(
  values
) {

  if (
    values.length < 35
  ) {
    return 0;
  }

  const ema12 =
    calculateEMA(
      values,
      12
    );

  const ema26 =
    calculateEMA(
      values,
      26
    );

  return ema12 - ema26;
}


// ============================================================
// ATR
// ============================================================

function calculateATR(
  candles,
  period
) {

  if (
    candles.length <
    period + 2
  ) {
    return 0;
  }

  const chronological =
    [...candles]
      .reverse();

  const tr = [];

  for (
    let i = 1;
    i < chronological.length;
    i++
  ) {

    const high =
      Number(
        chronological[i].high
      );

    const low =
      Number(
        chronological[i].low
      );

    const prevClose =
      Number(
        chronological[i-1].close
      );

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high - prevClose
        ),
        Math.abs(
          low - prevClose
        )
      )
    );
  }

  const recent =
    tr.slice(
      -period
    );

  return (
    recent.reduce(
      (a,b) => a+b,
      0
    ) /
    recent.length
  );
}


// ============================================================
// ADX / DI
// ============================================================

function calculateADX(
  candles,
  period
) {

  if (
    candles.length <
    period * 2 + 5
  ) {
    return 0;
  }

  const c =
    [...candles]
      .reverse();

  const trs = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let i = 1;
    i < c.length;
    i++
  ) {

    const high =
      Number(c[i].high);

    const low =
      Number(c[i].low);

    const prevHigh =
      Number(c[i-1].high);

    const prevLow =
      Number(c[i-1].low);

    const prevClose =
      Number(c[i-1].close);

    const tr =
      Math.max(
        high - low,
        Math.abs(
          high - prevClose
        ),
        Math.abs(
          low - prevClose
        )
      );

    const up =
      high - prevHigh;

    const down =
      prevLow - low;

    trs.push(tr);

    plusDM.push(
      up > down && up > 0
        ? up
        : 0
    );

    minusDM.push(
      down > up && down > 0
        ? down
        : 0
    );
  }

  const start =
    Math.max(
      0,
      trs.length - period * 2
    );

  let dxValues = [];

  for (
    let i = start + period;
    i < trs.length;
    i++
  ) {

    const trSlice =
      trs.slice(
        i-period,
        i
      );

    const plusSlice =
      plusDM.slice(
        i-period,
        i
      );

    const minusSlice =
      minusDM.slice(
        i-period,
        i
      );

    const trSum =
      trSlice.reduce(
        (a,b) => a+b,
        0
      );

    if (
      trSum <= 0
    ) {
      continue;
    }

    const plus =
      100 *
      plusSlice.reduce(
        (a,b) => a+b,
        0
      ) /
      trSum;

    const minus =
      100 *
      minusSlice.reduce(
        (a,b) => a+b,
        0
      ) /
      trSum;

    const denominator =
      plus + minus;

    if (
      denominator <= 0
    ) {
      continue;
    }

    const dx =
      100 *
      Math.abs(
        plus-minus
      ) /
      denominator;

    dxValues.push(dx);
  }

  if (
    dxValues.length === 0
  ) {
    return 0;
  }

  return dxValues
    .slice(-period)
    .reduce(
      (a,b) => a+b,
      0
    ) /
    Math.min(
      period,
      dxValues.length
    );
}


// ============================================================
// MOMENTUM
// ============================================================

function calculateMomentum(
  closes,
  period
) {

  if (
    closes.length <= period
  ) {
    return 0;
  }

  const current =
    closes[0];

  const old =
    closes[period];

  if (
    old === 0
  ) {
    return 0;
  }

  return (
    (current-old) /
    old
  ) * 100;
}


// ============================================================
// TREND
// ============================================================

function getTrend(
  price,
  ema20,
  ema50
) {

  if (
    ema20 <= 0 ||
    ema50 <= 0
  ) {
    return "NEUTRAL";
  }

  if (
    price > ema20 &&
    ema20 > ema50
  ) {
    return "BULLISH";
  }

  if (
    price < ema20 &&
    ema20 < ema50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// MARKET STRUCTURE
// ============================================================

function detectStructure(
  highs,
  lows,
  closes
) {

  const n =
    Math.min(
      highs.length,
      lows.length
    );

  if (
    n < 20
  ) {
    return "NEUTRAL";
  }

  const recentHighs =
    highs.slice(
      0,
      20
    );

  const recentLows =
    lows.slice(
      0,
      20
    );

  const previousHighs =
    highs.slice(
      10,
      30
    );

  const previousLows =
    lows.slice(
      10,
      30
    );

  const recentHigh =
    Math.max(
      ...recentHighs
    );

  const previousHigh =
    Math.max(
      ...previousHighs
    );

  const recentLow =
    Math.min(
      ...recentLows
    );

  const previousLow =
    Math.min(
      ...previousLows
    );

  if (
    recentHigh > previousHigh &&
    recentLow > previousLow
  ) {
    return "BULLISH";
  }

  if (
    recentHigh < previousHigh &&
    recentLow < previousLow
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}


// ============================================================
// BOS
// ============================================================

function detectBOS(
  candles
) {

  if (
    candles.length < 25
  ) {
    return "NONE";
  }

  const current =
    Number(
      candles[0].close
    );

  const previous =
    candles.slice(
      5,
      20
    );

  const high =
    Math.max(
      ...previous.map(
        x => Number(x.high)
      )
    );

  const low =
    Math.min(
      ...previous.map(
        x => Number(x.low)
      )
    );

  if (
    current > high
  ) {
    return "BULLISH";
  }

  if (
    current < low
  ) {
    return "BEARISH";
  }

  return "NONE";
}


// ============================================================
// CHOCH
// ============================================================

function detectCHoCH(
  candles
) {

  if (
    candles.length < 35
  ) {
    return "NONE";
  }

  const current =
    Number(
      candles[0].close
    );

  const recent =
    candles.slice(
      0,
      10
    );

  const older =
    candles.slice(
      10,
      30
    );

  const recentHigh =
    Math.max(
      ...recent.map(
        x => Number(x.high)
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x => Number(x.low)
      )
    );

  const olderHigh =
    Math.max(
      ...older.map(
        x => Number(x.high)
      )
    );

  const olderLow =
    Math.min(
      ...older.map(
        x => Number(x.low)
      )
    );

  if (
    current > olderHigh &&
    current > recentLow
  ) {
    return "BULLISH";
  }

  if (
    current < olderLow &&
    current < recentHigh
  ) {
    return "BEARISH";
  }

  return "NONE";
}


// ============================================================
// LIQUIDITY SWEEP
// ============================================================

function detectLiquiditySweep(
  candles
) {

  if (
    candles.length < 15
  ) {
    return "NONE";
  }

  const current =
    candles[0];

  const previous =
    candles.slice(
      2,
      12
    );

  const high =
    Math.max(
      ...previous.map(
        x => Number(x.high)
      )
    );

  const low =
    Math.min(
      ...previous.map(
        x => Number(x.low)
      )
    );

  const currentHigh =
    Number(
      current.high
    );

  const currentLow =
    Number(
      current.low
    );

  const currentClose =
    Number(
      current.close
    );

  // sweep low + close back above
  if (
    currentLow < low &&
    currentClose > low
  ) {
    return "BULLISH";
  }

  // sweep high + close back below
  if (
    currentHigh > high &&
    currentClose < high
  ) {
    return "BEARISH";
  }

  return "NONE";
}


// ============================================================
// BREAKOUT
// ============================================================

function detectBreakout(
  candles
) {

  if (
    candles.length < 25
  ) {
    return "NONE";
  }

  const current =
    Number(
      candles[0].close
    );

  const previous =
    candles.slice(
      3,
      20
    );

  const high =
    Math.max(
      ...previous.map(
        x => Number(x.high)
      )
    );

  const low =
    Math.min(
      ...previous.map(
        x => Number(x.low)
      )
    );

  if (
    current > high
  ) {
    return "BULLISH";
  }

  if (
    current < low
  ) {
    return "BEARISH";
  }

  return "NONE";
}


// ============================================================
// RETEST
// ============================================================

function detectRetest(
  candles
) {

  if (
    candles.length < 20
  ) {
    return "NONE";
  }

  const current =
    Number(
      candles[0].close
    );

  const previous =
    candles.slice(
      3,
      15
    );

  const high =
    Math.max(
      ...previous.map(
        x => Number(x.high)
      )
    );

  const low =
    Math.min(
      ...previous.map(
        x => Number(x.low)
      )
    );

  const range =
    high-low;

  if (
    range <= 0
  ) {
    return "NONE";
  }

  const nearLow =
    Math.abs(
      current-low
    ) <
    range * 0.18;

  const nearHigh =
    Math.abs(
      current-high
    ) <
    range * 0.18;

  if (
    nearLow &&
    current > low
  ) {
    return "BULLISH";
  }

  if (
    nearHigh &&
    current < high
  ) {
    return "BEARISH";
  }

  return "NONE";
}


// ============================================================
// PULLBACK
// ============================================================

function detectPullback(
  candles,
  ema20
) {

  if (
    candles.length < 10
  ) {
    return "NONE";
  }

  const current =
    Number(
      candles[0].close
    );

  const previous =
    Number(
      candles[3].close
    );

  const distance =
    Math.abs(
      current-ema20
    );

  if (
    distance <=
    Math.abs(
      previous-current
    ) * 1.5
  ) {

    if (
      current > ema20
    ) {
      return "BULLISH";
    }

    if (
      current < ema20
    ) {
      return "BEARISH";
    }
  }

  return "NONE";
}


// ============================================================
// TRADE PLAN
// ============================================================

function buildTradePlan(
  direction,
  price,
  atr,
  candles
) {

  if (
    atr <= 0
  ) {
    return null;
  }

  const recent =
    candles.slice(
      0,
      20
    );

  const recentHigh =
    Math.max(
      ...recent.map(
        x => Number(x.high)
      )
    );

  const recentLow =
    Math.min(
      ...recent.map(
        x => Number(x.low)
      )
    );

  const entryOffset =
    atr *
    CONFIG.ATR_ENTRY_MULTIPLIER;

  let entry;
  let stopLoss;
  let tp1;
  let tp2;
  let tp3;

  if (
    direction === "BUY"
  ) {

    // BUY LIMIT باید پایین‌تر از بازار باشد
    entry =
      Math.min(
        price-entryOffset,
        recentLow + atr * 0.15
      );

    stopLoss =
      Math.min(
        entry - atr * CONFIG.ATR_SL_MULTIPLIER,
        recentLow - atr * 0.20
      );

    const risk =
      entry-stopLoss;

    tp1 =
      entry +
      risk * 1.50;

    tp2 =
      entry +
      risk * 2.20;

    tp3 =
      entry +
      risk * 3.00;

  } else {

    // SELL LIMIT باید بالاتر از بازار باشد
    entry =
      Math.max(
        price+entryOffset,
        recentHigh - atr * 0.15
      );

    stopLoss =
      Math.max(
        entry + atr * CONFIG.ATR_SL_MULTIPLIER,
        recentHigh + atr * 0.20
      );

    const risk =
      stopLoss-entry;

    tp1 =
      entry -
      risk * 1.50;

    tp2 =
      entry -
      risk * 2.20;

    tp3 =
      entry -
      risk * 3.00;
  }

  return {
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3
  };
}


// ============================================================
// RR
// ============================================================

function calculateRR(
  direction,
  entry,
  stopLoss,
  tp
) {

  let risk;
  let reward;

  if (
    direction === "BUY"
  ) {

    risk =
      entry-stopLoss;

    reward =
      tp-entry;

  } else {

    risk =
      stopLoss-entry;

    reward =
      entry-tp;
  }

  if (
    risk <= 0
  ) {
    return 0;
  }

  return reward/risk;
}


// ============================================================
// NEWS FILTER
// ============================================================

function getNewsFilter() {

  if (
    !CONFIG.NEWS_FILTER_ENABLED
  ) {

    return {
      enabled: false,
      blocked: false,
      event: null,
      reason: "disabled"
    };
  }

  const now =
    new Date();

  const day =
    now.getUTCDay();

  const hour =
    now.getUTCHours();

  const minute =
    now.getUTCMinutes();

  const currentMinutes =
    hour * 60 +
    minute;

  // ----------------------------------------------------------
  // محافظه‌کارانه:
  //
  // جمعه اطراف بازه معمول NFP
  // 12:00 تا 15:00 UTC
  //
  // چهارشنبه اطراف FOMC
  // 17:30 تا 21:00 UTC
  //
  // پنجشنبه اطراف CPI/PPI/Jobless Claims
  // 12:00 تا 15:00 UTC
  //
  // این‌ها تقویم زنده نیستند و فقط blackout محافظه‌کارانه‌اند.
  // ----------------------------------------------------------

  if (
    day === 5 &&
    currentMinutes >= 720 &&
    currentMinutes <= 900
  ) {

    return {
      enabled: true,
      blocked: true,
      event: "US high-impact Friday window",
      reason:
        "New trades blocked during conservative Friday news window."
    };
  }

  if (
    day === 3 &&
    currentMinutes >= 1050 &&
    currentMinutes <= 1260
  ) {

    return {
      enabled: true,
      blocked: true,
      event: "US central-bank/news window",
      reason:
        "New trades blocked during conservative Wednesday news window."
    };
  }

  if (
    day === 4 &&
    currentMinutes >= 720 &&
    currentMinutes <= 900
  ) {

    return {
      enabled: true,
      blocked: true,
      event: "US economic-data window",
      reason:
        "New trades blocked during conservative Thursday news window."
    };
  }

  return {
    enabled: true,
    blocked: false,
    event: null,
    reason:
      "No configured blackout window is active."
  };
}


// ============================================================
// RESPONSE
// ============================================================

function buildFullResponse(data) {

  return {

    status: "ok",

    engine:
      "Hakim Gold Signal Engine V6.0",

    timestamp:
      new Date().toISOString(),

    symbol:
      CONFIG.SYMBOL,

    price:
      data.price ?? null,

    signal:
      data.signal ?? "WAIT",

    score:
      data.score ?? 0,

    buyScore:
      data.buyScore ?? 0,

    sellScore:
      data.sellScore ?? 0,

    entry:
      data.entry ?? null,

    stopLoss:
      data.stopLoss ?? null,

    tp1:
      data.tp1 ?? null,

    tp2:
      data.tp2 ?? null,

    tp3:
      data.tp3 ?? null,

    rr:
      data.rr ?? null,

    rsi:
      roundNumber(
        data.rsi15
      ),

    macd:
      roundNumber(
        data.macd15
      ),

    adx:
      roundNumber(
        data.adx15
      ),

    atr:
      roundNumber(
        data.atr15
      ),

    momentum:
      roundNumber(
        data.momentum15
      ),

    trend15:
      data.trend15,

    trend1h:
      data.trend1h,

    alignment:
      data.alignment,

    structure15:
      data.structure15,

    structure1h:
      data.structure1h,

    bos15:
      data.bos15,

    bos1h:
      data.bos1h,

    choch15:
      data.choch15,

    choch1h:
      data.choch1h,

    liquidity:
      data.liquidity,

    breakout:
      data.breakout,

    retest:
      data.retest,

    pullback:
      data.pullback,

    newsFilter:
      data.news,

    reasonsBuy:
      data.reasonsBuy ?? [],

    reasonsSell:
      data.reasonsSell ?? [],

    reason:
      data.reason ?? null,

    riskMessage:
      "💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.\n" +
      "📊 این سیگنال بر اساس شرایط تکنیکال فعلی بازار تولید شده و با تغییر شرایط بازار ممکن است اعتبار آن از بین برود."
  };
}


function buildWaitResponse(data) {

  return buildFullResponse({

    ...data,

    signal:
      "WAIT",

    score:
      0,

    buyScore:
      0,

    sellScore:
      0
  });
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
    return;
  }

  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_CHAT_ID
  ) {
    return;
  }

  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";

  await fetch(
    url,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body:
        JSON.stringify({
          chat_id:
            env.TELEGRAM_CHAT_ID,

          text:
            message
        })
    }
  );
}


// ============================================================
// PRICE ROUNDING
// ============================================================

function roundPrice(
  value
) {

  if (
    !Number.isFinite(
      value
    )
  ) {
    return null;
  }

  return Number(
    value.toFixed(2)
  );
}


function roundNumber(
  value
) {

  if (
    !Number.isFinite(
      value
    )
  ) {
    return 0;
  }

  return Number(
    value.toFixed(4)
  );
}


// ============================================================
// JSON RESPONSE
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
        ...corsHeaders(),

        "content-type":
          "application/json; charset=UTF-8",

        "cache-control":
          "no-store"
      }
    }
  );
}


function corsHeaders() {

  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type"
  };
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
FX · موتور سیگنال فارکس V6.0
</title>

<style>

body {
  margin:0;
  font-family:
    Arial,
    sans-serif;
  background:
    #0f1225;
  color:
    #fff;
}

.container {
  max-width:
    900px;
  margin:
    auto;
  padding:
    20px;
}

.card {
  background:
    #181c36;
  border-radius:
    18px;
  padding:
    20px;
  margin-bottom:
    15px;
}

h1 {
  margin-top:
    0;
}

.price {
  font-size:
    32px;
  font-weight:
    bold;
}

.signal {
  font-size:
    28px;
  font-weight:
    bold;
  margin:
    15px 0;
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

.item {
  background:
    #10142a;

  padding:
    12px;

  border-radius:
    12px;
}

.label {
  opacity:
    .65;

  font-size:
    13px;
}

.value {
  font-size:
    19px;

  margin-top:
    5px;

  font-weight:
    bold;
}

button {
  border:
    0;

  border-radius:
    10px;

  padding:
    12px 18px;

  cursor:
    pointer;
}

#status {
  opacity:
    .7;
}

.news {
  background:
    #2a2030;

  border-radius:
    12px;

  padding:
    14px;
}

.risk {
  margin-top:
    15px;

  line-height:
    1.8;

  opacity:
    .9;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>
FX · موتور سیگنال فارکس V6.0
</h1>

<div>
Gold Priority · XAU/USD · 15M + 1H
</div>

<br>

<button
onclick="loadSignal()">
🔄 بروزرسانی
</button>

<span id="status">
در حال دریافت...
</span>

</div>


<div class="card">

<div>
XAU/USD
</div>

<div
id="price"
class="price">
-
</div>

<div
id="signal"
class="signal">
WAIT
</div>

<div class="grid">

<div class="item">
<div class="label">
روند ۱۵ دقیقه
</div>
<div
id="trend15"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
روند ۱ ساعته
</div>
<div
id="trend1h"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
هم‌راستایی
</div>
<div
id="alignment"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
امتیاز
</div>
<div
id="score"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
RSI 14
</div>
<div
id="rsi"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
MACD
</div>
<div
id="macd"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
ADX 14
</div>
<div
id="adx"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
ATR
</div>
<div
id="atr"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
Momentum
</div>
<div
id="momentum"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
Breakout
</div>
<div
id="breakout"
class="value">
-
</div>
</div>

</div>

</div>


<div class="card">

<h3>
📰 فیلتر خبر
</h3>

<div
id="news"
class="news">
-
</div>

</div>


<div class="card">

<h3>
📌 Trade Plan
</h3>

<div class="grid">

<div class="item">
<div class="label">
Entry
</div>
<div
id="entry"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
Stop Loss
</div>
<div
id="sl"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
TP1
</div>
<div
id="tp1"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
TP2
</div>
<div
id="tp2"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
TP3
</div>
<div
id="tp3"
class="value">
-
</div>
</div>

<div class="item">
<div class="label">
R:R
</div>
<div
id="rr"
class="value">
-
</div>
</div>

</div>

</div>


<div class="card">

<div class="risk">

💰 مدیریت سرمایه و کنترل ریسک را رعایت کنید.<br>

📊 این سیگنال بر اساس شرایط تکنیکال فعلی بازار تولید شده و با تغییر شرایط بازار ممکن است اعتبار آن از بین برود.

</div>

</div>

</div>


<script>

async function loadSignal() {

  const status =
    document.getElementById(
      "status"
    );

  status.textContent =
    "در حال دریافت...";

  try {

    const response =
      await fetch(
        "/api/signals?ts=" +
        Date.now()
      );

    const data =
      await response.json();

    document.getElementById(
      "price"
    ).textContent =
      data.price ??
      "-";

    document.getElementById(
      "signal"
    ).textContent =
      data.signal ??
      "WAIT";

    document.getElementById(
      "trend15"
    ).textContent =
      data.trend15 ??
      "-";

    document.getElementById(
      "trend1h"
    ).textContent =
      data.trend1h ??
      "-";

    document.getElementById(
      "alignment"
    ).textContent =
      data.alignment ??
      "-";

    document.getElementById(
      "score"
    ).textContent =
      (data.score ?? 0) +
      "/100";

    document.getElementById(
      "rsi"
    ).textContent =
      data.rsi ??
      "-";

    document.getElementById(
      "macd"
    ).textContent =
      data.macd ??
      "-";

    document.getElementById(
      "adx"
    ).textContent =
      data.adx ??
      "-";

    document.getElementById(
      "atr"
    ).textContent =
      data.atr ??
      "-";

    document.getElementById(
      "momentum"
    ).textContent =
      data.momentum ??
      "-";

    document.getElementById(
      "breakout"
    ).textContent =
      data.breakout ??
      "-";

    document.getElementById(
      "entry"
    ).textContent =
      data.entry ??
      "-";

    document.getElementById(
      "sl"
    ).textContent =
      data.stopLoss ??
      "-";

    document.getElementById(
      "tp1"
    ).textContent =
      data.tp1 ??
      "-";

    document.getElementById(
      "tp2"
    ).textContent =
      data.tp2 ??
      "-";

    document.getElementById(
      "tp3"
    ).textContent =
      data.tp3 ??
      "-";

    document.getElementById(
      "rr"
    ).textContent =
      data.rr
        ? Number(
            data.rr
          ).toFixed(2)
        : "-";

    const news =
      data.newsFilter;

    if (
      news &&
      news.blocked
    ) {

      document.getElementById(
        "news"
      ).textContent =
        "🛑 " +
        news.event +
        " — معامله جدید متوقف است.";

    } else {

      document.getElementById(
        "news"
      ).textContent =
        "🟢 فیلتر خبر فعال است؛ در حال حاضر پنجره مسدودکننده فعال نیست.";
    }

    status.textContent =
      "آخرین بروزرسانی: " +
      new Date()
        .toLocaleTimeString();

  } catch(error) {

    status.textContent =
      "خطا در دریافت داده";

    console.error(error);
  }
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
