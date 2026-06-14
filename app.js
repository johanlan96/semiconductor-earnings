const fallbackDataset = {
  generatedAt: null,
  source: "fallback",
  asOfDate: "2026-05-24",
  fxRates: {
    asOf: "2026-05-23 09:00 UTC",
    base: "USD",
    rates: {
      USD: 1,
      TWD: 0.031,
      KRW: 0.00073,
      JPY: 0.0064,
      EUR: 1.08,
    },
    note:
      "演示版统一按 2026-05-23 09:00 UTC 的近似汇率换算为 USD，用于跨市场横向比较；后续接入实时数据时可改为自动拉取外汇报价。",
  },
  companies: [],
};

let dashboardData = window.__EARNINGS_DASHBOARD_DATA__;
let fxRates = fallbackDataset.fxRates;
let companies = [];
let today = new Date();
let activeStatus = "all";
let activeSearch = "";
let activeCompany = null;

const elements = {
  currentDate: document.querySelector("#currentDate"),
  upcomingList: document.querySelector("#upcomingList"),
  searchInput: document.querySelector("#searchInput"),
  statusFilters: document.querySelector("#statusFilters"),
  cardsGrid: document.querySelector("#cardsGrid"),
  cardTemplate: document.querySelector("#cardTemplate"),
  heroMeta: document.querySelector("#heroMeta"),
  visibleCount: document.querySelector("#visibleCount"),
  releasedCount: document.querySelector("#releasedCount"),
  upcomingCount: document.querySelector("#upcomingCount"),
  pendingCount: document.querySelector("#pendingCount"),
  modal: document.querySelector("#detailModal"),
  modalBackdrop: document.querySelector("#modalBackdrop"),
  modalClose: document.querySelector("#modalClose"),
  modalTitle: document.querySelector("#modalTitle"),
  modalSubtitle: document.querySelector("#modalSubtitle"),
  modalStatus: document.querySelector("#modalStatus"),
  modalQuarter: document.querySelector("#modalQuarter"),
  metricsHeading: document.querySelector("#metricsHeading"),
  metricsTable: document.querySelector("#metricsTable"),
  guidanceText: document.querySelector("#guidanceText"),
  highlightsList: document.querySelector("#highlightsList"),
  barChart: document.querySelector("#barChart"),
  fxNote: document.querySelector("#fxNote"),
};

bootstrap();

async function bootstrap() {
  bindEvents();
  await loadDataset();
  renderAll();
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    activeSearch = event.target.value.trim().toLowerCase();
    renderDashboard();
  });

  elements.statusFilters.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    activeStatus = button.dataset.status;
    document.querySelectorAll(".filter-button").forEach((node) => {
      node.classList.toggle("active", node === button);
    });
    renderDashboard();
  });

  elements.modalBackdrop.addEventListener("click", closeModal);
  elements.modalClose.addEventListener("click", closeModal);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
}

async function loadDataset() {
  if (!dashboardData || !dashboardData.companies?.length) {
    try {
      const response = await fetch("./data/earnings-dashboard.json", { cache: "no-store" });
      if (response.ok) {
        dashboardData = await response.json();
      }
    } catch (error) {
      console.warn("Failed to fetch generated dashboard dataset, using fallback.", error);
    }
  }

  if (!dashboardData || !dashboardData.companies?.length) {
    try {
      const response = await fetch("./data/company-seed.json", { cache: "no-store" });
      if (response.ok) {
        const seed = await response.json();
        dashboardData = {
          generatedAt: null,
          source: "seed-direct",
          asOfDate: fallbackDataset.asOfDate,
          fxRates: seed.fxRates,
          companies: seed.companies,
        };
      }
    } catch (error) {
      console.warn("Failed to fetch seed dataset, using static fallback.", error);
    }
  }

  dashboardData = normalizeDataset(dashboardData || fallbackDataset);
  fxRates = dashboardData.fxRates;
  today = new Date(`${dashboardData.asOfDate}T12:00:00`);
  companies = dashboardData.companies.map((company) => decorateCompany(company, fxRates, today));
}

function normalizeDataset(dataset) {
  const safeCompanies = Array.isArray(dataset.companies) ? dataset.companies : [];
  return {
    generatedAt: dataset.generatedAt ?? null,
    source: dataset.source ?? "unknown",
    asOfDate: dataset.asOfDate ?? fallbackDataset.asOfDate,
    fxRates: dataset.fxRates ?? fallbackDataset.fxRates,
    companies: safeCompanies,
  };
}

