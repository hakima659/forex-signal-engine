// ============================================================
// FOREX SIGNAL ENGINE V5.4 GOLD FOCUS
// Cloudflare Worker + Twelve Data + Telegram
// PRIMARY: XAU/USD
// ============================================================

const CONFIG = {
  version: "V5.4",
  name: "Gold Focus",

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

  // GOLD FILTER
  goldMinScore: 70,
  normalMinScore: 85,

  strongScore: 85,
  eliteScore: 92,

  minADX: 22,
  minDISpread: 5,
  minMomentum: 0.05,

  breakoutLookback: 20,

  candleBodyMin: 0.35,

  atrSLMultiplier: 0.70,

  tp1RiskReward: 1.50,
  tp2RiskReward: 2.50,
  tp3RiskReward: 3.50,

  limitATRMultiplier: 0.20,

  signalCooldownMinutes: 30,

  useClosedCandle: true
};

// ============================================================
// RUNTIME
// ============================================================

const cooldowns = new Map();

const STATS = {
  runs: 0,
  signals: 0,
  telegramSent: 0,
  telegramFailed: 0,
  lastRun: null,
  lastSignal: null
};

// ============================================================
// ENV
// ============================================================

function envValue(env, names) {
  for (const name of names) {
    if (
      env[name] !== undefined &&
      env[name] !== null &&
      String(env[name]).trim() !== ""
    ) {
      return String(env[name]).trim();
    }
  }

  return null;
}

function twelveKey(env) {
  return envValue(env, [
    "TWELVE_DATA_API_KEY",
    "کلید API دوازده داده",
    "کلید_API_دوازده_داده",
    "TWELVE_DATA_KEY"
  ]);
}

function telegramToken(env) {
  return envValue(env, [
    "TELEGRAM_BOT_TOKEN",
    "توکن_ربات_تلگرام",
    "توکن ربات تلگرام"
  ]);
}

function telegramChatId(env) {
  return envValue(env, [
    "TELEGRAM_CHAT_ID",
    "شناسه_چت_تلگرام",
    "آیدی_چت_تلگرام",
    "TELEGRAM_CHATID"
  ]);
}

// ============================================================
// RESPONSE
// ============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*"
      }
    }
  );
}

function html(data) {
  return new Response(data, {
    headers: {
      "content-type":
        "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function round(n, decimals = 2) {
  const x = Number(n);

  if (!Number.isFinite(x)) {
    return null;
  }

  return Number(x.toFixed(decimals));
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
  const key = twelveKey(env);

  if (!key) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url = new URL(
    "https://api.twelvedata.com/time_series"
  );

  url.searchParams.set(
    "symbol",
    symbol
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
    "format",
    "JSON"
  );

  url.searchParams.set(
    "apikey",
    key
  );

  const response =
    await fetch(url.toString());

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error" ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      data.message ||
      `Twelve Data error ${response.status}`
    );
  }

  const candles =
    data.values
      .map(x => ({
        datetime: x.datetime,
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close),
        volume:
          x.volume !== undefined
            ? Number(x.volume)
            : null
      }))
      .filter(x =>
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close)
      )
      .reverse();

  if (candles.length < 50) {
    throw new Error(
      `Not enough candles for ${symbol} ${interval}`
    );
  }

  if (
    CONFIG.useClosedCandle &&
    candles.length > 2
  ) {
    return candles.slice(0, -1);
  }

  return candles;
}

// ============================================================
// EMA
// ============================================================

function EMA(values, period) {
  if (values.length < period) {
    return [];
  }

  const multiplier =
    2 / (period + 1);

  let previous = 0;

  for (let i = 0; i < period; i++) {
    previous += values[i];
  }

  previous /= period;

  const result = [previous];

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    previous =
      ((values[i] - previous) *
        multiplier) +
      previous;

    result.push(previous);
  }

  return result;
}

function lastEMA(values, period) {
  const x = EMA(values, period);

  return x.length
    ? x[x.length - 1]
    : null;
}

