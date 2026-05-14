#!/usr/bin/env python3
"""
半导体财报数据采集器 - 精准替换版
从SEC EDGAR获取真实财务数据，直接更新HTML中的数值字段

用法:
  python3 fetch_financials.py
  python3 fetch_financials.py --dry-run

依赖：纯标准库
"""

import json, os, re, sys, time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(BASE_DIR, 'semiconductor_earnings.html')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

CIK_MAP = {
    'NVDA': 1045810, 'AMD': 2488, 'AVGO': 1730168,
    'QCOM': 804328, 'ARM': 1973239, 'MRVL': 1835632,
    'MPWR': 1280452, 'INTC': 50863, 'TXN': 97476,
    'ADI': 6281, 'ON': 1097864, 'MCHP': 827054,
    'NXPI': 1413447, 'STM': 932787, 'TSM': 1046179,
    'GFS': 1709048, 'UMC': 1033767, 'ASML': 937966,
    'AMAT': 6951, 'LRCX': 707549, 'KLAC': 319201,
    'MU': 723125, 'SNPS': 883241, 'CDNS': 813672,
    'ASX': 1122411
}

def sec_fetch(url):
    for i in range(3):
        try:
            req = Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            return json.loads(urlopen(req, timeout=25).read())
        except (HTTPError, URLError, OSError):
            if i < 2:
                time.sleep(3 * (i + 1))
                continue
            return None

def get_standalone(entries):
    groups = {}
    for e in entries:
        fy, fp = e.get('fy'), e.get('fp')
        if not fp or fp == 'FY': continue
        val = e.get('val', 0)
        if val == 0: continue
        groups.setdefault((fy, fp), []).append(val)
    result = []
    order = {'Q1': 1, 'Q2': 2, 'Q3': 3, 'Q4': 4}
    for (fy, fp), vals in sorted(groups.items(), key=lambda x: (x[0][0] or 0, order.get(x[0][1], 99))):
        result.append({'quarter': f"FY{fy}{fp}", 'standalone': min(set(vals))})
    return result[-8:]

def extract(us_gaap, *concept_groups):
    for concepts in concept_groups:
        for name in concepts:
            d = us_gaap.get(name)
            if not d: continue
            for uk, ue in d.get('units', {}).items():
                if 'USD' in uk:
                    r = get_standalone(ue)
                    if r: return r
    return None

def get_sec_data(ticker):
    cik = CIK_MAP.get(ticker)
    if not cik: return None
    data = sec_fetch(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json')
    if not data: return None
    ug = data.get('facts', {}).get('us-gaap', {})
    if not ug: return None
    
    rev = extract(ug, ['Revenues', 'RevenueFromContractWithCustomer'],
                  ['SalesRevenueNet', 'SalesRevenueGoodsNet', 'Revenue'])
    gp = extract(ug, ['GrossProfit'])
    ni = extract(ug, ['NetIncomeLoss'], ['NetIncomeLossAvailableToCommonStockholders'])
    eps = extract(ug, ['EarningsPerShareDiluted'])
    
    if not rev: return None
    
    result = {'rev': rev[-1]['standalone'] / 1e9}
    if gp and rev: result['gm'] = round(gp[-1]['standalone'] / rev[-1]['standalone'] * 100, 1)
    if ni: result['ni'] = ni[-1]['standalone'] / 1e9
    if eps: result['eps'] = eps[-1]['standalone']
    if len(rev) >= 5 and rev[-5]['standalone'] > 0:
        yoy = round((rev[-1]['standalone'] - rev[-5]['standalone']) / rev[-5]['standalone'] * 100, 1)
        result['yoy'] = f"{'+' if yoy >= 0 else ''}{yoy}%"
    # 历史序列
    result['hist'] = [round(q['standalone'] / 1e9, 1) for q in rev]
    result['labels'] = [q['quarter'].replace('FY','') for q in rev]
    return result

def update_field(html, ticker, field, value):
    """精准替换某公司的某个字段"""
    # 查找公司对象块：找到 ticker: '{ticker}' 附近的区域
    patterns = [
        # 数字字段
        (f"(id:\\s*'{ticker.lower()}'.*?{field}:\\s*)\\d+\\.?\\d*",
         f"\\g<1>{value}" if not isinstance(value, str) else f"\\g<1>{value}"),
        # 字符串字段
        (f"(id:\\s*'{ticker.lower()}'.*?{field}:\\s*)'[^']*'",
         f"\\g<1>'{value}'"),
        # null字段
        (f"(id:\\s*'{ticker.lower()}'.*?{field}:\\s*)null",
         f"\\g<1>{value}" if not isinstance(value, str) else f"\\g<1>'{value}'"),
    ]
    
    for pattern, replacement in patterns:
        new_html, count = re.subn(pattern, replacement, html, flags=re.DOTALL)
        if count > 0:
            return new_html, True
    return html, False

def main():
    dry_run = '--dry-run' in sys.argv
    ts = datetime.now()
    
    print(f"{'🔬 半导体财报数据采集器'}")
    print(f"📅 {ts}")
    print(f"📊 {len(CIK_MAP)} 家公司\n")
    
    if not os.path.exists(HTML_FILE):
        print(f"❌ 找不到: {HTML_FILE}")
        return 1
    
    with open(HTML_FILE, 'r', encoding='utf-8') as f:
        html = f.read()
    
    # 逐家采集
    sec_data = {}
    for i, ticker in enumerate(sorted(CIK_MAP.keys()), 1):
        print(f"[{i}/{len(CIK_MAP)}] {ticker}...", end=' ', flush=True)
        result = get_sec_data(ticker)
        if result:
            sec_data[ticker] = result
            print(f"✅ ${result['rev']:.1f}B GM:{result.get('gm','?')}% EPS:{'$'+str(result.get('eps','?'))}")
        else:
            print(f"⚠️ 无SEC数据")
        if i < len(CIK_MAP):
            time.sleep(1.5)
    
    if not sec_data:
        print("❌ 未能获取任何SEC数据，请检查网络")
        return 1
    
    # 执行替换
    print(f"\n📝 {'模拟' if dry_run else '更新'}HTML...")
    modified = 0
    for ticker, data in sec_data.items():
        fields = {
            'rev': round(data['rev'], 1),
            'grossMargin': data.get('gm'),
            'eps': data.get('eps'),
            'netIncome': round(data['ni'], 1) if data.get('ni') else None,
            'revYoY': data.get('yoy'),
        }
        
        ticker_lower = ticker.lower()
        for field, val in fields.items():
            if val is None:
                continue
            # 在公司区块内找字段
            pattern = f"(id:\\s*'{ticker_lower}'[\\s\\S]*?{field}:\\s*)([^,}}]+)"
            replacement = f"\\g<1>{val}" if not isinstance(val, str) else f"\\g<1>'{val}'"
            new_html, count = re.subn(pattern, replacement, html, flags=re.DOTALL)
            if count > 0:
                html = new_html
                modified += 1
    
    updated_count = len(sec_data)
    print(f"✅ {'模拟更新' if dry_run else '已更新'}: {updated_count} 家公司, {modified} 个字段")
    
    if not dry_run:
        with open(HTML_FILE, 'w', encoding='utf-8') as f:
            f.write(html)
        print(f"  文件: {HTML_FILE}")
    
    print(f"\n📊 统计: 成功采集 {updated_count}/{len(CIK_MAP)} 家")
    return 0

if __name__ == '__main__':
    exit(main())