function renderAll() {
  elements.currentDate.textContent = formatTopDate(today);
  elements.heroMeta.textContent = buildHeroMeta();
  renderUpcomingBanner();
  renderDashboard();
}

function buildHeroMeta() {
  const sourceLabel =
    dashboardData.source === "yfinance+official" || dashboardData.source === "yfinance-primary"
      ? "数据来源：yfinance / 公司官方披露"
      : dashboardData.source === "official-only"
        ? "数据来源：公司官方披露"
        : "数据来源：已生成数据";
  return `${companies.length} 家核心半导体公司 · ${today.getFullYear()} 财年 · ${sourceLabel} · 货币单位：USD`;
}

function renderUpcomingBanner() {
  const items = companies
    .filter((company) => company.status !== "released" && company.daysUntil >= 0 && company.daysUntil <= 14)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  elements.upcomingList.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "mini-note";
    empty.textContent = "未来两周暂无待发布";
    elements.upcomingList.append(empty);
    return;
  }

  items.forEach((company) => {
    const button = document.createElement("button");
    button.className = "upcoming-link";
    button.type = "button";
    button.innerHTML = `
      <strong>${company.ticker}</strong>
      <span>${compactDaysLabel(company.daysUntil)}</span>
    `;
    button.addEventListener("click", () => {
      const target = document.getElementById(`card-${company.id}`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("highlight");
        window.setTimeout(() => target.classList.remove("highlight"), 1800);
      }
    });
    elements.upcomingList.append(button);
  });
}

function renderDashboard() {
  const filtered = filterCompanies();
  const releasedCount = companies.filter((company) => company.status === "released").length;
  const upcomingCount = companies.filter(
    (company) => company.status !== "released" && company.isWithinThreeDays
  ).length;
  const pendingCount = companies.filter(
    (company) => company.status === "pending" && !company.isWithinThreeDays
  ).length;

  elements.visibleCount.textContent = filtered.length;
  elements.releasedCount.textContent = releasedCount;
  elements.upcomingCount.textContent = upcomingCount;
  elements.pendingCount.textContent = pendingCount;
  elements.cardsGrid.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有匹配的公司，请尝试其他关键词或状态筛选。";
    elements.cardsGrid.append(empty);
    return;
  }

  filtered.forEach((company) => {
    const fragment = elements.cardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".company-card");
    card.id = `card-${company.id}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `查看 ${company.nameCn} 财报详情`);
    card.classList.toggle("highlight", company.isWithinThreeDays);
    card.classList.toggle("today", company.status === "today");

    fragment.querySelector("h3").textContent = company.nameCn;
    fragment.querySelector(".company-subtitle").textContent = `${company.ticker} · ${company.nameEn}`;
    fragment.querySelector(".quarter-tag").textContent = company.shortQuarterLabel;
    fragment.querySelector(".track-copy").textContent = company.track;

    const statusPill = fragment.querySelector(".status-pill");
    statusPill.textContent = company.statusLabel;
    statusPill.classList.add(company.visualStatusClass);

    fragment.querySelector(".sector-pill").textContent = company.industry;

    const cardBody = fragment.querySelector(".card-body");
    if (company.metricsUsd) {
      cardBody.innerHTML = `
        <div class="metric-grid">
          ${metricCard("营收 (USD)", formatUsd(company.metricsUsd.revenue), company.metricSource)}
          ${metricCard("净利润", formatUsd(company.metricsUsd.netIncome), "当季")}
          ${metricCard("毛利率", formatPercent(company.metricsUsd.grossMargin), "当季")}
          ${metricCard("Non-GAAP EPS", formatEps(company.metricsUsd.eps), "当季")}
        </div>
      `;
    } else if (company.status === "no-data") {
      cardBody.innerHTML = `
        <div class="countdown">
          <div class="card-label">数据状态</div>
          <strong>暂无数据</strong>
          <div class="countdown-days pending">等待更新</div>
          <div class="mini-note">当前未从 yfinance 或官方来源获取到有效财务数据</div>
        </div>
      `;
    } else {
      cardBody.innerHTML = `
        <div class="countdown">
          <div class="card-label">财报日期</div>
          <strong>${formatLongDate(company.reportDateObj)}</strong>
          <div class="countdown-days ${company.visualStatusClass}">${company.daysCountdownLabel}</div>
          <div class="mini-note">${company.shortQuarterLabel} 财报</div>
        </div>
      `;
    }

    card.addEventListener("click", () => openModal(company));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openModal(company);
      }
    });
    elements.cardsGrid.append(fragment);
  });
}

function openModal(company) {
  activeCompany = company;
  elements.modalTitle.textContent = `${company.nameCn}${company.ticker === "AMD" ? " (AMD)" : ""}`;
  elements.modalSubtitle.textContent = `${company.nameEn} · ${company.industry} · ${company.track}`;
  elements.modalStatus.textContent = company.statusLabel;
  elements.modalStatus.className = `status-pill ${company.visualStatusClass}`;
  elements.modalQuarter.textContent = company.shortQuarterLabel;
  elements.metricsHeading.textContent = `核心财务数据 · ${company.shortQuarterLabel}`;
  elements.guidanceText.textContent = company.guidance;
  elements.fxNote.textContent = company.fxNote;

  elements.metricsTable.innerHTML = "";
  const metricRows = company.metricsUsd
    ? [
        ["营收 (USD)", `${formatUsd(company.metricsUsd.revenue)} USD`],
        ["净利润 (USD)", `${formatUsd(company.metricsUsd.netIncome)} USD`],
        ["毛利率", formatPercent(company.metricsUsd.grossMargin)],
        ["Non-GAAP EPS", formatEps(company.metricsUsd.eps)],
      ]
    : company.status === "no-data"
      ? [
          ["状态", "暂无数据"],
          ["数据来源", "yfinance / 官方来源"],
          ["最近结果", "未获取到有效财务字段"],
          ["季度", company.shortQuarterLabel],
        ]
    : [
        ["状态", company.statusLabel],
        ["财报日期", formatLongDate(company.reportDateObj)],
        ["倒计时", company.daysCountdownLabel],
        ["季度", company.shortQuarterLabel],
      ];

  metricRows.forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "metric-item";
    item.innerHTML = `<span class="card-label">${label}</span><strong>${value}</strong>`;
    elements.metricsTable.append(item);
  });

  elements.highlightsList.innerHTML = "";
  company.highlights.forEach((highlight) => {
    const li = document.createElement("li");
    li.textContent = highlight;
    elements.highlightsList.append(li);
  });

  renderChart(company.revenueHistory, company.status === "no-data");

  elements.modal.classList.remove("hidden");
  elements.modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal() {
  if (!activeCompany) return;
  activeCompany = null;
  elements.modal.classList.add("hidden");
  elements.modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function renderChart(values, isNoData = false) {
  const safeValues = Array.isArray(values) && values.length ? values : [0];
  const max = Math.max(...safeValues, 1);
  elements.barChart.innerHTML = "";

  if (isNoData || !Array.isArray(values) || !values.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无 12 季度营收数据";
    elements.barChart.append(empty);
    return;
  }

  safeValues.forEach((value, index) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(18, (value / max) * 100)}%`;
    bar.dataset.tooltip = `${quarterTagForHistory(index, safeValues.length)} · ${formatUsd(value)}`;

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = quarterTagForHistory(index, safeValues.length);

    bar.append(label);
    elements.barChart.append(bar);
  });
}

