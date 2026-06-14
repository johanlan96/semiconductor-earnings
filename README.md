# 半导体财报追踪看板

## 数据更新

前端读取 `data/earnings-dashboard.js` 里的全局数据对象，更新流程由 `scripts/update-data.mjs` 生成。

这个流程现在分成两层：

1. 数值层：财报日期、利润表、近 12 季度营收、汇率
2. 叙事层：`guidance` 和 `highlights`

默认策略：

1. `data/company-seed.json` 仅作为公司清单、行业和展示文案的静态底座，不再兜底财务数值
2. 默认主数据源：优先使用 `yfinance` 拉取财报日期、季度利润表和近 12 季营收
3. 对已配置官方抓取器的公司，如 `NVDA`、`AMD`，只有在 `yfinance` 缺少关键指标时才补抓公司官方新闻稿 / IR
4. 如果 `yfinance` 和官方源都没有可用数据，则该公司显示“暂无数据”
5. 对跨市场公司，如果 `yfinance` 返回的营收量级和历史口径明显不一致，脚本会先尝试按 `data/company-seed.json` 里的原始币种配合 FX 汇率自动换算为 USD；换算后仍不合理则拒绝使用该组异常数值
6. 新增公司时，务必在 `data/company-seed.json` 中维护正确的 `currency` 和一条可信的历史营收底座；这会直接影响自动口径校正是否生效
7. 汇率默认尝试从 Frankfurter 拉取最新 USD 基准汇率；失败时退回种子汇率
8. `data/company-overrides.json` 始终优先覆盖 `guidance` 和 `highlights`

### 命令

```bash
npm run update-data
npm run update-data:official-core
npm run refresh-plan
npm run generate-narrative-drafts
npm run apply-narrative-drafts
```

推荐刷新顺序：

1. `npm run update-data`
   用 `yfinance + 官方补抓` 刷新全量公司
2. `npm run refresh-plan`
   执行默认全量刷新，并输出刷新报告到 `data/refresh-plan-report.json`
3. `npm run update-data:official-core`
   仅在你想单独验证 `NVDA`、`AMD` 官方抓取器时使用

### 环境变量

```bash
export OPENAI_API_KEY=your_key_here
```

### Python 依赖

项目的全量数值刷新现在依赖本机 Python 环境中的：

```bash
python3 -m pip install yfinance pandas
```

说明：

- `yfinance` 是当前全量财报数据主来源
- 如需启用 `Ticker.get_earnings_dates()` 等更完整功能，可额外安装 `lxml`

### 输出文件

- `data/company-seed.json`: 静态种子数据，手工维护公司列表、中文名、赛道、摘要等
- `data/company-overrides.json`: 叙事覆盖层，优先维护 `guidance`、`highlights`
- `data/narrative-source-texts.json`: 原始文字材料输入区，可粘贴新闻稿、电话会纪要、IR 摘录
- `data/narrative-drafts.json`: 半自动生成的叙事草稿，默认不直接影响前端
- `data/earnings-dashboard.json`: 更新脚本生成的结构化数据
- `data/earnings-dashboard.js`: 前端直接加载的全局数据文件
- `data/company-fiscal-periods.json`: 每家公司独立财年 / 财季标签配置
- `data/last-refresh-report.json`: 最近一次更新脚本的机器可读刷新结果
- `data/refresh-plan-report.json`: 分层刷新计划的执行报告

### 新增公司注意事项

当你后续新增公司时，请至少确认这几项：

1. `ticker` 正确
2. `currency` 为公司原始披露币种，而不是页面展示币种
3. `revenueHistory` 具备一条可信的 12 季度历史底座
4. 如果是非美股口径公司，优先检查 `yfinance` 返回的营收量级是否和历史口径一致

说明：

- 页面统一展示 USD
- 但更新脚本会先参考 `currency` 判断是否需要把 `yfinance` 的原始量级自动归一到 USD
- 如果 `currency` 填错，像 `UMC / TSM / ASX` 这类公司就容易出现图表或核心营收口径异常

## GitHub 部署

这个项目适合部署为：

1. GitHub Pages 托管静态页面
2. GitHub Actions 定时刷新数据

仓库里已经包含两条工作流：

- `.github/workflows/deploy-pages.yml`
  负责把当前仓库内容发布到 GitHub Pages
- `.github/workflows/refresh-data.yml`
  负责每天自动运行 `npm run refresh-plan`，并把更新后的数据文件提交回仓库

默认定时规则：

- `15 1 * * *`
- 这是 GitHub Actions 的 UTC 时间
- 对应中国时区是每天 `09:15`

### 上线步骤

1. 在 GitHub 新建仓库
2. 把当前项目推送到仓库的 `main` 分支
3. 在 GitHub 仓库设置里开启 Pages
   选择 `GitHub Actions` 作为部署来源
4. 在仓库 `Settings -> Secrets and variables -> Actions` 中添加：

```bash
OPENAI_API_KEY=你的 OpenAI key
```

说明：

- `OPENAI_API_KEY` 只有在你要运行叙事草稿流程时才需要；纯数值刷新不是必需

### 部署后如何运行

部署完成后，线上链接本身是静态页面，不会在用户打开页面时实时抓数据。

实际执行方式是：

1. GitHub Actions 定时运行刷新脚本
2. 脚本更新 `data/earnings-dashboard.json` 和 `data/earnings-dashboard.js`
3. Action 自动提交数据变更
4. `main` 分支更新后，GitHub Pages 自动重新发布
5. 用户访问链接时，看到的是最近一次自动刷新的结果

### 手动触发

如果你想立即刷新，而不是等定时任务：

1. 打开 GitHub 仓库
2. 进入 `Actions`
3. 选择 `Refresh Dashboard Data`
4. 点击 `Run workflow`

## 半自动叙事更新

推荐工作流：

1. 把财报新闻稿、IR 摘录或电话会纪要粘贴到 `data/narrative-source-texts.json`
2. 运行：

```bash
npm run generate-narrative-drafts
```

3. 检查 `data/narrative-drafts.json`
4. 把需要采用的草稿状态改为 `approved`
4. 如果草稿满意，再运行：

```bash
npm run apply-narrative-drafts
npm run update-data
```

说明：

- 没有 `OPENAI_API_KEY` 时，草稿脚本会生成低置信度的规则兜底草稿，仅用于占位
- 有 `OPENAI_API_KEY` 时，会调用 OpenAI Responses API 生成结构化 JSON 草稿
- `apply-narrative-drafts` 只会把 `status: "approved"` 的草稿写回 `company-overrides.json`
- 这个流程默认是“先审稿，再发布”，不会直接改页面展示数据

### 后续可扩展

- 接入 OpenAI 或其他摘要流程，为 `guidance`、`business highlights` 生成候选草稿，再人工审核写回 `company-overrides.json`
- 通过 `cron` 或桌面自动化定时执行 `npm run refresh-plan`
- 为高价值字段增加多源校验，比如财报日历对照 Nasdaq IR 或公司官网
- 优先为 `AVGO / QCOM / MU / ASML / AMAT / KLAC / LRCX` 增加公司官方抓取器，进一步降低对单一第三方源的依赖
