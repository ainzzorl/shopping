const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const db = require("../models/database");
const { extractFromScreenshot } = require("./aiExtractor");
const { startLmServer, loadModel, unloadModel } = require("./lmsClient");

const PROJECT_ROOT = path.join(__dirname, "..");
const RESULTS_DIR = path.join(PROJECT_ROOT, "results");
const LOCK_FILE = path.join(os.tmpdir(), "shopping-ai-batch.lock");
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MODEL = process.env.AI_VISION_MODEL || "qwen/qwen3-vl-4b";
const LOOKBACK_HOURS = parseInt(process.env.AI_BATCH_LOOKBACK_HOURS, 10) || 36;

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    })
  );
}

async function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const ageMs = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      const running = await dbGet(
        "SELECT id FROM ai_batch_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1"
      );
      if (!running) {
        console.log(`Removing stale AI batch lock (age ${Math.round(ageMs / 1000)}s)`);
        fs.unlinkSync(LOCK_FILE);
      } else {
        return { ok: false, reason: `batch run ${running.id} is still running` };
      }
    }
  }
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
      { flag: "wx" }
    );
    return { ok: true };
  } catch (e) {
    if (e.code === "EEXIST") {
      return { ok: false, reason: "another AI batch is in progress" };
    }
    throw e;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("Failed to release AI batch lock:", e);
  }
}

async function ranSuccessfullyToday() {
  const row = await dbGet(
    `SELECT id FROM ai_batch_runs
     WHERE status IN ('success', 'partial')
       AND date(started_at) = date('now', 'localtime')
     ORDER BY id DESC LIMIT 1`
  );
  return row || null;
}

function resolveScreenshotPath(rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return rel;
  if (rel.startsWith("results/")) return path.join(PROJECT_ROOT, rel);
  return path.join(RESULTS_DIR, path.basename(rel));
}

function boolToInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

async function applyAiResultToDatapoint(taskId, ai) {
  const dp = await dbGet(
    "SELECT id FROM item_datapoints WHERE task_id = ? LIMIT 1",
    [taskId]
  );
  if (!dp) return;

  if (ai.error) {
    // Extraction failed — leave the HTML datapoint untouched.
    return;
  }

  const inStock = boolToInt(ai.in_stock);
  const available = boolToInt(ai.available);

  if (typeof ai.price === "number" && Number.isFinite(ai.price)) {
    await dbRun(
      "UPDATE item_datapoints SET price = ?, in_stock = ?, available = ?, source = 'ai' WHERE id = ?",
      [ai.price, inStock, available, dp.id]
    );
  } else if (ai.in_stock === false || ai.available === false) {
    // Item is out of stock or no longer available — keep HTML price for history,
    // but mark with 'ai_oos' so checkPriceDrops filters it out.
    await dbRun(
      "UPDATE item_datapoints SET in_stock = ?, available = ?, source = 'ai_oos' WHERE id = ?",
      [inStock, available, dp.id]
    );
  } else {
    // AI couldn't extract a price but item appears available — keep HTML price.
    await dbRun(
      "UPDATE item_datapoints SET in_stock = ?, available = ? WHERE id = ?",
      [inStock, available, dp.id]
    );
  }
}

async function processOneTask(task, model) {
  const absPath = resolveScreenshotPath(task.screenshot_path);
  let ai;
  try {
    await fsp.access(absPath);
  } catch (_) {
    await dbRun(
      `UPDATE scraping_tasks
       SET ai_processed_at = datetime('now', 'localtime'),
           ai_error = 'screenshot_missing',
           ai_model = ?
       WHERE id = ?`,
      [model, task.task_id]
    );
    return { ok: false, reason: "screenshot_missing" };
  }

  try {
    ai = await extractFromScreenshot(absPath, {
      url: task.url,
      itemName: task.item_name,
    });
  } catch (e) {
    await dbRun(
      `UPDATE scraping_tasks
       SET ai_processed_at = datetime('now', 'localtime'),
           ai_error = ?,
           ai_model = ?
       WHERE id = ?`,
      [`exception: ${e.message || String(e)}`.slice(0, 500), model, task.task_id]
    );
    return { ok: false, reason: "exception" };
  }

  await dbRun(
    `UPDATE scraping_tasks
     SET ai_processed_at = datetime('now', 'localtime'),
         ai_price = ?,
         ai_in_stock = ?,
         ai_available = ?,
         ai_model = ?,
         ai_latency_ms = ?,
         ai_error = ?
     WHERE id = ?`,
    [
      typeof ai.price === "number" && Number.isFinite(ai.price) ? ai.price : null,
      boolToInt(ai.in_stock),
      boolToInt(ai.available),
      ai.model || model,
      ai.latency_ms ?? null,
      ai.error || null,
      task.task_id,
    ]
  );

  await applyAiResultToDatapoint(task.task_id, ai);
  return { ok: !ai.error, ai };
}

