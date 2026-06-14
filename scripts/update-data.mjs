import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SEED_PATH = path.join(DATA_DIR, "company-seed.json");
const FISCAL_PERIODS_PATH = path.join(DATA_DIR, "company-fiscal-periods.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "company-overrides.json");
const OUTPUT_JSON_PATH = path.join(DATA_DIR, "earnings-dashboard.json");
const OUTPUT_JS_PATH = path.join(DATA_DIR, "earnings-dashboard.js");
const REFRESH_REPORT_PATH = path.join(DATA_DIR, "last-refresh-report.json");
const YFINANCE_SCRIPT_PATH = path.join(ROOT, "scripts", "fetch-yfinance-data.py");
const execFileAsync = promisify(execFile);

const REQUEST_DELAY_MS = 1000;
const RETRY_DELAY_MS = 2500;
const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 15000;
const OFFICIAL_SCRAPERS = {
  NVDA: fetchOfficialNvidiaUpdate,
  AMD: fetchOfficialAmdUpdate,
};

async function main() {
  await loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  const seed = JSON.parse(await fs.readFile(SEED_PATH, "utf8"));
  const fiscalPeriods = await readJsonIfExists(FISCAL_PERIODS_PATH, {});
  const existingOutput = await readJsonIfExists(OUTPUT_JSON_PATH, null);
  const existingCompanies = new Map(
    Array.isArray(existingOutput?.companies)
      ? existingOutput.companies.map((company) => [company.ticker, company])
      : []
  );
  const overrides = await readJsonIfExists(OVERRIDES_PATH, {});
  const today = new Date();
  const seedCompanies = seed.companies.map((company) => ({
    ...company,
    ...(fiscalPeriods[company.ticker] || {}),
  }));
  const targetCompanies = options.tickers?.length
    ? seedCompanies.filter((company) => options.tickers.includes(company.ticker))
    : seedCompanies;
  const provider = createProvider(options, targetCompanies.map((company) => company.ticker));

  const fxRates = await provider.getFxRates(seed.fxRates);
  const companies = [];
  const refreshStats = {
    fullSuccess: 0,
    partialSuccess: 0,
    fallback: 0,
  };

  for (const company of targetCompanies) {
    const fiscalConfig = fiscalPeriods[company.ticker] || {};
    const existingCompany = existingCompanies.get(company.ticker) || {};
    const baseline = createCompanyBaseline(company, existingCompany, fiscalConfig);
    const remote = await provider.getCompanyUpdate(baseline, fxRates);
    const merged = mergeCompany(baseline, remote, overrides[company.ticker]);
    companies.push(merged);

    if (merged.refreshMeta?.status === "full") refreshStats.fullSuccess += 1;
    else if (merged.refreshMeta?.status === "partial") refreshStats.partialSuccess += 1;
    else refreshStats.fallback += 1;
  }

  if (targetCompanies.length !== seed.companies.length) {
    for (const company of seedCompanies) {
      if (options.tickers.includes(company.ticker)) continue;
      const fiscalConfig = fiscalPeriods[company.ticker] || {};
      const existingCompany = existingCompanies.get(company.ticker) || {};
      companies.push({
        ...company,
        ...existingCompany,
        ...fiscalConfig,
      });
    }
  }

  const generatedAt = new Date().toISOString();
  const payload = {
    generatedAt,
    source: provider.name,
    asOfDate: formatDateISO(today),
    fxRates,
    companies,
    metadata: {
      companyCount: companies.length,
      narrativeSource: path.basename(OVERRIDES_PATH),
      numericSource: provider.name,
      refreshStats,
      refreshMode: options.officialOnly
        ? "official-only"
        : options.tickers?.length
          ? "targeted"
          : "full",
    },
  };

  const refreshReport = buildRefreshReport(payload, options);

  await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(payload, null, 2));
  await fs.writeFile(
    OUTPUT_JS_PATH,
    `window.__EARNINGS_DASHBOARD_DATA__ = ${JSON.stringify(payload, null, 2)};\n`
  );
  await fs.writeFile(REFRESH_REPORT_PATH, JSON.stringify(refreshReport, null, 2));

  console.log(
    `Generated ${path.relative(ROOT, OUTPUT_JSON_PATH)} and ${path.relative(
      ROOT,
      OUTPUT_JS_PATH
    )} using ${provider.name}.`
  );
  console.log(`Wrote ${path.relative(ROOT, REFRESH_REPORT_PATH)}.`);
  console.log(`Refresh stats: ${JSON.stringify(refreshStats)}`);
}

