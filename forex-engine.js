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

  minScore: 75,

  atrMultiplier: 1.5,

  tp1R: 2,
  tp2R: 3,

  riskPercent: 0.5,

  cooldownMinutes: 60,

  maxNewSignalsPerRun: 2,

  maxOpenSignals: 2,

  dailyLossLimitR: 2,

  requestTimeoutMs: 15000
};


// ============================================================
// MAIN FETCH
// ============================================================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      await initDatabase(env);

      if (request.method === "GET" && path === "/") {
        return htmlResponse(homePage());
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          ok: true,
          service: "forex-signal-engine",
          time: new Date().toISOString()
        });
      }

      if (request.method === "GET" && path === "/robots.txt") {
        return new Response(
          "User-agent: *\nAllow: /\nSitemap: https://forex-signal-engine.hakima09360.workers.dev/sitemap.xml",
          {
            headers: {
              "content-type": "text/plain; charset=UTF-8"
            }
          }
        );
      }

      if (request.method === "GET" && path === "/sitemap.xml") {
        return new Response(sitemapXml(url.origin), {
          headers: {
            "content-type": "application/xml; charset=UTF-8"
          }
        });
      }

      if (request.method === "GET" && path === "/setup-chat") {
        return await setupTelegramChat(env);
      }

      if (request.method === "GET" && path === "/run") {
        const result = await runEngine(env);

        return json({
          ok: true,
          result
        });
      }

      if (request.method === "GET" && path === "/api/signals") {
        const limit = Math.min(
          Number(url.searchParams.get("limit") || 50),
          200
        );

        const result = await env.DB.prepare(`
          SELECT *
          FROM signals
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(limit).all();

        return json({
          ok: true,
          signals: result.results || []
        });
      }

      if (request.method === "GET" && path === "/api/stats") {
        return await getStats(env);
      }

      if (
        request.method === "POST" &&
        path === "/telegram/webhook"
      ) {
        return await telegramWebhook(request, env);
      }

      return new Response("Not Found", {
        status: 404
      });

    } catch (error) {
      console.error(error);

      return json({
        ok: false,
        error: String(error?.message || error)
      }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEngine(env));
  }
};


// ============================================================
// DATABASE
// ============================================================

async function initDatabase(env) {

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
// ENGINE
// ============================================================

async function runEngine(env) {

  const started = Date.now();

  const result = {
    startedAt: new Date().toISOString(),
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
      String(error?.message || error)
    );
  }

  const openCountResult = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM signals
    WHERE status IN ('ACTIVE','TP1_HIT')
  `).first();

  let openCount =
    Number(openCountResult?.count || 0);

  if (openCount >= CONFIG.maxOpenSignals) {
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - started;
    return result;
  }

  for (const symbol of CONFIG.symbols) {

    if (
      result.created >=
      CONFIG.maxNewSignalsPerRun
    ) {
      break;
    }

    result.scanned++;

    try {

      const candidate =
        await analyzeSymbol(symbol, env);

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
        await hasOpenSignal(env, symbol);

      if (alreadyOpen) {
        result.skipped++;
        continue;
      }

      await createSignal(env, candidate);

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

      result.errors.push(
        symbol +
        ": " +
        String(error?.message || error)
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
// MARKET ANALYSIS
// ============================================================

async function analyzeSymbol(symbol, env) {

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

  const close15 =
    candles15.map(x => x.close);

  const close1h =
    candles1h.map(x => x.close);

  const ema20 =
    EMA(close15, 20);

  const ema50 =
    EMA(close15, 50);

  const ema200 =
    EMA(close15, 200);

  const ema20_1h =
    EMA(close1h, 20);

  const ema50_1h =
    EMA(close1h, 50);

  const ema200_1h =
    EMA(close1h, 200);

  const rsi =
    RSI(close15, 14);

  const macd =
    MACD(close15);

  const atr =
    ATR(candles15, 14);

  const last =
    candles15[candles15.length - 1];

  const previous =
    candles15[candles15.length - 2];

  const price =
    last.close;

  const atrValue =
    atr[atr.length - 1];

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(atrValue) ||
    atrValue <= 0
  ) {
    return null;
  }

  const currentEma20 =
    ema20[ema20.length - 1];

  const currentEma50 =
    ema50[ema50.length - 1];

  const currentEma200 =
    ema200[ema200.length - 1];

  const h1Ema20 =
    ema20_1h[ema20_1h.length - 1];

  const h1Ema50 =
    ema50_1h[ema50_1h.length - 1];

  const h1Ema200 =
    ema200_1h[ema200_1h.length - 1];

  const currentRsi =
    rsi[rsi.length - 1];

  const currentMacd =
    macd.macd[macd.macd.length - 1];

  const currentSignal =
    macd.signal[macd.signal.length - 1];

  let longScore = 0;
  let shortScore = 0;

  if (
    price > currentEma20 &&
    currentEma20 > currentEma50 &&
    currentEma50 > currentEma200
  ) {
    longScore += 25;
  }

  if (
    price < currentEma20 &&
    currentEma20 < currentEma50 &&
    currentEma50 < currentEma200
  ) {
    shortScore += 25;
  }

  if (
    h1Ema20 > h1Ema50 &&
    h1Ema50 > h1Ema200
  ) {
    longScore += 20;
  }

  if (
    h1Ema20 < h1Ema50 &&
    h1Ema50 < h1Ema200
  ) {
    shortScore += 20;
  }

  if (
    currentRsi >= 50 &&
    currentRsi <= 68
  ) {
    longScore += 15;
  }

  if (
    currentRsi <= 50 &&
    currentRsi >= 32
  ) {
    shortScore += 15;
  }

  if (
    currentMacd > currentSignal
  ) {
    longScore += 15;
  }

  if (
    currentMacd < currentSignal
  ) {
    shortScore += 15;
  }

  if (
    last.close > previous.close
  ) {
    longScore += 10;
  }

  if (
    last.close < previous.close
  ) {
    shortScore += 10;
  }

  const recent =
    candles15.slice(
      Math.max(0, candles15.length - 21),
      candles15.length - 1
    );

  const recentHigh =
    Math.max(
      ...recent.map(x => x.high)
    );

  const recentLow =
    Math.min(
      ...recent.map(x => x.low)
    );

  if (price > recentHigh) {
    longScore += 15;
  }

  if (price < recentLow) {
    shortScore += 15;
  }

  let direction;
  let score;

  if (
    longScore >= shortScore
  ) {
    direction = "LONG";
    score = longScore;
  } else {
    direction = "SHORT";
    score = shortScore;
  }

  if (
    score < CONFIG.minScore
  ) {
    return null;
  }

  const bullishCandle =
    last.close > last.open;

  const bearishCandle =
    last.close < last.open;

  if (
    direction === "LONG" &&
    !bullishCandle
  ) {
    return null;
  }

  if (
    direction === "SHORT" &&
    !bearishCandle
  ) {
    return null;
  }

  const risk =
    atrValue * CONFIG.atrMultiplier;

  const entry =
    price;

  let stopLoss;
  let tp1;
  let tp2;

  if (direction === "LONG") {

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
    timeframe: CONFIG.signalInterval,
    score,

    entry: roundPrice(
      symbol,
      entry
    ),

    stopLoss: roundPrice(
      symbol,
      stopLoss
    ),

    tp1: roundPrice(
      symbol,
      tp1
    ),

    tp2: roundPrice(
      symbol,
      tp2
    ),

    initialR: roundPrice(
      symbol,
      risk
    ),

    rsi: Number(
      currentRsi.toFixed(2)
    ),

    atr: Number(
      atrValue.toFixed(6)
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

  if (!env.TWELVE_DATA_API_KEY) {
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
          "accept": "application/json"
        }
      },
      CONFIG.requestTimeoutMs
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
    !Array.isArray(data.values)
  ) {
    throw new Error(
      "No candle data returned for " +
      symbol
    );
  }

  return data.values
    .map(item => ({
      time: item.datetime,
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),

      volume:
        item.volume === undefined
          ? null
          : Number(item.volume)
    }))
    .filter(item =>
      Number.isFinite(item.open) &&
      Number.isFinite(item.high) &&
      Number.isFinite(item.low) &&
      Number.isFinite(item.close)
    )
    .reverse();
}


// ============================================================
// SIGNAL CREATION
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).bind(
      candidate.symbol,
      candidate.direction,
      candidate.timeframe,
      candidate.score,
      candidate.entry,
      candidate.stopLoss,
      candidate.tp1,
      candidate.tp2,
      candidate.initialR
    ).run();

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
    `).bind(
      signalId,
      candidate.entry,
      "Signal created"
    ).run();
  }

  return signalId;
}


// ============================================================
// OPEN SIGNAL MONITORING
// ============================================================

async function updateOpenSignals(env) {

  const result =
    await env.DB.prepare(`
      SELECT *
      FROM signals
      WHERE status IN ('ACTIVE','TP1_HIT')
      ORDER BY created_at ASC
    `).all();

  const signals =
    result.results || [];

  for (const signal of signals) {

    try {

      const candles =
        await getCandles(
          env,
          signal.symbol,
          CONFIG.signalInterval,
          5
        );

      if (!candles.length) {
        continue;
      }

      const price =
        candles[candles.length - 1].close;

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
        `).bind(signal.id).run();

        await env.DB.prepare(`
          INSERT INTO signal_events (
            signal_id,
            event_type,
            price,
            note
          )
          VALUES (?, 'TP1_HIT', ?, ?)
        `).bind(
          signal.id,
          price,
          "TP1 reached; stop moved to breakeven"
        ).run();

        await sendTelegram(
          env,
          formatEvent(
            signal,
            "TP1 HIT",
            price,
            "TP1 reached. Remaining position protected at breakeven."
          )
        );

        continue;
      }

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
            "Target 2 reached."
          )
        );

        continue;
      }

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
  `).bind(
    status,
    resultR,
    price,
    signal.id
  ).run();

  await env.DB.prepare(`
    INSERT INTO signal_events (
      signal_id,
      event_type,
      price,
      note
    )
    VALUES (?, ?, ?, ?)
  `).bind(
    signal.id,
    status,
    price,
    note
  ).run();
}


// ============================================================
// HELPERS
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
    `).bind(symbol).first();

  return Boolean(result);
}


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
    `).bind(
      symbol,
      direction
    ).first();

  if (!result) {
    return false;
  }

  const created =
    new Date(
      result.created_at
    ).getTime();

  const age =
    Date.now() - created;

  return (
    age <
    CONFIG.cooldownMinutes *
    60 *
    1000
  );
}


function reachedTarget(
  direction,
  price,
  target
) {

  if (
    direction === "LONG"
  ) {
    return price >= target;
  }

  return price <= target;
}


function stopReached(
  direction,
  price,
  stop
) {

  if (
    direction === "LONG"
  ) {
    return price <= stop;
  }

  return price >= stop;
}


// ============================================================
// TELEGRAM SETUP
// ============================================================

async function setupTelegramChat(env) {

  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN is missing"
    }, 500);
  }

  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/getUpdates";

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (!data.ok) {
    return json({
      ok: false,
      telegram: data
    }, 500);
  }

  const updates =
    data.result || [];

  let chatId = null;

  for (
    let i = updates.length - 1;
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

    return json({
      ok: false,
      message:
        "No Telegram chat found. Open your bot in Telegram and send /start, then open /setup-chat again."
    }, 400);
  }

  await saveChatId(
    env,
    chatId
  );

  await sendTelegram(
    env,
    "✅ اتصال موتور سیگنال فارکس برقرار شد.\n\nربات آماده دریافت سیگنال است."
  );

  return json({
    ok: true,
    message:
      "Telegram chat connected successfully.",
    chat_id_saved: true
  });
}


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
  `).bind(chatId).run();

  await env.DB.prepare(`
    INSERT INTO subscribers (
      chat_id,
      active
    )
    VALUES (?, 1)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      active = 1
  `).bind(chatId).run();
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
    ).trim();

  if (
    text === "/start" ||
    text === "/help"
  ) {

    await sendTelegram(
      env,
      "🤖 Forex Signal Engine\n\n" +
      "ربات فعال است.\n" +
      "سیگنال‌ها پس از بررسی شرایط بازار ارسال می‌شوند."
    );
  }

  return json({
    ok: true
  });
}


