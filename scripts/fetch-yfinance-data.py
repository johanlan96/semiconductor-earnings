import argparse
import json
import math
import sys
from datetime import date, datetime

import pandas as pd
import yfinance as yf


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tickers", required=True)
    args = parser.parse_args()

    tickers = [ticker.strip().upper() for ticker in args.tickers.split(",") if ticker.strip()]
    payload = {}

    for ticker in tickers:
      payload[ticker] = fetch_ticker_payload(ticker)

    print(json.dumps(payload, ensure_ascii=False))


def fetch_ticker_payload(ticker):
    try:
        ticker_client = yf.Ticker(ticker)
        calendar = safe_calendar(ticker_client)
        income = safe_frame(ticker_client.quarterly_income_stmt)
        fast_info = safe_mapping(getattr(ticker_client, "fast_info", {}))

        metrics = extract_metrics(income)
        revenue_history = extract_revenue_history(income)
        next_report_date = extract_next_earnings_date(calendar)
        last_reported_at = extract_last_report_date(income)

        return {
            "ok": True,
            "skipped": False,
            "data": {
                "currency": normalize_currency(fast_info.get("currency")),
                "lastReportedAt": last_reported_at,
                "nextReportDate": next_report_date,
                "metrics": metrics,
                "revenueHistory": revenue_history,
                "providerMeta": {
                    "primarySource": "yfinance",
                    "companyName": safe_string(fast_info.get("shortName")),
                    "marketCap": safe_number(fast_info.get("marketCap")),
                    "currency": normalize_currency(fast_info.get("currency")),
                    "yfinanceIncomeColumns": [to_iso(column) for column in list(income.columns[:8])] if not income.empty else [],
                },
            },
        }
    except Exception as exc:
        return {
            "ok": False,
            "skipped": False,
            "data": None,
            "error": str(exc),
        }


def safe_calendar(ticker_client):
    try:
        value = ticker_client.calendar
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def safe_mapping(value):
    try:
        return dict(value)
    except Exception:
        return {}


def safe_frame(frame):
    if frame is None:
        return pd.DataFrame()
    try:
        return frame
    except Exception:
        return pd.DataFrame()


def extract_metrics(income):
    if income.empty:
        return None

    revenue = first_value(income, ["Total Revenue", "Operating Revenue", "Revenue"])
    net_income = first_value(
        income,
        [
            "Net Income",
            "Net Income Common Stockholders",
            "Net Income From Continuing Operation Net Minority Interest",
        ],
    )
    gross_profit = first_value(income, ["Gross Profit"])
    eps = first_value(
        income,
        [
            "Diluted EPS",
            "Basic EPS",
        ],
    )

    revenue_billions = to_billions(revenue)
    net_income_billions = to_billions(net_income)
    gross_margin = None
    if revenue and gross_profit:
        gross_margin = round((gross_profit / revenue) * 100, 1)

    if all(value is None for value in [revenue_billions, net_income_billions, gross_margin, eps]):
        return None

    return {
        "revenue": revenue_billions,
        "netIncome": net_income_billions,
        "grossMargin": gross_margin,
        "eps": safe_number(eps),
    }


def extract_revenue_history(income):
    if income.empty:
        return None

    revenue_row = first_series(income, ["Total Revenue", "Operating Revenue", "Revenue"])
    if revenue_row is None:
        return None

    values = []
    for value in list(revenue_row.dropna().iloc[::-1])[-12:]:
        number = to_billions(value)
        if number is not None:
            values.append(number)

    return values or None


def extract_next_earnings_date(calendar):
    raw_value = calendar.get("Earnings Date")
    if isinstance(raw_value, (list, tuple)) and raw_value:
        return to_iso(raw_value[0])
    return to_iso(raw_value)


def extract_last_report_date(income):
    if income.empty or len(income.columns) == 0:
        return None
    return to_iso(income.columns[0])


def first_series(frame, candidates):
    for candidate in candidates:
        if candidate in frame.index:
            return frame.loc[candidate]
    return None


def first_value(frame, candidates):
    row = first_series(frame, candidates)
    if row is None:
        return None
    for value in row.tolist():
        number = safe_number(value)
        if number is not None:
            return number
    return None


def to_billions(value):
    number = safe_number(value)
    if number is None:
        return None
    return round(number / 1_000_000_000, 2)


def safe_number(value):
    try:
        if value is None:
            return None
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return None
        return round(number, 2)
    except Exception:
        return None


def safe_string(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_currency(value):
    text = safe_string(value)
    return text.upper() if text else None


def to_iso(value):
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    text = safe_string(value)
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt).strftime("%Y-%m-%d")
        except Exception:
            continue
    return text


if __name__ == "__main__":
    main()
