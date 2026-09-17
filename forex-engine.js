// ============================================================
// FOREX SIGNAL ENGINE V5.3
// GOLD FOCUS - XAU/USD
// Cloudflare Worker + Twelve Data + Telegram
//
// V5.3 Improvements:
// - Stronger multi-timeframe confirmation
// - Weighted directional scoring
// - ADX + DI trend-strength filter
// - RSI overbought/oversold protection
// - MACD histogram confirmation
// - Momentum confirmation
// - Breakout confirmation
// - ATR volatility filter
// - Signal confidence levels
// - Duplicate Telegram signal cooldown
//
// Primary: XAU/USD
// Analysis: 15M + 1H
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
  version: "V5.3",

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

  // Stronger signal thresholds
  minScore: 80,
  strongScore: 90,

  // Minimum ADX for a real directional signal
  minADX: 20,
  strongADX: 25,

  // Cooldown between identical Telegram signals
  signalCooldownMinutes: 15,

  // Minimum ATR percentage required for a directional signal
  minATRPercent: 0.03,

  timezone: "UTC"
};

// ============================================================
// DASHBOARD HTML
// ============================================================

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>موتور سیگنال فارکس — V5.3</title>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet">

<style>
:root {
  --bg: #0d1117;
  --bg-raised: #131a24;
  --bg-card: #161d29;
  --border: #232c3b;
  --border-soft: #1a212d;

  --text: #eef1f6;
  --text-dim: #8f9bb3;
  --text-faint: #566079;

  --gold: #e8b84b;
  --gold-glow: rgba(232,184,75,0.35);
  --gold-dim: #a37f2c;

  --red: #ef5a54;
  --red-glow: rgba(239,90,84,0.32);
  --red-dim: #a13f3b;

  --teal: #3fc9b5;
  --teal-glow: rgba(63,201,181,0.28);

  --neutral: #4b5468;
  --neutral-glow: rgba(75,84,104,0.25);

  --mono: 'IBM Plex Mono', monospace;
  --sans: 'Vazirmatn', sans-serif;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background:
    radial-gradient(
      ellipse 900px 500px at 15% -10%,
      rgba(232,184,75,0.08),
      transparent 60%
    ),
    radial-gradient(
      ellipse 700px 400px at 100% 0%,
      rgba(63,201,181,0.06),
      transparent 55%
    ),
    var(--bg);

  color: var(--text);
  font-family: var(--sans);
  min-height: 100vh;
  padding: 22px 16px 60px;
}

.wrap {
  max-width: 960px;
  margin: 0 auto;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 20px;
  margin-bottom: 22px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;

  background:
    linear-gradient(
      135deg,
      var(--gold),
      #b9852a
    );

  display: flex;
  align-items: center;
  justify-content: center;

  font-family: var(--mono);
  font-weight: 700;
  font-size: 15px;

  color: #1a1306;

  box-shadow:
    0 4px 18px var(--gold-glow);

  flex-shrink: 0;
}

header h1 {
  font-size: 18px;
  font-weight: 700;
}

header h1 span {
  color: var(--text-faint);
  font-weight: 500;
  font-size: 13px;
}

header .meta {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-faint);
  direction: ltr;
  text-align: left;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 9px;

  font-family: var(--mono);
  font-size: 12px;

  color: var(--text-dim);

  margin-bottom: 26px;

  padding: 10px 14px;

  background: var(--bg-raised);

  border: 1px solid var(--border-soft);

  border-radius: 8px;

  width: fit-content;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;

  background: var(--text-faint);

  flex-shrink: 0;
}

.dot.live {
  background: var(--teal);

  box-shadow:
    0 0 0 4px var(--teal-glow);

  animation:
    pulse 2s ease-in-out infinite;
}

.dot.error {
  background: var(--red);

  box-shadow:
    0 0 0 4px var(--red-glow);
}

@keyframes pulse {
  0%,100% {
    opacity: 1;
  }

  50% {
    opacity: 0.5;
  }
}

.hero {
  background:
    linear-gradient(
      155deg,
      var(--bg-card) 0%,
      var(--bg-raised) 100%
    );

  border: 1px solid var(--border);

  border-radius: 16px;

  padding: 30px 26px;

  margin-bottom: 18px;

  position: relative;

  overflow: hidden;

  box-shadow:
    0 20px 50px -25px rgba(0,0,0,0.6);
}

.hero::before {
  content: "";

  position: absolute;

  inset: 0;

  background:
    radial-gradient(
      700px 260px at 100% 0%,
      var(--signal-glow, var(--neutral-glow)),
      transparent 65%
    );

  pointer-events: none;
}

.hero::after {
  content: "";

  position: absolute;

  top: 0;
  right: 0;

  width: 4px;
  height: 100%;

  background:
    var(--signal-color, var(--neutral));

  box-shadow:
    0 0 16px var(--signal-glow, transparent);
}

.hero-top {
  display: flex;

  justify-content: space-between;

  align-items: flex-start;

  margin-bottom: 20px;

  flex-wrap: wrap;

  gap: 14px;

  position: relative;
}

.hero-symbol {
  font-family: var(--mono);

  font-size: 13px;

  color: var(--text-dim);

  letter-spacing: 0.04em;

  margin-bottom: 8px;

  display: flex;

  align-items: center;

  gap: 8px;
}

.hero-symbol .pill {
  background: var(--bg);

  border: 1px solid var(--border);

  padding: 2px 9px;

  border-radius: 20px;

  font-size: 11px;
}

.hero-price {
  font-family: var(--mono);

  font-size: 46px;

  font-weight: 700;

  line-height: 1;

  direction: ltr;

  text-align: left;
}

.signal-badge {
  font-family: var(--mono);

  font-size: 14px;

  font-weight: 700;

  padding: 10px 18px;

  border-radius: 10px;

  background:
    var(--signal-color, var(--neutral));

  color: #0d1117;

  white-space: nowrap;

  height: fit-content;

  box-shadow:
    0 8px 24px -6px
    var(--signal-glow, transparent);

  display: flex;

  align-items: center;

  gap: 8px;
}

.signal-badge .strength-dot {
  width: 6px;
  height: 6px;

  border-radius: 50%;

  background: rgba(13,17,23,0.5);
}

.hero-sub {
  display: flex;

  gap: 22px;

  flex-wrap: wrap;

  font-size: 13px;

  color: var(--text-dim);

  position: relative;
}

.hero-sub b {
  color: var(--text);

  font-weight: 600;
}

.score-bar-wrap {
  margin-top: 20px;

  position: relative;
}

.score-bar-label {
  display: flex;

  justify-content: space-between;

  font-family: var(--mono);

  font-size: 11px;

  color: var(--text-faint);

  margin-bottom: 7px;
}

.score-bar-label .score-num {
  color:
    var(--signal-color, var(--text));

  font-weight: 700;

  font-size: 13px;
}

.score-bar {
  height: 7px;

  background: var(--bg);

  border-radius: 4px;

  overflow: hidden;

  border: 1px solid var(--border-soft);
}

