const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const sqlite3 = require("sqlite3").verbose();
const {
  extractFromScreenshot,
  PROMPT_VERSION,
} = require("./workers/aiExtractor");

const PROJECT_ROOT = __dirname;
const DB_PATH = path.join(PROJECT_ROOT, "shopping.db");
const RESULTS_DIR = path.join(PROJECT_ROOT, "results");

function parseArgs(argv) {
  const args = { limit: 50, days: 90, includeFailed: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--days") args.days = parseInt(argv[++i], 10);
    else if (a === "--no-failed") args.includeFailed = false;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node test-ai-extraction.js [--limit N] [--days D] [--no-failed]\n" +
        "  --limit N       max usable rows after filtering missing PNGs (default 50)\n" +
        "  --days D        sample window in days (default 90)\n" +
        "  --no-failed     exclude tasks where the original extraction failed"
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    console.error("--limit must be a positive integer");
    process.exit(2);
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    console.error("--days must be a positive integer");
    process.exit(2);
  }
  return args;
}

function openDbReadOnly(p) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(p, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

const SAMPLE_SQL = `
WITH ranked AS (
  SELECT
    t.id AS task_id, t.item_id, t.url, t.execution_time,
    t.success, t.screenshot_path,
    i.name AS item_name,
    ROW_NUMBER() OVER (
      PARTITION BY t.item_id, t.success
      ORDER BY t.execution_time DESC
    ) AS rn
  FROM scraping_tasks t
  JOIN items i ON i.id = t.item_id
  WHERE t.screenshot_path IS NOT NULL
    AND t.execution_time >= datetime('now', '-' || ? || ' days')
)
SELECT
  r.task_id, r.item_id, r.url, r.item_name,
  r.execution_time, r.success, r.screenshot_path,
  (SELECT d.price FROM item_datapoints d
     WHERE d.item_id = r.item_id AND d.timestamp <= r.execution_time
     ORDER BY d.timestamp DESC LIMIT 1) AS old_price
FROM ranked r
WHERE r.rn = 1
ORDER BY r.success DESC, r.execution_time DESC
`;

function classifyMatch(oldPrice, aiPrice) {
  const oldNum = typeof oldPrice === "number" && Number.isFinite(oldPrice);
  const aiNum = typeof aiPrice === "number" && Number.isFinite(aiPrice);
  if (!oldNum && !aiNum) return { kind: "both_null" };
  if (!oldNum && aiNum) return { kind: "ai_only" };
  if (oldNum && !aiNum) return { kind: "old_only" };
  const absDiff = Math.abs(oldPrice - aiPrice);
  if (absDiff < 0.01) return { kind: "exact", abs_diff: absDiff };
  const pctDiff = oldPrice !== 0 ? (absDiff / Math.abs(oldPrice)) * 100 : null;
  return { kind: "mismatch", abs_diff: absDiff, pct_diff: pctDiff };
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmtPrice(p) {
  return typeof p === "number" && Number.isFinite(p) ? `$${p.toFixed(2)}` : "—";
}

function summarize(rows) {
  const counts = {
    exact: 0,
    mismatch: 0,
    ai_only: 0,
    old_only: 0,
    both_null: 0,
  };
  let aiInStockFalse = 0;
  let aiAvailableFalse = 0;
  const absDiffs = [];
  const latencies = [];
  const errors = {};

  for (const r of rows) {
    counts[r.match.kind]++;
    if (r.match.kind === "exact" || r.match.kind === "mismatch") {
      absDiffs.push(r.match.abs_diff);
    }
    if (r.ai.in_stock === false) aiInStockFalse++;
    if (r.ai.available === false) aiAvailableFalse++;
    if (typeof r.ai.latency_ms === "number") latencies.push(r.ai.latency_ms);
    if (r.ai.error) errors[r.ai.error] = (errors[r.ai.error] || 0) + 1;
  }

  const avgAbsDiff =
    absDiffs.length > 0
      ? absDiffs.reduce((a, b) => a + b, 0) / absDiffs.length
      : null;

  return {
    ...counts,
    ai_in_stock_false: aiInStockFalse,
    ai_available_false: aiAvailableFalse,
    avg_abs_diff_when_both_numbers: avgAbsDiff,
    median_latency_ms: median(latencies),
    soft_errors_by_kind: errors,
  };
}

function printSummary(summary, totals, args, cfg) {
  const lines = [
    "",
    "=== AI extraction test summary ===",
    `model:           ${cfg.model}`,
    `base_url:        ${cfg.baseUrl}`,
    `prompt_version:  ${PROMPT_VERSION}`,
    `args:            limit=${args.limit} days=${args.days} include_failed=${args.includeFailed}`,
    "",
    "Totals:",
    `  sampled:                       ${totals.sampled}`,
    `  skipped (PNG missing on disk): ${totals.skipped_missing_png}`,
    `  successful old extractions:    ${totals.successful_old_extractions}`,
    `  failed old extractions:        ${totals.failed_old_extractions}`,
    "",
    "Match breakdown:",
    `  exact (|diff|<$0.01):          ${summary.exact}`,
    `  mismatch:                      ${summary.mismatch}`,
    `  ai_only (old=null, ai=number): ${summary.ai_only}`,
    `  old_only (old=number, ai=null):${summary.old_only}`,
    `  both_null:                     ${summary.both_null}`,
    "",
    "AI availability signals:",
    `  in_stock=false:                ${summary.ai_in_stock_false}`,
    `  available=false:               ${summary.ai_available_false}`,
    "",
    "Performance:",
    `  avg abs_diff (both numeric):   ${summary.avg_abs_diff_when_both_numbers === null
      ? "—"
      : `$${summary.avg_abs_diff_when_both_numbers.toFixed(4)}`
    }`,
    `  median latency:                ${summary.median_latency_ms === null
      ? "—"
      : `${Math.round(summary.median_latency_ms)} ms`
    }`,
  ];
  const errKinds = Object.entries(summary.soft_errors_by_kind);
  if (errKinds.length > 0) {
    lines.push("", "Soft errors:");
    for (const [k, v] of errKinds) {
      lines.push(`  ${k.padEnd(30)} ${v}`);
    }
  }
  lines.push("");
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv);

  const cfg = {
    baseUrl: process.env.AI_VISION_BASE_URL || "http://framework-desktop.local:1234/v1",
    model: process.env.AI_VISION_MODEL || "qwen/qwen3-vl-4b",
  };

  console.log(
    `Sampling from ${DB_PATH} (last ${args.days} days, limit ${args.limit}, include_failed=${args.includeFailed})`
  );
  console.log(`AI endpoint: ${cfg.baseUrl}, model: ${cfg.model}`);

  const db = await openDbReadOnly(DB_PATH);
  let allRows;
  try {
    allRows = await dbAll(db, SAMPLE_SQL, [args.days]);
  } finally {
    db.close();
  }

  let candidates = allRows;
  if (!args.includeFailed) {
    candidates = candidates.filter((r) => r.success === 1);
  }

  // Resolve and filter by file existence
  let skippedMissing = 0;
  const usable = [];
  for (const r of candidates) {
    const abs = path.resolve(PROJECT_ROOT, r.screenshot_path);
    if (fs.existsSync(abs)) {
      usable.push({ ...r, abs_screenshot_path: abs });
    } else {
      skippedMissing++;
    }
    if (usable.length >= args.limit) break;
  }

  if (usable.length === 0) {
    console.error(
      `No usable rows: 0 screenshots resolved on disk (skipped_missing_png=${skippedMissing}). ` +
      `Most production PNGs may live on the Pi — copy them locally or run this on the Pi.`
    );
    process.exit(1);
  }

  console.log(
    `Resolved ${usable.length} screenshots on disk (skipped ${skippedMissing} missing). Starting extraction…`
  );
  console.log(
    "Note: first call may be slow if the model is cold-loading in LM Studio."
  );

  const reportRows = [];
  let successfulOld = 0;
  let failedOld = 0;

  for (let i = 0; i < usable.length; i++) {
    const row = usable[i];
    if (row.success === 1) successfulOld++;
    else failedOld++;

    const ai = await extractFromScreenshot(row.abs_screenshot_path, {
      url: row.url,
      itemName: row.item_name,
    });
    const match = classifyMatch(row.old_price, ai.price);

    const stockStr = `is=${ai.in_stock === null ? "?" : ai.in_stock ? "y" : "n"}/av=${ai.available === null ? "?" : ai.available ? "y" : "n"
      }`;
    const errStr = ai.error ? ` err=${ai.error}` : "";
    console.log(
      `[${i + 1}/${usable.length}] task=${row.task_id} item=${row.item_id} ` +
      `old=${fmtPrice(row.old_price)} ai=${fmtPrice(ai.price)} ` +
      `match=${match.kind} ${stockStr} (${ai.latency_ms}ms)${errStr}`
    );

    reportRows.push({
      task_id: row.task_id,
      item_id: row.item_id,
      url: row.url,
      item_name: row.item_name,
      execution_time: row.execution_time,
      success: row.success,
      screenshot_path: row.screenshot_path,
      old_price: row.old_price,
      ai,
      match,
    });
  }

  const summary = summarize(reportRows);
  const totals = {
    sampled: usable.length,
    skipped_missing_png: skippedMissing,
    successful_old_extractions: successfulOld,
    failed_old_extractions: failedOld,
  };

  await fsp.mkdir(RESULTS_DIR, { recursive: true });
  const ts = Date.now();
  const reportPath = path.join(RESULTS_DIR, `ai-extraction-test-${ts}.json`);
  const reportDoc = {
    generated_at: new Date().toISOString(),
    model: cfg.model,
    base_url: cfg.baseUrl,
    prompt_version: PROMPT_VERSION,
    args,
    totals,
    summary,
    rows: reportRows,
  };
  await fsp.writeFile(reportPath, JSON.stringify(reportDoc, null, 2));

  printSummary(summary, totals, args, cfg);
  console.log(`Report written to ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
