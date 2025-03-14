const { TelegramClient } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const db = require("../models/database");
const telegramConfig = require("../config/telegram");

let client = null;

// Only initialize Telegram client if not in test environment
if (process.env.NODE_ENV !== "test") {
  // Initialize Telegram client
  // You'll need to set these environment variables:
  // TELEGRAM_API_ID: Your API ID from https://my.telegram.org
  // TELEGRAM_API_HASH: Your API hash from https://my.telegram.org
  // TELEGRAM_STRING_SESSION: The session string from initial login
  client = new TelegramClient(
    new StoreSession("telegram_session"),
    telegramConfig.apiId,
    telegramConfig.apiHash,
    { connectionRetries: 5 }
  );

  // Start the client
  (async () => {
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      console.error(
        "Telegram client not authorized. Please run the setup script first."
      );
    }
  })();
}

async function sendPriceAlert(item, currentPrice) {
  try {
    // Get store information
    const store = await new Promise((resolve, reject) => {
      db.get(
        `SELECT s.name
         FROM stores s
         JOIN items i ON s.id = i.store_id
         WHERE i.id = ?`,
        [item.id],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });

    // Format the message
    const message =
      `🎉 Price Drop Alert! 🎉\n\n` +
      `${item.name}\n` +
      `Store: ${store ? store.name : "Unknown Store"}\n` +
      `Current Price: $${currentPrice.toFixed(2)}\n` +
      `Target Price: $${item.target_price.toFixed(2)}\n` +
      `Check it out here: ${item.url}`;

    // Only send message if client is initialized (not in test environment)
    if (client) {
      await client.sendMessage(
        await client.getEntity(telegramConfig.channelId),
        {
          message,
        }
      );
    }

    // Store the notification in the database
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (item_id, price, type) VALUES (?, ?, ?)`,
        [item.id, currentPrice, "price_drop"],
        (err) => {
          if (err) reject(err);
          resolve();
        }
      );
    });

    console.log(`Sent price drop notification for item ${item.id}`);
  } catch (error) {
    console.error("Error sending price alert:", error);
  }
}

module.exports = {
  sendPriceAlert,
  client, // Export the client in case we need it elsewhere
};