.score-bar-fill {
  height: 100%;

  background:
    linear-gradient(
      90deg,
      var(--signal-dim, var(--neutral)),
      var(--signal-color, var(--neutral))
    );

  border-radius: 4px;

  transition:
    width 0.8s
    cubic-bezier(0.22,1,0.36,1);

  box-shadow:
    0 0 10px
    var(--signal-glow, transparent);
}

.indicators {
  display: grid;

  grid-template-columns:
    repeat(auto-fit,minmax(95px,1fr));

  gap: 12px;

  margin-top: 22px;

  padding-top: 20px;

  border-top:
    1px solid var(--border-soft);

  position: relative;
}

.ind-item {
  background:
    rgba(255,255,255,0.02);

  border:
    1px solid var(--border-soft);

  border-radius: 9px;

  padding: 10px 12px;
}

.ind-label {
  font-size: 10.5px;

  color: var(--text-faint);

  margin-bottom: 4px;
}

.ind-value {
  font-family: var(--mono);

  font-size: 15px;

  font-weight: 600;

  color: var(--text);

  direction: ltr;
}

.section-label {
  font-family: var(--mono);

  font-size: 12px;

  color: var(--text-faint);

  margin: 30px 0 14px;

  display: flex;

  align-items: center;

  gap: 10px;
}

.section-label::after {
  content: "";

  flex: 1;

  height: 1px;

  background:
    var(--border-soft);
}

.pairs-grid {
  display: grid;

  grid-template-columns:
    repeat(auto-fit,minmax(270px,1fr));

  gap: 13px;
}

.pair-card {
  background: var(--bg-raised);

  border:
    1px solid var(--border);

  border-radius: 12px;

  padding: 18px 20px;

  position: relative;

  overflow: hidden;
}

.pair-card::before {
  content: "";

  position: absolute;

  top: 0;
  right: 0;

  width: 3px;
  height: 100%;

  background:
    var(--signal-color,var(--neutral));

  box-shadow:
    0 0 12px
    var(--signal-glow,transparent);
}

.pair-top {
  display: flex;

  justify-content: space-between;

  align-items: center;

  margin-bottom: 12px;
}

.pair-symbol {
  font-family: var(--mono);

  font-size: 13px;

  color: var(--text);

  font-weight: 600;
}

.pair-signal {
  font-family: var(--mono);

  font-size: 11px;

  font-weight: 700;

  color:
    var(--signal-color,var(--neutral));

  background:
    color-mix(
      in srgb,
      var(--signal-color,var(--neutral)) 15%,
      transparent
    );

  padding: 3px 10px;

  border-radius: 20px;
}

.pair-price {
  font-family: var(--mono);

  font-size: 24px;

  font-weight: 700;

  direction: ltr;

  text-align: left;

  margin-bottom: 12px;
}

.pair-meta {
  display: flex;

  justify-content: space-between;

  font-size: 12px;

  color: var(--text-dim);

  padding-top: 10px;

  border-top:
    1px solid var(--border-soft);
}

.pair-meta span b {
  color: var(--text);

  font-family: var(--mono);

  font-weight: 600;
}

.state-box {
  background: var(--bg-card);

  border:
    1px solid var(--border);

  border-radius: 14px;

  padding: 48px 24px;

  text-align: center;

  color: var(--text-dim);

  font-size: 14px;
}

.state-box.error {
  border-color:
    var(--red-dim);

  color:
    #f19d98;
}

.state-box .retry {
  margin-top: 16px;

  display: inline-block;

  font-family: var(--mono);

  font-size: 12px;

  color: var(--text);

  background: var(--bg-raised);

  border:
    1px solid var(--border);

  padding: 9px 18px;

  border-radius: 8px;

  cursor: pointer;
}

footer {
  margin-top: 44px;

  padding-top: 18px;

  border-top:
    1px solid var(--border-soft);

  font-family: var(--mono);

  font-size: 11px;

  color: var(--text-faint);

  display: flex;

  justify-content: space-between;

  flex-wrap: wrap;

  gap: 8px;
}

@media (max-width:560px) {
  .hero-price {
    font-size: 34px;
  }

  .indicators {
    grid-template-columns:
      repeat(2,1fr);
  }
}
</style>
</head>

<body>

<div class="wrap">

<header>

<div class="brand">

<div class="brand-mark">FX</div>

<h1>
موتور سیگنال فارکس
<span>V5.3 · Gold Focus</span>
</h1>

</div>

<div class="meta" id="lastUpdate">—</div>

</header>

<div class="status-line">

<span class="dot" id="statusDot"></span>

<span id="statusText">
در حال اتصال...
</span>

</div>

<div id="content">

<div class="state-box">
در حال دریافت سیگنال‌ها...
</div>

</div>

<footer>

<span>
تحلیل ۱۵ دقیقه‌ای + تأیید ۱ ساعته
</span>

<span id="refreshCountdown">
رفرش خودکار: ۶۰ ثانیه
</span>

</footer>

</div>

<script>

