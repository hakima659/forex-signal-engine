// ============================================================
// FOREX SIGNAL ENGINE — V2
// Multi-Timeframe + EMA + RSI + MACD + ATR + ADX
// Closed-candle confirmation + strict scoring + Telegram + D1
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

  // سخت‌گیری سیگنال
  minScore: 80,

  // ATR based risk
  atrMultiplier: 1.5,

  tp1R: 2,
  tp2R: 3,

  riskPercent: 0.5,

  cooldownMinutes: 60,

  maxNewSignalsPerRun: 1,
  maxOpenSignals: 2,

  requestTimeoutMs: 15000,

  // حداقل فاصله برای جلوگیری از بازار بدون حرکت
  minAtrPercent15: {
    "EUR/USD": 0.015,
    "GBP/USD": 0.020,
    "USD/JPY": 0.010,
    "XAU/USD": 0.020
  }
};


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(request, env, ctx) {

    try {

      const url = new URL(request.url);
      const path = url.pathname;

      await initDatabase(env);

      // --------------------------------------------------------
      // HOME
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/"
      ) {
        return htmlResponse(homePage());
      }

      // --------------------------------------------------------
      // HEALTH
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/health"
      ) {

        return json({
          ok: true,
          service: "forex-signal-engine",
          version: "V2",
          time: new Date().toISOString()
        });
      }

      // --------------------------------------------------------
      // ROBOTS
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/robots.txt"
      ) {

        return new Response(
          [
            "User-agent: *",
            "Allow: /",
            "Sitemap: " +
            url.origin +
            "/sitemap.xml"
          ].join("\n"),
          {
            headers: {
              "content-type":
                "text/plain; charset=UTF-8"
            }
          }
        );
      }

      // --------------------------------------------------------
      // SITEMAP
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/sitemap.xml"
      ) {

        return new Response(
          sitemapXml(url.origin),
          {
            headers: {
              "content-type":
                "application/xml; charset=UTF-8"
            }
          }
        );
      }

      // --------------------------------------------------------
      // TELEGRAM SETUP
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/setup-chat"
      ) {

        return await setupTelegramChat(env);
      }

      // --------------------------------------------------------
      // MANUAL ENGINE RUN
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/run"
      ) {

        const result =
          await runEngine(env);

        return json({
          ok: true,
          result
        });
      }

      // --------------------------------------------------------
      // SIGNALS API
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/api/signals"
      ) {

        const requestedLimit =
          Number(
            url.searchParams.get("limit") || 50
          );

        const limit =
          Math.min(
            Math.max(
              Number.isFinite(requestedLimit)
                ? requestedLimit
                : 50,
              1
            ),
            200
          );

        const result =
          await env.DB.prepare(`
            SELECT *
            FROM signals
            ORDER BY created_at DESC
            LIMIT ?
          `)
          .bind(limit)
          .all();

        return json({
          ok: true,
          signals:
            result.results || []
        });
      }

      // --------------------------------------------------------
      // STATS
      // --------------------------------------------------------

      if (
        request.method === "GET" &&
        path === "/api/stats"
      ) {

        return await getStats(env);
      }

      // --------------------------------------------------------
      // TELEGRAM WEBHOOK
      // --------------------------------------------------------

      if (
        request.method === "POST" &&
        path === "/telegram/webhook"
      ) {

        return await telegramWebhook(
          request,
          env
        );
      }

      return new Response(
        "Not Found",
        {
          status: 404
        }
      );

    } catch (error) {

      console.error(error);

      return json(
        {
          ok: false,
          error:
            String(
              error?.message || error
            )
        },
        500
      );
    }
  },


  // ==========================================================
  // CRON
  // ==========================================================

  async scheduled(event, env, ctx) {

    ctx.waitUntil(
      runEngine(env)
    );
  }
};


// ============================================================
// DATABASE
// ============================================================

