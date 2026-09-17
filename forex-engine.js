// ============================================================
// FOREX SIGNAL ENGINE V5.2
// GOLD FOCUS - XAU/USD
// Cloudflare Worker + Twelve Data + Telegram
//
// Primary: XAU/USD
// Analysis: 15M + 1H confirmation
//
// Indicators:
// EMA 20 / 50 / 200
// RSI 14
// MACD 12 / 26 / 9
// ATR 14
// ADX 14
// Momentum
// Breakout
//
// Endpoints:
// /
// /health
// /api/signals
// /api/stats
// /run
// /telegram-test
// ============================================================

const CONFIG = {
  version: "V5.2",

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

  minScore: 65,
  strongScore: 80,

  signalCooldownMinutes: 15,

  timezone: "UTC"
};

// ============================================================
// SECRET HELPERS
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

      if (path === "/" || path === "/health") {
        const telegramToken = getTelegramToken(env);
        const telegramChatId = getTelegramChatId(env);
        const twelveKey = getTwelveDataKey(env);

        return jsonResponse({
          ok: true,
          service: "موتور سیگنال فارکس",
          version: CONFIG.version,
          focus: CONFIG.primarySymbol,
          analysis: "15M + 1H",
          indicators: [
            "EMA 20", "EMA 50", "EMA 200", "RSI 14",
            "MACD 12/26/9", "ATR 14", "ADX 14", "Momentum", "Breakout"
          ],
          connections: {
            twelve_data: !!twelveKey,
            telegram: !!(telegramToken && telegramChatId)
          },
          telegram: !!(telegramToken && telegramChatId),
          timestamp: new Date().toISOString()
        });
      }

      if (path === "/api/signals") {
        const signals = await generateAllSignals(env);

        return jsonResponse({
          ok: true,
          version: CONFIG.version,
          focus: CONFIG.primarySymbol,
          count: signals.length,
          signals,
          timestamp: new Date().toISOString()
        });
      }

      if (path === "/api/stats") {
        return jsonResponse(await getStats(env));
      }

      if (path === "/run") {
        const result = await runEngine(env);
        return jsonResponse(result);
      }

      if (path === "/telegram-test") {
        const result = await testTelegram(env);
        return jsonResponse(result);
      }

      return jsonResponse(
        {
          ok: false,
          error: "Not Found",
          endpoints: ["/health", "/api/signals", "/api/stats", "/run", "/telegram-test"]
        },
        404
      );

    } catch (error) {
      console.error("ENGINE ERROR:", error);

      return jsonResponse(
        {
          ok: false,
          version: CONFIG.version,
          error: error?.message || String(error),
          timestamp: new Date().toISOString()
        },
        500
      );
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runEngine(env).catch(error => {
        console.error("SCHEDULED ENGINE ERROR:", error);
      })
    );
  }
};

// ============================================================
// RUN ENGINE
// ============================================================