function createProvider(options, targetTickers) {
  if (options.officialOnly) {
    return createOfficialSeedProvider();
  }
  return createYFinanceProvider({ targetTickers });
}

function parseArgs(argv) {
  const tickersArg = argv.find((arg) => arg.startsWith("--tickers="));
  const officialOnly = argv.includes("--official-only");
  const tickers = tickersArg
    ? tickersArg
        .split("=")[1]
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean)
    : null;

  return {
    officialOnly,
    tickers,
  };
}

function createSeedOnlyProvider() {
  return {
    name: "seed-only",
    async getFxRates(fallback) {
      return {
        ...fallback,
        source: "seed",
        fetchedAt: new Date().toISOString(),
      };
    },
    async getCompanyUpdate() {
      return {
        refreshMeta: {
          status: "fallback",
          provider: "seed-only",
          notes: ["No external provider configured."],
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  };
}

function createOfficialSeedProvider() {
  return {
    name: "official-only",
    async getFxRates(fallback) {
      try {
        const latest = await fetchJson("https://api.frankfurter.app/latest?from=USD");
        return {
          asOf: `${latest.date} 00:00 UTC`,
          base: "USD",
          rates: {
            USD: 1,
            TWD: inverseRate(latest.rates.TWD, fallback.rates.TWD),
            KRW: inverseRate(latest.rates.KRW, fallback.rates.KRW),
            JPY: inverseRate(latest.rates.JPY, fallback.rates.JPY),
            EUR: inverseRate(latest.rates.EUR, fallback.rates.EUR),
          },
          note:
            "汇率由 Frankfurter 最新中间价换算为 USD，用于跨市场口径统一展示；正式投研场景建议在披露日锁定当日汇率。",
          source: "Frankfurter",
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          ...fallback,
          source: "seed-fallback",
          fetchedAt: new Date().toISOString(),
        };
      }
    },
    async getCompanyUpdate(company) {
      const fetchedAt = new Date().toISOString();
      const officialResult = await getOfficialCompanyUpdate(company);
      if (!officialResult.ok) {
        return {
          refreshMeta: {
            provider: "official",
            primarySource: "unavailable",
            status: "fallback",
            endpoints: {
              official: false,
            },
            notes: officialResult.skipped ? [] : [`official: ${officialResult.error}`],
            fetchedAt,
          },
        };
      }

      const officialUpdate = officialResult.data;
      const lastReportedAt = normalizeDate(officialUpdate.lastReportedAt || null);
      const nextReportDate = normalizeDate(officialUpdate.nextReportDate || null);

      return {
        reportDate: nextReportDate || lastReportedAt || null,
        lastReportedAt,
        nextReportDate,
        currency: officialUpdate.currency || company.currency,
        metrics: officialUpdate.metrics,
        revenueHistory: [],
        refreshMeta: {
          provider: "official",
          primarySource: "official-company-release",
          status: "full",
          endpoints: {
            official: true,
          },
          notes: [],
          fetchedAt,
        },
        providerMeta: {
          ...(company.providerMeta || {}),
          primarySource: officialUpdate.sourceType,
          sourceUrl: officialUpdate.sourceUrl,
          sourceTitle: officialUpdate.sourceTitle,
          guidanceRaw: officialUpdate.guidanceRaw || null,
          publishedAt: officialUpdate.lastReportedAt || null,
          fetchedAt,
        },
      };
    },
  };
}

function createYFinanceProvider({ targetTickers }) {
  const yfinanceBatchPromise = fetchYFinanceBatch(targetTickers);

  return {
    name: "yfinance+official",
    async getFxRates(fallback) {
      try {
        const latest = await fetchJson("https://api.frankfurter.app/latest?from=USD");
        return {
          asOf: `${latest.date} 00:00 UTC`,
          base: "USD",
          rates: {
            USD: 1,
            TWD: inverseRate(latest.rates.TWD, fallback.rates.TWD),
            KRW: inverseRate(latest.rates.KRW, fallback.rates.KRW),
            JPY: inverseRate(latest.rates.JPY, fallback.rates.JPY),
            EUR: inverseRate(latest.rates.EUR, fallback.rates.EUR),
          },
          note:
            "汇率由 Frankfurter 最新中间价换算为 USD，用于跨市场口径统一展示；正式投研场景建议在披露日锁定当日汇率。",
          source: "Frankfurter",
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        console.warn(`FX refresh failed, using seed rates instead: ${error.message}`);
        return {
          ...fallback,
          source: "seed-fallback",
          fetchedAt: new Date().toISOString(),
        };
      }
    },
    async getCompanyUpdate(company, fxRates) {
      const notes = [];
      const fetchedAt = new Date().toISOString();
      const yfinanceBatch = await yfinanceBatchPromise;
      const yfinanceResult =
        yfinanceBatch[company.ticker] ||
        skippedFetchResult(`No yfinance batch entry found for ${company.ticker}.`);
      const normalizedYfinance = normalizeYfinancePayload(company, yfinanceResult.ok ? yfinanceResult.data : null, fxRates);
      const yfinanceUpdate = normalizedYfinance.data;
      const yfinanceMetricsAreReasonable = normalizedYfinance.metricsAreReasonable;
      const yfinanceHistoryIsReasonable = normalizedYfinance.historyIsReasonable;
      const needsOfficialMetrics =
        !yfinanceUpdate?.metrics ||
        !yfinanceMetricsAreReasonable ||
        ["revenue", "netIncome", "grossMargin", "eps"].some((key) => yfinanceUpdate.metrics?.[key] == null);
      const shouldFetchOfficial =
        Boolean(OFFICIAL_SCRAPERS[company.ticker]) &&
        (needsOfficialMetrics || !yfinanceUpdate?.lastReportedAt);
      const officialResult = shouldFetchOfficial
        ? await getOfficialCompanyUpdate(company)
        : skippedFetchResult("Skipped because yfinance supplied complete metrics.");

      if (!officialResult.ok && !officialResult.skipped) {
        notes.push(`official: ${officialResult.error}`);
      }
      if (!yfinanceResult.ok && !yfinanceResult.skipped) {
        notes.push(`yfinance: ${yfinanceResult.error}`);
      }
      if (normalizedYfinance.note) {
        notes.push(normalizedYfinance.note);
      }

      const currency = yfinanceUpdate?.currency || officialResult.data?.currency || company.currency;
      const officialUpdate = officialResult.ok ? officialResult.data : null;
      const lastReportedAt = normalizeDate(
        yfinanceUpdate?.lastReportedAt ||
          officialUpdate?.lastReportedAt ||
          null
      );
      const nextReportDate = normalizeDate(
        yfinanceUpdate?.nextReportDate ||
          officialUpdate?.nextReportDate ||
          null
      );
      const reportDate = nextReportDate || lastReportedAt || null;

      const remote = {
        reportDate,
        lastReportedAt,
        nextReportDate,
        currency,
        revenueHistory: yfinanceHistoryIsReasonable
          ? mergeRevenueHistory(company.revenueHistory, yfinanceUpdate?.revenueHistory)
          : sanitizeRevenueHistory(company.revenueHistory),
      };

      if (yfinanceUpdate?.metrics && yfinanceMetricsAreReasonable) {
        remote.metrics = {
          revenue: numberOrFallback(yfinanceUpdate.metrics.revenue, null),
          netIncome: numberOrFallback(yfinanceUpdate.metrics.netIncome, null),
          grossMargin: numberOrFallback(yfinanceUpdate.metrics.grossMargin, null),
          eps: numberOrFallback(yfinanceUpdate.metrics.eps, null),
        };
      }

      if (officialUpdate?.metrics) {
        remote.metrics = mergeMetrics(remote.metrics, officialUpdate.metrics);
      }

      if (yfinanceUpdate?.providerMeta) {
        remote.providerMeta = {
          ...(remote.providerMeta || {}),
          ...yfinanceUpdate.providerMeta,
          fetchedAt,
        };
      }

      if (yfinanceUpdate?.providerMeta || yfinanceUpdate?.lastReportedAt) {
        remote.providerMeta = {
          ...(remote.providerMeta || {}),
          companyName: yfinanceUpdate?.providerMeta?.companyName || company.nameEn,
          marketCap: numberOrFallback(yfinanceUpdate?.providerMeta?.marketCap, null),
          sector: null,
          period: null,
          latestStatementDate: yfinanceUpdate?.lastReportedAt || null,
          fetchedAt,
        };
      }

      if (officialUpdate) {
        remote.providerMeta = {
          ...(remote.providerMeta || {}),
          primarySource: remote.metrics ? "yfinance+official-supplement" : officialUpdate.sourceType,
          sourceUrl: officialUpdate.sourceUrl,
          sourceTitle: officialUpdate.sourceTitle,
          guidanceRaw: officialUpdate.guidanceRaw || null,
          publishedAt: officialUpdate.lastReportedAt || null,
        };
      }

      remote.refreshMeta = buildRefreshMeta({
        officialOk: officialResult.ok,
        yfinanceOk: yfinanceResult.ok,
        hasMetrics: hasAnyMetric(remote.metrics),
        hasHistory: Array.isArray(remote.revenueHistory) && remote.revenueHistory.length > 0,
        lastReportedAt,
        nextReportDate,
        notes,
        fetchedAt,
      });

      if (remote.refreshMeta.status === "fallback") {
        console.warn(`${company.ticker} refresh failed, showing no financial data: ${notes.join(" | ")}`);
      }

      return remote;
    },
  };
}

function mergeCompany(seedCompany, remote, override = {}) {
  return {
    ...seedCompany,
    ...remote,
    guidance: override.guidance || remote.guidance || seedCompany.guidance,
    highlights: override.highlights || remote.highlights || seedCompany.highlights,
    overrideMeta: override
      ? {
          used: Boolean(override.guidance || override.highlights),
          source: path.basename(OVERRIDES_PATH),
        }
      : undefined,
  };
}

function buildRefreshReport(payload, options) {
  const targetSet = options.tickers?.length ? new Set(options.tickers) : null;
  const companies = payload.companies.map((company) => ({
    ticker: company.ticker,
    nameCn: company.nameCn,
    refreshStatus: company.refreshMeta?.status || "unknown",
    primarySource: company.refreshMeta?.primarySource || company.providerMeta?.primarySource || "unknown",
    hasMetrics: Boolean(company.metrics),
    lastReportedAt: company.lastReportedAt || null,
    nextReportDate: company.nextReportDate || null,
    notes: company.refreshMeta?.notes || [],
  }));

  return {
    generatedAt: payload.generatedAt,
    asOfDate: payload.asOfDate,
    source: payload.source,
    mode: options.officialOnly ? "official-only" : options.tickers?.length ? "targeted" : "full",
    tickers: options.tickers || null,
    stats: payload.metadata.refreshStats,
    updatedTickers: companies
      .filter((company) => (!targetSet || targetSet.has(company.ticker)) && company.refreshStatus === "full")
      .map((company) => company.ticker),
    fallbackTickers: companies
      .filter((company) => (!targetSet || targetSet.has(company.ticker)) && company.refreshStatus === "fallback")
      .map((company) => company.ticker),
    companies,
  };
}

function buildRefreshMeta({
  officialOk,
  yfinanceOk,
  hasMetrics,
  hasHistory,
  notes,
  fetchedAt,
  lastReportedAt,
  nextReportDate,
}) {
  const metricsOk = Boolean(hasMetrics);
  const dateOk = Boolean(lastReportedAt) || Boolean(nextReportDate);
  const historyOk = Boolean(hasHistory);
  const successCount = [metricsOk, dateOk, historyOk].filter(Boolean).length;
  const status = successCount === 3 ? "full" : successCount > 0 ? "partial" : "fallback";
  const primarySource = yfinanceOk
    ? officialOk
      ? "yfinance+official-supplement"
      : "yfinance"
    : officialOk
      ? "official-company-release"
      : "unavailable";

  return {
    provider: yfinanceOk ? "yfinance" : officialOk ? "official" : "none",
    primarySource,
    status,
    endpoints: {
      official: officialOk,
      yfinance: yfinanceOk,
    },
    notes,
    fetchedAt,
  };
}

async function fetchYFinanceBatch(tickers) {
  if (!Array.isArray(tickers) || !tickers.length) return {};

  try {
    const { stdout } = await execFileAsync("python3", [YFINANCE_SCRIPT_PATH, "--tickers", tickers.join(",")], {
      cwd: ROOT,
      maxBuffer: 20 * 1024 * 1024,
    });

    return JSON.parse(stdout);
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message || error);
    return Object.fromEntries(
      tickers.map((ticker) => [
        ticker,
        {
          ok: false,
          skipped: false,
          data: null,
          error: message,
        },
      ])
    );
  }
}

function mergeMetrics(primaryMetrics, fallbackMetrics) {
  const primary = primaryMetrics || {};
  const fallback = fallbackMetrics || {};

  return {
    revenue: numberOrFallback(primary.revenue, fallback.revenue ?? null),
    netIncome: numberOrFallback(primary.netIncome, fallback.netIncome ?? null),
    grossMargin: numberOrFallback(primary.grossMargin, fallback.grossMargin ?? null),
    eps: numberOrFallback(primary.eps, fallback.eps ?? null),
  };
}

function createCompanyBaseline(seedCompany, existingCompany, fiscalConfig) {
  const existing = existingCompany || {};

  return {
    ...seedCompany,
    ...existing,
    ...fiscalConfig,
    currency: seedCompany.currency,
    metrics: null,
    revenueHistory: sanitizeRevenueHistory(seedCompany.revenueHistory),
    reportDate: null,
    lastReportedAt: null,
    nextReportDate: null,
    refreshMeta: null,
    providerMeta: existing.providerMeta || seedCompany.providerMeta || null,
  };
}

function sanitizeRevenueHistory(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => numberOrFallback(value, null)).filter((value) => value != null).slice(-12);
}

function mergeRevenueHistory(seedHistory, latestHistory) {
  const baseline = sanitizeRevenueHistory(seedHistory);
  const latest = sanitizeRevenueHistory(latestHistory);

  if (!latest.length) return baseline;
  if (!baseline.length) return latest;

  const tailLength = Math.min(latest.length, baseline.length, 12);
  const head = baseline.slice(0, Math.max(0, baseline.length - tailLength));
  return [...head, ...latest.slice(-tailLength)].slice(-12);
}

function normalizeYfinancePayload(company, payload, fxRates) {
  if (!payload) {
    return {
      data: null,
      metricsAreReasonable: false,
      historyIsReasonable: false,
      note: null,
    };
  }

  const baselineRevenue = lastValue(company.revenueHistory);
  const directMetricsReasonable = isReasonableAgainstSeed(baselineRevenue, payload.metrics?.revenue);
  const directHistoryReasonable = isReasonableAgainstSeed(baselineRevenue, lastValue(payload.revenueHistory));

  if (directMetricsReasonable && directHistoryReasonable) {
    return {
      data: payload,
      metricsAreReasonable: true,
      historyIsReasonable: true,
      note: null,
    };
  }

  const converted = convertYfinancePayloadToUsd(company, payload, fxRates);
  const convertedMetricsReasonable = isReasonableAgainstSeed(baselineRevenue, converted.metrics?.revenue);
  const convertedHistoryReasonable = isReasonableAgainstSeed(baselineRevenue, lastValue(converted.revenueHistory));

  if (convertedMetricsReasonable && convertedHistoryReasonable) {
    return {
      data: converted,
      metricsAreReasonable: true,
      historyIsReasonable: true,
      note: `yfinance: normalized from ${company.currency} to USD using FX baseline`,
    };
  }

  return {
    data: {
      ...payload,
      metrics: null,
      revenueHistory: sanitizeRevenueHistory(company.revenueHistory),
    },
    metricsAreReasonable: false,
    historyIsReasonable: false,
    note: "yfinance: revenue scale mismatch vs baseline",
  };
}

function convertYfinancePayloadToUsd(company, payload, fxRates) {
  const rate = fxRates?.rates?.[company.currency];
  if (!rate || company.currency === "USD") return payload;

  const convert = (value) => {
    const number = numberOrFallback(value, null);
    if (number == null) return null;
    return Number((number * Number(rate)).toFixed(2));
  };

  return {
    ...payload,
    currency: "USD",
    metrics: payload.metrics
      ? {
          revenue: convert(payload.metrics.revenue),
          netIncome: convert(payload.metrics.netIncome),
          grossMargin: numberOrFallback(payload.metrics.grossMargin, null),
          eps: numberOrFallback(payload.metrics.eps, null),
        }
      : null,
    revenueHistory: sanitizeRevenueHistory(payload.revenueHistory).map((value) => convert(value)).filter((value) => value != null),
  };
}

function lastValue(values) {
  const history = sanitizeRevenueHistory(values);
  return history.length ? history[history.length - 1] : null;
}

function isReasonableAgainstSeed(seedValue, candidateValue) {
  const seed = numberOrFallback(seedValue, null);
  const candidate = numberOrFallback(candidateValue, null);

  if (seed == null || candidate == null || seed <= 0 || candidate <= 0) return true;

  const ratio = candidate / seed;
  return ratio >= 0.25 && ratio <= 4;
}

function hasAnyMetric(metrics) {
  if (!metrics) return false;
  return ["revenue", "netIncome", "grossMargin", "eps"].some((key) => metrics[key] != null);
}

async function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .forEach((line) => {
        const [key, ...rest] = line.split("=");
        if (!process.env[key]) {
          process.env[key] = rest.join("=").trim();
        }
      });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "earnings-dashboard-updater/1.0",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.json();
}

async function fetchJsonWithRetry(url, attempt = 0) {
  try {
    const data = await fetchJson(url);
    return { ok: true, data };
  } catch (error) {
    const message = String(error.message || error);
    const retryable = message.includes("429") || message.includes("fetch failed") || message.includes("5");
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchJsonWithRetry(url, attempt + 1);
    }
    return { ok: false, data: null, error: message };
  }
}