async function initDatabase(env) {

  if (!env.DB) {
    throw new Error(
      "D1 binding DB is missing"
    );
  }

  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      timeframe TEXT NOT NULL,

      score INTEGER NOT NULL,

      entry REAL NOT NULL,
      stop_loss REAL NOT NULL,
      tp1 REAL NOT NULL,
      tp2 REAL NOT NULL,

      initial_r REAL NOT NULL,

      status TEXT DEFAULT 'ACTIVE',

      tp1_hit INTEGER DEFAULT 0,
      tp2_hit INTEGER DEFAULT 0,

      breakeven_applied INTEGER DEFAULT 0,

      result_r REAL DEFAULT NULL,
      exit_price REAL DEFAULT NULL,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      signal_id INTEGER NOT NULL,

      event_type TEXT NOT NULL,

      price REAL,

      note TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_signals_symbol
    ON signals(symbol);

    CREATE INDEX IF NOT EXISTS idx_signals_status
    ON signals(status);

    CREATE INDEX IF NOT EXISTS idx_signals_created
    ON signals(created_at);

    CREATE INDEX IF NOT EXISTS idx_events_signal
    ON signal_events(signal_id);
  `);
}


// ============================================================
// MAIN ENGINE
// ============================================================

async function runEngine(env) {

  const started =
    Date.now();

  const result = {

    version: "V2",

    startedAt:
      new Date().toISOString(),

    scanned: 0,

    created: 0,

    skipped: 0,

    errors: []
  };

  try {

    await updateOpenSignals(env);

  } catch (error) {

    result.errors.push(
      "updateOpenSignals: " +
      String(
        error?.message || error
      )
    );
  }


  const openCountResult =
    await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM signals
      WHERE status IN ('ACTIVE','TP1_HIT')
    `)
    .first();


  let openCount =
    Number(
      openCountResult?.count || 0
    );


  if (
    openCount >=
    CONFIG.maxOpenSignals
  ) {

    result.reason =
      "Maximum open signals reached";

    result.finishedAt =
      new Date().toISOString();

    result.durationMs =
      Date.now() - started;

    return result;
  }


  for (
    const symbol of CONFIG.symbols
  ) {

    if (
      result.created >=
      CONFIG.maxNewSignalsPerRun
    ) {
      break;
    }


    result.scanned++;


    try {

      const candidate =
        await analyzeSymbol(
          symbol,
          env
        );


      if (!candidate) {

        result.skipped++;

        continue;
      }


      const cooldown =
        await isInCooldown(
          env,
          symbol,
          candidate.direction
        );


      if (cooldown) {

        result.skipped++;

        continue;
      }


      const alreadyOpen =
        await hasOpenSignal(
          env,
          symbol
        );


      if (alreadyOpen) {

        result.skipped++;

        continue;
      }


      await createSignal(
        env,
        candidate
      );


      await sendTelegram(
        env,
        formatNewSignal(candidate)
      );


      result.created++;

      openCount++;


      if (
        openCount >=
        CONFIG.maxOpenSignals
      ) {
        break;
      }

    } catch (error) {

      console.error(
        symbol,
        error
      );

      result.errors.push(
        symbol +
        ": " +
        String(
          error?.message || error
        )
      );
    }
  }


  result.finishedAt =
    new Date().toISOString();

  result.durationMs =
    Date.now() - started;


  return result;
}


// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(
  symbol,
  env
) {

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


  if (
    candles15.length < 210 ||
    candles1h.length < 210
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // IMPORTANT:
  // Use the LAST CLOSED candle.
  // Ignore the currently forming candle.
  // ----------------------------------------------------------

  const signal15 =
    candles15.length - 2;

  const signal1h =
    candles1h.length - 2;


  const close15 =
    candles15.map(
      x => x.close
    );


  const close1h =
    candles1h.map(
      x => x.close
    );


  const ema20 =
    EMA(
      close15,
      20
    );

  const ema50 =
    EMA(
      close15,
      50
    );

  const ema200 =
    EMA(
      close15,
      200
    );


  const ema20_1h =
    EMA(
      close1h,
      20
    );

  const ema50_1h =
    EMA(
      close1h,
      50
    );

  const ema200_1h =
    EMA(
      close1h,
      200
    );


  const rsi =
    RSI(
      close15,
      14
    );


  const macd =
    MACD(
      close15
    );


  const atr =
    ATR(
      candles15,
      14
    );


  const adx =
    ADX(
      candles15,
      14
    );


  const last =
    candles15[
      signal15
    ];


  const previous =
    candles15[
      signal15 - 1
    ];


  const previous2 =
    candles15[
      signal15 - 2
    ];


  const price =
    last.close;


  const atrValue =
    atr[signal15];


  const currentEma20 =
    ema20[signal15];

  const currentEma50 =
    ema50[signal15];

  const currentEma200 =
    ema200[signal15];


  const h1Ema20 =
    ema20_1h[signal1h];

  const h1Ema50 =
    ema50_1h[signal1h];

  const h1Ema200 =
    ema200_1h[signal1h];


  const currentRsi =
    rsi[signal15];


  const currentMacd =
    macd.macd[signal15];

  const currentSignal =
    macd.signal[signal15];


  const currentAdx =
    adx.adx[signal15];


  if (
    ![
      price,
      atrValue,
      currentEma20,
      currentEma50,
      currentEma200,
      h1Ema20,
      h1Ema50,
      h1Ema200,
      currentRsi,
      currentMacd,
      currentSignal,
      currentAdx
    ].every(
      Number.isFinite
    )
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // ATR FILTER
  // ----------------------------------------------------------

  const atrPercent =
    (
      atrValue /
      Math.abs(price)
    ) * 100;


  const minAtr =
    CONFIG.minAtrPercent15[
      symbol
    ] || 0;


  if (
    atrPercent <
    minAtr
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // SCORES
  // ----------------------------------------------------------

  let longScore = 0;
  let shortScore = 0;


  // ----------------------------------------------------------
  // 15M TREND — 25
  // ----------------------------------------------------------

  if (
    price >
    currentEma20 &&
    currentEma20 >
    currentEma50 &&
    currentEma50 >
    currentEma200
  ) {

    longScore += 25;
  }


  if (
    price <
    currentEma20 &&
    currentEma20 <
    currentEma50 &&
    currentEma50 <
    currentEma200
  ) {

    shortScore += 25;
  }


  // ----------------------------------------------------------
  // 1H TREND — 25
  // ----------------------------------------------------------

  if (
    h1Ema20 >
    h1Ema50 &&
    h1Ema50 >
    h1Ema200
  ) {

    longScore += 25;
  }


  if (
    h1Ema20 <
    h1Ema50 &&
    h1Ema50 <
    h1Ema200
  ) {

    shortScore += 25;
  }


  // ----------------------------------------------------------
  // RSI — 10
  // ----------------------------------------------------------

  if (
    currentRsi >= 52 &&
    currentRsi <= 68
  ) {

    longScore += 10;
  }


  if (
    currentRsi <= 48 &&
    currentRsi >= 32
  ) {

    shortScore += 10;
  }


  // ----------------------------------------------------------
  // MACD — 10
  // ----------------------------------------------------------

  if (
    currentMacd >
    currentSignal
  ) {

    longScore += 10;
  }


  if (
    currentMacd <
    currentSignal
  ) {

    shortScore += 10;
  }


  // ----------------------------------------------------------
  // ADX — 10
  // Strong trend confirmation
  // ----------------------------------------------------------

  if (
    currentAdx >= 20
  ) {

    if (
      longScore >
      shortScore
    ) {
      longScore += 10;
    }

    if (
      shortScore >
      longScore
    ) {
      shortScore += 10;
    }
  }


  // ----------------------------------------------------------
  // CANDLE MOMENTUM — 5
  // ----------------------------------------------------------

  const candleRange =
    last.high -
    last.low;


  const candleBody =
    Math.abs(
      last.close -
      last.open
    );


  const bodyRatio =
    candleRange > 0
      ? candleBody /
        candleRange
      : 0;


  if (
    bodyRatio >= 0.55 &&
    last.close >
    last.open
  ) {

    longScore += 5;
  }


  if (
    bodyRatio >= 0.55 &&
    last.close <
    last.open
  ) {

    shortScore += 5;
  }


  // ----------------------------------------------------------
  // SHORT-TERM MOMENTUM — 5
  // ----------------------------------------------------------

  if (
    last.close >
    previous.close &&
    previous.close >=
    previous2.close
  ) {

    longScore += 5;
  }


  if (
    last.close <
    previous.close &&
    previous.close <=
    previous2.close
  ) {

    shortScore += 5;
  }


  // ----------------------------------------------------------
  // BREAKOUT CONFIRMATION — 10
  // ----------------------------------------------------------

  const recent =
    candles15.slice(
      Math.max(
        0,
        signal15 - 20
      ),
      signal15
    );


  const recentHigh =
    Math.max(
      ...recent.map(
        x => x.high
      )
    );


  const recentLow =
    Math.min(
      ...recent.map(
        x => x.low
      )
    );


  if (
    price >
    recentHigh
  ) {

    longScore += 10;
  }


  if (
    price <
    recentLow
  ) {

    shortScore += 10;
  }


  // ----------------------------------------------------------
  // DIRECTION
  // ----------------------------------------------------------

  let direction;
  let score;


  if (
    longScore >
    shortScore
  ) {

    direction = "LONG";
    score = longScore;

  } else {

    direction = "SHORT";
    score = shortScore;
  }


  // ----------------------------------------------------------
  // MINIMUM SCORE
  // ----------------------------------------------------------

  if (
    score <
    CONFIG.minScore
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // SCORE GAP
  // Prevent ambiguous signals
  // ----------------------------------------------------------

  const scoreGap =
    Math.abs(
      longScore -
      shortScore
    );


  if (
    scoreGap < 15
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // CANDLE DIRECTION CONFIRMATION
  // ----------------------------------------------------------

  if (
    direction === "LONG" &&
    last.close <=
    last.open
  ) {
    return null;
  }


  if (
    direction === "SHORT" &&
    last.close >=
    last.open
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // RSI EXTREME FILTER
  // ----------------------------------------------------------

  if (
    direction === "LONG" &&
    currentRsi > 70
  ) {
    return null;
  }


  if (
    direction === "SHORT" &&
    currentRsi < 30
  ) {
    return null;
  }


  // ----------------------------------------------------------
  // ATR RISK
  // ----------------------------------------------------------

  const risk =
    atrValue *
    CONFIG.atrMultiplier;


  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return null;
  }


  const entry =
    price;


  let stopLoss;
  let tp1;
  let tp2;


  if (
    direction === "LONG"
  ) {

    stopLoss =
      entry -
      risk;

    tp1 =
      entry +
      risk *
      CONFIG.tp1R;

    tp2 =
      entry +
      risk *
      CONFIG.tp2R;

  } else {

    stopLoss =
      entry +
      risk;

    tp1 =
      entry -
      risk *
      CONFIG.tp1R;

    tp2 =
      entry -
      risk *
      CONFIG.tp2R;
  }


  return {

    symbol,

    direction,

    timeframe:
      CONFIG.signalInterval,

    score,

    longScore,

    shortScore,

    scoreGap,

    entry:
      roundPrice(
        symbol,
        entry
      ),

    stopLoss:
      roundPrice(
        symbol,
        stopLoss
      ),

    tp1:
      roundPrice(
        symbol,
        tp1
      ),

    tp2:
      roundPrice(
        symbol,
        tp2
      ),

    initialR:
      roundPrice(
        symbol,
        risk
      ),

    rsi:
      Number(
        currentRsi.toFixed(2)
      ),

    adx:
      Number(
        currentAdx.toFixed(2)
      ),

    atr:
      Number(
        atrValue.toFixed(6)
      ),

    atrPercent:
      Number(
        atrPercent.toFixed(4)
      )
  };
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

  if (
    !env.TWELVE_DATA_API_KEY
  ) {

    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }


  const url =
    new URL(
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
    "apikey",
    env.TWELVE_DATA_API_KEY
  );


  const response =
    await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",

        headers: {
          "accept":
            "application/json"
        }
      },

      CONFIG.requestTimeoutMs
    );


  if (
    !response.ok
  ) {

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
      "No candle data returned for " +
      symbol
    );
  }


  return data.values
    .map(item => ({

      time:
        item.datetime,

      open:
        Number(
          item.open
        ),

      high:
        Number(
          item.high
        ),

      low:
        Number(
          item.low
        ),

      close:
        Number(
          item.close
        ),

      volume:
        item.volume === undefined
          ? null
          : Number(
              item.volume
            )
    }))

    .filter(item =>
      Number.isFinite(
        item.open
      ) &&
      Number.isFinite(
        item.high
      ) &&
      Number.isFinite(
        item.low
      ) &&
      Number.isFinite(
        item.close
      )
    )

    .reverse();
}


// ============================================================
// CREATE SIGNAL
// ============================================================

async function createSignal(
  env,
  candidate
) {

  const result =
    await env.DB.prepare(`
      INSERT INTO signals (
        symbol,
        direction,
        timeframe,
        score,
        entry,
        stop_loss,
        tp1,
        tp2,
        initial_r,
        status
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE'
      )
    `)
    .bind(
      candidate.symbol,
      candidate.direction,
      candidate.timeframe,
      candidate.score,
      candidate.entry,
      candidate.stopLoss,
      candidate.tp1,
      candidate.tp2,
      candidate.initialR
    )
    .run();


  const signalId =
    result.meta?.last_row_id;


  if (signalId) {

    await env.DB.prepare(`
      INSERT INTO signal_events (
        signal_id,
        event_type,
        price,
        note
      )
      VALUES (?, 'CREATED', ?, ?)
    `)
    .bind(
      signalId,
      candidate.entry,
      "Strict V2 signal created"
    )
    .run();
  }


  return signalId;
}


// ============================================================
// OPEN SIGNAL MONITORING
// ============================================================

async function updateOpenSignals(
  env
) {

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM signals
      WHERE status IN ('ACTIVE','TP1_HIT')
      ORDER BY created_at ASC
    `)
    .all();


  const signals =
    result.results || [];


  for (
    const signal of signals
  ) {

    try {

      const candles =
        await getCandles(
          env,
          signal.symbol,
          CONFIG.signalInterval,
          5
        );


      if (
        !candles.length
      ) {
        continue;
      }


      // Current/latest price
      const price =
        candles[
          candles.length - 1
        ].close;


      // ------------------------------------------------------
      // TP1
      // ------------------------------------------------------

      if (
        signal.status === "ACTIVE" &&
        !signal.tp1_hit &&
        reachedTarget(
          signal.direction,
          price,
          signal.tp1
        )
      ) {

        await env.DB.prepare(`
          UPDATE signals
          SET
            status = 'TP1_HIT',
            tp1_hit = 1,
            breakeven_applied = 1,
            stop_loss = entry,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(
          signal.id
        )
        .run();


        await env.DB.prepare(`
          INSERT INTO signal_events (
            signal_id,
            event_type,
            price,
            note
          )
          VALUES (?, 'TP1_HIT', ?, ?)
        `)
        .bind(
          signal.id,
          price,
          "TP1 reached; stop moved to breakeven"
        )
        .run();


        await sendTelegram(
          env,
          formatEvent(
            signal,
            "TP1 HIT",
            price,
            "TP1 reached. Stop moved to breakeven."
          )
        );


        continue;
      }


      // ------------------------------------------------------
      // TP2
      // ------------------------------------------------------

      if (
        (
          signal.status === "ACTIVE" ||
          signal.status === "TP1_HIT"
        ) &&
        reachedTarget(
          signal.direction,
          price,
          signal.tp2
        )
      ) {

        const resultR =
          CONFIG.tp2R;


        await closeSignal(
          env,
          signal,
          "TP2_HIT",
          price,
          resultR,
          "TP2 reached"
        );


        await sendTelegram(
          env,
          formatEvent(
            signal,
            "TP2 HIT",
            price,
            "TP2 reached."
          )
        );


        continue;
      }


      // ------------------------------------------------------
      // STOP LOSS
      // ------------------------------------------------------

      if (
        stopReached(
          signal.direction,
          price,
          signal.stop_loss
        )
      ) {

        const resultR =
          signal.breakeven_applied
            ? 0
            : -1;


        await closeSignal(
          env,
          signal,
          "SL_HIT",
          price,
          resultR,
          signal.breakeven_applied
            ? "Breakeven stop hit"
            : "Stop loss hit"
        );


        await sendTelegram(
          env,
          formatEvent(
            signal,
            "STOP LOSS",
            price,
            signal.breakeven_applied
              ? "Breakeven stop hit."
              : "Stop loss hit."
          )
        );
      }

    } catch (error) {

      console.error(
        "Signal update error:",
        signal.id,
        error
      );
    }
  }
}


