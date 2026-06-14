import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT_PATH = path.join(DATA_DIR, "refresh-plan-report.json");
const RUNS = [
  {
    name: "full-yfinance-primary",
    command: ["node", "scripts/update-data.mjs"],
  },
];

const results = [];

for (const run of RUNS) {
  const startedAt = new Date().toISOString();
  const result = await runCommand(run.command);
  const endedAt = new Date().toISOString();
  const refreshReport = await readJsonIfExists(path.join(DATA_DIR, "last-refresh-report.json"));

  results.push({
    name: run.name,
    command: run.command.join(" "),
    startedAt,
    endedAt,
    exitCode: result.exitCode,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    refreshReport,
  });
}

const finalReport = {
  generatedAt: new Date().toISOString(),
  runs: results,
};

await fs.writeFile(OUTPUT_PATH, JSON.stringify(finalReport, null, 2));
console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}.`);

async function runCommand([cmd, ...args]) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