// ============================================================
// TELEGRAM SEND
// ============================================================

async function sendTelegram(
  env,
  text
) {

  if (!env.TELEGRAM_BOT_TOKEN) {
    return false;
  }

  const result =
    await env.DB.prepare(`
      SELECT value
      FROM settings
      WHERE key = 'telegram_chat_id'
      LIMIT 1
    `).first();

  if (!result?.value) {
    return false;
  }

  const url =
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage";

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body: JSON.stringify({
        chat_id: result.value,
        text,
        disable_web_page_preview: true
      })
    });

  return response.ok;
}


// ============================================================
// TELEGRAM FORMAT
// ============================================================

function formatNewSignal(signal) {

  const emoji =
    signal.direction === "LONG"
      ? "🟢"
      : "🔴";

  return (
    emoji +
    " FOREX SIGNAL\n\n" +

    "📌 Symbol: " +
    signal.symbol +
    "\n" +

    "📈 Direction: " +
    signal.direction +
    "\n" +

    "⏱ Timeframe: " +
    signal.timeframe +
    "\n\n" +

    "⭐ Score: " +
    signal.score +
    "/100\n\n" +

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

    "⚠️ Risk per trade: " +
    CONFIG.riskPercent +
    "%\n\n" +

    "این سیگنال تضمین سود نیست."
  );
}


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

    "📌 " +
    signal.symbol +
    "\n" +

    "📈 " +
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

