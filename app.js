const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const moment = require("moment");
const expressLayouts = require("express-ejs-layouts");
const db = require("./models/database");

const app = express();
const port = 3000;

// Set up EJS as the view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Set up express-ejs-layouts
app.use(expressLayouts);
app.set("layout", "layout");

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/results", express.static(path.join(__dirname, "results")));

// Make moment available in all views
app.locals.moment = moment;

// Routes for items
app.get("/", (req, res) => {
  const sortColumn = req.query.sort || "store_name"; // Default sort by store name
  const sortOrder = req.query.order === "desc" ? "DESC" : "ASC";

  // Validate sort column to prevent SQL injection
  const validColumns = ["name", "store_name", "target_price", "current_price"];
  const safeColumn = validColumns.includes(sortColumn) ? sortColumn : "name";

  // Latest datapoint per item, restricted to those that have been vetted by the
  // AI batch (or pre-deploy datapoints with no task_id) so a fresh HTML scrape
  // doesn't surface here until AI has had a chance to override or flag it.
  const query = `
        SELECT i.*,
               d.price as current_price,
               d.timestamp as price_timestamp,
               d.in_stock as current_in_stock,
               d.available as current_available,
               d.source as current_source,
               s.name as store_name,
               s.website as store_website
        FROM items i
        LEFT JOIN (
            SELECT dp.item_id, MAX(dp.timestamp) AS max_timestamp
            FROM item_datapoints dp
            LEFT JOIN scraping_tasks st ON st.id = dp.task_id
            WHERE dp.task_id IS NULL OR st.ai_processed_at IS NOT NULL
            GROUP BY dp.item_id
        ) m ON m.item_id = i.id
        LEFT JOIN item_datapoints d
            ON d.item_id = m.item_id AND d.timestamp = m.max_timestamp
        LEFT JOIN stores s ON i.store_id = s.id
        ORDER BY ${
          safeColumn === "current_price"
            ? "d.price"
            : safeColumn === "store_name"
            ? "s.name"
            : "i." + safeColumn
        } ${sortOrder}${safeColumn === "store_name" ? ", i.name ASC" : ""}
    `;

  db.all(query, [], (err, items) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    res.render("items/index", {
      items,
      currentSort: sortColumn,
      currentOrder: sortOrder.toLowerCase(),
    });
  });
});

app.get("/items/new", (req, res) => {
  db.all("SELECT id, name FROM stores ORDER BY name", [], (err, stores) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    res.render("items/new", { stores });
  });
});

app.post("/items", (req, res) => {
  const { url, name, target_price, image_url, store_id, enable_notifications } =
    req.body;
  db.run(
    "INSERT INTO items (url, name, target_price, image_url, store_id, enable_notifications) VALUES (?, ?, ?, ?, ?, ?)",
    [
      url,
      name,
      target_price,
      image_url,
      store_id,
      enable_notifications ? 1 : 0,
    ],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).send("Error creating item");
      }

      // Create initial scraping task
      const itemId = this.lastID;
      const scheduledTime = new Date().toLocaleString("sv-SE");

      db.run(
        "INSERT INTO scraping_tasks (item_id, url, scheduled_time) VALUES (?, ?, ?)",
        [itemId, url, scheduledTime],
        (err) => {
          if (err) {
            console.error("Error creating scraping task:", err);
            // Continue with redirect even if scraping task creation fails
          }
          res.redirect("/");
        }
      );
    }
  );
});

app.get("/items/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM items WHERE id = ?", [id], (err, item) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    if (!item) {
      return res.status(404).send("Item not found");
    }
    // Get scraping tasks with their associated price datapoints
    const query = `
      SELECT
        st.*,
        dp.price,
        dp.timestamp as price_timestamp,
        dp.in_stock as dp_in_stock,
        dp.available as dp_available,
        dp.source as dp_source
      FROM scraping_tasks st
      LEFT JOIN item_datapoints dp
        ON dp.task_id = st.id
        OR (dp.task_id IS NULL AND dp.item_id = st.item_id
            AND datetime(dp.timestamp) = datetime(st.execution_time))
      WHERE st.item_id = ?
      ORDER BY st.scheduled_time DESC
    `;
    db.all(query, [id], (err, scrapingTasks) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Database error");
      }
      res.render("items/show", { item, scrapingTasks });
    });
  });
});

app.get("/items/:id/edit", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM items WHERE id = ?", [id], (err, item) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    if (!item) {
      return res.status(404).send("Item not found");
    }
    db.all("SELECT id, name FROM stores ORDER BY name", [], (err, stores) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Database error");
      }
      res.render("items/edit", { item, stores });
    });
  });
});

app.post("/items/:id", (req, res) => {
  const id = req.params.id;
  const {
    url,
    name,
    target_price,
    image_url,
    enabled,
    enable_notifications,
    store_id,
  } = req.body;
  db.run(
    "UPDATE items SET url = ?, name = ?, target_price = ?, image_url = ?, enabled = ?, enable_notifications = ?, store_id = ? WHERE id = ?",
    [
      url,
      name,
      target_price,
      image_url,
      enabled ? 1 : 0,
      enable_notifications ? 1 : 0,
      store_id,
      id,
    ],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Error updating item");
      }
      res.redirect(`/items/${id}`);
    }
  );
});

app.post("/items/:id/delete", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM items WHERE id = ?", [id], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error deleting item");
    }
    res.redirect("/");
  });
});

// Routes for stores
app.get("/stores", (req, res) => {
  const query = `
        SELECT s.*,
               COUNT(i.id) as items_count
        FROM stores s
        LEFT JOIN items i ON s.id = i.store_id
        GROUP BY s.id
        ORDER BY s.name
    `;

  db.all(query, [], (err, stores) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    res.render("stores/index", { stores });
  });
});

app.get("/stores/new", (req, res) => {
  res.render("stores/new");
});

app.post("/stores", (req, res) => {
  const { name, website } = req.body;
  db.run(
    "INSERT INTO stores (name, website) VALUES (?, ?)",
    [name, website],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Error creating store");
      }
      res.redirect("/stores");
    }
  );
});

app.get("/stores/:id/edit", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM stores WHERE id = ?", [id], (err, store) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Database error");
    }
    if (!store) {
      return res.status(404).send("Store not found");
    }
    res.render("stores/edit", { store });
  });
});

app.post("/stores/:id", (req, res) => {
  const id = req.params.id;
  const { name, website } = req.body;
  db.run(
    "UPDATE stores SET name = ?, website = ? WHERE id = ?",
    [name, website, id],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Error updating store");
      }
      res.redirect("/stores");
    }
  );
});

app.post("/stores/:id/delete", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM stores WHERE id = ?", [id], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error deleting store");
    }
    res.redirect("/stores");
  });
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
