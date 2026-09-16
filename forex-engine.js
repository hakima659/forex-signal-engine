// ============================================================
// FOREX SIGNAL ENGINE V5.2 GOLD FOCUS
// Cloudflare Worker + D1 + Twelve Data + Telegram
// Focus: XAU/USD + Multi-Timeframe Confirmation
// ============================================================

const CONFIG = {
  symbols: [
    "XAU/USD",
    "EUR/USD",
    "GBP/USD",
    "USD/JPY"
  ],

  signalInterval: "15min",
  confirmInterval: "1h",

  candles15: 250,
  candles1h: 250,

  minScore: 72,
  strongScore: 85,
  minScoreGap: 10,

  atrMultiplier: 1.5,
  tp1R: 2,
  tp2R: 3,

  riskPercent: 0.5,

  cooldownMinutes: 60,

  maxNewSignalsPerRun: 1,
  maxOpenSignals: 2,

  minAtrPercent: 0.01,

  // Gold priority
  goldPriorityBonus: 3,

  // Gold V5.2 filters
  goldMinAdx15: 15,
  goldMinAdx1h: 20,

  // Gold extra confirmations
  goldAlignmentBonus: 8,
  goldTrendBonus: 5
};


// ============================================================
// RESPONSE
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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}


// ============================================================
// SECRETS
// ============================================================

function getTelegramToken(env) {
  return env.TELEGRAM_BOT_TOKEN || "";
}

function getTwelveDataKey(env) {
  return env.TWELVE_DATA_API_KEY || "";
}


// ============================================================
// HOME
// ============================================================

function homePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">

<title>Gold & Forex Signal Engine</title>

<meta name="description"
content="Multi-timeframe analytical signal engine with special focus on XAU/USD Gold.">

<style>
body{
  margin:0;
  background:#0b1220;
  color:#fff;
  font-family:Arial,sans-serif;
}

.container{
  max-width:900px;
  margin:auto;
  padding:25px 18px;
}

.card{
  background:#121c2e;
  border-radius:18px;
  padding:22px;
  margin-bottom:16px;
}

h1{
  font-size:30px;
  margin-bottom:8px;
}

h2{
  font-size:20px;
}

.badge{
  display:inline-block;
  padding:7px 12px;
  border-radius:20px;
  background:#1d3557;
  margin:3px;
}

.gold{
  background:#6b4f00;
}

a{
  color:#6db7ff;
  text-decoration:none;
}

.endpoint{
  background:#07101e;
  padding:10px;
  border-radius:8px;
  margin:8px 0;
}
</style>
</head>

<body>

<div class="container">

<div class="card">
<h1>Gold & Forex Signal Engine</h1>

<p class="badge gold">
XAU/USD Priority
</p>

<p class="badge">
Multi-Timeframe Analysis
</p>

<p class="badge">
V5.2 Gold Focus
</p>

<p>
15-minute signal analysis with 1-hour confirmation.
</p>
</div>

<div class="card">

<h2>Gold Analysis</h2>

<p>
XAU/USD receives special multi-timeframe filtering.
</p>

<p>
15m trend + 1h trend + ADX + EMA + RSI + MACD + ATR
</p>

</div>

<div class="card">

<h2>Technical Analysis</h2>

<p>EMA 20 / 50 / 200</p>
<p>RSI 14</p>
<p>MACD</p>
<p>ATR</p>
<p>ADX</p>
<p>Momentum</p>
<p>Breakout</p>

</div>

<div class="card">

<h2>API</h2>

<div class="endpoint">
<a href="/health">/health</a>
</div>

<div class="endpoint">
<a href="/api/signals">/api/signals</a>
</div>

<div class="endpoint">
<a href="/api/stats">/api/stats</a>
</div>

<div class="endpoint">
<a href="/run">/run</a>
</div>

</div>

<div class="card">

<p>
The engine identifies multi-confirmation analytical
trading opportunities using multiple technical indicators
and timeframes.
</p>

<p>
XAU/USD is processed first and receives additional
trend and alignment validation.
</p>

</div>

</div>

</body>
</html>`;
}


// ============================================================
// ROBOTS
// ============================================================

function robotsTxt() {
  return new Response(
`User-agent: *
Allow: /

Sitemap: https://forex-signal-engine.hakima09360.workers.dev/sitemap.xml`,
    {
      headers: {
        "content-type":
          "text/plain; charset=UTF-8"
      }
    }
  );
}


// ============================================================
// SITEMAP
// ============================================================

function sitemapXml() {
  return new Response(
`<?xml version="1.0" encoding="UTF-8"?>

<urlset
xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

<url>
<loc>https://forex-signal-engine.hakima09360.workers.dev/</loc>
</url>

<url>
<loc>https://forex-signal-engine.hakima09360.workers.dev/health</loc>
</url>

<url>
<loc>https://forex-signal-engine.hakima09360.workers.dev/api/signals</loc>
</url>

</urlset>`,
    {
      headers: {
        "content-type":
          "application/xml; charset=UTF-8"
      }
    }
  );
}


// ============================================================
// D1 DATABASE
// ============================================================