// ============================================================
// RSI
// ============================================================

function RSI(values, period = 14) {
  if (values.length <= period) {
    return [];
  }

  let gain = 0;
  let loss = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain =
    gain / period;

  let avgLoss =
    loss / period;

  const result = [];

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    if (i > period) {
      const change =
        values[i] -
        values[i - 1];

      const g =
        change > 0
          ? change
          : 0;

      const l =
        change < 0
          ? Math.abs(change)
          : 0;

      avgGain =
        ((avgGain * (period - 1)) + g) /
        period;

      avgLoss =
        ((avgLoss * (period - 1)) + l) /
        period;
    }

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs =
        avgGain / avgLoss;

      result.push(
        100 -
        100 / (1 + rs)
      );
    }
  }

  return result;
}

// ============================================================
// MACD
// ============================================================

function MACD(
  values,
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {
  const fastEMA =
    EMA(values, fast);

  const slowEMA =
    EMA(values, slow);

  if (!slowEMA.length) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const offset =
    slow - fast;

  const line = [];

  for (
    let i = 0;
    i < slowEMA.length;
    i++
  ) {
    line.push(
      fastEMA[i + offset] -
      slowEMA[i]
    );
  }

  const signal =
    EMA(
      line,
      signalPeriod
    );

  if (!signal.length) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const m =
    line[line.length - 1];

  const s =
    signal[signal.length - 1];

  return {
    macd: m,
    signal: s,
    histogram: m - s
  };
}

// ============================================================
// ATR
// ============================================================

function ATR(candles, period = 14) {
  if (candles.length <= period) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const c = candles[i];
    const p = candles[i - 1];

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high - p.close
        ),
        Math.abs(
          c.low - p.close
        )
      )
    );
  }

  let value = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    value += tr[i];
  }

  value /= period;

  for (
    let i = period;
    i < tr.length;
    i++
  ) {
    value =
      ((value * (period - 1)) +
        tr[i]) /
      period;
  }

  return value;
}

// ============================================================
// ADX / DI
// ============================================================

function ADX(candles, period = 14) {
  if (
    candles.length <
    period * 2 + 5
  ) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
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
    const c = candles[i];
    const p = candles[i - 1];

    const up =
      c.high - p.high;

    const down =
      p.low - c.low;

    tr.push(
      Math.max(
        c.high - c.low,
        Math.abs(
          c.high - p.close
        ),
        Math.abs(
          c.low - p.close
        )
      )
    );

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

  function smooth(values) {
    let v = 0;

    for (
      let i = 0;
      i < period;
      i++
    ) {
      v += values[i];
    }

    v /= period;

    const result = [v];

    for (
      let i = period;
      i < values.length;
      i++
    ) {
      v =
        ((v * (period - 1)) +
          values[i]) /
        period;

      result.push(v);
    }

    return result;
  }

  const sTR = smooth(tr);
  const sPlus = smooth(plusDM);
  const sMinus = smooth(minusDM);

  const dx = [];
  const plus = [];
  const minus = [];

  for (
    let i = 0;
    i < sTR.length;
    i++
  ) {
    const p =
      sTR[i] === 0
        ? 0
        : 100 *
          sPlus[i] /
          sTR[i];

    const m =
      sTR[i] === 0
        ? 0
        : 100 *
          sMinus[i] /
          sTR[i];

    plus.push(p);
    minus.push(m);

    const sum = p + m;

    dx.push(
      sum === 0
        ? 0
        : 100 *
          Math.abs(p - m) /
          sum
    );
  }

  if (dx.length < period) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  const adxValues =
    smooth(dx);

  return {
    adx:
      adxValues[
        adxValues.length - 1
      ],

    plusDI:
      plus[
        plus.length - 1
      ],

    minusDI:
      minus[
        minus.length - 1
      ]
  };
}

// ============================================================
// MOMENTUM
// ============================================================