// ============================================================
// CLOSE SIGNAL
// ============================================================

async function closeSignal(
  env,
  signal,
  status,
  price,
  resultR,
  note
) {

  await env.DB.prepare(`
    UPDATE signals
    SET
      status = ?,
      result_r = ?,
      exit_price = ?,
      updated_at = CURRENT_TIMESTAMP,
      closed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
  .bind(
    status,
    resultR,
    price,
    signal.id
  )
  .run();


  await env.DB.prepare(`
    INSERT INTO signal_events (
      signal_id,
      event_type,
      price,
      note
    )
    VALUES (?, ?, ?, ?)
  `)
  .bind(
    signal.id,
    status,
    price,
    note
  )
  .run();
}


// ============================================================
// OPEN SIGNAL CHECK
// ============================================================

async function hasOpenSignal(
  env,
  symbol
) {

  const result =
    await env.DB.prepare(`
      SELECT id
      FROM signals
      WHERE symbol = ?
      AND status IN ('ACTIVE','TP1_HIT')
      LIMIT 1
    `)
    .bind(symbol)
    .first();


  return Boolean(result);
}


// ============================================================
// COOLDOWN
// ============================================================

async function isInCooldown(
  env,
  symbol,
  direction
) {

  const result =
    await env.DB.prepare(`
      SELECT created_at
      FROM signals
      WHERE symbol = ?
      AND direction = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .bind(
      symbol,
      direction
    )
    .first();


  if (!result) {
    return false;
  }


  const created =
    new Date(
      result.created_at
    ).getTime();


  if (
    !Number.isFinite(created)
  ) {
    return false;
  }


  const age =
    Date.now() -
    created;


  return (
    age <
    CONFIG.cooldownMinutes *
    60 *
    1000
  );
}


// ============================================================
// TARGET
// ============================================================

function reachedTarget(
  direction,
  price,
  target
) {

  if (
    direction === "LONG"
  ) {

    return (
      price >= target
    );
  }


  return (
    price <= target
  );
}


// ============================================================
// STOP
// ============================================================

function stopReached(
  direction,
  price,
  stop
) {

  if (
    direction === "LONG"
  ) {

    return (
      price <= stop
    );
  }


  return (
    price >= stop
  );
}


// ============================================================
// TELEGRAM SETUP
// ============================================================

async function setupTelegramChat(
  env
) {

  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {

    return json(
      {
        ok: false,
        error:
          "TELEGRAM_BOT_TOKEN is missing"
      },
      500
    );
  }


  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/getUpdates";


  const response =
    await fetchWithTimeout(
      url,
      {},
      CONFIG.requestTimeoutMs
    );


  const data =
    await response.json();


  if (
    !data.ok
  ) {

    return json(
      {
        ok: false,
        telegram: data
      },
      500
    );
  }


  const updates =
    data.result || [];


  let chatId =
    null;


  for (
    let i =
      updates.length - 1;
    i >= 0;
    i--
  ) {

    const message =
      updates[i]?.message;


    if (
      message?.chat?.id
    ) {

      chatId =
        String(
          message.chat.id
        );

      break;
    }
  }


  if (!chatId) {

    return json(
      {
        ok: false,
        message:
          "No Telegram chat found. Open your bot in Telegram and send /start, then open /setup-chat again."
      },
      400
    );
  }


  await saveChatId(
    env,
    chatId
  );


  await sendTelegram(
    env,
    "✅ اتصال موتور سیگنال فارکس برقرار شد.\n\n" +
    "نسخه V2 فعال است.\n" +
    "سیگنال‌ها با فیلتر چندتایم‌فریمی ارسال می‌شوند."
  );


  return json({
    ok: true,
    message:
      "Telegram chat connected successfully.",
    chat_id_saved: true
  });
}


// ============================================================
// SAVE TELEGRAM CHAT
// ============================================================

async function saveChatId(
  env,
  chatId
) {

  await env.DB.prepare(`
    INSERT INTO settings (
      key,
      value
    )
    VALUES ('telegram_chat_id', ?)
    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `)
  .bind(chatId)
  .run();


  await env.DB.prepare(`
    INSERT INTO subscribers (
      chat_id,
      active
    )
    VALUES (?, 1)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      active = 1
  `)
  .bind(chatId)
  .run();
}


// ============================================================
// TELEGRAM WEBHOOK
// ============================================================

async function telegramWebhook(
  request,
  env
) {

  const body =
    await request.json();


  const message =
    body?.message;


  const chatId =
    message?.chat?.id;


  if (chatId) {

    await saveChatId(
      env,
      String(chatId)
    );
  }


  const text =
    String(
      message?.text || ""
    )
    .trim();


  if (
    text === "/start" ||
    text === "/help"
  ) {

    await sendTelegram(
      env,
      "🤖 Forex Signal Engine V2\n\n" +
      "ربات فعال است.\n\n" +
      "سیگنال‌ها پس از بررسی روند 1H، " +
      "روند 15M، EMA، RSI، MACD، ATR و ADX ارسال می‌شوند.\n\n" +
      "⚠️ سود یا دقت ۱۰۰٪ تضمین نمی‌شود."
    );
  }


  return json({
    ok: true
  });
}


// ============================================================
// SEND TELEGRAM
// ============================================================

async function sendTelegram(
  env,
  text
) {

  if (
    !env.TELEGRAM_BOT_TOKEN
  ) {
    return false;
  }


  if (!env.DB) {
    return false;
  }


  const result =
    await env.DB.prepare(`
      SELECT value
      FROM settings
      WHERE key = 'telegram_chat_id'
      LIMIT 1
    `)
    .first();


  if (
    !result?.value
  ) {
    return false;
  }


  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";


  try {

    const response =
      await fetchWithTimeout(
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
                result.value,

              text,

              disable_web_page_preview:
                true
            })
        },

        CONFIG.requestTimeoutMs
      );


    return response.ok;

  } catch (error) {

    console.error(
      "Telegram error:",
      error
    );

    return false;
  }
}


