const { Markup } = require("telegraf");

// Customer-facing menu, cart, order history, and self-cancellation.
function registerCustomerHandlers(bot, database, adminTelegramId) {
  const {
    getMenu,
    getCart,
    setCartQuantity,
    createOrder,
    getRecentOrders,
    getOrderById,
    cancelCustomerOrder,
  } = database;

  function mainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("📋 ምግብ ዝርዝር", "MENU")],
      [
        Markup.button.callback("🛒 ቅርጫት", "CART"),
        Markup.button.callback("📦 ትዕዛዞቼ", "ORDERS"),
      ],
    ]);
  }

  async function renderScreen(ctx, message, keyboard) {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(message, keyboard);
        return;
      } catch (error) {
        if (error.description?.includes("message is not modified")) return;
        console.error("Could not edit customer message:", error.description || error.message);
      }
    }
    await ctx.reply(message, keyboard);
  }

  function isAdmin(ctx) {
    return ctx.from?.id === adminTelegramId;
  }

  async function blockAdminFromCustomerFlow(ctx) {
    if (!isAdmin(ctx)) return false;
    const notice = "👨‍🍳 This account is the Abe Food owner account and cannot place customer orders. Use /admin to manage the restaurant.";
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("Owner accounts cannot place customer orders.", { show_alert: true });
    } else {
      await ctx.reply(notice);
    }
    return true;
  }

  async function showMenu(ctx) {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    const menu = getMenu();
    if (menu.length === 0) {
      return renderScreen(
        ctx,
        "🍽️ አሁን የሚገኝ ምግብ የለም። እባክዎ ቆይተው ይመለሱ።",
        Markup.inlineKeyboard([
          [Markup.button.callback("🛒 ቅርጫት", "CART")],
          [Markup.button.callback("📦 ትዕዛዞቼ", "ORDERS")],
        ])
      );
    }

    const cart = getCart(ctx.from.id);
    const cartMap = new Map(cart.map((item) => [item.menu_item_id, item]));
    const buttons = [];

    for (const item of menu) {
      const selected = cartMap.get(item.id);
      buttons.push([
        Markup.button.callback(
          `${selected ? "✅" : "🍽️"} ${item.name} — ${item.price_etb} ብር`,
          `TOGGLE_${item.id}`
        ),
      ]);

      if (selected) {
        buttons.push([
          Markup.button.callback("➖", `QTY_${item.id}_MINUS`),
          Markup.button.callback(String(selected.quantity), "NOOP"),
          Markup.button.callback("➕", `QTY_${item.id}_PLUS`),
        ]);
      }
    }

    buttons.push([
      Markup.button.callback("🛒 ቅርጫት", "CART"),
      Markup.button.callback("✅ ትዕዛዝ አስገባ", "CONFIRM"),
    ]);

    const total = cart.reduce((sum, item) => sum + item.line_total_etb, 0);
    await renderScreen(
      ctx,
      "🇪🇹 አቤ ምግብ ቤት · የፆም ምግቦች\n\n" +
      "ምግብ ለመምረጥ ይንኩ። ብዛቱን ለመቀየር ➖ ወይም ➕ ይጠቀሙ።\n\n" +
      `🍽️ በቅርጫት ያሉ ምግቦች: ${cart.reduce((sum, item) => sum + item.quantity, 0)}\n💰 ጠቅላላ: ${total} ብር`,
      Markup.inlineKeyboard(buttons)
    );
  }

  async function showCart(ctx) {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    const items = getCart(ctx.from.id);
    if (items.length === 0) {
      return renderScreen(
        ctx,
        "🛒 ቅርጫትዎ ባዶ ነው።\n\nምግብ ለመምረጥ ወደ ምግብ ዝርዝሩ ይሂዱ።",
        Markup.inlineKeyboard([
          [Markup.button.callback("📋 ምግብ ዝርዝር", "MENU")],
          [Markup.button.callback("📦 ትዕዛዞቼ", "ORDERS")],
        ])
      );
    }

    const lines = items.map(
      (item) => `• ${item.name} × ${item.quantity} — ${item.line_total_etb} ብር`
    );
    const total = items.reduce((sum, item) => sum + item.line_total_etb, 0);
    await renderScreen(
      ctx,
      `🛒 ቅርጫትዎ\n\n${lines.join("\n")}\n\n💰 ጠቅላላ: ${total} ብር`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ ትዕዛዝ አስገባ", "CONFIRM"),
          Markup.button.callback("✏️ ምግቦችን ቀይር", "MENU"),
        ],
        [Markup.button.callback("📦 ትዕዛዞቼ", "ORDERS")],
      ])
    );
  }

  async function showOrders(ctx) {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    const orders = getRecentOrders(ctx.from.id);
    const keyboard = [];

    for (const order of orders) {
      if (["pending", "accepted"].includes(order.status)) {
        keyboard.push([
          Markup.button.callback(`❌ Cancel #${order.id}`, `CUSTOMER_CANCEL_${order.id}`),
        ]);
      }
    }

    keyboard.push([Markup.button.callback("📋 ምግብ ዝርዝር", "MENU")]);
    keyboard.push([Markup.button.callback("🛒 ቅርጫት", "CART")]);

    if (orders.length === 0) {
      return renderScreen(
        ctx,
        "📦 My Orders\n\nYou haven't placed an order yet.",
        Markup.inlineKeyboard(keyboard)
      );
    }

    const statusLabels = {
      pending: "Waiting for restaurant",
      accepted: "Accepted",
      preparing: "Being prepared",
      ready: "Ready",
      delivered: "Delivered",
      cancelled: "Cancelled",
    };

    const lines = orders.map((order) => {
      const cancellationNote = ["pending", "accepted"].includes(order.status)
        ? "\nCancel below."
        : ["preparing", "ready", "delivered"].includes(order.status)
          ? "\nCancellation unavailable at this stage."
          : "";

      return `Order #${order.id}\nStatus: ${statusLabels[order.status] || order.status}\nTotal: ${order.total_etb} ETB\nCreated: ${order.created_at}${cancellationNote}`;
    });

    await renderScreen(
      ctx,
      `📦 Your Recent Orders\n\n${lines.join("\n\n")}`,
      Markup.inlineKeyboard(keyboard)
    );
  }

  // Starting the bot and customer commands.
  bot.start(async (ctx) => {
    await showMenu(ctx);
  });
  bot.command("menu", showMenu);
  bot.command("cart", showCart);
  bot.command("orders", showOrders);

  // Main navigation callbacks.
  bot.action("MENU", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    await showMenu(ctx);
  });
  bot.action("CART", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    await showCart(ctx);
  });
  bot.action("ORDERS", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    await showOrders(ctx);
  });

  // Select/deselect dishes and change quantities.
  bot.action(/^TOGGLE_(\d+)$/, async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    const itemId = Number(ctx.match[1]);
    const cart = getCart(ctx.from.id);
    const existing = cart.find((item) => item.menu_item_id === itemId);
    setCartQuantity(ctx.from.id, itemId, existing ? 0 : 1);
    await showMenu(ctx);
  });

  bot.action(/^QTY_(\d+)_(PLUS|MINUS)$/, async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    const itemId = Number(ctx.match[1]);
    const operation = ctx.match[2];
    const item = getCart(ctx.from.id).find((food) => food.menu_item_id === itemId);
    if (!item) return showMenu(ctx);

    const quantity = operation === "PLUS" ? item.quantity + 1 : item.quantity - 1;
    setCartQuantity(ctx.from.id, itemId, quantity);
    await showMenu(ctx);
  });

  bot.action("NOOP", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
  });

  // Step 1: show the customer an order preview; the order is not saved yet.
  bot.action("CONFIRM", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    const items = getCart(ctx.from.id);
    if (items.length === 0) {
      return renderScreen(
        ctx,
        "🛒 ቅርጫትዎ ባዶ ነው።\n\nትዕዛዝ ከማስገባትዎ በፊት ምግብ ይምረጡ።",
        Markup.inlineKeyboard([[Markup.button.callback("📋 ምግብ ዝርዝር", "MENU")]])
      );
    }

    const total = items.reduce((sum, item) => sum + item.line_total_etb, 0);
    const lines = items.map(
      (item) => `• ${item.name} × ${item.quantity} — ${item.line_total_etb} ብር`
    );
    await renderScreen(
      ctx,
      `🧾 ትዕዛዝዎን ያረጋግጡ\n\n${lines.join("\n")}\n\n` +
      `💰 ጠቅላላ: ${total} ብር\n\nትዕዛዙን ያስገቡ?`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ አረጋግጥ", "PLACE_ORDER"),
          Markup.button.callback("❌ ሰርዝ", "CANCEL_ORDER"),
        ],
        [Markup.button.callback("✏️ ቅርጫት ቀይር", "CART")],
      ])
    );
  });

  // Step 2: save the order, notify the owner, then confirm to the customer.
  bot.action("PLACE_ORDER", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();
    const order = createOrder(ctx.from.id);
    if (!order) {
      return renderScreen(
        ctx,
        "🛒 ቅርጫትዎ ባዶ ነው። እባክዎ ምግቦችን እንደገና ይምረጡ።",
        Markup.inlineKeyboard([[Markup.button.callback("📋 ምግብ ዝርዝር", "MENU")]])
      );
    }

    const lines = order.items.map(
      (item) => `• ${item.name} × ${item.quantity} — ${item.line_total_etb} ብር`
    );
    const ownerMessage =
      `🔔 NEW FOOD ORDER #${order.orderId}\n\n` +
      `👤 Customer: ${ctx.from.first_name || "Customer"}\n` +
      `📱 Username: ${ctx.from.username ? "@" + ctx.from.username : "Not set"}\n` +
      `🆔 Customer ID: ${ctx.from.id}\n\n` +
      `🧾 ORDER DETAILS\n${lines.join("\n")}\n\n` +
      `💰 ጠቅላላ: ${order.totalEtb} ብር\n📌 ሁኔታ: በመጠባበቅ ላይ`;

    try {
      await bot.telegram.sendMessage(
        adminTelegramId,
        ownerMessage,
        Markup.inlineKeyboard([
          [
            Markup.button.callback("✅ Accept Order", `ADMIN_ACCEPT_${order.orderId}`),
            Markup.button.callback("❌ Reject Order", `ADMIN_REJECT_${order.orderId}`),
          ],
        ])
      );
    } catch (error) {
      console.error(
        `Order #${order.orderId} was saved, but owner notification failed:`,
        error.message
      );
    }

    await renderScreen(
      ctx,
      `🎉 ትዕዛዝዎ ተሳክቷል!\n\n🧾 የትዕዛዝ ቁጥር: #${order.orderId}\n\n` +
      `${lines.join("\n")}\n\n💰 ጠቅላላ: ${order.totalEtb} ብር\n📌 ሁኔታ: በመጠባበቅ ላይ`,
      mainMenu()
    );
  });

  // Cancel the checkout preview without placing an order.
  bot.action("CANCEL_ORDER", async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery("Order not placed.");
    await showCart(ctx);
  });

  // A customer can cancel only their own pending/accepted order.
  bot.action(/^CUSTOMER_CANCEL_(\d+)$/, async (ctx) => {
    if (await blockAdminFromCustomerFlow(ctx)) return;
    await ctx.answerCbQuery();

    const orderId = Number(ctx.match[1]);
    const order = getOrderById(orderId);
    if (!order || order.telegram_id !== ctx.from.id) {
      return ctx.reply("⚠️ That order was not found for your account.");
    }

    const changed = cancelCustomerOrder(orderId, ctx.from.id);
    if (!changed) {
      return renderScreen(
        ctx,
        `⚠️ Order #${orderId} can no longer be cancelled. Its current status is ${getOrderById(orderId)?.status || "unknown"}.`,
        Markup.inlineKeyboard([[Markup.button.callback("📦 My Orders", "ORDERS")]])
      );
    }

    try {
      await bot.telegram.sendMessage(
        adminTelegramId,
        `⚠️ CUSTOMER CANCELLED ORDER #${orderId}\n\n` +
        `👤 Customer: ${ctx.from.first_name || "Customer"}\n` +
        `💰 Total: ${order.total_etb} ETB\n` +
        "📌 Status: CANCELLED by customer"
      );
    } catch (error) {
      console.error(`Could not notify owner about order #${orderId} cancellation:`, error.message);
    }

    await renderScreen(ctx, `✅ Order #${orderId} has been cancelled.`, mainMenu());
  });
}

module.exports = { registerCustomerHandlers };