(function () {

const REFRESH_MS = 60000;

const API_PATH = "/api/signals";

const SIGNAL_LABEL = {
  BUY: "خرید",
  SELL: "فروش",
  WAIT: "صبر کن"
};

const SIGNAL_STYLE = {

  BUY: {
    color: "var(--gold)",
    glow: "var(--gold-glow)",
    dim: "var(--gold-dim)"
  },

  SELL: {
    color: "var(--red)",
    glow: "var(--red-glow)",
    dim: "var(--red-dim)"
  },

  WAIT: {
    color: "var(--neutral)",
    glow: "var(--neutral-glow)",
    dim: "var(--neutral)"
  }

};

const STRENGTH_LABEL = {
  STRONG: "قوی",
  MODERATE: "متوسط",
  WEAK: "ضعیف"
};

function fmtNumber(n, decimals) {

  if (
    typeof n !== "number" ||
    !isFinite(n)
  ) {
    return "—";
  }

  return n.toFixed(
    decimals != null ? decimals : 2
  );
}

function fmtTime(iso) {

  try {

    const d = new Date(iso);

    return d.toLocaleTimeString(
      "fa-IR",
      {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }
    );

  } catch (e) {

    return iso;

  }
}

function styleFor(signal) {

  return (
    SIGNAL_STYLE[signal] ||
    SIGNAL_STYLE.WAIT
  );

}

function renderHero(sig) {

  const s = styleFor(sig.signal);

  const label =
    SIGNAL_LABEL[sig.signal] ||
    sig.signal;

  const strengthLabel =
    STRENGTH_LABEL[sig.strength] ||
    sig.strength;

  return \`
  <div
    class="hero"
    style="
      --signal-color:\${s.color};
      --signal-glow:\${s.glow};
      --signal-dim:\${s.dim}
    "
  >

    <div class="hero-top">

      <div>

        <div class="hero-symbol">
          \${sig.symbol}

          <span class="pill">
            نماد اصلی
          </span>
        </div>

        <div class="hero-price">
          \${fmtNumber(sig.price,5)}
        </div>

      </div>

      <div class="signal-badge">

        <span class="strength-dot"></span>

        \${label}
        ·
        \${strengthLabel}

      </div>

    </div>

    <div class="hero-sub">

      <span>
        روند ۱۵ دقیقه:
        <b>\${sig.trend_15m}</b>
      </span>

      <span>
        روند ۱ ساعته:
        <b>\${sig.trend_1h}</b>
      </span>

      <span>
        هم‌راستایی:
        <b>\${sig.analysis.multi_timeframe}</b>
      </span>

      <span>
        اعتماد:
        <b>\${sig.confidence}%</b>
      </span>

    </div>

    <div class="score-bar-wrap">

      <div class="score-bar-label">

        <span>
          امتیاز تحلیل
        </span>

        <span class="score-num">
          \${sig.score}/100
        </span>

      </div>

      <div class="score-bar">

        <div
          class="score-bar-fill"
          style="width:\${sig.score}%"
        ></div>

      </div>

    </div>

    <div class="indicators">

      <div class="ind-item">
        <div class="ind-label">
          RSI 14
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.rsi14,2)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          MACD
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.macd,4)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          ADX 14
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.adx14,2)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          +DI
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.plusDI,2)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          -DI
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.minusDI,2)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          ATR 14
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.atr14,4)}
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          Momentum
        </div>
        <div class="ind-value">
          \${fmtNumber(sig.indicators.momentum,3)}%
        </div>
      </div>

      <div class="ind-item">
        <div class="ind-label">
          شکست قیمت
        </div>
        <div
          class="ind-value"
          style="font-size:12px;"
        >
          \${sig.indicators.breakout}
        </div>
      </div>

    </div>

  </div>
  \`;
}

function renderPairCard(sig) {

  const s =
    styleFor(sig.signal);

  const label =
    SIGNAL_LABEL[sig.signal] ||
    sig.signal;

  return \`
  <div
    class="pair-card"
    style="
      --signal-color:\${s.color};
      --signal-glow:\${s.glow}
    "
  >

    <div class="pair-top">

      <span class="pair-symbol">
        \${sig.symbol}
      </span>

      <span class="pair-signal">
        \${label}
      </span>

    </div>

    <div class="pair-price">
      \${fmtNumber(sig.price,5)}
    </div>

    <div class="pair-meta">

      <span>
        امتیاز:
        <b>\${sig.score}</b>
      </span>

      <span>
        RSI:
        <b>\${fmtNumber(sig.indicators.rsi14,1)}</b>
      </span>

      <span>
        \${sig.trend_1h}
      </span>

    </div>

  </div>
  \`;
}

function render(data) {

  const content =
    document.getElementById("content");

  const signals =
    data.signals || [];

  if (!signals.length) {

    content.innerHTML =
      '<div class="state-box">سیگنالی دریافت نشد.</div>';

    return;
  }

  const primary =
    signals.find(
      s => s.priority
    ) || signals[0];

  const others =
    signals.filter(
      s => s !== primary
    );

  let html =
    renderHero(primary);

  if (others.length) {

    html +=
      '<div class="section-label">سایر نمادها</div>';

    html +=
      '<div class="pairs-grid">' +
      others.map(renderPairCard).join("") +
      '</div>';

  }

  content.innerHTML = html;

  document.getElementById(
    "lastUpdate"
  ).textContent =
    fmtTime(data.timestamp);

}

function renderError(message) {

  const content =
    document.getElementById("content");

  content.innerHTML = \`
    <div class="state-box error">

      خطا در دریافت سیگنال‌ها:
      \${message}

      <br>

      <span
        class="retry"
        onclick="window.__fsRefresh()"
      >
        تلاش دوباره
      </span>

    </div>
  \`;

}

function setStatus(state,text) {

  const dot =
    document.getElementById(
      "statusDot"
    );

  const label =
    document.getElementById(
      "statusText"
    );

  dot.className =
    "dot" +
    (
      state === "live"
        ? " live"
        : state === "error"
          ? " error"
          : ""
    );

  label.textContent = text;

}

let countdownTimer = null;

function startCountdown() {

  let remaining =
    Math.floor(
      REFRESH_MS / 1000
    );

  const el =
    document.getElementById(
      "refreshCountdown"
    );

  if (countdownTimer) {
    clearInterval(countdownTimer);
  }

  countdownTimer =
    setInterval(() => {

      remaining -= 1;

      if (remaining <= 0) {
        remaining =
          Math.floor(
            REFRESH_MS / 1000
          );
      }

      el.textContent =
        "رفرش خودکار: " +
        remaining +
        " ثانیه";

    },1000);

}

async function fetchSignals() {

  setStatus(
    "",
    "در حال به‌روزرسانی..."
  );

  try {

    const res =
      await fetch(
        API_PATH,
        {
          cache: "no-store"
        }
      );

    if (!res.ok) {
      throw new Error(
        "HTTP " + res.status
      );
    }

    const data =
      await res.json();

    if (!data.ok) {
      throw new Error(
        data.error ||
        "پاسخ نامعتبر"
      );
    }

    render(data);

    setStatus(
      "live",
      "زنده — به‌روزرسانی شد"
    );

  } catch (err) {

    setStatus(
      "error",
      "خطا در اتصال"
    );

    renderError(
      err.message ||
      String(err)
    );

  }

}

window.__fsRefresh =
  fetchSignals;

fetchSignals();

startCountdown();

setInterval(
  fetchSignals,
  REFRESH_MS
);

})();
</script>

</body>
</html>`;

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

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {

      if (request.method === "OPTIONS") {
        return corsResponse("",204);
      }

      if (path === "/") {
        return htmlResponse(
          DASHBOARD_HTML
        );
      }

      if (path === "/health") {

        const telegramToken =
          getTelegramToken(env);

        const telegramChatId =
          getTelegramChatId(env);

        const twelveKey =
          getTwelveDataKey(env);

        return jsonResponse({

          ok: true,

          service:
            "موتور سیگنال فارکس",

          version:
            CONFIG.version,

          focus:
            CONFIG.primarySymbol,

          analysis:
            "15M + 1H",

          thresholds: {
            minScore:
              CONFIG.minScore,

            strongScore:
              CONFIG.strongScore,

            minADX:
              CONFIG.minADX
          },

          indicators: [
            "EMA 20",
            "EMA 50",
            "EMA 200",
            "RSI 14",
            "MACD 12/26/9",
            "ATR 14",
            "ADX 14",
            "Momentum",
            "Breakout"
          ],

          connections: {

            twelve_data:
              !!twelveKey,

            telegram:
              !!(
                telegramToken &&
                telegramChatId
              )

          },

          telegram:
            !!(
              telegramToken &&
              telegramChatId
            ),

          timestamp:
            new Date().toISOString()

        });

      }

      if (path === "/api/signals") {

        const signals =
          await generateAllSignals(env);

        return jsonResponse({

          ok: true,

          version:
            CONFIG.version,

          focus:
            CONFIG.primarySymbol,

          count:
            signals.length,

          signals,

          timestamp:
            new Date().toISOString()

        });

      }

      if (path === "/api/stats") {

        return jsonResponse(
          await getStats(env)
        );

      }

      if (path === "/run") {

        const result =
          await runEngine(env);

        return jsonResponse(
          result
        );

      }

      if (path === "/telegram-test") {

        const result =
          await testTelegram(env);

        return jsonResponse(
          result
        );

      }

      return jsonResponse(
        {
          ok: false,
          error: "Not Found",
          endpoints: [
            "/health",
            "/api/signals",
            "/api/stats",
            "/run",
            "/telegram-test"
          ]
        },
        404
      );

    } catch (error) {

      console.error(
        "ENGINE ERROR:",
        error
      );

      return jsonResponse(
        {
          ok: false,
          version:
            CONFIG.version,

          error:
            error?.message ||
            String(error),

          timestamp:
            new Date().toISOString()
        },
        500
      );

    }

  },

  async scheduled(event, env, ctx) {

    ctx.waitUntil(

      runEngine(env).catch(
        error => {

          console.error(
            "SCHEDULED ENGINE ERROR:",
            error
          );

        }
      )

    );

  }

};

// ============================================================
// RUN ENGINE
// ============================================================

async function runEngine(env) {

  const startedAt =
    Date.now();

  const signals =
    await generateAllSignals(env);

  const sent = [];

  for (const signal of signals) {

    if (
      signal.symbol ===
      CONFIG.primarySymbol ||
      signal.signal !== "WAIT"
    ) {

      const result =
        await processSignal(
          signal,
          env
        );

      sent.push({

        symbol:
          signal.symbol,

        signal:
          signal.signal,

        score:
          signal.score,

        confidence:
          signal.confidence,

        telegram:
          result.telegram,

        reason:
          result.reason || null

      });

    }

  }

  return {

    ok: true,

    version:
      CONFIG.version,

    priority:
      CONFIG.primarySymbol,

    generated:
      signals.length,

    signals,

    delivery:
      sent,

    execution_ms:
      Date.now() - startedAt,

    timestamp:
      new Date().toISOString()

  };

}

// ============================================================
// GENERATE ALL SIGNALS
// ============================================================

async function generateAllSignals(env) {

  const results = [];

  const orderedSymbols = [

    CONFIG.primarySymbol,

    ...CONFIG.symbols.filter(
      symbol =>
        symbol !==
        CONFIG.primarySymbol
    )

  ];

  const settled =
    await Promise.allSettled(

      orderedSymbols.map(
        symbol =>
          analyzeSymbol(
            symbol,
            env
          )
      )

    );

  settled.forEach(
    (outcome,i) => {

      const symbol =
        orderedSymbols[i];

      if (
        outcome.status ===
        "fulfilled"
      ) {

        results.push(
          outcome.value
        );

      } else {

        const error =
          outcome.reason;

        console.error(
          `ANALYSIS ERROR ${symbol}:`,
          error
        );

        results.push({

          ok: false,

          symbol,

          priority:
            symbol ===
            CONFIG.primarySymbol,

          signal: "WAIT",

          strength: "WEAK",

          score: 0,

          confidence: 0,

          error:
            error?.message ||
            String(error),

          timestamp:
            new Date().toISOString()

        });

      }

    }
  );

  return results;

}

// ============================================================
// ANALYZE SYMBOL
// ============================================================

async function analyzeSymbol(
  symbol,
  env
) {

  const [
    candles15m,
    candles1h
  ] = await Promise.all([

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
    candles15m.length < 220
  ) {

    throw new Error(
      `${symbol}: insufficient 15M candles (${candles15m.length})`
    );

  }

  if (
    candles1h.length < 220
  ) {

    throw new Error(
      `${symbol}: insufficient 1H candles (${candles1h.length})`
    );

  }

  const indicators15m =
    calculateIndicators(
      candles15m
    );

  const indicators1h =
    calculateIndicators(
      candles1h
    );

  const trend15m =
    determineTrend(
      indicators15m
    );

  const trend1h =
    determineTrend(
      indicators1h
    );

  const momentum15m =
    calculateMomentum(
      candles15m
    );

  const breakout15m =
    calculateBreakout(
      candles15m
    );

  const scoreData =
    calculateSignalScore({

      indicators15m,

      indicators1h,

      trend15m,

      trend1h,

      momentum15m,

      breakout15m

    });

  const score =
    scoreData.score;

  const direction =
    scoreData.direction;

  const signal =
    scoreToSignal(
      score,
      direction,
      trend15m,
      trend1h,
      indicators15m,
      indicators1h,
      breakout15m
    );

  const strength =
    getStrength(score);

  const confidence =
    calculateConfidence({
      score,
      signal,
      trend15m,
      trend1h,
      indicators15m,
      indicators1h,
      momentum15m,
      breakout15m
    });

  const last =
    candles15m[
      candles15m.length - 1
    ];

  const atrPercent =
    last.close !== 0
      ? (indicators15m.atr /
          last.close) * 100
      : 0;

  return {

    ok: true,

    version:
      CONFIG.version,

    symbol,

    priority:
      symbol ===
      CONFIG.primarySymbol,

    timeframe:
      CONFIG.interval,

    confirmation_timeframe:
      CONFIG.confirmationInterval,

    signal,

    direction,

    strength,

    score,

    confidence,

    price:
      round(last.close,5),

    trend_15m:
      trend15m,

    trend_1h:
      trend1h,

    indicators: {

      ema20_15m:
        round(indicators15m.ema20),

      ema50_15m:
        round(indicators15m.ema50),

      ema200_15m:
        round(indicators15m.ema200),

      ema20_1h:
        round(indicators1h.ema20),

      ema50_1h:
        round(indicators1h.ema50),

      ema200_1h:
        round(indicators1h.ema200),

      rsi14:
        round(indicators15m.rsi,2),

      rsi14_1h:
        round(indicators1h.rsi,2),

      macd:
        round(indicators15m.macd,4),

      macd_signal:
        round(
          indicators15m.macdSignal,
          4
        ),

      macd_histogram:
        round(
          indicators15m.macdHistogram,
          4
        ),

      macd_1h:
        round(indicators1h.macd,4),

      macd_signal_1h:
        round(
          indicators1h.macdSignal,
          4
        ),

      atr14:
        round(indicators15m.atr,4),

      atr_percent:
        round(atrPercent,4),

      adx14:
        round(indicators15m.adx,2),

      plusDI:
        round(indicators15m.plusDI,2),

      minusDI:
        round(indicators15m.minusDI,2),

      adx14_1h:
        round(indicators1h.adx,2),

      plusDI_1h:
        round(indicators1h.plusDI,2),

      minusDI_1h:
        round(indicators1h.minusDI,2),

      momentum:
        round(momentum15m,4),

      breakout:
        breakout15m.type

    },

    analysis: {

      ema:
        indicators15m.emaStatus,

      ema_1h:
        indicators1h.emaStatus,

      rsi:
        indicators15m.rsiStatus,

      rsi_1h:
        indicators1h.rsiStatus,

      macd:
        indicators15m.macdStatus,

      macd_1h:
        indicators1h.macdStatus,

      adx:
        indicators15m.adxStatus,

      momentum:
        momentum15m > 0
          ? "BULLISH"
          : momentum15m < 0
            ? "BEARISH"
            : "NEUTRAL",

      breakout:
        breakout15m.type,

      multi_timeframe:
        trend1h === trend15m
          ? "CONFIRMED"
          : "MIXED",

      direction_score:
        direction === "BULLISH"
          ? scoreData.bullish
          : direction === "BEARISH"
            ? scoreData.bearish
            : 0

    },

    filters:
      scoreData.filters,

    timestamp:
      new Date().toISOString()

  };

}

// ============================================================
// TWELVE DATA
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
    "&format=JSON" +
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
      `No candle data for ${symbol} ${interval}`
    );

  }

  return data.values

    .map(x => ({

      datetime:
        x.datetime,

      open:
        Number(x.open),

      high:
        Number(x.high),

      low:
        Number(x.low),

      close:
        Number(x.close),

      volume:
        Number(x.volume || 0)

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

function calculateIndicators(
  candles
) {

  const closes =
    candles.map(
      x => x.close
    );

  const highs =
    candles.map(
      x => x.high
    );

  const lows =
    candles.map(
      x => x.low
    );

  const ema20 =
    EMA(closes,20);

  const ema50 =
    EMA(closes,50);

  const ema200 =
    EMA(closes,200);

  const rsi =
    RSI(closes,14);

  const macdData =
    MACD(
      closes,
      12,
      26,
      9
    );

  const atr =
    ATR(
      highs,
      lows,
      closes,
      14
    );

  const adxData =
    ADX(
      highs,
      lows,
      closes,
      14
    );

  const lastClose =
    closes[
      closes.length - 1
    ];

  let emaStatus =
    "NEUTRAL";

  if (
    lastClose > ema20 &&
    ema20 > ema50 &&
    ema50 > ema200
  ) {

    emaStatus =
      "BULLISH";

  } else if (
    lastClose < ema20 &&
    ema20 < ema50 &&
    ema50 < ema200
  ) {

    emaStatus =
      "BEARISH";

  }

  let rsiStatus =
    "NEUTRAL";

  if (
    rsi >= 55 &&
    rsi <= 70
  ) {

    rsiStatus =
      "BULLISH";

  } else if (
    rsi <= 45 &&
    rsi >= 30
  ) {

    rsiStatus =
      "BEARISH";

  } else if (
    rsi > 70
  ) {

    rsiStatus =
      "OVERBOUGHT";

  } else if (
    rsi < 30
  ) {

    rsiStatus =
      "OVERSOLD";

  }

  let macdStatus =
    "NEUTRAL";

  if (
    macdData.macd >
      macdData.signal &&
    macdData.histogram > 0
  ) {

    macdStatus =
      "BULLISH";

  } else if (
    macdData.macd <
      macdData.signal &&
    macdData.histogram < 0
  ) {

    macdStatus =
      "BEARISH";

  }

  let adxStatus =
    "WEAK";

  if (
    adxData.adx >= 25
  ) {

    adxStatus =
      "STRONG";

  } else if (
    adxData.adx >= 20
  ) {

    adxStatus =
      "MODERATE";

  }

  return {

    ema20,
    ema50,
    ema200,

    rsi,

    macd:
      macdData.macd,

    macdSignal:
      macdData.signal,

    macdHistogram:
      macdData.histogram,

    atr,

    adx:
      adxData.adx,

    plusDI:
      adxData.plusDI,

    minusDI:
      adxData.minusDI,

    emaStatus,
    rsiStatus,
    macdStatus,
    adxStatus

  };

}

// ============================================================
// EMA
// ============================================================

function EMA(
  values,
  period
) {

  if (!values.length) {
    return 0;
  }

  const effectivePeriod =
    Math.min(
      period,
      values.length
    );

  const multiplier =
    2 /
    (effectivePeriod + 1);

  let ema =
    values
      .slice(
        0,
        effectivePeriod
      )
      .reduce(
        (a,b) => a + b,
        0
      ) /
    effectivePeriod;

  for (
    let i = effectivePeriod;
    i < values.length;
    i++
  ) {

    ema =
      (values[i] - ema) *
      multiplier +
      ema;

  }

  return ema;

}

// ============================================================
// EMA SERIES
// ============================================================

function EMA_series(
  values,
  period
) {

  const series =
    new Array(
      values.length
    ).fill(null);

  if (!values.length) {
    return series;
  }

  const effectivePeriod =
    Math.min(
      period,
      values.length
    );

  const multiplier =
    2 /
    (effectivePeriod + 1);

  let ema =
    values
      .slice(
        0,
        effectivePeriod
      )
      .reduce(
        (a,b) => a + b,
        0
      ) /
    effectivePeriod;

  series[
    effectivePeriod - 1
  ] = ema;

  for (
    let i = effectivePeriod;
    i < values.length;
    i++
  ) {

    ema =
      (values[i] - ema) *
      multiplier +
      ema;

    series[i] =
      ema;

  }

  for (
    let i = 0;
    i < effectivePeriod - 1;
    i++
  ) {

    series[i] =
      series[
        effectivePeriod - 1
      ];

  }

  return series;

}

// ============================================================
// RSI
// ============================================================

function RSI(
  values,
  period = 14
) {

  if (
    values.length <= period
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

    const diff =
      values[i] -
      values[i - 1];

    if (diff >= 0) {

      gains += diff;

    } else {

      losses +=
        Math.abs(diff);

    }

  }

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const diff =
      values[i] -
      values[i - 1];

    const gain =
      diff > 0
        ? diff
        : 0;

    const loss =
      diff < 0
        ? Math.abs(diff)
        : 0;

    avgGain =
      (
        avgGain *
        (period - 1) +
        gain
      ) /
      period;

    avgLoss =
      (
        avgLoss *
        (period - 1) +
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

  return (
    100 -
    100 /
      (1 + rs)
  );

}

// ============================================================
// MACD
// ============================================================

function MACD(
  values,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {

  const fastSeries =
    EMA_series(
      values,
      fastPeriod
    );

  const slowSeries =
    EMA_series(
      values,
      slowPeriod
    );

  const macdSeries =
    values.map(
      (_,i) =>
        fastSeries[i] -
        slowSeries[i]
    );

  const macd =
    macdSeries[
      macdSeries.length - 1
    ];

  const signal =
    macdSeries.length >=
    signalPeriod
      ? EMA(
          macdSeries,
          signalPeriod
        )
      : macd;

  return {

    macd,

    signal,

    histogram:
      macd - signal

  };

}

// ============================================================
// ATR
// ============================================================

function ATR(
  highs,
  lows,
  closes,
  period = 14
) {

  const trs = [];

  for (
    let i = 1;
    i < closes.length;
    i++
  ) {

    const tr =
      Math.max(

        highs[i] -
        lows[i],

        Math.abs(
          highs[i] -
          closes[i - 1]
        ),

        Math.abs(
          lows[i] -
          closes[i - 1]
        )

      );

    trs.push(tr);

  }

  if (
    trs.length < period
  ) {

    return 0;

  }

  let atr =
    trs
      .slice(0,period)
      .reduce(
        (a,b) => a + b,
        0
      ) /
    period;

  for (
    let i = period;
    i < trs.length;
    i++
  ) {

    atr =
      (
        atr *
        (period - 1) +
        trs[i]
      ) /
      period;

  }

  return atr;

}

// ============================================================
// ADX + DI
// ============================================================

function ADX(
  highs,
  lows,
  closes,
  period = 14
) {

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (
    let i = 1;
    i < closes.length;
    i++
  ) {

    const up =
      highs[i] -
      highs[i - 1];

    const down =
      lows[i - 1] -
      lows[i];

    const trueRange =
      Math.max(

        highs[i] -
        lows[i],

        Math.abs(
          highs[i] -
          closes[i - 1]
        ),

        Math.abs(
          lows[i] -
          closes[i - 1]
        )

      );

    tr.push(
      trueRange
    );

    plusDM.push(
      up > down &&
      up > 0
        ? up
        : 0
    );

    minusDM.push(
      down > up &&
      down > 0
        ? down
        : 0
    );

  }

  if (
    tr.length <
    period * 2
  ) {

    return {
      adx: 0,
      plusDI: 0,
      minusDI: 0
    };

  }

  let atr =
    average(
      tr.slice(0,period)
    );

  let plus =
    average(
      plusDM.slice(0,period)
    );

  let minus =
    average(
      minusDM.slice(0,period)
    );

  const dxValues = [];

  let plusDI =
    atr === 0
      ? 0
      : (100 * plus) / atr;

  let minusDI =
    atr === 0
      ? 0
      : (100 * minus) / atr;

  let dx =
    plusDI + minusDI === 0
      ? 0
      : (
          100 *
          Math.abs(
            plusDI -
            minusDI
          )
        ) /
        (plusDI + minusDI);

  dxValues.push(dx);

  for (
    let i = period;
    i < tr.length;
    i++
  ) {

    atr =
      (
        atr *
        (period - 1) +
        tr[i]
      ) /
      period;

    plus =
      (
        plus *
        (period - 1) +
        plusDM[i]
      ) /
      period;

    minus =
      (
        minus *
        (period - 1) +
        minusDM[i]
      ) /
      period;

    plusDI =
      atr === 0
        ? 0
        : (100 * plus) / atr;

    minusDI =
      atr === 0
        ? 0
        : (100 * minus) / atr;

    dx =
      plusDI + minusDI === 0
        ? 0
        : (
            100 *
            Math.abs(
              plusDI -
              minusDI
            )
          ) /
          (plusDI + minusDI);

    dxValues.push(dx);

  }

  let adx =
    average(
      dxValues.slice(
        0,
        Math.min(
          period,
          dxValues.length
        )
      )
    );

  for (
    let i = period;
    i < dxValues.length;
    i++
  ) {

    adx =
      (
        adx *
        (period - 1) +
        dxValues[i]
      ) /
      period;

  }

  return {
    adx,
    plusDI,
    minusDI
  };

}

// ============================================================
// MOMENTUM
// ============================================================

function calculateMomentum(
  candles
) {

  const closes =
    candles.map(
      x => x.close
    );

  if (
    closes.length < 11
  ) {

    return 0;

  }

  const current =
    closes[
      closes.length - 1
    ];

  const previous =
    closes[
      closes.length - 11
    ];

  if (
    previous === 0
  ) {

    return 0;

  }

  return (
    (
      (current - previous) /
      previous
    ) *
    100
  );

}

// ============================================================
// BREAKOUT
// ============================================================

function calculateBreakout(
  candles
) {

  const lookback = 20;

  if (
    candles.length <=
    lookback
  ) {

    return {
      type: "NONE"
    };

  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles.slice(
      candles.length -
        lookback -
        1,

      candles.length - 1
    );

  const highest =
    Math.max(
      ...previous.map(
        x => x.high
      )
    );

  const lowest =
    Math.min(
      ...previous.map(
        x => x.low
      )
    );

  if (
    last.close >
    highest
  ) {

    return {

      type:
        "BULLISH_BREAKOUT",

      level:
        highest

    };

  }

  if (
    last.close <
    lowest
  ) {

    return {

      type:
        "BEARISH_BREAKOUT",

      level:
        lowest

    };

  }

  return {

    type: "NONE",

    resistance:
      highest,

    support:
      lowest

  };

}

// ============================================================
// TREND
// ============================================================

function determineTrend(
  indicators
) {

  const bullish =
    indicators.ema20 >
      indicators.ema50 &&

    indicators.ema50 >
      indicators.ema200 &&

    indicators.macd >
      indicators.macdSignal &&

    indicators.macdHistogram >
      0 &&

    indicators.plusDI >
      indicators.minusDI;

  const bearish =
    indicators.ema20 <
      indicators.ema50 &&

    indicators.ema50 <
      indicators.ema200 &&

    indicators.macd <
      indicators.macdSignal &&

    indicators.macdHistogram <
      0 &&

    indicators.minusDI >
      indicators.plusDI;

  if (bullish) {
    return "BULLISH";
  }

  if (bearish) {
    return "BEARISH";
  }

  return "NEUTRAL";

}

// ============================================================
// SCORE V5.3
// ============================================================

function calculateSignalScore({
  indicators15m,
  indicators1h,
  trend15m,
  trend1h,
  momentum15m,
  breakout15m
}) {

  let bullish = 0;
  let bearish = 0;

  const filters = [];

  // ----------------------------------------------------------
  // EMA 15M
  // ----------------------------------------------------------

  if (
    indicators15m.ema20 >
    indicators15m.ema50
  ) {

    bullish += 10;

  } else if (
    indicators15m.ema20 <
    indicators15m.ema50
  ) {

    bearish += 10;

  }

  if (
    indicators15m.ema50 >
    indicators15m.ema200
  ) {

    bullish += 10;

  } else if (
    indicators15m.ema50 <
    indicators15m.ema200
  ) {

    bearish += 10;

  }

  // ----------------------------------------------------------
  // EMA 1H
  // ----------------------------------------------------------

  if (
    indicators1h.ema20 >
    indicators1h.ema50
  ) {

    bullish += 8;

  } else if (
    indicators1h.ema20 <
    indicators1h.ema50
  ) {

    bearish += 8;

  }

  if (
    indicators1h.ema50 >
    indicators1h.ema200
  ) {

    bullish += 8;

  } else if (
    indicators1h.ema50 <
    indicators1h.ema200
  ) {

    bearish += 8;

  }

  // ----------------------------------------------------------
  // 1H trend confirmation
  // ----------------------------------------------------------

  if (
    trend1h ===
    "BULLISH"
  ) {

    bullish += 20;

    filters.push(
      "1H bullish confirmation"
    );

  } else if (
    trend1h ===
    "BEARISH"
  ) {

    bearish += 20;

    filters.push(
      "1H bearish confirmation"
    );

  }

  // ----------------------------------------------------------
  // RSI
  // ----------------------------------------------------------

  if (
    indicators15m.rsi >= 55 &&
    indicators15m.rsi <= 68
  ) {

    bullish += 10;

    filters.push(
      "RSI bullish zone"
    );

  } else if (
    indicators15m.rsi <= 45 &&
    indicators15m.rsi >= 32
  ) {

    bearish += 10;

    filters.push(
      "RSI bearish zone"
    );

  }

  // ----------------------------------------------------------
  // MACD
  // ----------------------------------------------------------

  if (
    indicators15m.macd >
      indicators15m.macdSignal &&
    indicators15m.macdHistogram >
      0
  ) {

    bullish += 10;

    filters.push(
      "MACD bullish"
    );

  } else if (
    indicators15m.macd <
      indicators15m.macdSignal &&
    indicators15m.macdHistogram <
      0
  ) {

    bearish += 10;

    filters.push(
      "MACD bearish"
    );

  }

  // ----------------------------------------------------------
  // ADX + DI
  // ----------------------------------------------------------

  if (
    indicators15m.adx >=
    CONFIG.minADX
  ) {

    if (
      indicators15m.plusDI >
      indicators15m.minusDI
    ) {

      bullish += 10;

      filters.push(
        "ADX bullish strength"
      );

    }

    if (
      indicators15m.minusDI >
      indicators15m.plusDI
    ) {

      bearish += 10;

      filters.push(
        "ADX bearish strength"
      );

    }

  }

  // ----------------------------------------------------------
  // Momentum
  // ----------------------------------------------------------

  if (
    momentum15m > 0
  ) {

    bullish += 5;

    filters.push(
      "Positive momentum"
    );

  } else if (
    momentum15m < 0
  ) {

    bearish += 5;

    filters.push(
      "Negative momentum"
    );

  }

  // ----------------------------------------------------------
  // Breakout
  // ----------------------------------------------------------

  if (
    breakout15m.type ===
    "BULLISH_BREAKOUT"
  ) {

    bullish += 15;

    filters.push(
      "Bullish breakout"
    );

  } else if (
    breakout15m.type ===
    "BEARISH_BREAKOUT"
  ) {

    bearish += 15;

    filters.push(
      "Bearish breakout"
    );

  }

  // ----------------------------------------------------------
  // 15M trend
  // ----------------------------------------------------------

  if (
    trend15m ===
    "BULLISH"
  ) {

    bullish += 5;

    filters.push(
      "15M bullish trend"
    );

  } else if (
    trend15m ===
    "BEARISH"
  ) {

    bearish += 5;

    filters.push(
      "15M bearish trend"
    );

  }

  // ----------------------------------------------------------
  // Calculate direction
  // ----------------------------------------------------------

  let direction =
    "NEUTRAL";

  if (
    bullish > bearish
  ) {

    direction =
      "BULLISH";

  } else if (
    bearish > bullish
  ) {

    direction =
      "BEARISH";

  }

  return {

    score:
      Math.min(
        100,
        Math.max(
          bullish,
          bearish
        )
      ),

    bullish,

    bearish,

    direction,

    filters

  };

}

// ============================================================
// SIGNAL FILTER
// ============================================================

function scoreToSignal(
  score,
  direction,
  trend15m,
  trend1h,
  indicators15m,
  indicators1h,
  breakout15m
) {

  // Opposite timeframe = WAIT
  if (
    (
      trend15m ===
      "BULLISH" &&
      trend1h ===
      "BEARISH"
    ) ||

    (
      trend15m ===
      "BEARISH" &&
      trend1h ===
      "BULLISH"
    )
  ) {

    return "WAIT";

  }

  // No 1H confirmation
  if (
    trend1h !==
    trend15m
  ) {

    return "WAIT";

  }

  // Weak ADX
  if (
    indicators15m.adx <
    CONFIG.minADX
  ) {

    return "WAIT";

  }

  // BUY
  if (
    score >=
      CONFIG.minScore &&

    direction ===
      "BULLISH" &&

    trend15m ===
      "BULLISH" &&

    trend1h ===
      "BULLISH" &&

    indicators15m.plusDI >
      indicators15m.minusDI &&

    indicators1h.plusDI >
      indicators1h.minusDI &&

    indicators15m.macd >
      indicators15m.macdSignal &&

    indicators15m.macdHistogram >
      0 &&

    indicators15m.rsi >= 50 &&

    indicators15m.rsi < 70

  ) {

    return "BUY";

  }

  // SELL
  if (
    score >=
      CONFIG.minScore &&

    direction ===
      "BEARISH" &&

    trend15m ===
      "BEARISH" &&

    trend1h ===
      "BEARISH" &&

    indicators15m.minusDI >
      indicators15m.plusDI &&

    indicators1h.minusDI >
      indicators1h.plusDI &&

    indicators15m.macd <
      indicators15m.macdSignal &&

    indicators15m.macdHistogram <
      0 &&

    indicators15m.rsi <= 50 &&

    indicators15m.rsi > 30

  ) {

    return "SELL";

  }

  return "WAIT";

}

// ============================================================
// STRENGTH
// ============================================================

function getStrength(score) {

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

    return "MODERATE";

  }

  return "WEAK";

}

// ============================================================
// CONFIDENCE
// ============================================================

function calculateConfidence({
  score,
  signal,
  trend15m,
  trend1h,
  indicators15m,
  indicators1h,
  momentum15m,
  breakout15m
}) {

  if (
    signal === "WAIT"
  ) {

    return Math.min(
      69,
      Math.round(score)
    );

  }

  let confidence =
    score;

  if (
    trend15m ===
    trend1h
  ) {

    confidence += 3;

  }

  if (
    indicators15m.adx >=
    CONFIG.strongADX
  ) {

    confidence += 3;

  }

  if (
    signal === "BUY" &&
    indicators15m.plusDI >
      indicators15m.minusDI
  ) {

    confidence += 2;

  }

  if (
    signal === "SELL" &&
    indicators15m.minusDI >
      indicators15m.plusDI
  ) {

    confidence += 2;

  }

  if (
    signal === "BUY" &&
    momentum15m > 0
  ) {

    confidence += 2;

  }

  if (
    signal === "SELL" &&
    momentum15m < 0
  ) {

    confidence += 2;

  }

  if (
    (
      signal === "BUY" &&
      breakout15m.type ===
        "BULLISH_BREAKOUT"
    ) ||

    (
      signal === "SELL" &&
      breakout15m.type ===
        "BEARISH_BREAKOUT"
    )
  ) {

    confidence += 3;

  }

  return Math.min(
    99,
    Math.round(confidence)
  );

}

// ============================================================
// TELEGRAM PROCESS
// ============================================================

async function processSignal(
  signal,
  env
) {

  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  if (!token) {

    return {
      telegram: false,
      reason:
        "TELEGRAM_BOT_TOKEN missing"
    };

  }

  if (!chatId) {

    return {
      telegram: false,
      reason:
        "TELEGRAM_CHAT_ID missing"
    };

  }

  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {

    return {
      telegram: false,
      reason:
        "WAIT signal"
    };

  }

  // ----------------------------------------------------------
  // Cooldown
  // ----------------------------------------------------------

  const cooldown =
    await checkSignalCooldown(
      signal,
      env
    );

  if (
    !cooldown.allowed
  ) {

    return {

      telegram: false,

      reason:
        "Signal cooldown active",

      remaining_minutes:
        cooldown.remainingMinutes

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

    await saveSignalDelivery(
      signal,
      env
    );

  }

  return {

    telegram:
      result.ok,

    reason:
      result.ok
        ? "Telegram sent"
        : result.error,

    response:
      result

  };

}

// ============================================================
// SIGNAL COOLDOWN
// ============================================================
//
// Uses Cloudflare KV if SIGNAL_KV binding exists.
// If KV is not configured, the engine still works normally.
//
// Recommended KV binding name:
// SIGNAL_KV
//
// ============================================================

async function checkSignalCooldown(
  signal,
  env
) {

  const kv =
    env.SIGNAL_KV;

  if (!kv) {

    return {
      allowed: true,
      remainingMinutes: 0
    };

  }

  const key =
    `signal:${signal.symbol}:${signal.signal}`;

  const stored =
    await kv.get(key);

  if (!stored) {

    return {
      allowed: true,
      remainingMinutes: 0
    };

  }

  const lastSent =
    Number(stored);

  if (
    !Number.isFinite(lastSent)
  ) {

    return {
      allowed: true,
      remainingMinutes: 0
    };

  }

  const elapsed =
    Date.now() -
    lastSent;

  const cooldownMs =
    CONFIG.signalCooldownMinutes *
    60 *
    1000;

  if (
    elapsed >=
    cooldownMs
  ) {

    return {
      allowed: true,
      remainingMinutes: 0
    };

  }

  const remaining =
    cooldownMs -
    elapsed;

  return {

    allowed: false,

    remainingMinutes:
      Math.ceil(
        remaining /
        60000
      )

  };

}

async function saveSignalDelivery(
  signal,
  env
) {

  const kv =
    env.SIGNAL_KV;

  if (!kv) {
    return;
  }

  const key =
    `signal:${signal.symbol}:${signal.signal}`;

  await kv.put(
    key,
    String(Date.now()),
    {
      expirationTtl:
        CONFIG.signalCooldownMinutes *
        60
    }
  );

}

// ============================================================
// TELEGRAM MESSAGE
// ============================================================

function formatTelegramMessage(
  signal
) {

  const emoji =
    signal.signal === "BUY"
      ? "🟢"
      : "🔴";

  const direction =
    signal.signal === "BUY"
      ? "خرید"
      : "فروش";

  const filters =
    Array.isArray(
      signal.filters
    )
      ? signal.filters
          .slice(0,8)
          .map(
            x => "• " + x
          )
          .join("\n")
      : "—";

  return `
🥇 ${signal.symbol} — V5.3

${emoji} سیگنال: ${signal.signal} (${direction})

⏱ تایم‌فریم: 15M
🔎 تأیید: 1H

💰 قیمت: ${signal.price}

📊 امتیاز: ${signal.score}/100
🎯 اعتماد تحلیلی: ${signal.confidence}%
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
ATR %: ${signal.indicators.atr_percent}

ADX 14: ${signal.indicators.adx14}
+DI: ${signal.indicators.plusDI}
-DI: ${signal.indicators.minusDI}

Momentum:
${signal.indicators.momentum}%

Breakout:
${signal.indicators.breakout}

━━ تأییدها ━━

${filters}

━━ وضعیت تحلیل ━━

EMA: ${signal.analysis.ema}
RSI: ${signal.analysis.rsi}
MACD: ${signal.analysis.macd}
ADX: ${signal.analysis.adx}
Momentum: ${signal.analysis.momentum}
Breakout: ${signal.analysis.breakout}
MTF: ${signal.analysis.multi_timeframe}

⚠️ این سیگنال تضمینی نیست و فقط خروجی تحلیلی موتور است.

🕐 ${signal.timestamp}

🚀 FOREX SIGNAL ENGINE
V5.3 — GOLD FOCUS
`.trim();

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
        "Telegram bot token missing"
    };

  }

  if (!chatId) {

    return {
      ok: false,
      error:
        "Telegram chat ID missing"
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
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({

              chat_id:
                chatId,

              text:
                message,

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

      return {

        ok: false,

        status:
          response.status,

        error:
          data.description ||
          "Telegram API error"

      };

    }

    return {

      ok: true,

      status:
        response.status,

      message_id:
        data.result?.message_id ||
        null

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
        "Telegram bot token is missing"

    };

  }

  if (!chatId) {

    return {

      ok: false,

      telegram: false,

      error:
        "Telegram chat ID is missing"

    };

  }

  const message = [

    "✅ تست اتصال موتور سیگنال فارکس",

    `نسخه: ${CONFIG.version}`,

    `تمرکز: ${CONFIG.primarySymbol}`,

    "وضعیت: اتصال Telegram برقرار است",

    new Date().toISOString()

  ].join("\n");

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

    result,

    timestamp:
      new Date().toISOString()

  };

}

// ============================================================
// STATS
// ============================================================

async function getStats(
  env
) {

  const token =
    getTelegramToken(env);

  const chatId =
    getTelegramChatId(env);

  const twelveKey =
    getTwelveDataKey(env);

  return {

    ok: true,

    version:
      CONFIG.version,

    engine: {

      status:
        "ONLINE",

      primary:
        CONFIG.primarySymbol,

      timeframe:
        CONFIG.interval,

      confirmation:
        CONFIG.confirmationInterval,

      min_score:
        CONFIG.minScore,

      strong_score:
        CONFIG.strongScore,

      min_adx:
        CONFIG.minADX

    },

    symbols:
      CONFIG.symbols,

    indicators: [

      "EMA 20",
      "EMA 50",
      "EMA 200",
      "RSI 14",
      "MACD 12/26/9",
      "ATR 14",
      "ADX 14",
      "Momentum",
      "Breakout"

    ],

    connections: {

      twelve_data:
        !!twelveKey,

      telegram:
        !!(
          token &&
          chatId
        ),

      signal_kv:
        !!env.SIGNAL_KV

    },

    telegram: {

      configured:
        !!(
          token &&
          chatId
        ),

      token:
        !!token,

      chat_id:
        !!chatId

    },

    timestamp:
      new Date().toISOString()

  };

}

// ============================================================
// HELPERS
// ============================================================

function average(
  values
) {

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (a,b) => a + b,
      0
    ) /
    values.length
  );

}

function round(
  value,
  decimals = 4
) {

  if (
    !Number.isFinite(value)
  ) {

    return 0;

  }

  return Number(
    value.toFixed(
      decimals
    )
  );

}

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

        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type"

      }

    }

  );

}

function htmlResponse(
  html,
  status = 200
) {

  return new Response(
    html,
    {

      status,

      headers: {

        "Content-Type":
          "text/html; charset=UTF-8",

        "Access-Control-Allow-Origin":
          "*"

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
          "Content-Type"

      }

    }
  );

}