// ============================================================
// SIGNAL MESSAGE
// ============================================================

function formatNewSignal(
  signal
) {

  const emoji =
    signal.direction === "LONG"
      ? "🟢"
      : "🔴";


  const directionText =
    signal.direction === "LONG"
      ? "BUY / LONG"
      : "SELL / SHORT";


  return (

    emoji +
    " FOREX SIGNAL V2\n\n" +

    "📌 Symbol: " +
    signal.symbol +
    "\n" +

    "📈 Direction: " +
    directionText +
    "\n" +

    "⏱ Timeframe: " +
    signal.timeframe +
    "\n\n" +

    "⭐ Score: " +
    signal.score +
    "/100\n" +

    "📊 Long: " +
    signal.longScore +
    "\n" +

    "📊 Short: " +
    signal.shortScore +
    "\n\n" +

    "🎯 Entry: " +
    signal.entry +
    "\n" +

    "🛑 SL: " +
    signal.stopLoss +
    "\n" +

    "💰 TP1: " +
    signal.tp1 +
    "\n" +

    "💰 TP2: " +
    signal.tp2 +
    "\n\n" +

    "📐 RSI: " +
    signal.rsi +
    "\n" +

    "📐 ADX: " +
    signal.adx +
    "\n" +

    "📐 ATR: " +
    signal.atr +
    "\n\n" +

    "⚠️ Risk per trade: " +
    CONFIG.riskPercent +
    "%\n\n" +

    "این سیگنال تضمین سود نیست."
  );
}


