import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAFTS_PATH = path.join(DATA_DIR, "narrative-drafts.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "company-overrides.json");

async function main() {
  const draftsPayload = JSON.parse(await fs.readFile(DRAFTS_PATH, "utf8"));
  const overrides = JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"));

  let applied = 0;
  for (const [ticker, draftMeta] of Object.entries(draftsPayload.drafts || {})) {
    if (draftMeta?.status !== "approved") continue;
    const candidate = draftMeta?.candidate;
    if (!candidate?.guidance || !Array.isArray(candidate.highlights)) continue;

    overrides[ticker] = {
      ...overrides[ticker],
      guidance: candidate.guidance,
      highlights: candidate.highlights,
    };
    applied += 1;
  }

  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
  console.log(`Applied approved narrative drafts to ${applied} companies.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