async function getOfficialCompanyUpdate(company) {
  const scraper = OFFICIAL_SCRAPERS[company.ticker];
  if (!scraper) {
    return { ok: false, skipped: true, data: null, error: "No official scraper configured." };
  }

  try {
    const data = await scraper(company);
    return { ok: true, skipped: false, data };
  } catch (error) {
    return { ok: false, skipped: false, data: null, error: String(error.message || error) };
  }
}

async function fetchOfficialNvidiaUpdate(company) {
  let sourceUrl = company?.providerMeta?.sourceUrl || null;

  if (!sourceUrl) {
    const listingUrl = "https://nvidianews.nvidia.com/news?o=0";
    const listingHtml = await fetchTextWithRetry(listingUrl);
    const relativePath = extractFirstMatch(
      listingHtml,
      /href="(\/news\/nvidia-announces-financial-results-for-[^"#?]+)"/i
    );

    if (relativePath) {
      sourceUrl = new URL(relativePath, "https://nvidianews.nvidia.com").toString();
    }
  }

  if (!sourceUrl) {
    throw new Error("NVIDIA official release link not found on newsroom listing page or cache.");
  }

  const detailHtml = await fetchTextWithRetry(sourceUrl);
  const detailText = htmlToText(detailHtml);

  const publishedLabel = extractFirstMatch(
    detailText,
    /([A-Z][a-z]+ \d{1,2}, \d{4})\s+NVIDIA\s+\(NASDAQ:\s*NVDA\)\s+today reported/i
  );
  const revenue = toNumber(extractFirstMatch(detailText, /of \$([\d.]+) billion/i));
  const grossMargin = toNumber(
    extractFirstMatch(detailText, /GAAP and non-GAAP gross margins were ([\d.]+)% and [\d.]+%/i)
  );
  const eps = toNumber(
    extractFirstMatch(detailText, /GAAP and non-GAAP earnings per diluted share were \$([\d.]+) and \$[\d.]+/i)
  );
  const netIncomeMillions = toNumber(
    extractFirstMatch(detailText, /Net income\s+\$([\d,]+)\s+\$[\d,]+\s+\$[\d,]+/i)?.replace(/,/g, "")
  );
  const guidanceRaw = extractFirstMatch(
    detailText,
    /(Revenue is expected to be \$[\d.]+ billion, plus or minus \d+%\.\s+GAAP and non-GAAP gross margins are expected to be [\d.]+% and [\d.]+%, respectively, plus or minus \d+ basis points\.)/i
  );

  if ([publishedLabel, revenue, grossMargin, eps, netIncomeMillions].some((value) => value == null)) {
    throw new Error("NVIDIA official release parse incomplete.");
  }

  return {
    sourceType: "official-newsroom",
    sourceTitle: "NVIDIA newsroom financial results release",
    sourceUrl,
    lastReportedAt: toIsoDateString(publishedLabel),
    currency: "USD",
    metrics: {
      revenue,
      netIncome: Number((netIncomeMillions / 1000).toFixed(2)),
      grossMargin,
      eps,
    },
    guidanceRaw,
  };
}

