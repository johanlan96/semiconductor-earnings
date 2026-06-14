import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SOURCE_PATH = path.join(DATA_DIR, "narrative-source-texts.json");
const SEED_PATH = path.join(DATA_DIR, "company-seed.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "company-overrides.json");
const OUTPUT_PATH = path.join(DATA_DIR, "narrative-drafts.json");

await loadDotEnv();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_NARRATIVE_MODEL || "gpt-4o-mini";

async function main() {
  const sourceTexts = await readJson(SOURCE_PATH, {});
  const seed = await readJson(SEED_PATH, { companies: [] });
  const overrides = await readJson(OVERRIDES_PATH, {});
  const existingDraftsPayload = await readJson(OUTPUT_PATH, { drafts: {} });

  const drafts = {};

  for (const company of seed.companies) {
    const textEntry = sourceTexts[company.ticker];
    if (!textEntry?.text?.trim()) continue;

    let candidate;
    if (OPENAI_API_KEY) {
      candidate = await generateDraftWithOpenAI(company, textEntry.text);
    } else {
      candidate = buildFallbackDraft(company, textEntry.text);
    }

    const previousDraft = existingDraftsPayload.drafts?.[company.ticker] || {};
    drafts[company.ticker] = {
      companyName: company.nameCn,
      model: OPENAI_API_KEY ? MODEL : "fallback-rule-based",
      sourceType: textEntry.sourceType || "manual-note",
      updatedAt: new Date().toISOString(),
      status: previousDraft.status === "approved" ? "approved" : "pending_review",
      reviewerNotes: previousDraft.reviewerNotes || "",
      existingOverride: overrides[company.ticker] || null,
      candidate,
      sourcePreview: textEntry.text.slice(0, 1000),
    };
  }

  const output = {
    generatedAt: new Date().toISOString(),
    model: OPENAI_API_KEY ? MODEL : "fallback-rule-based",
    drafts,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Generated narrative drafts for ${Object.keys(drafts).length} companies.`);
}

async function generateDraftWithOpenAI(company, text) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "你是半导体财报摘要助手。请基于原文，生成用于投资看板的中文草稿。不要编造数字，不要加入原文没有的判断，保留谨慎措辞。"
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `公司：${company.nameCn} (${company.ticker})`,
                `英文名：${company.nameEn}`,
                `赛道：${company.track}`,
                "",
                "请输出 JSON，字段如下：",
                "- guidance: 一句中文总结，20-50字",
                "- highlights: 3条中文要点，每条18-40字",
                "- confidence: high / medium / low",
                "- notes: 一句说明不确定点，若无则为空字符串",
                "",
                "原始文本：",
                text
              ].join("\n")
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "narrative_draft",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              guidance: { type: "string" },
              highlights: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 3
              },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"]
              },
              notes: { type: "string" }
            },
            required: ["guidance", "highlights", "confidence", "notes"]
          }
        }
      }
    }),
  });

  if (!response.ok) {
    const textBody = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${textBody}`);
  }

  const payload = await response.json();
  const jsonText =
    payload.output?.[0]?.content?.find((item) => item.type === "output_text")?.text ||
    payload.output_text ||
    "{}";

  return JSON.parse(jsonText);
}

function buildFallbackDraft(company, text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();

  const guidanceFragments = [];
  if (hasAny(lower, ["data center demand remains strong", "data center demand"])) {
    guidanceFragments.push("数据中心需求维持强劲");
  }
  if (hasAny(lower, ["shipments are expected to ramp", "ramp next quarter", "volume ramp"])) {
    guidanceFragments.push("下季度出货有望继续爬坡");
  }
  if (hasAny(lower, ["ai infrastructure", "ai accelerators", "ai accelerator"])) {
    guidanceFragments.push("AI 基础设施投入仍是主要驱动");
  }

  const guidance =
    guidanceFragments.length > 0
      ? truncate(`${guidanceFragments.join("，")}。`, 46)
      : truncate("原始材料显示公司下季度展望偏积极，建议结合财报原文进一步人工确认。", 46);

  const highlights = [
    summarizeHighlight(lower, [
      {
        keys: ["hyperscaler investment", "hyperscaler"],
        text: "超大规模云厂商继续投入 AI 基础设施。"
      },
      {
        keys: ["networking attach rates", "networking"],
        text: "网络相关产品附加率改善，产品组合继续优化。"
      },
      {
        keys: ["supply availability", "better supply", "supply"],
        text: "高端 GPU 产品供应可得性较前期改善。"
      }
    ]) || "建议从原始材料中补充最核心的业务催化剂表述。",
    summarizeHighlight(lower, [
      {
        keys: ["blackwell"],
        text: "Blackwell 平台相关出货进度值得重点跟踪。"
      },
      {
        keys: ["ai accelerators", "ai accelerator"],
        text: "AI 加速器需求仍是本轮增长的核心主线。"
      },
      {
        keys: ["data center"],
        text: "数据中心业务仍是管理层重点强调方向。"
      }
    ]) || `${company.track}相关进展建议从原始材料中人工确认。`,
    "当前为无模型兜底草稿，建议发布前再人工润色一次。"
  ].map((item) => truncate(item, 36));

  return {
    guidance,
    highlights,
    confidence: "low",
    notes: "未配置 OPENAI_API_KEY，当前为关键词规则兜底草稿，适合先做编辑起点。",
  };
}

function summarizeHighlight(text, rules) {
  const matched = rules.find((rule) => hasAny(text, rule.keys));
  return matched?.text || "";
}

function hasAny(text, keys) {
  return keys.some((key) => text.includes(key));
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
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
    if (error.code !== "ENOENT") throw error;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