function Momentum(
  closes,
  period = 10
) {
  if (
    closes.length <= period
  ) {
    return null;
  }

  const now =
    closes[closes.length - 1];

  const old =
    closes[
      closes.length - 1 - period
    ];

  if (
    old === 0 ||
    !Number.isFinite(old)
  ) {
    return null;
  }

  return (
    ((now - old) / old) *
    100
  );
}

// ============================================================
// TREND
// ============================================================

function trend(
  price,
  e20,
  e50,
  e200
) {
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(e20) ||
    !Number.isFinite(e50) ||
    !Number.isFinite(e200)
  ) {
    return "NEUTRAL";
  }

  if (
    price > e20 &&
    e20 > e50 &&
    e50 > e200
  ) {
    return "BULLISH";
  }

  if (
    price < e20 &&
    e20 < e50 &&
    e50 < e200
  ) {
    return "BEARISH";
  }

  if (
    price > e50 &&
    e20 > e50
  ) {
    return "BULLISH";
  }

  if (
    price < e50 &&
    e20 < e50
  ) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

// ============================================================
// CANDLE
// ============================================================

function candleInfo(c) {
  const range =
    c.high - c.low;

  if (range <= 0) {
    return {
      direction: "NEUTRAL",
      ratio: 0
    };
  }

  const body =
    Math.abs(
      c.close - c.open
    );

  return {
    direction:
      c.close > c.open
        ? "BULLISH"
        : c.close < c.open
        ? "BEARISH"
        : "NEUTRAL",

    ratio:
      body / range
  };
}

// ============================================================
// BREAKOUT
// ============================================================

function breakout(
  candles,
  lookback
) {
  if (
    candles.length <=
    lookback + 1
  ) {
    return "NONE";
  }

  const current =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      candles.length -
        1 -
        lookback,

      candles.length - 1
    );

  const high =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const low =
    Math.min(
      ...previous.map(
        x => x.low
      )
    );

  if (
    current.close > high
  ) {
    return "BULLISH";
  }

  if (
    current.close < low
  ) {
    return "BEARISH";
  }

  return "NONE";
}

// ============================================================
// TIMEFRAME ANALYSIS
// ============================================================

function analyze(candles) {
  const closes =
    candles.map(
      x => x.close
    );

  const last =
    candles[
      candles.length - 1
    ];

  const e20 =
    lastEMA(
      closes,
      20
    );

  const e50 =
    lastEMA(
      closes,
      50
    );

  const e200 =
    lastEMA(
      closes,
      200
    );

  const rsiValues =
    RSI(
      closes,
      14
    );

  const rsi =
    rsiValues.length
      ? rsiValues[
          rsiValues.length - 1
        ]
      : null;

  const macd =
    MACD(closes);

  const atr =
    ATR(
      candles,
      14
    );

  const adx =
    ADX(
      candles,
      14
    );

  const momentum =
    Momentum(
      closes,
      10
    );

  const candle =
    candleInfo(last);

  return {
    price: last.close,

    ema20: e20,
    ema50: e50,
    ema200: e200,

    rsi,

    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram:
      macd.histogram,

    adx: adx.adx,
    plusDI: adx.plusDI,
    minusDI: adx.minusDI,

    atr,

    momentum,

    trend:
      trend(
        last.close,
        e20,
        e50,
        e200
      ),

    candleDirection:
      candle.direction,

    candleBody:
      candle.ratio,

    breakout:
      breakout(
        candles,
        CONFIG.breakoutLookback
      )
  };
}

// ============================================================
// SCORE
// ============================================================

