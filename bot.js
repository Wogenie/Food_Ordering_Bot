require("dotenv").config();

const { Telegraf } = require("telegraf");
const database = require("./db");
const { registerCustomerHandlers } = require("./customer");
const { registerAdminHandlers, isAwaitingMenuPrice } = require("./admin");

// -------------------- CONFIGURATION --------------------
if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing from your .env file");
}
if (!process.env.ADMIN_TELEGRAM_ID) {
  throw new Error("ADMIN_TELEGRAM_ID is missing from your .env file");
}

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID);
if (!Number.isSafeInteger(ADMIN_TELEGRAM_ID) || ADMIN_TELEGRAM_ID <= 0) {
  throw new Error("ADMIN_TELEGRAM_ID must be a valid positive Telegram user ID");
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Save customer profile details, but never register the owner as a customer.
bot.use(async (ctx, next) => {
  if (ctx.from && ctx.from.id !== ADMIN_TELEGRAM_ID) {
    database.upsertCustomer({
      telegram_id: ctx.from.id,
      first_name: ctx.from.first_name || "Customer",
      username: ctx.from.username || null,
    });
  }
  await next();
});

// Hard guard: owner account may use admin commands/buttons only, not customer ordering.
// This also blocks old customer-menu buttons if the owner has any old messages.
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== ADMIN_TELEGRAM_ID) return next();

  const callbackData = ctx.callbackQuery?.data;
  if (callbackData?.startsWith("ADMIN_")) return next();

  const text = ctx.message?.text || "";
  const commandMatch = text.match(/^\/(\w+)(?:@\w+)?/);
  const command = commandMatch?.[1]?.toLowerCase();
  const allowedAdminCommands = new Set([
    "admin",
    "pending",
    "active",
    "allorders",
    "today",
    "menuadmin",
    "cancelprice",
    "help",
  ]);

  if (command && allowedAdminCommands.has(command)) return next();
  if (isAwaitingMenuPrice(ctx.from.id, ctx.chat?.id)) return next();

  const notice =
    "👨‍🍳 This Telegram account is configured as the Abe Food owner.\n\n" +
    "Owner accounts cannot place customer orders. Use /admin to manage orders.";

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("Owner accounts cannot place customer orders.", { show_alert: true });
    return;
  }

  if (ctx.message) {
    await ctx.reply(notice);
    return;
  }
});

// -------------------- REGISTER FEATURE MODULES --------------------
registerAdminHandlers(bot, database, ADMIN_TELEGRAM_ID);
registerCustomerHandlers(bot, database, ADMIN_TELEGRAM_ID);

// Give a useful response to messages and stale buttons that have no handler.
bot.on("text", async (ctx) => {
  await ctx.reply("I didn't recognize that. Use /start, /menu, /cart, or /orders.");
});
bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery("This button is no longer available.", { show_alert: true });
});

// -------------------- ERROR HANDLING --------------------
bot.catch(async (error, ctx) => {
  console.error(`Error processing update ${ctx.update?.update_id}:`, error);
  try {
    await ctx.reply(
      "Something went wrong. Please try again or use /orders to check your saved orders."
    );
  } catch {
    // Telegram may be temporarily unavailable or the chat may no longer be reachable.
  }
});

// -------------------- START BOT --------------------
bot.launch({}, () => console.log("Connected to Telegram; initializing long polling."))
  .catch((error) => {
    console.error(
      "Telegram polling stopped. Check the bot token, network connection, and whether another instance is polling:",
      error
    );
    try {
      database.db.close();
    } catch (closeError) {
      console.error("Could not close the database after polling stopped:", closeError.message);
    }
    process.exitCode = 1;
  });

// Customer commands are global; admin.js registers a more-specific menu for the owner.
bot.telegram.setMyCommands(
  [
    { command: "start", description: "Start Abe Food" },
    { command: "menu", description: "Browse the menu" },
    { command: "cart", description: "View your cart" },
    { command: "orders", description: "View your orders" },
  ],
  { scope: { type: "all_private_chats" } }
).catch((error) => {
  console.error("Could not register customer commands:", error.message);
});

// -------------------- GRACEFUL SHUTDOWN --------------------
function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  bot.stop(signal);
  try {
    database.db.close();
  } catch (error) {
    console.error("Database shutdown error:", error.message);
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