async function getStats(env) {

  const total =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
    `).first();

  const wins =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r > 0
    `).first();

  const losses =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r < 0
    `).first();

  const closed =
    await env.DB.prepare(`
      SELECT COUNT(*) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `).first();

  const average =
    await env.DB.prepare(`
      SELECT AVG(result_r) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `).first();

  const sumR =
    await env.DB.prepare(`
      SELECT SUM(result_r) AS value
      FROM signals
      WHERE result_r IS NOT NULL
    `).first();

  const winRate =
    Number(closed?.value || 0) > 0
      ? (
          Number(wins?.value || 0) /
          Number(closed?.value || 1)
        ) * 100
      : 0;

  return json({
    ok: true,

    stats: {
      totalSignals:
        Number(total?.value || 0),

      wins:
        Number(wins?.value || 0),

      losses:
        Number(losses?.value || 0),

      closed:
        Number(closed?.value || 0),

      winRate:
        Number(winRate.toFixed(2)),

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
// TECHNICAL INDICATORS
// ============================================================

function EMA(values, period) {

  const result =
    new Array(values.length)
      .fill(null);

  if (
    values.length < period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    sum += values[i];
  }

  let previous =
    sum / period;

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


function RSI(values, period) {

  const result =
    new Array(values.length)
      .fill(null);

  if (
    values.length <= period
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

    if (change > 0) {
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
    let i = period + 1;
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

  return 100 -
    (
      100 /
      (1 + rs)
    );
}


function MACD(values) {

  const ema12 =
    EMA(values, 12);

  const ema26 =
    EMA(values, 26);

  const macd =
    new Array(values.length)
      .fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    if (
      ema12[i] !== null &&
      ema26[i] !== null
    ) {

      macd[i] =
        ema12[i] -
        ema26[i];
    }
  }

  const clean =
    macd.filter(
      x => x !== null
    );

  const signalClean =
    EMA(clean, 9);

  const signal =
    new Array(values.length)
      .fill(null);

  let index = 0;

  for (
    let i = 0;
    i < macd.length;
    i++
  ) {

    if (
      macd[i] !== null
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


function ATR(
  candles,
  period
) {

  const tr =
    new Array(candles.length)
      .fill(null);

  for (
    let i = 0;
    i < candles.length;
    i++
  ) {

    if (i === 0) {

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
      candles[i - 1].close;

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
    new Array(candles.length)
      .fill(null);

  if (
    candles.length <= period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    sum += tr[i];
  }

  let previous =
    sum / period;

  result[period] =
    previous;

  for (
    let i = period + 1;
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
      () => controller.abort(),
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
// JSON RESPONSE
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
// HTML
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


function homePage() {

  return `<!DOCTYPE html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