function score(
  a15,
  a1h,
  symbol
) {
  let score = 0;
  const reasons = [];

  // EMA
  if (
    a15.trend !== "NEUTRAL"
  ) {
    score += 15;
    reasons.push(
      "15M EMA trend"
    );
  }

  // 1H confirmation
  if (
    a1h.trend !== "NEUTRAL"
  ) {
    score += 20;
    reasons.push(
      "1H trend confirmed"
    );
  }

  // Same direction
  if (
    a15.trend !== "NEUTRAL" &&
    a15.trend === a1h.trend
  ) {
    score += 10;
    reasons.push(
      "Timeframe alignment"
    );
  }

  // MACD
  if (
    Number.isFinite(a15.macd) &&
    Number.isFinite(a15.macdSignal)
  ) {
    if (
      a15.trend === "BULLISH" &&
      a15.macd >
        a15.macdSignal
    ) {
      score += 15;
      reasons.push(
        "MACD bullish"
      );
    }

    if (
      a15.trend === "BEARISH" &&
      a15.macd <
        a15.macdSignal
    ) {
      score += 15;
      reasons.push(
        "MACD bearish"
      );
    }
  }

  // RSI
  if (
    Number.isFinite(a15.rsi)
  ) {
    if (
      a15.trend === "BULLISH" &&
      a15.rsi >= 50 &&
      a15.rsi < 75
    ) {
      score += 10;
      reasons.push(
        "RSI bullish"
      );
    }

    if (
      a15.trend === "BEARISH" &&
      a15.rsi <= 50 &&
      a15.rsi > 25
    ) {
      score += 10;
      reasons.push(
        "RSI bearish"
      );
    }
  }

  // ADX / DI
  if (
    Number.isFinite(a15.adx) &&
    Number.isFinite(a15.plusDI) &&
    Number.isFinite(a15.minusDI)
  ) {
    const spread =
      Math.abs(
        a15.plusDI -
        a15.minusDI
      );

    if (
      a15.adx >= CONFIG.minADX &&
      spread >= CONFIG.minDISpread
    ) {
      score += 10;
      reasons.push(
        "ADX/DI confirmed"
      );
    }
  }

  // Momentum
  if (
    Number.isFinite(
      a15.momentum
    )
  ) {
    if (
      a15.trend === "BULLISH" &&
      a15.momentum >=
        CONFIG.minMomentum
    ) {
      score += 10;
      reasons.push(
        "Bullish momentum"
      );
    }

    if (
      a15.trend === "BEARISH" &&
      a15.momentum <=
        -CONFIG.minMomentum
    ) {
      score += 10;
      reasons.push(
        "Bearish momentum"
      );
    }
  }

  // Breakout
  if (
    a15.breakout !== "NONE" &&
    a15.breakout ===
      a15.trend
  ) {
    score += 5;
    reasons.push(
      "Breakout confirmed"
    );
  }

  // Candle
  if (
    a15.candleDirection ===
      a15.trend &&
    a15.candleBody >=
      CONFIG.candleBodyMin
  ) {
    score += 5;
    reasons.push(
      "Candle confirmed"
    );
  }

  // Conflict
  if (
    a1h.trend !== "NEUTRAL" &&
    a15.trend !==
      a1h.trend
  ) {
    score *= 0.60;

    reasons.push(
      "15M/1H conflict"
    );
  }

  return {
    score: Math.round(score),
    reasons
  };
}

// ============================================================
// SIGNAL DECISION
// ============================================================