// ============================================================
// EVENT MESSAGE
// ============================================================

function formatEvent(
  signal,
  title,
  price,
  note
) {

  return (

    "📢 " +
    title +
    "\n\n" +

    "📌 Symbol: " +
    signal.symbol +
    "\n" +

    "📈 Direction: " +
    signal.direction +
    "\n\n" +

    "💵 Price: " +
    price +
    "\n\n" +

    note
  );
}


// ============================================================
// STATISTICS
// ============================================================

async function getStats(
  env
) {

  const total =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
    `)
    .first();


  const wins =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r > 0
    `)
    .first();


  const losses =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r < 0
    `)
    .first();


  const closed =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `)
    .first();


  const average =
    await env.DB.prepare(`
      SELECT AVG(result_r) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `)
    .first();


  const sumR =
    await env.DB.prepare(`
      SELECT SUM(result_r) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `)
    .first();


  const closedCount =
    Number(
      closed?.value || 0
    );


  const winRate =
    closedCount > 0

      ? (
          Number(
            wins?.value || 0
          ) /
          closedCount
        ) * 100

      : 0;


  return json({

    ok: true,

    stats: {

      totalSignals:
        Number(
          total?.value || 0
        ),

      wins:
        Number(
          wins?.value || 0
        ),

      losses:
        Number(
          losses?.value || 0
        ),

      closed:
        closedCount,

      winRate:
        Number(
          winRate.toFixed(2)
        ),

      averageR:
        Number(
          Number(
            average?.value || 0
          ).toFixed(3)
        ),

      totalR:
        Number(
          Number(
            sumR?.value || 0
          ).toFixed(3)
        )
    }
  });
}