function filterCompanies() {
  return companies.filter((company) => {
    const matchesSearch =
      !activeSearch ||
      [company.nameCn, company.nameEn, company.ticker].some((field) =>
        field.toLowerCase().includes(activeSearch)
      );

    if (!matchesSearch) return false;
    if (activeStatus === "all") return true;
    if (activeStatus === "released") return company.status === "released";
    if (activeStatus === "upcoming") return company.status !== "released" && company.isWithinThreeDays;
    if (activeStatus === "pending") return company.status === "pending" && !company.isWithinThreeDays;
    return true;
  });
}

function decorateCompany(company, currentFxRates, referenceDate) {
  const effectiveReportDate = company.metrics
    ? company.lastReportedAt || company.reportDate
    : company.nextReportDate || company.reportDate;
  const reportDateObj = effectiveReportDate ? new Date(`${effectiveReportDate}T09:00:00`) : new Date(`${referenceDate.toISOString().slice(0,10)}T09:00:00`);
  const hasValidDate = Boolean(effectiveReportDate);
  const daysUntil = hasValidDate
    ? Math.ceil((reportDateObj - referenceDate) / (1000 * 60 * 60 * 24))
    : null;
  const status = company.metrics
    ? "released"
    : !hasValidDate
      ? "no-data"
      : daysUntil === 0
        ? "today"
        : "pending";
  const convertedMetrics = company.metrics ? convertMetrics(company.metrics, company.currency, currentFxRates) : null;
  const fiscalPeriod = resolveFiscalPeriod(company, reportDateObj);

  return {
    ...company,
    effectiveReportDate,
    reportDateObj,
    fiscalPeriod,
    quarter: fiscalPeriod.quarterNumber,
    quarterLabel: fiscalPeriod.label,
    shortQuarterLabel: fiscalPeriod.shortLabel,
    daysUntil,
    daysLabel: buildDaysLabel(daysUntil, status),
    daysCountdownLabel: buildCountdownLabel(daysUntil, status),
    status,
    statusLabel: buildStatusLabel(status, daysUntil),
    isWithinThreeDays: !company.metrics && daysUntil != null && daysUntil >= 0 && daysUntil <= 3,
    visualStatusClass: buildVisualStatusClass(status, daysUntil),
    metricsUsd: convertedMetrics,
    metricSource: company.currency === "USD" ? "USD" : `原币种 ${company.currency} 已换算`,
    fxNote: buildFxNote(company.currency, currentFxRates),
  };
}