async function ensureDatabase(env) {

  if (!env.DB) {
    throw new Error(
      "D1 binding DB is missing"
    );
  }

  await env.DB.prepare(
`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
)`
  ).run();

  await env.DB.prepare(
`CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT UNIQUE NOT NULL,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`
  ).run();

  await env.DB.prepare(
`CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL,
  entry REAL NOT NULL,
  stop_loss REAL NOT NULL,
  tp1 REAL NOT NULL,
  tp2 REAL NOT NULL,
  atr REAL,
  timeframe TEXT NOT NULL,
  confirmation_timeframe TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reason TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
)`
  ).run();

  await env.DB.prepare(
`CREATE TABLE IF NOT EXISTS signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER,
  event TEXT NOT NULL,
  price REAL,
  details TEXT,
  created_at TEXT NOT NULL
)`
  ).run();

  return true;
}


// ============================================================
// HEALTH
// ============================================================

async function health(env) {

  if (!env.DB) {
    return json({
      ok: false,
      error: "D1 binding DB is missing"
    }, 500);
  }

  try {

    await ensureDatabase(env);

    const result =
      await env.DB.prepare(
        "SELECT 1 AS database_ok"
      ).first();

    return json({
      ok: true,
      service: "forex-signal-engine",
      version: "V5.2",
      database:
        result?.database_ok === 1
          ? "connected"
          : "error",
      time: new Date().toISOString()
    });

  } catch (error) {

    return json({
      ok: false,
      service: "forex-signal-engine",
      version: "V5.2",
      error:
        error?.message ||
        String(error)
    }, 500);
  }
}


// ============================================================
// TWELVE DATA
// ============================================================

async function getCandles(
  env,
  symbol,
  interval,
  outputsize
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
    "?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&outputsize=" +
    outputsize +
    "&format=JSON" +
    "&apikey=" +
    encodeURIComponent(apiKey);

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      "Twelve Data HTTP " +
      response.status
    );
  }

  const data =
    await response.json();

  if (data.status === "error") {
    throw new Error(
      data.message ||
      "Twelve Data API error"
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "No candle data returned for " +
      symbol +
      " " +
      interval
    );
  }

  return data.values
    .map(c => ({
      datetime: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
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
// SMA
// ============================================================

function sma(values, period) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  let sum = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    sum += values[i];
  }

  return sum / period;
}


// ============================================================
// EMA
// ============================================================

function emaSeries(values, period) {

  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return [];
  }

  const result = [];

  let seed = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    seed += values[i];
  }

  let previous =
    seed / period;

  result[period - 1] =
    previous;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    previous =
      (
        values[i] - previous
      ) *
      multiplier +
      previous;

    result[i] =
      previous;
  }

  return result;
}


function ema(values, period) {

  const series =
    emaSeries(
      values,
      period
    );

  if (!series.length) {
    return null;
  }

  return series[
    series.length - 1
  ];
}


// ============================================================
// RSI
// ============================================================

function rsi(
  values,
  period = 14
) {

  if (
    !Array.isArray(values) ||
    values.length <= period
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

    const difference =
      values[i] -
      values[i - 1];

    if (difference >= 0) {
      gains += difference;
    } else {
      losses +=
        Math.abs(difference);
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const difference =
      values[i] -
      values[i - 1];

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? Math.abs(difference)
        : 0;

    averageGain =
      (
        averageGain *
        (period - 1) +
        gain
      ) / period;

    averageLoss =
      (
        averageLoss *
        (period - 1) +
        loss
      ) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 / (1 + rs)
  );
}


// ============================================================
// MACD
// ============================================================

function macd(values) {

  const ema12 =
    emaSeries(values, 12);

  const ema26 =
    emaSeries(values, 26);

  if (
    !ema12.length ||
    !ema26.length
  ) {
    return null;
  }

  const macdValues = [];

  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    if (
      ema12[i] !== undefined &&
      ema26[i] !== undefined
    ) {

      macdValues.push(
        ema12[i] -
        ema26[i]
      );
    }
  }

  if (macdValues.length < 9) {
    return null;
  }

  const signalSeries =
    emaSeries(
      macdValues,
      9
    );

  if (!signalSeries.length) {
    return null;
  }

  const macdLine =
    macdValues[
      macdValues.length - 1
    ];

  const signalLine =
    signalSeries[
      signalSeries.length - 1
    ];

  return {
    macd: macdLine,
    signal: signalLine,
    histogram:
      macdLine - signalLine
  };
}


// ============================================================
// ATR
// ============================================================