function signalDecision(
  a15,
  a1h,
  scoreData,
  symbol
) {
  const isGold =
    symbol === "XAU/USD";

  const minimum =
    isGold
      ? CONFIG.goldMinScore
      : CONFIG.normalMinScore;

  if (
    scoreData.score <
    minimum
  ) {
    return "WAIT";
  }

  if (
    a15.trend ===
    "NEUTRAL"
  ) {
    return "WAIT";
  }

  // ----------------------------------------------------------
  // GOLD SPECIAL RULE
  // ----------------------------------------------------------
  // 1H Neutral is allowed for GOLD if 15M is sufficiently strong.
  // ----------------------------------------------------------

  if (
    isGold &&
    a1h.trend ===
      "NEUTRAL"
  ) {

    if (
      a15.trend === "BULLISH" &&
      a15.macd >
        a15.macdSignal &&
      a15.plusDI >
        a15.minusDI &&
      a15.adx >=
        CONFIG.minADX &&
      a15.momentum >=
        CONFIG.minMomentum &&
      a15.candleDirection ===
        "BULLISH"
    ) {
      return "BUY";
    }

    if (
      a15.trend === "BEARISH" &&
      a15.macd <
        a15.macdSignal &&
      a15.minusDI >
        a15.plusDI &&
      a15.adx >=
        CONFIG.minADX &&
      a15.momentum <=
        -CONFIG.minMomentum &&
      a15.candleDirection ===
        "BEARISH"
    ) {
      return "SELL";
    }

    return "WAIT";
  }

  // Normal aligned mode
  if (
    a15.trend !==
    a1h.trend
  ) {
    return "WAIT";
  }

  if (
    a15.trend ===
    "BULLISH"
  ) {
    if (
      a15.macd >
        a15.macdSignal &&
      a15.plusDI >
        a15.minusDI &&
      a15.adx >=
        CONFIG.minADX &&
      a15.momentum >=
        CONFIG.minMomentum &&
      a15.candleDirection ===
        "BULLISH"
    ) {
      return "BUY";
    }
  }

  if (
    a15.trend ===
    "BEARISH"
  ) {
    if (
      a15.macd <
        a15.macdSignal &&
      a15.minusDI >
        a15.plusDI &&
      a15.adx >=
        CONFIG.minADX &&
      a15.momentum <=
        -CONFIG.minMomentum &&
      a15.candleDirection ===
        "BEARISH"
    ) {
      return "SELL";
    }
  }

  return "WAIT";
}

// ============================================================
// TRADE PLAN
// ============================================================

function tradePlan(
  signal,
  analysis,
  symbol
) {
  const price =
    Number(
      analysis.price
    );

  const atr =
    Number(
      analysis.atr
    );

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return null;
  }

  const decimals =
    symbol === "XAU/USD"
      ? 2
      : symbol === "USD/JPY"
      ? 3
      : 5;

  const limitDistance =
    atr *
    CONFIG.limitATRMultiplier;

  const risk =
    atr *
    CONFIG.atrSLMultiplier;

  const entry =
    signal === "BUY"
      ? price - limitDistance
      : price + limitDistance;

  let sl;
  let tp1;
  let tp2;
  let tp3;

  if (
    signal === "BUY"
  ) {
    sl =
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
    sl =
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
    marketPrice:
      round(price, decimals),

    limitEntry:
      round(entry, decimals),

    stopLoss:
      round(sl, decimals),

    tp1:
      round(tp1, decimals),

    tp2:
      round(tp2, decimals),

    tp3:
      round(tp3, decimals),

    atr:
      round(atr, decimals),

    signal
  };
}

// ============================================================
// COOLDOWN
// ============================================================

function key(
  symbol,
  signal
) {
  return `${symbol}:${signal}`;
}

function cooling(
  symbol,
  signal
) {
  const k =
    key(
      symbol,
      signal
    );

  const last =
    cooldowns.get(k);

  if (!last) {
    return false;
  }

  const age =
    Date.now() - last;

  if (
    age >=
    CONFIG.signalCooldownMinutes *
      60 *
      1000
  ) {
    cooldowns.delete(k);
    return false;
  }

  return true;
}

function mark(
  symbol,
  signal
) {
  cooldowns.set(
    key(
      symbol,
      signal
    ),
    Date.now()
  );
}

// ============================================================
// TELEGRAM FORMAT
// ============================================================