// ============================================================
// EMA
// ============================================================

function EMA(
  values,
  period
) {

  const result =
    new Array(
      values.length
    )
    .fill(null);


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

    sum +=
      values[i];
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
// RSI
// ============================================================

function RSI(
  values,
  period
) {

  const result =
    new Array(
      values.length
    )
    .fill(null);


  if (
    values.length <=
    period
  ) {
    return result;
  }


  let gain = 0;
  let loss = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    if (
      change > 0
    ) {

      gain += change;

    } else {

      loss -= change;
    }
  }


  let avgGain =
    gain / period;


  let avgLoss =
    loss / period;


  result[period] =
    rsiValue(
      avgGain,
      avgLoss
    );


  for (
    let i =
      period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] -
      values[i - 1];


    const currentGain =
      change > 0
        ? change
        : 0;


    const currentLoss =
      change < 0
        ? -change
        : 0;


    avgGain =
      (
        avgGain *
        (period - 1) +
        currentGain
      ) /
      period;


    avgLoss =
      (
        avgLoss *
        (period - 1) +
        currentLoss
      ) /
      period;


    result[i] =
      rsiValue(
        avgGain,
        avgLoss
      );
  }


  return result;
}


// ============================================================
// RSI VALUE
// ============================================================

function rsiValue(
  avgGain,
  avgLoss
) {

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
    (
      100 /
      (1 + rs)
    )
  );
}


// ============================================================
// MACD
// ============================================================

function MACD(
  values
) {

  const ema12 =
    EMA(
      values,
      12
    );


  const ema26 =
    EMA(
      values,
      26
    );


  const macd =
    new Array(
      values.length
    )
    .fill(null);


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    if (
      Number.isFinite(
        ema12[i]
      ) &&
      Number.isFinite(
        ema26[i]
      )
    ) {

      macd[i] =
        ema12[i] -
        ema26[i];
    }
  }


  const clean =
    macd.filter(
      x =>
        Number.isFinite(x)
    );


  const signalClean =
    EMA(
      clean,
      9
    );


  const signal =
    new Array(
      values.length
    )
    .fill(null);


  let index = 0;


  for (
    let i = 0;
    i < macd.length;
    i++
  ) {

    if (
      Number.isFinite(
        macd[i]
      )
    ) {

      signal[i] =
        signalClean[index];

      index++;
    }
  }


  return {
    macd,
    signal
  };
}


// ============================================================
// ATR
// ============================================================