function atr(
  candles,
  period = 14
) {

  if (
    !Array.isArray(candles) ||
    candles.length <= period
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {

    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const range1 =
      current.high -
      current.low;

    const range2 =
      Math.abs(
        current.high -
        previous.close
      );

    const range3 =
      Math.abs(
        current.low -
        previous.close
      );

    trueRanges.push(
      Math.max(
        range1,
        range2,
        range3
      )
    );
  }

  return sma(
    trueRanges,
    period
  );
}


// ============================================================
// ADX
// ============================================================

function adx(
  candles,
  period = 14
) {

  if (
    candles.length <
    period * 2 + 1
  ) {
    return null;
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

    const trueRange =
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

    trs.push(trueRange);

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
  }

  const tr =
    sma(trs, period);

  const plus =
    sma(plusDM, period);

  const minus =
    sma(minusDM, period);

  if (
    tr === null ||
    plus === null ||
    minus === null ||
    tr === 0
  ) {
    return null;
  }

  const plusDI =
    100 * plus / tr;

  const minusDI =
    100 * minus / tr;

  const total =
    plusDI + minusDI;

  if (total === 0) {
    return 0;
  }

  return (
    100 *
    Math.abs(
      plusDI - minusDI
    ) /
    total
  );
}


// ============================================================
// MOMENTUM
// ============================================================

function candleMomentum(candles) {

  if (candles.length < 3) {
    return 0;
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const bodyLast =
    last.close -
    last.open;

  const bodyPrevious =
    previous.close -
    previous.open;

  if (
    bodyLast > 0 &&
    bodyPrevious > 0
  ) {
    return 1;
  }

  if (
    bodyLast < 0 &&
    bodyPrevious < 0
  ) {
    return -1;
  }

  return 0;
}


// ============================================================
// BREAKOUT
// ============================================================

function breakoutDirection(
  candles,
  lookback = 20
) {

  if (
    candles.length <
    lookback + 2
  ) {
    return 0;
  }

  const last =
    candles[candles.length - 1];

  const start =
    candles.length -
    1 -
    lookback;

  let highest =
    -Infinity;

  let lowest =
    Infinity;

  for (
    let i = start;
    i < candles.length - 1;
    i++
  ) {

    highest =
      Math.max(
        highest,
        candles[i].high
      );

    lowest =
      Math.min(
        lowest,
        candles[i].low
      );
  }

  if (
    last.close >
    highest
  ) {
    return 1;
  }

  if (
    last.close <
    lowest
  ) {
    return -1;
  }

  return 0;
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

  const last =
    candles[candles.length - 1];

  const ema20 =
    ema(closes, 20);

  const ema50 =
    ema(closes, 50);

  const ema200 =
    ema(closes, 200);

  const rsiValue =
    rsi(closes, 14);

  const macdValue =
    macd(closes);

  const atrValue =
    atr(candles, 14);

  const adxValue =
    adx(candles, 14);

  const momentum =
    candleMomentum(candles);

  const breakout =
    breakoutDirection(
      candles,
      20
    );

  let buyScore = 0;
  let sellScore = 0;

  const buyReasons = [];
  const sellReasons = [];


  // EMA20
  if (
    ema20 !== null
  ) {

    if (
      last.close > ema20
    ) {
      buyScore += 10;
      buyReasons.push(
        "Price above EMA20"
      );
    }

    if (
      last.close < ema20
    ) {
      sellScore += 10;
      sellReasons.push(
        "Price below EMA20"
      );
    }
  }


  // EMA20 / EMA50
  if (
    ema20 !== null &&
    ema50 !== null
  ) {

    if (
      ema20 > ema50
    ) {
      buyScore += 10;
      buyReasons.push(
        "EMA20 above EMA50"
      );
    }

    if (
      ema20 < ema50
    ) {
      sellScore += 10;
      sellReasons.push(
        "EMA20 below EMA50"
      );
    }
  }


  // EMA200
  if (
    ema200 !== null
  ) {

    if (
      last.close > ema200
    ) {
      buyScore += 8;
      buyReasons.push(
        "Price above EMA200"
      );
    }

    if (
      last.close < ema200
    ) {
      sellScore += 8;
      sellReasons.push(
        "Price below EMA200"
      );
    }
  }


  // RSI
  if (
    rsiValue !== null
  ) {

    if (
      rsiValue >= 52 &&
      rsiValue < 70
    ) {
      buyScore += 10;
      buyReasons.push(
        "Bullish RSI"
      );
    }

    if (
      rsiValue <= 48 &&
      rsiValue > 30
    ) {
      sellScore += 10;
      sellReasons.push(
        "Bearish RSI"
      );
    }
  }


  // MACD
  if (
    macdValue
  ) {

    if (
      macdValue.macd >
        macdValue.signal &&
      macdValue.histogram > 0
    ) {

      buyScore += 12;

      buyReasons.push(
        "Bullish MACD"
      );
    }

    if (
      macdValue.macd <
        macdValue.signal &&
      macdValue.histogram < 0
    ) {

      sellScore += 12;

      sellReasons.push(
        "Bearish MACD"
      );
    }
  }


  // ADX
  if (
    adxValue !== null &&
    adxValue >= 20
  ) {

    if (
      buyScore >
      sellScore
    ) {

      buyScore += 10;

      buyReasons.push(
        "ADX trend strength confirmed"
      );

    } else if (
      sellScore >
      buyScore
    ) {

      sellScore += 10;

      sellReasons.push(
        "ADX trend strength confirmed"
      );
    }
  }


  // Momentum
  if (
    momentum === 1
  ) {

    buyScore += 10;

    buyReasons.push(
      "Bullish candle momentum"
    );
  }

  if (
    momentum === -1
  ) {

    sellScore += 10;

    sellReasons.push(
      "Bearish candle momentum"
    );
  }


  // Breakout
  if (
    breakout === 1
  ) {

    buyScore += 10;

    buyReasons.push(
      "Bullish breakout"
    );
  }

  if (
    breakout === -1
  ) {

    sellScore += 10;

    sellReasons.push(
      "Bearish breakout"
    );
  }


  return {
    price: last.close,

    ema20,
    ema50,
    ema200,

    rsi: rsiValue,
    macd: macdValue,
    atr: atrValue,
    adx: adxValue,

    momentum,
    breakout,

    buyScore,
    sellScore,

    buyReasons,
    sellReasons
  };
}


// ============================================================
// SCORE CONVERSION
// ============================================================

function convertTo100(
  score15,
  score1h
) {

  const combined =
    score15 + score1h;

  return Math.min(
    100,
    Math.round(
      combined / 160 * 100
    )
  );
}


// ============================================================
// BUILD SIGNAL V5.2
// ============================================================

function buildSignal(
  symbol,
  candles15,
  candles1h
) {

  if (
    candles15.length < 210 ||
    candles1h.length < 210
  ) {

    return {
      signal: null,

      diagnostics: {
        symbol,
        status: "REJECTED",
        reason: "INSUFFICIENT_CANDLES",
        candles15: candles15.length,
        candles1h: candles1h.length
      }
    };
  }


  // ----------------------------------------------------------
  // CLOSED CANDLES ONLY
  // ----------------------------------------------------------

  const closed15 =
    candles15.slice(
      0,
      candles15.length - 1
    );

  const closed1h =
    candles1h.slice(
      0,
      candles1h.length - 1
    );


  const analysis15 =
    analyzeTimeframe(
      closed15
    );

  const analysis1h =
    analyzeTimeframe(
      closed1h
    );


  // ----------------------------------------------------------
  // RAW SCORES
  // ----------------------------------------------------------

  const buyRaw =
    analysis15.buyScore +
    analysis1h.buyScore;

  const sellRaw =
    analysis15.sellScore +
    analysis1h.sellScore;


  // ----------------------------------------------------------
  // BASE SCORES
  // ----------------------------------------------------------

  const baseBuyScore =
    convertTo100(
      analysis15.buyScore,
      analysis1h.buyScore
    );

  const baseSellScore =
    convertTo100(
      analysis15.sellScore,
      analysis1h.sellScore
    );


  let finalBuyScore =
    baseBuyScore;

  let finalSellScore =
    baseSellScore;


  let goldTrendDirection = null;
  let goldAlignment = null;
  let goldFilterPassed = true;
  let goldFilterReason = null;


  // ==========================================================
  // GOLD SPECIAL LOGIC
  // ==========================================================

  if (
    symbol === "XAU/USD"
  ) {

    // --------------------------------------------------------
    // 1. 15m ADX
    // --------------------------------------------------------

    if (
      !Number.isFinite(
        analysis15.adx
      ) ||
      analysis15.adx <
      CONFIG.goldMinAdx15
    ) {

      goldFilterPassed = false;

      goldFilterReason =
        "GOLD_15M_ADX_TOO_LOW";
    }


    // --------------------------------------------------------
    // 2. 1h ADX
    // --------------------------------------------------------

    if (
      goldFilterPassed &&
      (
        !Number.isFinite(
          analysis1h.adx
        ) ||
        analysis1h.adx <
        CONFIG.goldMinAdx1h
      )
    ) {

      goldFilterPassed = false;

      goldFilterReason =
        "GOLD_1H_ADX_TOO_LOW";
    }


    // --------------------------------------------------------
    // 3. 1H TREND
    // --------------------------------------------------------

    const bullish1h =
      analysis1h.price >
      analysis1h.ema20 &&
      analysis1h.ema20 >
      analysis1h.ema50 &&
      analysis1h.price >
      analysis1h.ema200;

    const bearish1h =
      analysis1h.price <
      analysis1h.ema20 &&
      analysis1h.ema20 <
      analysis1h.ema50 &&
      analysis1h.price <
      analysis1h.ema200;


    if (bullish1h) {

      goldTrendDirection =
        "BUY";

    } else if (bearish1h) {

      goldTrendDirection =
        "SELL";

    } else {

      goldTrendDirection =
        "NEUTRAL";
    }


    // --------------------------------------------------------
    // 4. 15M TREND
    // --------------------------------------------------------

    const bullish15 =
      analysis15.price >
      analysis15.ema20 &&
      analysis15.ema20 >
      analysis15.ema50;

    const bearish15 =
      analysis15.price <
      analysis15.ema20 &&
      analysis15.ema20 <
      analysis15.ema50;


    // --------------------------------------------------------
    // 5. ALIGNMENT
    // --------------------------------------------------------

    if (
      bullish15 &&
      bullish1h
    ) {

      goldAlignment =
        "BUY";

    } else if (
      bearish15 &&
      bearish1h
    ) {

      goldAlignment =
        "SELL";

    } else {

      goldAlignment =
        "MIXED";
    }


    // --------------------------------------------------------
    // 6. 1H TREND BONUS
    // --------------------------------------------------------

    if (
      goldTrendDirection ===
      "BUY"
    ) {

      finalBuyScore =
        Math.min(
          100,
          finalBuyScore +
          CONFIG.goldTrendBonus
        );

    } else if (
      goldTrendDirection ===
      "SELL"
    ) {

      finalSellScore =
        Math.min(
          100,
          finalSellScore +
          CONFIG.goldTrendBonus
        );
    }


    // --------------------------------------------------------
    // 7. 15M + 1H ALIGNMENT BONUS
    // --------------------------------------------------------

    if (
      goldAlignment ===
      "BUY"
    ) {

      finalBuyScore =
        Math.min(
          100,
          finalBuyScore +
          CONFIG.goldAlignmentBonus
        );

    } else if (
      goldAlignment ===
      "SELL"
    ) {

      finalSellScore =
        Math.min(
          100,
          finalSellScore +
          CONFIG.goldAlignmentBonus
        );
    }


    // --------------------------------------------------------
    // 8. GOLD PRIORITY BONUS
    // --------------------------------------------------------

    if (
      finalBuyScore >
      finalSellScore
    ) {

      finalBuyScore =
        Math.min(
          100,
          finalBuyScore +
          CONFIG.goldPriorityBonus
        );

    } else if (
      finalSellScore >
      finalBuyScore
    ) {

      finalSellScore =
        Math.min(
          100,
          finalSellScore +
          CONFIG.goldPriorityBonus
        );
    }


    // --------------------------------------------------------
    // 9. GOLD FILTER REJECTION
    // --------------------------------------------------------

    if (
      !goldFilterPassed
    ) {

      return {
        signal: null,

        diagnostics: {
          symbol,
          status: "REJECTED",

          reason:
            goldFilterReason,

          buyScore:
            finalBuyScore,

          sellScore:
            finalSellScore,

          scoreGap:
            Math.abs(
              finalBuyScore -
              finalSellScore
            ),

          requiredScore:
            CONFIG.minScore,

          requiredGap:
            CONFIG.minScoreGap,

          rawBuyScore:
            buyRaw,

          rawSellScore:
            sellRaw,

          price15m:
            analysis15.price,

          rsi15m:
            analysis15.rsi,

          rsi1h:
            analysis1h.rsi,

          adx15m:
            analysis15.adx,

          adx1h:
            analysis1h.adx,

          atr15m:
            analysis15.atr,

          goldTrendDirection,

          goldAlignment,

          goldMinAdx15:
            CONFIG.goldMinAdx15,

          goldMinAdx1h:
            CONFIG.goldMinAdx1h,

          buyReasons15m:
            analysis15.buyReasons,

          sellReasons15m:
            analysis15.sellReasons,

          buyReasons1h:
            analysis1h.buyReasons,

          sellReasons1h:
            analysis1h.sellReasons
        }
      };
    }
  }


  // ==========================================================
  // FINAL GAP
  // ==========================================================

  const gap =
    Math.abs(
      finalBuyScore -
      finalSellScore
    );


  let direction = null;
  let score = 0;
  let reasons = [];
  let rejectionReason = null;


  // ==========================================================
  // BUY
  // ==========================================================

  if (
    finalBuyScore >=
      CONFIG.minScore &&
    finalBuyScore -
      finalSellScore >=
      CONFIG.minScoreGap
  ) {

    direction = "BUY";

    score =
      finalBuyScore;

    reasons = [
      ...analysis15.buyReasons,
      ...analysis1h.buyReasons
    ];


    if (
      symbol === "XAU/USD" &&
      goldTrendDirection ===
      "BUY"
    ) {

      reasons.push(
        "Gold 1h bullish trend confirmed"
      );
    }


    if (
      symbol === "XAU/USD" &&
      goldAlignment ===
      "BUY"
    ) {

      reasons.push(
        "Gold 15m/1h alignment confirmed"
      );
    }
  }


  // ==========================================================
  // SELL
  // ==========================================================

  else if (
    finalSellScore >=
      CONFIG.minScore &&
    finalSellScore -
      finalBuyScore >=
      CONFIG.minScoreGap
  ) {

    direction = "SELL";

    score =
      finalSellScore;

    reasons = [
      ...analysis15.sellReasons,
      ...analysis1h.sellReasons
    ];


    if (
      symbol === "XAU/USD" &&
      goldTrendDirection ===
      "SELL"
    ) {

      reasons.push(
        "Gold 1h bearish trend confirmed"
      );
    }


    if (
      symbol === "XAU/USD" &&
      goldAlignment ===
      "SELL"
    ) {

      reasons.push(
        "Gold 15m/1h alignment confirmed"
      );
    }
  }


  // ==========================================================
  // REJECTED
  // ==========================================================

  if (!direction) {

    if (
      finalBuyScore <
      CONFIG.minScore &&
      finalSellScore <
      CONFIG.minScore
    ) {

      rejectionReason =
        "SCORE_BELOW_MINIMUM";

    } else if (
      gap <
      CONFIG.minScoreGap
    ) {

      rejectionReason =
        "BUY_SELL_GAP_TOO_SMALL";

    } else {

      rejectionReason =
        "NO_DIRECTION_CONFIRMED";
    }


    return {
      signal: null,

      diagnostics: {
        symbol,
        status: "REJECTED",

        reason:
          rejectionReason,

        buyScore:
          finalBuyScore,

        sellScore:
          finalSellScore,

        scoreGap:
          gap,

        requiredScore:
          CONFIG.minScore,

        requiredGap:
          CONFIG.minScoreGap,

        rawBuyScore:
          buyRaw,

        rawSellScore:
          sellRaw,

        price15m:
          analysis15.price,

        rsi15m:
          analysis15.rsi,

        rsi1h:
          analysis1h.rsi,

        adx15m:
          analysis15.adx,

        adx1h:
          analysis1h.adx,

        atr15m:
          analysis15.atr,

        goldTrendDirection:
          symbol === "XAU/USD"
            ? goldTrendDirection
            : null,

        goldAlignment:
          symbol === "XAU/USD"
            ? goldAlignment
            : null,

        buyReasons15m:
          analysis15.buyReasons,

        sellReasons15m:
          analysis15.sellReasons,

        buyReasons1h:
          analysis1h.buyReasons,

        sellReasons1h:
          analysis1h.sellReasons
      }
    };
  }


  // ==========================================================
  // ENTRY / ATR
  // ==========================================================

  const entry =
    analysis15.price;

  const atrValue =
    analysis15.atr;


  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(atrValue) ||
    entry <= 0 ||
    atrValue <= 0
  ) {

    return {
      signal: null,

      diagnostics: {
        symbol,
        status: "REJECTED",

        reason:
          "INVALID_PRICE_OR_ATR",

        entry,
        atr:
          atrValue,

        score
      }
    };
  }


  const atrPercent =
    atrValue /
    entry *
    100;


  if (
    atrPercent <
    CONFIG.minAtrPercent
  ) {

    return {
      signal: null,

      diagnostics: {
        symbol,
        status: "REJECTED",

        reason:
          "ATR_TOO_LOW",

        atr:
          atrValue,

        atrPercent,

        requiredAtrPercent:
          CONFIG.minAtrPercent,

        score
      }
    };
  }


  // ==========================================================
  // RISK / REWARD
  // ==========================================================

  const risk =
    atrValue *
    CONFIG.atrMultiplier;

  let stopLoss;
  let tp1;
  let tp2;


  if (
    direction === "BUY"
  ) {

    stopLoss =
      entry - risk;

    tp1 =
      entry +
      risk * CONFIG.tp1R;

    tp2 =
      entry +
      risk * CONFIG.tp2R;

  } else {

    stopLoss =
      entry + risk;

    tp1 =
      entry -
      risk * CONFIG.tp1R;

    tp2 =
      entry -
      risk * CONFIG.tp2R;
  }


  const strength =
    score >=
    CONFIG.strongScore
      ? "STRONG"
      : "GOOD";


  // ==========================================================
  // FINAL SIGNAL
  // ==========================================================

  const signal = {
    symbol,

    direction,

    strength,

    score,

    confidence:
      score,

    entry,

    stopLoss,

    tp1,

    tp2,

    atr:
      atrValue,

    atrPercent,

    timeframe:
      CONFIG.signalInterval,

    confirmationTimeframe:
      CONFIG.confirmInterval,

    reasons,

    analysis: {
      signal15m:
        analysis15,

      confirmation1h:
        analysis1h,

      gold:
        symbol === "XAU/USD"
          ? {
              trend:
                goldTrendDirection,

              alignment:
                goldAlignment,

              adx15m:
                analysis15.adx,

              adx1h:
                analysis1h.adx
            }
          : null
    }
  };


  return {
    signal,

    diagnostics: {
      symbol,

      status:
        "APPROVED",

      direction,

      score,

      buyScore:
        finalBuyScore,

      sellScore:
        finalSellScore,

      scoreGap:
        gap,

      atrPercent,

      goldTrendDirection:
        symbol === "XAU/USD"
          ? goldTrendDirection
          : null,

      goldAlignment:
        symbol === "XAU/USD"
          ? goldAlignment
          : null
    }
  };
}


// ============================================================
// OPEN SIGNAL COUNT
// ============================================================

async function getOpenSignalCount(env) {

  const row =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE status = 'OPEN'`
    ).first();

  return Number(
    row?.count || 0
  );
}


// ============================================================
// COOLDOWN
// ============================================================

async function recentlySignaled(
  env,
  symbol
) {

  const cutoff =
    new Date(
      Date.now() -
      CONFIG.cooldownMinutes *
      60000
    ).toISOString();

  const row =
    await env.DB.prepare(
`SELECT id
FROM signals
WHERE symbol = ?
AND created_at >= ?
ORDER BY id DESC
LIMIT 1`
    )
    .bind(
      symbol,
      cutoff
    )
    .first();

  return Boolean(row);
}


// ============================================================
// SAVE SIGNAL
// ============================================================

async function saveSignal(
  env,
  signal
) {

  const now =
    new Date().toISOString();

  const result =
    await env.DB.prepare(
`INSERT INTO signals
(
  symbol,
  direction,
  score,
  confidence,
  entry,
  stop_loss,
  tp1,
  tp2,
  atr,
  timeframe,
  confirmation_timeframe,
  status,
  reason,
  created_at
)
VALUES
(
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?,
  ?
)`
    )
    .bind(
      signal.symbol,
      signal.direction,
      signal.score,
      signal.confidence,
      signal.entry,
      signal.stopLoss,
      signal.tp1,
      signal.tp2,
      signal.atr,
      signal.timeframe,
      signal.confirmationTimeframe,
      "OPEN",
      JSON.stringify({
        strength:
          signal.strength,

        reasons:
          signal.reasons,

        analysis:
          signal.analysis
      }),
      now
    )
    .run();

  return result.meta.last_row_id;
}


// ============================================================
// PRICE FORMAT
// ============================================================

function formatPrice(value) {

  if (
    !Number.isFinite(value)
  ) {
    return "-";
  }

  if (
    Math.abs(value) >= 1000
  ) {
    return value.toFixed(2);
  }

  if (
    Math.abs(value) >= 100
  ) {
    return value.toFixed(3);
  }

  return value.toFixed(5);
}


// ============================================================
// TELEGRAM FORMAT
// ============================================================

function formatSignal(
  signal
) {

  const emoji =
    signal.direction === "BUY"
      ? "🟢"
      : "🔴";

  const reasons =
    signal.reasons
      .slice(0, 10)
      .map(
        x => "• " + x
      )
      .join("\n");

  return `${emoji} ${signal.strength} SIGNAL

${signal.symbol}

Direction: ${signal.direction}

🔥 Strength: ${signal.score}/100

Entry: ${formatPrice(signal.entry)}

🛑 Stop Loss:
${formatPrice(signal.stopLoss)}

🎯 TP1:
${formatPrice(signal.tp1)}

🎯 TP2:
${formatPrice(signal.tp2)}

Timeframe: ${signal.timeframe}
Confirmation: ${signal.confirmationTimeframe}

Technical confirmations:
${reasons}

Risk model: ${CONFIG.riskPercent}%`;
}


// ============================================================
// TELEGRAM BROADCAST
// ============================================================

async function sendTelegram(
  env,
  text
) {

  const token =
    getTelegramToken(env);

  if (!token) {

    return {
      sent: false,
      reason:
        "Telegram token missing"
    };
  }

  const result =
    await env.DB.prepare(
`SELECT chat_id
FROM subscribers
WHERE active = 1`
    ).all();

  let sent = 0;

  for (
    const subscriber
    of result.results || []
  ) {

    try {

      const response =
        await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",

            headers: {
              "content-type":
                "application/json"
            },

            body:
              JSON.stringify({
                chat_id:
                  subscriber.chat_id,
                text
              })
          }
        );

      if (response.ok) {
        sent++;
      }

    } catch (error) {

      console.error(
        "Telegram error",
        error
      );
    }
  }

  return {
    sent: true,
    recipients: sent
  };
}


// ============================================================
// MAIN ENGINE
// ============================================================

async function runEngine(env) {

  if (!env.DB) {
    throw new Error(
      "D1 binding DB is missing"
    );
  }

  await ensureDatabase(env);


  const openSignals =
    await getOpenSignalCount(
      env
    );


  const diagnostics = [];
  const errors = [];
  const generated = [];


  if (
    openSignals >=
    CONFIG.maxOpenSignals
  ) {

    return {
      ok: true,
      version: "V5.2",
      generated: [],
      generatedCount: 0,
      openSignals,
      message:
        "Maximum open signals reached",
      diagnostics: [],
      time:
        new Date().toISOString()
    };
  }


  // XAU/USD is always processed first.
  for (
    const symbol
    of CONFIG.symbols
  ) {

    if (
      generated.length >=
      CONFIG.maxNewSignalsPerRun
    ) {
      break;
    }


    try {

      if (
        await recentlySignaled(
          env,
          symbol
        )
      ) {

        diagnostics.push({
          symbol,
          status: "SKIPPED",
          reason: "COOLDOWN"
        });

        continue;
      }


      const candles15 =
        await getCandles(
          env,
          symbol,
          CONFIG.signalInterval,
          CONFIG.candles15
        );


      const candles1h =
        await getCandles(
          env,
          symbol,
          CONFIG.confirmInterval,
          CONFIG.candles1h
        );


      const result =
        buildSignal(
          symbol,
          candles15,
          candles1h
        );


      diagnostics.push(
        result.diagnostics
      );


      if (!result.signal) {
        continue;
      }


      const signal =
        result.signal;


      const signalId =
        await saveSignal(
          env,
          signal
        );


      await env.DB.prepare(
`INSERT INTO signal_events
(
  signal_id,
  event,
  price,
  details,
  created_at
)
VALUES
(
  ?,
  ?,
  ?,
  ?,
  ?
)`
      )
      .bind(
        signalId,
        "CREATED",
        signal.entry,
        JSON.stringify(signal),
        new Date().toISOString()
      )
      .run();


      const telegram =
        await sendTelegram(
          env,
          formatSignal(signal)
        );


      generated.push({
        id: signalId,
        ...signal,
        telegram
      });


    } catch (error) {

      const message =
        error?.message ||
        String(error);

      console.error(
        "Symbol processing error:",
        symbol,
        message
      );


      errors.push({
        symbol,
        error: message
      });
    }
  }


  return {
    ok: true,

    version: "V5.2",

    generated,

    generatedCount:
      generated.length,

    diagnostics,

    errors,

    prioritySymbol:
      "XAU/USD",

    config: {
      minScore:
        CONFIG.minScore,

      strongScore:
        CONFIG.strongScore,

      minScoreGap:
        CONFIG.minScoreGap,

      minAtrPercent:
        CONFIG.minAtrPercent,

      goldPriorityBonus:
        CONFIG.goldPriorityBonus,

      goldMinAdx15:
        CONFIG.goldMinAdx15,

      goldMinAdx1h:
        CONFIG.goldMinAdx1h,

      goldAlignmentBonus:
        CONFIG.goldAlignmentBonus,

      goldTrendBonus:
        CONFIG.goldTrendBonus
    },

    time:
      new Date().toISOString()
  };
}


// ============================================================
// API SIGNALS
// ============================================================

async function apiSignals(env) {

  if (!env.DB) {

    return json({
      ok: false,
      error:
        "D1 binding DB is missing"
    }, 500);
  }

  await ensureDatabase(env);


  const result =
    await env.DB.prepare(
`SELECT
  id,
  symbol,
  direction,
  score,
  confidence,
  entry,
  stop_loss,
  tp1,
  tp2,
  atr,
  timeframe,
  confirmation_timeframe,
  status,
  reason,
  created_at,
  closed_at
FROM signals
ORDER BY id DESC
LIMIT 50`
    ).all();


  return json({
    ok: true,

    count:
      result.results?.length || 0,

    signals:
      result.results || []
  });
}


// ============================================================
// API STATS
// ============================================================

async function apiStats(env) {

  if (!env.DB) {

    return json({
      ok: false,
      error:
        "D1 binding DB is missing"
    }, 500);
  }

  await ensureDatabase(env);


  const total =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals`
    ).first();


  const open =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE status = 'OPEN'`
    ).first();


  const buy =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE direction = 'BUY'`
    ).first();


  const sell =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE direction = 'SELL'`
    ).first();


  const gold =
    await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE symbol = 'XAU/USD'`
    ).first();


  return json({
    ok: true,

    version: "V5.2",

    totalSignals:
      Number(total?.count || 0),

    openSignals:
      Number(open?.count || 0),

    buySignals:
      Number(buy?.count || 0),

    sellSignals:
      Number(sell?.count || 0),

    goldSignals:
      Number(gold?.count || 0),

    time:
      new Date().toISOString()
  });
}


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