Forex Signal Engine | موتور سیگنال فارکس
</title>

<meta
name="description"
content="موتور تحلیل و تولید سیگنال فارکس با بررسی روند، EMA، RSI، MACD و ATR."
>

<meta name="robots"
content="index,follow"
>

<link
rel="canonical"
href="https://forex-signal-engine.hakima09360.workers.dev/"
>

</head>

<body
style="
font-family:Arial,sans-serif;
max-width:900px;
margin:40px auto;
padding:20px;
line-height:2;
">

<h1>
📈 موتور سیگنال فارکس
</h1>

<p>
سیستم تحلیل بازار فارکس با استفاده از داده‌های بازار،
روندهای چند تایم‌فریمی و اندیکاتورهای تکنیکال.
</p>

<h2>
ویژگی‌ها
</h2>

<ul>

<li>EMA 20 / 50 / 200</li>

<li>RSI</li>

<li>MACD</li>

<li>ATR</li>

<li>تأیید روند 1H</li>

<li>تحلیل تایم‌فریم 15 دقیقه</li>

<li>مدیریت TP و SL</li>

<li>ثبت عملکرد سیگنال‌ها</li>

<li>ارسال اعلان تلگرام</li>

</ul>

<p>
⚠️ هیچ سیستم معاملاتی نمی‌تواند سود یا دقت ۱۰۰٪ را تضمین کند.
</p>

</body>

</html>`;
}


function sitemapXml(
  origin
) {

  return `<?xml version="1.0" encoding="UTF-8"?>

<urlset
xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
>

<url>
<loc>${origin}/</loc>
</url>

<url>
<loc>${origin}/health</loc>
</url>

</urlset>`;
        }