function ATR(
  candles,
  period
) {

  const tr =
    new Array(
      candles.length
    )
    .fill(null);


  for (
    let i = 0;
    i < candles.length;
    i++
  ) {

    if (
      i === 0
    ) {

      tr[i] =
        candles[i].high -
        candles[i].low;

      continue;
    }


    const high =
      candles[i].high;


    const low =
      candles[i].low;


    const previousClose =
      candles[
        i - 1
      ].close;


    tr[i] =
      Math.max(

        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
      );
  }


  const result =
    new Array(
      candles.length
    )
    .fill(null);


  if (
    candles.length <=
    period
  ) {
    return result;
  }


  let sum = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    sum +=
      tr[i];
  }


  let previous =
    sum / period;


  result[period] =
    previous;


  for (
    let i =
      period + 1;
    i < candles.length;
    i++
  ) {

    previous =
      (
        previous *
        (period - 1) +
        tr[i]
      ) /
      period;


    result[i] =
      previous;
  }


  return result;
}


// ============================================================
// ADX
// ============================================================

function ADX(
  candles,
  period
) {

  const length =
    candles.length;


  const tr =
    new Array(length)
      .fill(null);


  const plusDM =
    new Array(length)
      .fill(null);


  const minusDM =
    new Array(length)
      .fill(null);


  for (
    let i = 1;
    i < length;
    i++
  ) {

    const high =
      candles[i].high;


    const low =
      candles[i].low;


    const previousHigh =
      candles[
        i - 1
      ].high;


    const previousLow =
      candles[
        i - 1
      ].low;


    const previousClose =
      candles[
        i - 1
      ].close;


    tr[i] =
      Math.max(

        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
      );


    const upMove =
      high -
      previousHigh;


    const downMove =
      previousLow -
      low;


    plusDM[i] =
      (
        upMove > downMove &&
        upMove > 0
      )
        ? upMove
        : 0;


    minusDM[i] =
      (
        downMove > upMove &&
        downMove > 0
      )
        ? downMove
        : 0;
  }


  const adx =
    new Array(length)
      .fill(null);


  const plusDI =
    new Array(length)
      .fill(null);


  const minusDI =
    new Array(length)
      .fill(null);


  if (
    length <
    period * 2
  ) {

    return {
      adx,
      plusDI,
      minusDI
    };
  }


  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;


  for (
    let i = 1;
    i <= period;
    i++
  ) {

    trSum +=
      tr[i];

    plusSum +=
      plusDM[i];

    minusSum +=
      minusDM[i];
  }


  let dxValues = [];


  for (
    let i = period;
    i < length;
    i++
  ) {

    if (
      i > period
    ) {

      trSum =
        trSum -
        trSum / period +
        tr[i];


      plusSum =
        plusSum -
        plusSum / period +
        plusDM[i];


      minusSum =
        minusSum -
        minusSum / period +
        minusDM[i];
    }


    const pdi =
      trSum > 0
        ? 100 *
          plusSum /
          trSum
        : 0;


    const mdi =
      trSum > 0
        ? 100 *
          minusSum /
          trSum
        : 0;


    plusDI[i] =
      pdi;


    minusDI[i] =
      mdi;


    const denominator =
      pdi + mdi;


    const dx =
      denominator > 0
        ? 100 *
          Math.abs(
            pdi - mdi
          ) /
          denominator
        : 0;


    dxValues.push(dx);


    if (
      dxValues.length >=
      period
    ) {

      if (
        adx[i - 1] === null
      ) {

        let sumDX = 0;


        for (
          let j =
            dxValues.length -
            period;
          j <
            dxValues.length;
          j++
        ) {

          sumDX +=
            dxValues[j];
        }


        adx[i] =
          sumDX /
          period;

      } else {

        adx[i] =
          (
            adx[i - 1] *
            (period - 1) +
            dx
          ) /
          period;
      }
    }
  }


  return {
    adx,
    plusDI,
    minusDI
  };
}


// ============================================================
// PRICE ROUNDING
// ============================================================

function roundPrice(
  symbol,
  value
) {

  if (
    symbol === "XAU/USD"
  ) {

    return Number(
      value.toFixed(2)
    );
  }


  if (
    symbol === "USD/JPY"
  ) {

    return Number(
      value.toFixed(3)
    );
  }


  return Number(
    value.toFixed(5)
  );
}


// ============================================================
// FETCH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = 15000
) {

  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeout
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
// JSON
// ============================================================

function json(
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
          "application/json; charset=UTF-8",

        "cache-control":
          "no-store"
      }
    }
  );
}


// ============================================================
// HTML RESPONSE
// ============================================================

function htmlResponse(
  html
) {

  return new Response(
    html,
    {
      headers: {
        "content-type":
          "text/html; charset=UTF-8"
      }
    }
  );
}


// ============================================================
// HOME PAGE
// ============================================================

function homePage() {

  return `<!DOCTYPE html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
Forex Signal Engine V2 | موتور سیگنال فارکس
</title>

<meta
name="description"
content="موتور تحلیل چندتایم‌فریمی بازار فارکس با EMA، RSI، MACD، ATR و ADX."
>

<meta