async function telegramWebhook(
  request,
  env
) {

  if (
    request.method !== "POST"
  ) {

    return json({
      ok: true,
      message:
        "Telegram webhook endpoint"
    });
  }


  if (!env.DB) {

    return json({
      ok: false,
      error:
        "D1 binding DB is missing"
    }, 500);
  }


  await ensureDatabase(env);


  const update =
    await request.json();

  const message =
    update.message;


  if (!message) {
    return json({
      ok: true
    });
  }


  const chatId =
    String(
      message.chat.id
    );

  const username =
    message.from?.username ||
    "";

  const text =
    String(
      message.text || ""
    ).trim();

  const now =
    new Date().toISOString();


  await env.DB.prepare(
`INSERT INTO subscribers
(
  chat_id,
  username,
  active,
  created_at,
  updated_at
)
VALUES
(
  ?,
  ?,
  1,
  ?,
  ?
)
ON CONFLICT(chat_id)
DO UPDATE SET
username = excluded.username,
active = 1,
updated_at = excluded.updated_at`
  )
  .bind(
    chatId,
    username,
    now,
    now
  )
  .run();


  if (
    text === "/start"
  ) {

    await sendTelegramToChat(
      env,
      chatId,
`GOLD & FOREX SIGNAL ENGINE V5.2

You are subscribed.

XAU/USD is the priority market.

Gold is analyzed using 15m + 1h confirmation.

Commands:

/start
/signals
/stats`
    );

  }


  else if (
    text === "/signals"
  ) {

    const result =
      await env.DB.prepare(
`SELECT
  symbol,
  direction,
  score,
  entry,
  stop_loss,
  tp1,
  tp2,
  created_at
FROM signals
ORDER BY id DESC
LIMIT 5`
      ).all();


    let output =
      "LATEST SIGNALS\n\n";


    for (
      const signal
      of result.results || []
    ) {

      output +=
`${signal.symbol} ${signal.direction}
Strength: ${signal.score}/100
Entry: ${signal.entry}
SL: ${signal.stop_loss}
TP1: ${signal.tp1}
TP2: ${signal.tp2}

`;
    }


    await sendTelegramToChat(
      env,
      chatId,
      output
    );

  }


  else if (
    text === "/stats"
  ) {

    const total =
      await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals`
      ).first();


    const open =
      await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE status = 'OPEN'`
      ).first();


    const gold =
      await env.DB.prepare(
`SELECT COUNT(*) AS count
FROM signals
WHERE symbol = 'XAU/USD'`
      ).first();


    await sendTelegramToChat(
      env,
      chatId,
`GOLD & FOREX ENGINE V5.2

Total signals: ${total?.count || 0}

Open signals: ${open?.count || 0}

XAU/USD signals: ${gold?.count || 0}`
    );
  }


  return json({
    ok: true
  });
}


