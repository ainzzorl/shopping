const { TelegramClient } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const readline = require("readline");
const telegramConfig = require("../config/telegram");

const stringSession = new StoreSession("telegram_session"); // fill this later with the value from session.save()

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

(async () => {
  // Check if apiId is configured
  if (!telegramConfig.apiId || String(telegramConfig.apiId).trim() === "") {
    console.log(
      "Telegram setup skipped: apiId not configured in config/telegram.js"
    );
    console.log(
      "Please set apiId, apiHash, and channelId in config/telegram.js to enable Telegram notifications."
    );
    process.exit(0);
  }

  console.log("Loading interactive example...");
  const client = new TelegramClient(
    stringSession,
    telegramConfig.apiId,
    telegramConfig.apiHash,
    {
      connectionRetries: 5,
    }
  );
  await client.start({
    phoneNumber: async () =>
      new Promise((resolve) =>
        rl.question("Please enter your number: ", resolve)
      ),
    password: async () =>
      new Promise((resolve) =>
        rl.question("Please enter your password: ", resolve)
      ),
    phoneCode: async () =>
      new Promise((resolve) =>
        rl.question("Please enter the code you received: ", resolve)
      ),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");
  console.log(client.session.save()); // Save this string to avoid logging in again
  await client.sendMessage("me", { message: "Hello!" });
})();