async function runEngine(env) {
  const startedAt = Date.now();
  const signals = await generateAllSignals(env);
  const sent = [];

  for (const signal of signals) {
    if (signal.symbol === CONFIG.primarySymbol || signal.signal !== "WAIT") {
      const result = await processSignal(signal, env);
      sent.push({
        symbol: signal.symbol,
        signal: signal.signal,
        score: signal.score,
        telegram: result.telegram,
        reason: result.reason || null
      });
    }
  }

  return {
    ok: true,
    version: CONFIG.version,
    priority: CONFIG.primarySymbol,
    generated: signals.length,
    signals,
    delivery: sent,
    execution_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// GENERATE ALL SIGNALS
// ============================================================

async function generateAllSignals(env) {
  const results = [];

  const orderedSymbols = [
    CONFIG.primarySymbol,
    ...CONFIG.symbols.filter(symbol => symbol !== CONFIG.primarySymbol)
  ];

  // Run symbol analyses concurrently instead of sequentially.
  // This matters because each analysis makes 2 HTTP calls (15m + 1h candles)
  // to Twelve Data; running 4 symbols one-by-one means waiting on 8 sequential
  // network round trips, which is the single biggest cause of slow /api/signals
  // responses and, on a tight Worker CPU/wall-time budget, timeouts.
  const settled = await Promise.allSettled(
    orderedSymbols.map(symbol => analyzeSymbol(symbol, env))
  );

  settled.forEach((outcome, i) => {
    const symbol = orderedSymbols[i];

    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      const error = outcome.reason;
      console.error(`ANALYSIS ERROR ${symbol}:`, error);

      results.push({
        ok: false,
        symbol,
        signal: "WAIT",
        score: 0,
        error: error?.message || String(error),
        timestamp: new Date().toISOString()
      });
    }
  });

  return results;
}

// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(symbol, env) {
  const [candles15m, candles1h] = await Promise.all([
    getCandles(symbol, CONFIG.interval, CONFIG.outputsize15m, env),
    getCandles(symbol, CONFIG.confirmationInterval, CONFIG.outputsize1h, env)
  ]);

  if (candles15m.length < 220) {
    throw new Error(`${symbol}: insufficient 15M candles (${candles15m.length})`);
  }

  if (candles1h.length < 220) {
    throw new Error(`${symbol}: insufficient 1H candles (${candles1h.length})`);
  }

  const indicators15m = calculateIndicators(candles15m);
  const indicators1h = calculateIndicators(candles1h);

  const trend15m = determineTrend(indicators15m);
  const trend1h = determineTrend(indicators1h);

  const momentum15m = calculateMomentum(candles15m);
  const breakout15m = calculateBreakout(candles15m);

  const score = calculateSignalScore({
    indicators15m, indicators1h, trend15m, trend1h, momentum15m, breakout15m
  });

  const signal = scoreToSignal(score, trend15m, trend1h);
  const strength = getStrength(score);
  const last = candles15m[candles15m.length - 1];

  return {
    ok: true,
    version: CONFIG.version,
    symbol,
    priority: symbol === CONFIG.primarySymbol,
    timeframe: CONFIG.interval,
    confirmation_timeframe: CONFIG.confirmationInterval,
    signal,
    strength,
    score,
    price: round(last.close, 5),
    trend_15m: trend15m,
    trend_1h: trend1h,
    indicators: {
      ema20_15m: round(indicators15m.ema20),
      ema50_15m: round(indicators15m.ema50),
      ema200_15m: round(indicators15m.ema200),
      ema20_1h: round(indicators1h.ema20),
      ema50_1h: round(indicators1h.ema50),
      ema200_1h: round(indicators1h.ema200),
      rsi14: round(indicators15m.rsi),
      macd: round(indicators15m.macd),
      macd_signal: round(indicators15m.macdSignal),
      macd_histogram: round(indicators15m.macdHistogram),
      atr14: round(indicators15m.atr),
      adx14: round(indicators15m.adx),
      plusDI: round(indicators15m.plusDI),
      minusDI: round(indicators15m.minusDI),
      momentum: round(momentum15m, 4),
      breakout: breakout15m.type
    },
    analysis: {
      ema: indicators15m.emaStatus,
      rsi: indicators15m.rsiStatus,
      macd: indicators15m.macdStatus,
      adx: indicators15m.adxStatus,
      momentum: momentum15m > 0 ? "BULLISH" : momentum15m < 0 ? "BEARISH" : "NEUTRAL",
      breakout: breakout15m.type,
      multi_timeframe: trend1h === trend15m ? "CONFIRMED" : "MIXED"
    },
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// TWELVE DATA
// ============================================================

async function getCandles(symbol, interval, outputsize, env) {
  const apiKey = getTwelveDataKey(env);

  if (!apiKey) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    "&format=JSON" +
    `&apikey=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Twelve Data HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.status === "error") {
    throw new Error(data.message || "Twelve Data error");
  }

  if (!Array.isArray(data.values)) {
    throw new Error(`No candle data for ${symbol} ${interval}`);
  }

  return data.values
    .map(x => ({
      datetime: x.datetime,
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume || 0)
    }))
    .filter(x =>
      Number.isFinite(x.open) &&
      Number.isFinite(x.high) &&
      Number.isFinite(x.low) &&
      Number.isFinite(x.close)
    )
    .reverse();
}

// ============================================================
// INDICATORS
// ============================================================

function calculateIndicators(candles) {
  const closes = candles.map(x => x.close);
  const highs = candles.map(x => x.high);
  const lows = candles.map(x => x.low);

  const ema20 = EMA(closes, 20);
  const ema50 = EMA(closes, 50);
  const ema200 = EMA(closes, 200);

  const rsi = RSI(closes, 14);
  const macdData = MACD(closes, 12, 26, 9);
  const atr = ATR(highs, lows, closes, 14);
  const adxData = ADX(highs, lows, closes, 14);

  const lastClose = closes[closes.length - 1];

  let emaStatus = "NEUTRAL";
  if (lastClose > ema20 && ema20 > ema50 && ema50 > ema200) {
    emaStatus = "BULLISH";
  } else if (lastClose < ema20 && ema20 < ema50 && ema50 < ema200) {
    emaStatus = "BEARISH";
  }

  let rsiStatus = "NEUTRAL";
  if (rsi >= 55 && rsi <= 70) {
    rsiStatus = "BULLISH";
  } else if (rsi <= 45 && rsi >= 30) {
    rsiStatus = "BEARISH";
  } else if (rsi > 70) {
    rsiStatus = "OVERBOUGHT";
  } else if (rsi < 30) {
    rsiStatus = "OVERSOLD";
  }

  let macdStatus = "NEUTRAL";
  if (macdData.macd > macdData.signal && macdData.histogram > 0) {
    macdStatus = "BULLISH";
  } else if (macdData.macd < macdData.signal && macdData.histogram < 0) {
    macdStatus = "BEARISH";
  }

  let adxStatus = "WEAK";
  if (adxData.adx >= 25) {
    adxStatus = "STRONG";
  } else if (adxData.adx >= 20) {
    adxStatus = "MODERATE";
  }

  return {
    ema20, ema50, ema200,
    rsi,
    macd: macdData.macd,
    macdSignal: macdData.signal,
    macdHistogram: macdData.histogram,
    atr,
    adx: adxData.adx,
    plusDI: adxData.plusDI,
    minusDI: adxData.minusDI,
    emaStatus, rsiStatus, macdStatus, adxStatus
  };
}

// ============================================================
// EMA
// ============================================================
// FIX: previously, when values.length < period this returned a single
// price (values[values.length-1]) disguised as an "EMA", silently
// corrupting trend/score logic for EMA200 on shorter series with no
// error. Now it computes a proper EMA seeded over whatever data is
// available instead of pretending to have a period-length average.

function EMA(values, period) {
  if (values.length === 0) return 0;

  const effectivePeriod = Math.min(period, values.length);
  const multiplier = 2 / (effectivePeriod + 1);

  let ema =
    values.slice(0, effectivePeriod).reduce((a, b) => a + b, 0) /
    effectivePeriod;

  for (let i = effectivePeriod; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// ============================================================
// RSI
// ============================================================

function RSI(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================
// MACD
// ============================================================
// FIX: the original implementation recomputed EMA(fast) and EMA(slow)
// from scratch (O(n) each) inside a loop that runs ~(n - slowPeriod)
// times, making the whole function O(n^2). With 250 candles across
// 4 symbols x 2 timeframes = 8 calls per request, this was almost
// certainly the main cause of slow/timing-out /api/signals and /run
// responses on Cloudflare Workers' CPU time limit.
//
// This version computes the fast and slow EMA *series* in a single
// O(n) pass each, derives the MACD line as their difference at every
// point, then EMA-smooths that MACD series once for the signal line.
// Same output, linear time.

function EMA_series(values, period) {
  const series = new Array(values.length).fill(null);
  if (values.length === 0) return series;

  const effectivePeriod = Math.min(period, values.length);
  const multiplier = 2 / (effectivePeriod + 1);

  let ema =
    values.slice(0, effectivePeriod).reduce((a, b) => a + b, 0) /
    effectivePeriod;

  series[effectivePeriod - 1] = ema;

  for (let i = effectivePeriod; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    series[i] = ema;
  }

  // Backfill the warm-up region so the series has no nulls, using the
  // first computed value — keeps indices aligned with `values`.
  for (let i = 0; i < effectivePeriod - 1; i++) {
    series[i] = series[effectivePeriod - 1];
  }

  return series;
}

function MACD(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fastSeries = EMA_series(values, fastPeriod);
  const slowSeries = EMA_series(values, slowPeriod);

  const macdSeries = values.map((_, i) => fastSeries[i] - slowSeries[i]);

  const macd = macdSeries[macdSeries.length - 1];

  const signal =
    macdSeries.length >= signalPeriod
      ? EMA(macdSeries, signalPeriod)
      : macd;

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// ============================================================
// ATR
// ============================================================

function ATR(highs, lows, closes, period = 14) {
  const trs = [];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  if (trs.length < period) {
    return 0;
  }

  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

// ============================================================
// ADX + DI
// ============================================================

function ADX(highs, lows, closes, period = 14) {
  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];

    const trueRange = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );

    tr.push(trueRange);
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  if (tr.length < period * 2) {
    return { adx: 0, plusDI: 0, minusDI: 0 };
  }

  let atr = average(tr.slice(0, period));
  let plus = average(plusDM.slice(0, period));
  let minus = average(minusDM.slice(0, period));

  const dxValues = [];

  let plusDI = atr === 0 ? 0 : (100 * plus) / atr;
  let minusDI = atr === 0 ? 0 : (100 * minus) / atr;

  let dx =
    plusDI + minusDI === 0
      ? 0
      : (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI);

  dxValues.push(dx);

  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    plus = (plus * (period - 1) + plusDM[i]) / period;
    minus = (minus * (period - 1) + minusDM[i]) / period;

    plusDI = atr === 0 ? 0 : (100 * plus) / atr;
    minusDI = atr === 0 ? 0 : (100 * minus) / atr;

    dx =
      plusDI + minusDI === 0
        ? 0
        : (100 * Math.abs(plusDI - minusDI)) / (plusDI + minusDI);

    dxValues.push(dx);
  }

  let adx = average(dxValues.slice(0, Math.min(period, dxValues.length)));

  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return { adx, plusDI, minusDI };
}

// ============================================================
// MOMENTUM
// ============================================================

function calculateMomentum(candles) {
  const closes = candles.map(x => x.close);

  if (closes.length < 11) {
    return 0;
  }

  const current = closes[closes.length - 1];
  const previous = closes[closes.length - 11];

  if (previous === 0) {
    return 0;
  }

  return ((current - previous) / previous) * 100;
}

// ============================================================
// BREAKOUT
// ============================================================

function calculateBreakout(candles) {
  const lookback = 20;

  if (candles.length <= lookback) {
    return { type: "NONE" };
  }

  const last = candles[candles.length - 1];
  const previous = candles.slice(
    candles.length - lookback - 1,
    candles.length - 1
  );

  const highest = Math.max(...previous.map(x => x.high));
  const lowest = Math.min(...previous.map(x => x.low));

  if (last.close > highest) {
    return { type: "BULLISH_BREAKOUT", level: highest };
  }

  if (last.close < lowest) {
    return { type: "BEARISH_BREAKOUT", level: lowest };
  }

  return { type: "NONE", resistance: highest, support: lowest };
}

// ============================================================
// TREND
// ============================================================

function determineTrend(indicators) {
  const bullish =
    indicators.ema20 > indicators.ema50 &&
    indicators.ema50 > indicators.ema200 &&
    indicators.macd > indicators.macdSignal &&
    indicators.plusDI > indicators.minusDI;

  const bearish =
    indicators.ema20 < indicators.ema50 &&
    indicators.ema50 < indicators.ema200 &&
    indicators.macd < indicators.macdSignal &&
    indicators.minusDI > indicators.plusDI;

  if (bullish) return "BULLISH";
  if (bearish) return "BEARISH";
  return "NEUTRAL";
}

// ============================================================
// SCORE
// ============================================================

function calculateSignalScore({
  indicators15m, indicators1h, trend15m, trend1h, momentum15m, breakout15m
}) {
  let bullish = 0;
  let bearish = 0;

  if (indicators15m.ema20 > indicators15m.ema50) bullish += 10;
  if (indicators15m.ema20 < indicators15m.ema50) bearish += 10;

  if (indicators15m.ema50 > indicators15m.ema200) bullish += 10;
  if (indicators15m.ema50 < indicators15m.ema200) bearish += 10;

  if (trend1h === "BULLISH") bullish += 20;
  if (trend1h === "BEARISH") bearish += 20;

  if (indicators15m.rsi >= 50 && indicators15m.rsi <= 70) bullish += 10;
  if (indicators15m.rsi <= 50 && indicators15m.rsi >= 30) bearish += 10;

  if (indicators15m.macd > indicators15m.macdSignal) bullish += 10;
  if (indicators15m.macd < indicators15m.macdSignal) bearish += 10;

  if (indicators15m.adx >= 25) {
    if (indicators15m.plusDI > indicators15m.minusDI) bullish += 10;
    if (indicators15m.minusDI > indicators15m.plusDI) bearish += 10;
  }

  if (momentum15m > 0) bullish += 5;
  if (momentum15m < 0) bearish += 5;

  if (breakout15m.type === "BULLISH_BREAKOUT") bullish += 15;
  if (breakout15m.type === "BEARISH_BREAKOUT") bearish += 15;

  if (trend15m === "BULLISH") bullish += 5;
  if (trend15m === "BEARISH") bearish += 5;

  return Math.min(100, Math.max(bullish, bearish));
}

// ============================================================
// SIGNAL
// ============================================================

function scoreToSignal(score, trend15m, trend1h) {
  if (trend15m === "BULLISH" && trend1h === "BEARISH") return "WAIT";
  if (trend15m === "BEARISH" && trend1h === "BULLISH") return "WAIT";

  if (score >= CONFIG.minScore && trend15m === "BULLISH" && trend1h === "BULLISH") {
    return "BUY";
  }

  if (score >= CONFIG.minScore && trend15m === "BEARISH" && trend1h === "BEARISH") {
    return "SELL";
  }

  return "WAIT";
}

// ============================================================
// STRENGTH
// ============================================================

function getStrength(score) {
  if (score >= CONFIG.strongScore) return "STRONG";
  if (score >= CONFIG.minScore) return "MODERATE";
  return "WEAK";
}

// ============================================================
// TELEGRAM PROCESS
// ============================================================

async function processSignal(signal, env) {
  const token = getTelegramToken(env);
  const chatId = getTelegramChatId(env);

  if (!token) {
    return { telegram: false, reason: "TELEGRAM_BOT_TOKEN missing" };
  }

  if (!chatId) {
    return { telegram: false, reason: "TELEGRAM_CHAT_ID missing" };
  }

  if (signal.signal !== "BUY" && signal.signal !== "SELL") {
    return { telegram: false, reason: "WAIT signal" };
  }

  const message = formatTelegramMessage(signal);
  const result = await sendTelegram(message, env);

  return {
    telegram: result.ok,
    reason: result.ok ? "Telegram sent" : result.error,
    response: result
  };
}

// ============================================================
// TELEGRAM MESSAGE
// ============================================================

function formatTelegramMessage(signal) {
  const emoji = signal.signal === "BUY" ? "🟢" : "🔴";
  const direction = signal.signal === "BUY" ? "خرید" : "فروش";

  return `
🥇 ${signal.symbol} — V5.2

${emoji} سیگنال: ${signal.signal} (${direction})

⏱ تایم‌فریم اصلی: 15M
🔎 تأیید روند: 1H

💰 قیمت: ${signal.price}

📊 امتیاز تحلیل: ${signal.score}/100
💪 قدرت: ${signal.strength}

📈 روند 15M: ${signal.trend_15m}
📈 روند 1H: ${signal.trend_1h}

━━ اندیکاتورها ━━

EMA 20: ${signal.indicators.ema20_15m}
EMA 50: ${signal.indicators.ema50_15m}
EMA 200: ${signal.indicators.ema200_15m}

RSI 14: ${signal.indicators.rsi14}

MACD: ${signal.indicators.macd}
Signal: ${signal.indicators.macd_signal}
Histogram: ${signal.indicators.macd_histogram}

ATR 14: ${signal.indicators.atr14}

ADX 14: ${signal.indicators.adx14}

+DI: ${signal.indicators.plusDI}
-DI: ${signal.indicators.minusDI}

Momentum: ${signal.indicators.momentum}%

Breakout:
${signal.indicators.breakout}

━━ تحلیل ━━

EMA: ${signal.analysis.ema}
RSI: ${signal.analysis.rsi}
MACD: ${signal.analysis.macd}
ADX: ${signal.analysis.adx}
Momentum: ${signal.analysis.momentum}
Breakout: ${signal.analysis.breakout}
MTF: ${signal.analysis.multi_timeframe}

🕐 ${signal.timestamp}

🚀 موتور تحلیل طلا و فارکس
V5.2 — Gold Focus
`.trim();
}

// ============================================================
// SEND TELEGRAM
// ============================================================

async function sendTelegram(message, env) {
  const token = getTelegramToken(env);
  const chatId = getTelegramChatId(env);

  if (!token) {
    return { ok: false, error: "Telegram bot token missing" };
  }

  if (!chatId) {
    return { ok: false, error: "Telegram chat ID missing" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        status: response.status,
        error: data.description || "Telegram API error"
      };
    }

    return {
      ok: true,
      status: response.status,
      message_id: data.result?.message_id || null
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

// ============================================================
// TELEGRAM TEST
// ============================================================

async function testTelegram(env) {
  const token = getTelegramToken(env);
  const chatId = getTelegramChatId(env);

  if (!token) {
    return { ok: false, telegram: false, error: "Telegram bot token is missing" };
  }

  if (!chatId) {
    return { ok: false, telegram: false, error: "Telegram chat ID is missing" };
  }

  const message = [
    "✅ تست اتصال موتور سیگنال فارکس",
    `نسخه: ${CONFIG.version}`,
    `تمرکز: ${CONFIG.primarySymbol}`,
    "وضعیت: اتصال Telegram برقرار است",
    new Date().toISOString()
  ].join("\n");

  const result = await sendTelegram(message, env);

  return {
    ok: result.ok,
    telegram: result.ok,
    result,
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// STATS
// ============================================================

async function getStats(env) {
  const token = getTelegramToken(env);
  const chatId = getTelegramChatId(env);
  const twelveKey = getTwelveDataKey(env);

  return {
    ok: true,
    version: CONFIG.version,
    engine: {
      status: "ONLINE",
      primary: CONFIG.primarySymbol,
      timeframe: CONFIG.interval,
      confirmation: CONFIG.confirmationInterval
    },
    symbols: CONFIG.symbols,
    indicators: [
      "EMA 20", "EMA 50", "EMA 200", "RSI 14",
      "MACD 12/26/9", "ATR 14", "ADX 14", "Momentum", "Breakout"
    ],
    connections: {
      twelve_data: !!twelveKey,
      telegram: !!(token && chatId)
    },
    telegram: {
      configured: !!(token && chatId),
      token: !!token,
      chat_id: !!chatId
    },
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// HELPERS
// ============================================================

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
