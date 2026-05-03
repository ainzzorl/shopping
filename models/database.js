const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Create database connection
const db = new sqlite3.Database(
  path.join(__dirname, "../shopping.db"),
  (err) => {
    if (err) {
      console.error("Error connecting to database:", err);
    } else {
      console.log("Connected to SQLite database");
    }
  }
);

// Swallow "duplicate column name" errors so ALTER TABLE is idempotent.
function alter(sql) {
  db.run(sql, (err) => {
    if (err && !/duplicate column name/i.test(err.message)) {
      console.error(`Migration failed: ${sql}`, err);
    }
  });
}

// Initialize database tables
db.serialize(() => {
  // Create stores table
  db.run(`CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        website TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    )`);

  // Create items table
  db.run(`CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        target_price REAL NOT NULL,
        image_url TEXT,
        enabled BOOLEAN DEFAULT 1,
        enable_notifications BOOLEAN DEFAULT 1,
        store_id INTEGER,
        FOREIGN KEY (store_id) REFERENCES stores (id)
    )`);

  // Create item_datapoints table
  db.run(`CREATE TABLE IF NOT EXISTS item_datapoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
        price REAL NOT NULL,
        task_id INTEGER,
        in_stock INTEGER,
        available INTEGER,
        source TEXT DEFAULT 'html',
        FOREIGN KEY (item_id) REFERENCES items (id),
        FOREIGN KEY (task_id) REFERENCES scraping_tasks (id)
    )`);

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_datapoints_item_timestamp
       ON item_datapoints (item_id, timestamp DESC)`,
  );

  // Create scraping_tasks table
  db.run(`CREATE TABLE IF NOT EXISTS scraping_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        scheduled_time DATETIME NOT NULL,
        execution_time DATETIME,
        success BOOLEAN,
        screenshot_path TEXT,
        html_path TEXT,
        error_message TEXT,
        was_blocked INTEGER,
        ai_processed_at DATETIME,
        ai_price REAL,
        ai_in_stock INTEGER,
        ai_available INTEGER,
        ai_model TEXT,
        ai_latency_ms INTEGER,
        ai_error TEXT,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);

  // Create notifications table
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        price REAL NOT NULL,
        sent_at DATETIME DEFAULT (datetime('now', 'localtime')),
        type TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES items (id)
    )`);

  // Create ai_batch_runs table
  db.run(`CREATE TABLE IF NOT EXISTS ai_batch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at DATETIME DEFAULT (datetime('now', 'localtime')),
        finished_at DATETIME,
        status TEXT DEFAULT 'running',
        tasks_total INTEGER DEFAULT 0,
        tasks_processed INTEGER DEFAULT 0,
        tasks_failed INTEGER DEFAULT 0,
        forced INTEGER DEFAULT 0,
        error_message TEXT
    )`);

  // Migrations for existing databases
  alter(`ALTER TABLE scraping_tasks ADD COLUMN was_blocked INTEGER`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_processed_at DATETIME`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_price REAL`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_in_stock INTEGER`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_available INTEGER`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_model TEXT`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_latency_ms INTEGER`);
  alter(`ALTER TABLE scraping_tasks ADD COLUMN ai_error TEXT`);

  alter(`ALTER TABLE item_datapoints ADD COLUMN task_id INTEGER`);
  alter(`ALTER TABLE item_datapoints ADD COLUMN in_stock INTEGER`);
  alter(`ALTER TABLE item_datapoints ADD COLUMN available INTEGER`);
  alter(`ALTER TABLE item_datapoints ADD COLUMN source TEXT DEFAULT 'html'`);
});

module.exports = db;