function telegramMessage(
  symbol,
  signal,
  trade
) {
  const gold =
    symbol === "XAU/USD";

  const title =
    gold
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
// TELEGRAM SEND
// ============================================================

async function sendTelegram(
  env,
  message
) {
  const token =
    telegramToken(env);

  const chatId =
    telegramChatId(env);

  if (!token) {
    return {
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN missing"
    };
  }

  if (!chatId) {
    return {
      ok: false,
      error:
        "TELEGRAM_CHAT_ID missing"
    };
  }

  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    const response =
      await fetch(
        url,
        {
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
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      STATS.telegramFailed++;

      return {
        ok: false,
        status:
          response.status,
        telegram:
          data
      };
    }

    STATS.telegramSent++;

    return {
      ok: true,
      telegram:
        data
    };

  } catch(error) {

    STATS.telegramFailed++;

    return {
      ok: false,
      error:
        error.message
    };
  }
}

// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(
  env,
  symbol
) {
  const candles15 =
    await getCandles(
      env,
      symbol,
      CONFIG.interval,
      CONFIG.outputsize15m
    );

  const candles1h =
    await getCandles(
      env,
      symbol,
      CONFIG.confirmationInterval,
      CONFIG.outputsize1h
    );

  const a15 =
    analyze(candles15);

  const a1h =
    analyze(candles1h);

  const scored =
    score(
      a15,
      a1h,
      symbol
    );

  const signal =
    signalDecision(
      a15,
      a1h,
      scored,
      symbol
    );

  return {
    symbol,

    signal,

    score:
      scored.score,

    reasons:
      scored.reasons,

    analysis15:
      a15,

    analysis1h:
      a1h,

    alignment:
      a15.trend ===
      a1h.trend
        ? a15.trend
        : "MIXED"
  };
}

// ============================================================
// PROCESS SIGNAL
// ============================================================

async function process(
  env,
  result
) {
  if (
    result.signal !== "BUY" &&
    result.signal !== "SELL"
  ) {
    return {
      ...result,
      telegram: null,
      trade: null
    };
  }

  if (
    cooling(
      result.symbol,
      result.signal
    )
  ) {
    return {
      ...result,
      cooldown: true,
      telegram: null,
      trade: null
    };
  }

  const plan =
    tradePlan(
      result.signal,
      result.analysis15,
      result.symbol
    );

  if (!plan) {
    return {
      ...result,
      telegram: null,
      trade: null
    };
  }

  const message =
    telegramMessage(
      result.symbol,
      result.signal,
      plan
    );

  const telegram =
    await sendTelegram(
      env,
      message
    );

  if (
    telegram.ok
  ) {
    mark(
      result.symbol,
      result.signal
    );

    STATS.signals++;

    STATS.lastSignal = {
      symbol:
        result.symbol,

      signal:
        result.signal,

      entry:
        plan.limitEntry,

      time:
        new Date().toISOString()
    };
  }

  return {
    ...result,

    trade:
      plan,

    telegram
  };
}

// ============================================================
// RUN ENGINE
// ============================================================

async function runEngine(env) {
  STATS.runs++;

  STATS.lastRun =
    new Date().toISOString();

  const ordered = [
    "XAU/USD",
    "EUR/USD",
    "GBP/USD",
    "USD/JPY"
  ];

  const results = [];

  for (
    const symbol of ordered
  ) {
    try {

      const result =
        await analyzeSymbol(
          env,
          symbol
        );

      const processed =
        await process(
          env,
          result
        );

      results.push(
        processed
      );

    } catch(error) {

      results.push({
        symbol,
        signal: "ERROR",
        error:
          error.message
      });

    }
  }

  return {
    ok: true,

    version:
      CONFIG.version,

    name:
      CONFIG.name,

    generatedAt:
      new Date().toISOString(),

    results,

    stats:
      STATS
  };
}

// ============================================================
// API ONLY — NO TELEGRAM
// ============================================================

async function apiSignals(env) {
  const results = [];

  for (
    const symbol of CONFIG.symbols
  ) {
    try {

      results.push(
        await analyzeSymbol(
          env,
          symbol
        )
      );

    } catch(error) {

      results.push({
        symbol,
        signal: "ERROR",
        error:
          error.message
      });

    }
  }

  return {
    ok: true,

    version:
      CONFIG.version,

    generatedAt:
      new Date().toISOString(),

    results
  };
}

// ============================================================
// TELEGRAM TEST
// ============================================================

