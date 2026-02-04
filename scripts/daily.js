// scripts/daily.js
// GitHub Actions daily logger: writes one entry per UTC day to data/log.json
// Node 20 (GitHub runner)

import fs from "fs";

const LOG_PATH = "data/log.json";

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayYmdUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchJson(url, label, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": "cicilbtc-bot/1.0" },
    });
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function try3(label, f1, f2, f3) {
  try { return await f1(); } catch (e) { console.log(`${label} #1 fail:`, e.message); }
  try { return await f2(); } catch (e) { console.log(`${label} #2 fail:`, e.message); }
  return await f3();
}

// ---------- read/write log ----------
function readLog() {
  if (!fs.existsSync(LOG_PATH)) return { site_start: null, entries: [] };
  return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
}

function writeLog(log) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n", "utf8");
}

// ---------- sources ----------

// Fear & Greed (Alternative.me)
async function getFngToday() {
  const j = await fetchJson("https://api.alternative.me/fng/?limit=1&format=json", "FNG");
  const d = j?.data?.[0];
  if (!d) throw new Error("FNG no data");
  return {
    value: Number(d.value),
    label: String(d.value_classification),
    timestamp: Number(d.timestamp), // seconds
  };
}

// FX USD->IDR (only used if price source needs it)
async function fx1() {
  const j = await fetchJson("https://open.er-api.com/v6/latest/USD", "FX1");
  const idr = Number(j?.rates?.IDR);
  if (!idr) throw new Error("FX1 invalid");
  return { usdIdr: idr, source: "open.er-api.com" };
}
async function fx2() {
  const j = await fetchJson("https://api.frankfurter.app/latest?from=USD&to=IDR", "FX2");
  const idr = Number(j?.rates?.IDR);
  if (!idr) throw new Error("FX2 invalid");
  return { usdIdr: idr, source: "frankfurter.app" };
}
async function fx3() {
  const j = await fetchJson("https://api.exchangerate.host/latest?base=USD&symbols=IDR", "FX3");
  const idr = Number(j?.rates?.IDR);
  if (!idr) throw new Error("FX3 invalid");
  return { usdIdr: idr, source: "exchangerate.host" };
}
async function getUsdIdr() {
  return await try3("FX", fx1, fx2, fx3);
}

// BTC price (3 options)
async function btc1() {
  // CoinGecko gives USD + IDR directly
  const j = await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,idr",
    "BTC1"
  );
  const usd = Number(j?.bitcoin?.usd);
  const idr = Number(j?.bitcoin?.idr);
  if (!usd || !idr) throw new Error("BTC1 invalid");
  return { usd, idr, sourceNote: "BTC: CoinGecko (USD+IDR)" };
}

async function btc2() {
  // Binance BTCUSDT + FX
  const j = await fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", "BTC2");
  const usdt = Number(j?.price);
  if (!usdt) throw new Error("BTC2 invalid");
  const fx = await getUsdIdr();
  return {
    usd: usdt,
    idr: usdt * fx.usdIdr,
    sourceNote: `BTC: Binance (BTCUSDT) + FX: ${fx.source}`,
  };
}

async function btc3() {
  // Coinbase BTC-USD + FX
  const j = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot", "BTC3");
  const usd = Number(j?.data?.amount);
  if (!usd) throw new Error("BTC3 invalid");
  const fx = await getUsdIdr();
  return {
    usd,
    idr: usd * fx.usdIdr,
    sourceNote: `BTC: Coinbase (BTC-USD) + FX: ${fx.source}`,
  };
}

async function getBtcPrice() {
  return await try3("BTC", btc1, btc2, btc3);
}

// ---------- main ----------
async function main() {
  const ymd = todayYmdUTC();
  const log = readLog();

  if (!log.site_start) log.site_start = ymd;
  log.entries = log.entries || [];

  // skip if already logged today
  if (log.entries.some((e) => e.date === ymd)) {
    console.log("Already logged for", ymd, "- skip.");
    return;
  }

  // retry wrapper for transient failures
  let fng, btc;
  for (let i = 0; i < 3; i++) {
    try {
      [fng, btc] = await Promise.all([getFngToday(), getBtcPrice()]);
      break;
    } catch (e) {
      console.log("Attempt", i + 1, "failed:", e.message);
      if (i < 2) await sleep(1500);
      else throw e;
    }
  }

  const entry = {
    date: ymd,
    fng_value: fng.value,
    fng_label: fng.label,
    fng_timestamp: fng.timestamp,
    btc_usd: btc.usd,
    btc_idr: btc.idr,
    source: btc.sourceNote,
    created_at_utc: new Date().toISOString(),
  };

  log.entries.push(entry);
  log.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  writeLog(log);
  console.log("Wrote entry:", entry);
}

main().catch((e) => {
  console.error("daily.js failed:", e);
  process.exit(1);
});