async function fetchOfficialAmdUpdate() {
  const resultsUrl = "https://ir.amd.com/financial-information/financial-results";
  const resultsHtml = await fetchTextWithRetry(resultsUrl);
  const relativePath = extractFirstMatch(
    resultsHtml,
    /href="((?:https:\/\/ir\.amd\.com)?\/news-events\/press-releases\/detail\/\d+\/amd-reports-[^"#]+financial-results)"/i
  );

  if (!relativePath) {
    throw new Error("AMD official release link not found on financial results page.");
  }

  const sourceUrl = relativePath.startsWith("http")
    ? relativePath
    : new URL(relativePath, "https://ir.amd.com").toString();
  const detailHtml = await fetchTextWithRetry(sourceUrl);
  const detailText = htmlToText(detailHtml);

  const publishedLabel = extractFirstMatch(
    detailText,
    /SANTA CLARA,\s+Calif\.,\s+([A-Z][a-z]+ \d{1,2}, \d{4})\s+\(GLOBE NEWSWIRE\)/i
  );
  const revenue = toNumber(
    extractFirstMatch(
      detailText,
      /(First|Second|Third|Fourth) quarter revenue was \$([\d.]+) billion, gross margin was [\d.]+%/i,
      2
    )
  );
  const grossMargin = toNumber(
    extractFirstMatch(
      detailText,
      /(First|Second|Third|Fourth) quarter revenue was \$[\d.]+ billion, gross margin was ([\d.]+)%/i,
      2
    )
  );
  const netIncome = toNumber(
    extractFirstMatch(
      detailText,
      /net income was \$([\d.]+) billion and diluted earnings per share was \$[\d.]+/i
    )
  );
  const eps = toNumber(
    extractFirstMatch(
      detailText,
      /net income was \$[\d.]+ billion and diluted earnings per share was \$([\d.]+)/i
    )
  );
  const guidanceRaw = extractFirstMatch(
    detailText,
    /(For the (first|second|third|fourth) quarter of \d{4}, AMD expects revenue to be approximately \$[\d.]+ billion(?:, plus or minus \$[\d.]+ million)?\..*?approximately [\d.]+%\.)/i
  );

  if ([publishedLabel, revenue, grossMargin, netIncome, eps].some((value) => value == null)) {
    throw new Error("AMD official release parse incomplete.");
  }

  return {
    sourceType: "official-ir-release",
    sourceTitle: "AMD investor relations earnings release",
    sourceUrl,
    lastReportedAt: toIsoDateString(publishedLabel),
    currency: "USD",
    metrics: {
      revenue,
      netIncome,
      grossMargin,
      eps,
    },
    guidanceRaw,
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "earnings-dashboard-updater/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response.text();
}

async function fetchTextWithRetry(url, attempt = 0) {
  try {
    const data = await fetchText(url);
    return data;
  } catch (error) {
    const message = String(error.message || error);
    const retryable = message.includes("429") || message.includes("fetch failed") || message.includes("5");
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * (attempt + 1));
      return fetchTextWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, "-")
    .replace(/&#8212;|&mdash;/gi, "-")
    .replace(/&#174;|&reg;/gi, "")
    .replace(/&#8482;|&trade;/gi, "")
    .replace(/&#160;/gi, " ");
}

function extractFirstMatch(value, pattern, groupIndex = 1) {
  const match = value.match(pattern);
  return match?.[groupIndex] ?? null;
}

function toIsoDateString(value) {
  if (!value) return null;
  const match = String(value).match(/^([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) return normalizeDate(value);
  const [, monthLabel, dayLabel, yearLabel] = match;
  const month = MONTH_INDEX[monthLabel];
  if (!month) return normalizeDate(value);
  return `${yearLabel}-${month}-${String(dayLabel).padStart(2, "0")}`;
}

function toNumber(value) {
  if (value == null) return null;
  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/[.]+$/g, "")
    .trim();
  const number = Number(normalized);
  return Number.isNaN(number) ? null : number;
}

function skippedFetchResult(reason) {
  return {
    ok: false,
    skipped: true,
    data: null,
    error: reason,
  };
}

const MONTH_INDEX = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inverseRate(rate, fallback) {
  if (!rate) return fallback;
  return Number((1 / rate).toFixed(6));
}

function toBillions(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number((Number(value) / 1_000_000_000).toFixed(2));
}

function toPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number((Number(value) * 100).toFixed(1));
}

function resolveGrossMargin(incomeRow, fallback) {
  if (incomeRow?.grossProfitRatio != null) {
    return toPercent(incomeRow.grossProfitRatio);
  }
  if (incomeRow?.grossProfit != null && incomeRow?.revenue) {
    return Number(((Number(incomeRow.grossProfit) / Number(incomeRow.revenue)) * 100).toFixed(1));
  }
  return fallback;
}

function numberOrFallback(value, fallback) {
  return value == null || Number.isNaN(Number(value)) ? fallback : Number(value);
}

function normalizeDate(value) {
  if (!value) return null;
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value;
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