function resolveFiscalPeriod(company, reportDateObj) {
  const shortLabel = company.fiscalQuarterLabel || company.shortQuarterLabel;
  const label = company.fiscalQuarterDetail || company.quarterLabel || shortLabel || buildFallbackFiscalLabel(reportDateObj);
  const quarterNumber = parseQuarterNumber(shortLabel || label);

  return {
    shortLabel: shortLabel || buildFallbackFiscalLabel(reportDateObj),
    label,
    quarterNumber,
  };
}

function buildFallbackFiscalLabel(reportDateObj) {
  const year = reportDateObj.getFullYear();
  const month = reportDateObj.getMonth() + 1;
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year}Q${quarter}`;
}

function parseQuarterNumber(value) {
  const match = String(value || "").match(/Q([1-4])/i);
  return match ? Number(match[1]) : null;
}

function convertMetrics(metrics, currency, currentFxRates) {
  if (currency === "USD") return { ...metrics };
  const rate = currentFxRates?.rates?.[currency] ?? 1;
  return {
    revenue: multiplyMaybe(metrics.revenue, rate),
    netIncome: multiplyMaybe(metrics.netIncome, rate),
    grossMargin: metrics.grossMargin,
    eps: metrics.eps,
  };
}

function multiplyMaybe(value, rate) {
  if (value == null) return null;
  return Number((Number(value) * Number(rate)).toFixed(2));
}

function buildDaysLabel(daysUntil, status) {
  if (status === "no-data") return "暂无数据";
  if (daysUntil === 0) return "今天发布";
  if (daysUntil > 0) return `还有 ${daysUntil} 天`;
  return `已发布 ${Math.abs(daysUntil)} 天前`;
}

function buildStatusLabel(status, daysUntil) {
  if (status === "released") return "已发布";
  if (status === "no-data") return "暂无数据";
  if (status === "today") return "今天发布";
  if (daysUntil <= 3) return "即将发布";
  return "待发布";
}

function buildCountdownLabel(daysUntil, status) {
  if (status === "no-data") return "暂无数据";
  if (daysUntil === 0) return "今天";
  if (daysUntil > 0) return `还有 ${daysUntil} 天`;
  return "已发布";
}

function buildVisualStatusClass(status, daysUntil) {
  if (status === "released") return "released";
  if (status === "no-data") return "pending";
  if (status === "today") return "today";
  if (daysUntil <= 3) return "upcoming";
  return "pending";
}

function compactDaysLabel(daysUntil) {
  if (daysUntil === 0) return "今天";
  return `${daysUntil}天后`;
}

function buildFxNote(currency, currentFxRates) {
  const note = currentFxRates?.note || fallbackDataset.fxRates.note;
  if (currency === "USD") return `${note} 当前公司原始披露币种即为 USD，无需换算。`;
  const rate = currentFxRates?.rates?.[currency];
  return `${note} 当前公司原始披露币种为 ${currency}，展示值已按 1 ${currency} = $${rate} 换算。`;
}

function metricCard(label, value, note) {
  return `
    <div class="metric-item">
      <span class="card-label">${label}</span>
      <strong>${value ?? "--"}</strong>
      <div class="metric-note">${note}</div>
    </div>
  `;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function formatTopDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function formatUsd(value) {
  if (value == null) return "--";
  return `$${(Number(value) * 10).toFixed(1)}亿`;
}

function formatPercent(value) {
  if (value == null) return "--";
  return `${Number(value).toFixed(1)}%`;
}

function formatEps(value) {
  if (value == null) return "--";
  return `$${Number(value).toFixed(2)}`;
}

function quarterTagForHistory(index, total = 12) {
  const startYear = today.getFullYear() - Math.floor((total - 1) / 4);
  const year = startYear + Math.floor(index / 4);
  const quarter = (index % 4) + 1;
  return `${String(year).slice(-2)}Q${quarter}`;
}