async function telegramTest(env) {
  const token =
    telegramToken(env);

  const chatId =
    telegramChatId(env);

  if (!token) {
    return {
      ok: false,
      telegram: false,
      error:
        "TELEGRAM_BOT_TOKEN missing"
    };
  }

  if (!chatId) {
    return {
      ok: false,
      telegram: false,
      error:
        "TELEGRAM_CHAT_ID missing"
    };
  }

  const message = [
    "🟢 Hakim Gold Signals",
    "",
    "Telegram connection test",
    "",
    "FOREX SIGNAL ENGINE V5.4",
    "XAU/USD GOLD FOCUS",
    "",
    "اتصال تلگرام با موفقیت تست شد."
  ].join("\n");

  const result =
    await sendTelegram(
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

const DASHBOARD = `
<!doctype html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
Forex Signal Engine V5.4 Gold Focus
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background:
    #070a10;

  color:
    #f4f4f4;

  font-family:
    Arial,
    Tahoma,
    sans-serif;
}

.wrap {
  max-width: 900px;

  margin:
    auto;

  padding:
    15px;
}

.header,
.card {
  background:
    #111722;

  border:
    1px solid #222b3a;

  border-radius:
    18px;

  padding:
    18px;

  margin-bottom:
    14px;
}

.header {
  text-align:
    center;
}

h1 {
  margin:
    0 0 7px;
}

.muted {
  color:
    #9299a5;

  font-size:
    13px;
}

.gold {
  border-color:
    #9c7928;
}

.price {
  text-align:
    center;

  font-size:
    34px;

  font-weight:
    bold;

  direction:
    ltr;

  margin:
    12px 0;
}

.status {
  text-align:
    center;

  font-size:
    20px;

  font-weight:
    bold;

  margin:
    12px;
}

.buy {
  color:
    #43d17c;
}

.sell {
  color:
    #ff6376;
}

.wait {
  color:
    #f2c75c;
}

.grid {
  display:
    grid;

  grid-template-columns:
    repeat(2,1fr);

  gap:
    9px;
}

.box {
  background:
    #0b1018;

  border-radius:
    12px;

  padding:
    11px;
}

.label {
  color:
    #7f8998;

  font-size:
    12px;

  margin-bottom:
    5px;
}

.value {
  direction:
    ltr;

  font-weight:
    bold;

  font-size:
    15px;
}

.footer {
  text-align:
    center;

  color:
    #707887;

  font-size:
    12px;

  margin:
    18px;
}

@media(max-width:600px) {
  .price {
    font-size:
      28px;
  }
}

</style>

</head>

<body>

<div class="wrap">

<div class="header">

<h1>FX</h1>

<div>
موتور سیگنال فارکس
V5.4 · Gold Focus
</div>

<div class="muted">
XAU/USD · 15M + 1H
</div>

</div>

<div id="app">
در حال دریافت اطلاعات...
</div>

<div class="footer">
رفرش خودکار هر 30 ثانیه
</div>

</div>

<script>

function f(x) {

  const n =
    Number(x);

  return Number.isFinite(n)
    ? n.toFixed(2)
    : "-";

}

function esc(x) {

  return String(
    x ?? ""
  )
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;");

}

function card(item) {

  const a =
    item.analysis15 || {};

  const h =
    item.analysis1h || {};

  const signal =
    item.signal;

  const cls =
    signal === "BUY"
      ? "buy"
      : signal === "SELL"
      ? "sell"
      : "wait";

  const text =
    signal === "BUY"
      ? "BUY LIMIT"
      : signal === "SELL"
      ? "SELL LIMIT"
      : "صبر کن";

  return \`

  <div class="card \${item.symbol === "XAU/USD" ? "gold" : ""}">

    <div class="muted">
      \${esc(item.symbol)}
    </div>

    <div class="price">
      \${f(a.price)}
    </div>

    <div class="status \${cls}">
      \${text}
    </div>

    <div class="grid">

      <div class="box">
        <div class="label">
          روند ۱۵ دقیقه
        </div>

        <div class="value">
          \${esc(a.trend)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          روند ۱ ساعته
        </div>

        <div class="value">
          \${esc(h.trend)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          هم‌راستایی
        </div>

        <div class="value">
          \${esc(item.alignment)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          امتیاز
        </div>

        <div class="value">
          \${esc(item.score)}/100
        </div>
      </div>

      <div class="box">
        <div class="label">
          RSI 14
        </div>

        <div class="value">
          \${f(a.rsi)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          MACD
        </div>

        <div class="value">
          \${f(a.macd)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          ADX 14
        </div>

        <div class="value">
          \${f(a.adx)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          +DI
        </div>

        <div class="value">
          \${f(a.plusDI)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          -DI
        </div>

        <div class="value">
          \${f(a.minusDI)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          ATR
        </div>

        <div class="value">
          \${f(a.atr)}
        </div>
      </div>

      <div class="box">
        <div class="label">
          Momentum
        </div>

        <div class="value">
          \${f(a.momentum)}%
        </div>
      </div>

      <div class="box">
        <div class="label">
          Breakout
        </div>

        <div class="value">
          \${esc(a.breakout)}
        </div>
      </div>

    </div>

    \${item.trade ? \`

      <div class="grid" style="margin-top:10px">

        <div class="box">
          <div class="label">
            نقطه ورود
          </div>
          <div class="value">
            \${f(item.trade.limitEntry)}
          </div>
        </div>

        <div class="box">
          <div class="label">
            حد ضرر
          </div>
          <div class="value">
            \${f(item.trade.stopLoss)}
          </div>
        </div>

        <div class="box">
          <div class="label">
            TP1
          </div>
          <div class="value">
            \${f(item.trade.tp1)}
          </div>
        </div>

        <div class="box">
          <div class="label">
            TP2
          </div>
          <div class="value">
            \${f(item.trade.tp2)}
          </div>
        </div>

      </div>

    \` : ""}

  </div>

  \`;

}

async function load() {

  try {

    const r =
      await fetch(
        "/api/signals?t=" +
        Date.now()
      );

    const d =
      await r.json();

    if (!d.ok) {
      throw new Error(
        d.error || "Error"
      );
    }

    document.getElementById(
      "app"
    ).innerHTML =
      d.results
        .map(card)
        .join("");

  } catch(e) {

    document.getElementById(
      "app"
    ).innerHTML =

      '<div class="card">' +
      'خطا در دریافت اطلاعات<br>' +
      '<small>' +
      esc(e.message) +
      '</small></div>';

  }

}

load();

setInterval(
  load,
  30000
);

</script>

</body>

</html>
`;

// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    // HOME
    if (
      path === "/" ||
      path === ""
    ) {
      return html(
        DASHBOARD
      );
    }

    // HEALTH
    if (
      path === "/health"
    ) {

      return json({
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
            telegramToken(env) &&
            telegramChatId(env)
          ),

        twelveDataConfigured:
          Boolean(
            twelveKey(env)
          ),

        time:
          new Date().toISOString()
      });

    }

    // STATS
    if (
      path === "/api/stats"
    ) {

      return json({
        ok: true,

        version:
          CONFIG.version,

        config: {
          goldMinScore:
            CONFIG.goldMinScore,

          normalMinScore:
            CONFIG.normalMinScore,

          minADX:
            CONFIG.minADX,

          minDISpread:
            CONFIG.minDISpread,

          minMomentum:
            CONFIG.minMomentum,

          cooldown:
            CONFIG.signalCooldownMinutes
        },

        stats:
          STATS
      });

    }

    // API SIGNALS
    if (
      path === "/api/signals"
    ) {

      try {

        return json(
          await apiSignals(env)
        );

      } catch(error) {

        return json(
          {
            ok: false,
            error:
              error.message
          },
          500
        );

      }

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
        result,
        result.ok ? 200 : 500
      );

    }

    // RUN
    if (
      path === "/run"
    ) {

      try {

        const result =
          await runEngine(
            env
          );

        return json(
          result
        );

      } catch(error) {

        return json(
          {
            ok: false,
            error:
              error.message
          },
          500
        );

      }

    }

    return json(
      {
        ok: false,
        error: "Not Found"
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