// ============================================================
// TELEGRAM CHAT
// ============================================================

async function sendTelegramToChat(
  env,
  chatId,
  text
) {

  const token =
    getTelegramToken(env);

  if (!token) {
    return false;
  }


  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            chat_id: chatId,
            text
          })
      }
    );


  return response.ok;
}


// ============================================================
// TELEGRAM SETUP
// ============================================================

async function setupTelegramWebhook(
  env
) {

  const token =
    getTelegramToken(env);

  if (!token) {

    return json({
      ok: false,
      error:
        "Telegram token missing"
    }, 500);
  }


  const webhook =
    "https://forex-signal-engine.hakima09360.workers.dev/telegram/webhook";


  const response =
    await fetch(
      `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhook)}`
    );


  const data =
    await response.json();


  return json({
    ok: Boolean(data.ok),
    telegram: data
  });
}


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);


    try {

      // HOME
      if (
        url.pathname === "/" ||
        url.pathname === ""
      ) {

        return html(
          homePage()
        );
      }


      // HEALTH
      if (
        url.pathname === "/health"
      ) {

        return health(env);
      }


      // ROBOTS
      if (
        url.pathname === "/robots.txt"
      ) {

        return robotsTxt();
      }


      // SITEMAP
      if (
        url.pathname === "/sitemap.xml"
      ) {

        return sitemapXml();
      }


      // MANUAL RUN
      if (
        url.pathname === "/run"
      ) {

        const result =
          await runEngine(env);

        return json(result);
      }


      // SIGNALS
      if (
        url.pathname ===
        "/api/signals"
      ) {

        return apiSignals(env);
      }


      // STATS
      if (
        url.pathname ===
        "/api/stats"
      ) {

        return apiStats(env);
      }


      // TELEGRAM
      if (
        url.pathname ===
        "/telegram/webhook"
      ) {

        return telegramWebhook(
          request,
          env
        );
      }


      // TELEGRAM SETUP
      if (
        url.pathname ===
        "/setup-chat"
      ) {

        return setupTelegramWebhook(
          env
        );
      }


      return json({
        ok: false,
        error: "Not found"
      }, 404);


    } catch (error) {

      console.error(
        "Worker error:",
        error
      );


      return json({
        ok: false,
        error:
          error?.message ||
          String(error)
      }, 500);
    }
  },


  async scheduled(
    controller,
    env,
    ctx
  ) {

    ctx.waitUntil(
      runEngine(env)
        .catch(error => {

          console.error(
            "Scheduled engine error:",
            error
          );

        })
    );
  }

};
