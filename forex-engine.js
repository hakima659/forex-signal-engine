// ============================================================
// FOREX SIGNAL ENGINE V4
// Cloudflare Worker + D1 + Twelve Data + Telegram
// Multi-Timeframe Forex Signal Engine
// ============================================================

const CONFIG = {
  symbols: [
    "EUR/USD",
    "GBP/USD",
    "USD/JPY",
    "XAU/USD"
  ],

  signalInterval: "15min",
  confirmInterval: "1h",

  candles15: 250,
  candles1h: 250,

  minScore: 80,
  minScoreGap: 15,

  atrMultiplier: 1.5,
  tp1R: 2,
  tp2R: 3,

  riskPercent: 0.5,

  cooldownMinutes: 60,

  maxNewSignalsPerRun: 1,
  maxOpenSignals: 2,

  minAtrPercent: 0.02
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

<title>Forex Signal Engine V4</title>

<meta name="description"
content="Multi-timeframe forex signal engine using EMA, RSI, MACD, ATR and ADX.">

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
}

h2{
  font-size:20px;
}

.badge{
  display:inline-block;
  padding:7px 12px;
  border-radius:20px;
  background:#1d3557;
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
<h1>Forex Signal Engine V4</h1>
<p class="badge">Multi-Timeframe Signal Engine</p>

<p>
15-minute signal analysis with 1-hour confirmation.
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
This system generates analytical trading signals.
It does not guarantee profit and does not execute broker trades.
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
// D1 DATABASE INITIALIZATION
// ============================================================

async function ensureDatabase(env) {

  if (!env.DB) {
    throw new Error(
      "D1 binding DB is missing"
    );
  }

  // ----------------------------------------------------------
  // SETTINGS
  // ----------------------------------------------------------

  await env.DB.prepare(
`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
)`
  ).run();


  // ----------------------------------------------------------
  // SUBSCRIBERS
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // SIGNALS
  // ----------------------------------------------------------

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


  // ----------------------------------------------------------
  // SIGNAL EVENTS
  // ----------------------------------------------------------

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
      version: "V4",
      database: result?.database_ok === 1
        ? "connected"
        : "error",
      time: new Date().toISOString()
    });

  } catch (error) {

    return json({
      ok: false,
      service: "forex-signal-engine",
      version: "V4",
      error: error?.message || String(error)
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


  // EMA
  if (
    ema20 !== null &&
    ema50 !== null &&
    ema200 !== null
  ) {

    if (
      last.close > ema20 &&
      ema20 > ema50 &&
      ema50 > ema200
    ) {
      buyScore += 25;
    }

    if (
      last.close < ema20 &&
      ema20 < ema50 &&
      ema50 < ema200
    ) {
      sellScore += 25;
    }
  }


  // RSI
  if (rsiValue !== null) {

    if (
      rsiValue >= 50 &&
      rsiValue < 70
    ) {
      buyScore += 15;
    }

    if (
      rsiValue <= 50 &&
      rsiValue > 30
    ) {
      sellScore += 15;
    }
  }


  // MACD
  if (macdValue) {

    if (
      macdValue.macd >
        macdValue.signal &&
      macdValue.histogram > 0
    ) {
      buyScore += 15;
    }

    if (
      macdValue.macd <
        macdValue.signal &&
      macdValue.histogram < 0
    ) {
      sellScore += 15;
    }
  }


  // ADX
  if (
    adxValue !== null &&
    adxValue >= 20
  ) {

    if (
      buyScore >= sellScore
    ) {
      buyScore += 10;
    } else {
      sellScore += 10;
    }
  }


  // Momentum
  if (momentum === 1) {
    buyScore += 10;
  }

  if (momentum === -1) {
    sellScore += 10;
  }


  // Breakout
  if (breakout === 1) {
    buyScore += 10;
  }

  if (breakout === -1) {
    sellScore += 10;
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
    sellScore
  };
}


// ============================================================
// BUILD SIGNAL
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
    return null;
  }


  // Ignore currently forming candles.
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


  const buyScore =
    analysis15.buyScore +
    analysis1h.buyScore;

  const sellScore =
    analysis15.sellScore +
    analysis1h.sellScore;


  let direction = null;

  if (
    buyScore >= CONFIG.minScore &&
    buyScore - sellScore >=
      CONFIG.minScoreGap
  ) {
    direction = "BUY";
  }

  if (
    sellScore >= CONFIG.minScore &&
    sellScore - buyScore >=
      CONFIG.minScoreGap
  ) {
    direction = "SELL";
  }

  if (!direction) {
    return null;
  }


  const score =
    Math.max(
      buyScore,
      sellScore
    );

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
    return null;
  }


  const atrPercent =
    atrValue /
    entry *
    100;


  if (
    atrPercent <
    CONFIG.minAtrPercent
  ) {
    return null;
  }


  const risk =
    atrValue *
    CONFIG.atrMultiplier;


  let stopLoss;
  let tp1;
  let tp2;


  if (direction === "BUY") {

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


  return {
    symbol,
    direction,
    score,
    confidence: score,
    entry,
    stopLoss,
    tp1,
    tp2,
    atr: atrValue,
    timeframe:
      CONFIG.signalInterval,
    confirmationTimeframe:
      CONFIG.confirmInterval,
    reason: {
      signal15m: analysis15,
      confirmation1h: analysis1h
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
      JSON.stringify(
        signal.reason
      ),
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

  return `${emoji} FOREX SIGNAL

Symbol: ${signal.symbol}
Direction: ${signal.direction}

Score: ${signal.score}/200

Entry: ${formatPrice(signal.entry)}
Stop Loss: ${formatPrice(signal.stopLoss)}

TP1: ${formatPrice(signal.tp1)}
TP2: ${formatPrice(signal.tp2)}

Timeframe: ${signal.timeframe}
Confirmation: ${signal.confirmationTimeframe}

Risk model: ${CONFIG.riskPercent}%

Analytical signal only.
No profit guarantee.`;
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


  if (
    openSignals >=
    CONFIG.maxOpenSignals
  ) {

    return {
      ok: true,
      version: "V4",
      message:
        "Maximum open signals reached",
      openSignals
    };

  }


  const generated = [];


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


      const signal =
        buildSignal(
          symbol,
          candles15,
          candles1h
        );


      if (!signal) {
        continue;
      }


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

      console.error(
        "Symbol processing error:",
        symbol,
        error
      );

    }

  }


  return {
    ok: true,
    version: "V4",
    generated,
    generatedCount:
      generated.length,
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


  return json({
    ok: true,
    version: "V4",
    totalSignals:
      Number(total?.count || 0),
    openSignals:
      Number(open?.count || 0),
    buySignals:
      Number(buy?.count || 0),
    sellSignals:
      Number(sell?.count || 0),
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
`FOREX SIGNAL ENGINE

You are subscribed.

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
Score: ${signal.score}
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


    await sendTelegramToChat(
      env,
      chatId,
`FOREX ENGINE STATS

Total signals: ${total?.count || 0}
Open signals: ${open?.count || 0}`
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