async function runAiBatch(opts = {}) {
  const { force = false, catchUpOnly = false, model = DEFAULT_MODEL } = opts;

  const lock = await acquireLock();
  if (!lock.ok) {
    console.log(`AI batch skipped: ${lock.reason}`);
    return { skipped: true, reason: lock.reason };
  }

  let batchRunId = null;
  let lmsLoaded = false;
  let status = "failed";
  let processed = 0;
  let failed = 0;
  let total = 0;
  let errorMessage = null;

  try {
    if (!force) {
      const prior = await ranSuccessfullyToday();
      if (prior) {
        console.log(`AI batch already ran today (batch #${prior.id}); skipping.`);
        return { skipped: true, reason: "already_ran_today" };
      }
    } else if (catchUpOnly) {
      // Mutually exclusive in spirit, but explicit anyway.
      console.log("force overrides catchUpOnly");
    }

    if (catchUpOnly) {
      const prior = await ranSuccessfullyToday();
      if (prior) return { skipped: true, reason: "already_ran_today" };
    }

    const insert = await dbRun(
      "INSERT INTO ai_batch_runs (forced) VALUES (?)",
      [force ? 1 : 0]
    );
    batchRunId = insert.lastID;
    console.log(`AI batch run #${batchRunId} starting`);

    try {
      await startLmServer();
      await loadModel(model);
      lmsLoaded = true;
    } catch (e) {
      errorMessage = `LMS init failed: ${e.message || String(e)}`;
      throw new Error(errorMessage);
    }

    const tasks = await dbAll(
      `SELECT t.id AS task_id, t.item_id, t.url, t.screenshot_path, i.name AS item_name
       FROM scraping_tasks t
       JOIN items i ON i.id = t.item_id
       WHERE t.success = 1
         AND (t.was_blocked IS NULL OR t.was_blocked = 0)
         AND t.ai_processed_at IS NULL
         AND t.screenshot_path IS NOT NULL
         AND t.execution_time >= datetime('now', '-' || ? || ' hours')
       ORDER BY t.execution_time ASC`,
      [LOOKBACK_HOURS]
    );
    total = tasks.length;
    await dbRun(
      "UPDATE ai_batch_runs SET tasks_total = ? WHERE id = ?",
      [total, batchRunId]
    );
    console.log(`AI batch: ${total} candidate task(s) within ${LOOKBACK_HOURS}h`);

    for (const task of tasks) {
      try {
        const res = await processOneTask(task, model);
        if (res.ok) {
          processed++;
          const ai = res.ai || {};
          console.log(
            `  task ${task.task_id} (${task.item_name}): price=${ai.price}, in_stock=${ai.in_stock}, available=${ai.available}, ${ai.latency_ms}ms`
          );
        } else {
          failed++;
          console.log(`  task ${task.task_id}: ${res.reason}`);
        }
      } catch (e) {
        failed++;
        console.error(`  task ${task.task_id} threw:`, e);
      }
      await dbRun(
        "UPDATE ai_batch_runs SET tasks_processed = ?, tasks_failed = ? WHERE id = ?",
        [processed, failed, batchRunId]
      );
    }

    if (failed === 0) status = "success";
    else if (processed === 0) status = "failed";
    else status = "partial";
  } catch (e) {
    errorMessage = errorMessage || e.message || String(e);
    console.error("AI batch error:", e);
    status = processed > 0 ? "partial" : "failed";
  } finally {
    if (lmsLoaded) {
      try {
        await unloadModel();
      } catch (e) {
        console.warn("Failed to unload model:", e.message || e);
      }
    }
    if (batchRunId !== null) {
      try {
        await dbRun(
          `UPDATE ai_batch_runs
           SET finished_at = datetime('now', 'localtime'),
               status = ?,
               tasks_total = ?,
               tasks_processed = ?,
               tasks_failed = ?,
               error_message = ?
           WHERE id = ?`,
          [status, total, processed, failed, errorMessage, batchRunId]
        );
      } catch (e) {
        console.warn("Failed to finalize ai_batch_runs row:", e);
      }
      console.log(
        `AI batch run #${batchRunId} ${status} (${processed} processed, ${failed} failed of ${total})`
      );
    }
    releaseLock();
  }

  return { skipped: false, status, processed, failed, total, batchRunId };
}

if (require.main === module) {
  const force = process.argv.includes("--force");
  runAiBatch({ force })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { runAiBatch };
