const { TelegramClient } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const db = require("../models/database");
const telegramConfig = require("../config/telegram");

// Initialize Telegram client
// You'll need to set these environment variables:
// TELEGRAM_API_ID: Your API ID from https://my.telegram.org
// TELEGRAM_API_HASH: Your API hash from https://my.telegram.org
// TELEGRAM_STRING_SESSION: The session string from initial login
const client = new TelegramClient(
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

async function sendPriceAlert(item, currentPrice) {
  try {
    // Check if we've already sent a notification for this price
    const existingNotification = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM notifications 
                WHERE item_id = ? AND price = ? AND type = 'price_drop'
                ORDER BY sent_at DESC LIMIT 1`,
        [item.id, currentPrice],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });

    // If we've already sent a notification for this price, don't send another one
    if (existingNotification) {
      console.log(
        `Already sent notification for item ${item.id} at price ${currentPrice}`
      );
      return;
    }

    // Format the message
    const message =
      `🎉 Price Drop Alert! 🎉\n\n` +
      `${item.name} is now ${currentPrice}!\n` +
      `Target price: ${item.target_price}\n` +
      `Check it out here: ${item.url}`;

    // Send the message to yourself ("me" is a special identifier in Telegram for self-messages)
    await client.sendMessage(await client.getEntity(telegramConfig.channelId), {
      message,
    });

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
