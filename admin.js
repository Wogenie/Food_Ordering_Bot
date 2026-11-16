
const { Markup } = require("telegraf");
const {
  BUSINESS_TIME_ZONE,
  formatLocalDateTime,
} = require("./date-time");

const pendingMenuPriceEdits = new Map();

function isAwaitingMenuPrice(telegramId, chatId) {
  const pending = pendingMenuPriceEdits.get(telegramId);
  return Boolean(pending && pending.chatId === chatId);
}

// Restaurant lifecycle:
// pending -> accepted -> preparing -> ready -> delivered
// pending can also become cancelled.
function registerAdminHandlers(
  bot,
  database,
  adminTelegramId
) {
  const {
    getOrderById,
    getAdminOrders,
    getAdminSummary,
    getAllMenuItems,
    toggleMenuItemActive,
    updateMenuItemPrice,
    updateOrderStatus,
  } = database;

  const nextStatus = {
    accepted: "preparing",
    preparing: "ready",
    ready: "delivered",
  };

  const statusLabels = {
    pending: "⏳ Pending",
    accepted: "✅ Accepted",
    preparing: "👨‍🍳 Preparing",
    ready: "🍽️ Ready",
    delivered: "🚚 Delivered",
    cancelled: "❌ Cancelled",
  };

  function isAdmin(ctx) {
    return ctx.from?.id === adminTelegramId;
  }

  async function authorizeCallback(ctx) {
    if (isAdmin(ctx)) return true;

    await ctx.answerCbQuery(
      "⛔ You are not authorized.",
      { show_alert: true }
    );

    return false;
  }

  async function renderAdminScreen(ctx, message, keyboard) {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(message, keyboard);
        return;
      } catch (error) {
        if (
          error.description?.includes("message is not modified")
        ) {
          return;
        }

        console.error(
          "Could not edit admin message:",
          error.description || error.message
        );
      }
    }

    await ctx.reply(message, keyboard);
  }

  function dashboardKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("⏳ Pending", "ADMIN_PENDING"),
        Markup.button.callback("✅ Accepted", "ADMIN_ACTIVE"),
      ],
      [
        Markup.button.callback("📦 Recent", "ADMIN_RECENT"),
        Markup.button.callback("📊 Today", "ADMIN_TODAY"),
      ],
      [Markup.button.callback("🍽️ Manage Menu", "ADMIN_MENU")],
      [
        Markup.button.callback("🔄 Refresh", "ADMIN_DASHBOARD"),
      ],
    ]);
  }

  async function showDashboard(ctx) {
    const summary = getAdminSummary();

    const message =
      "👨‍🍳 ABE FOOD — ADMIN PANEL\n\n" +
      `⏳ Pending: ${summary.pending || 0}\n` +
      `✅ Accepted: ${summary.accepted || 0}\n` +
      `👨‍🍳 Preparing: ${summary.preparing || 0}\n` +
      `🍽️ Ready: ${summary.ready || 0}\n` +
      `🚚 Delivered: ${summary.delivered || 0}\n` +
      `❌ Cancelled: ${summary.cancelled || 0}\n\n` +
      `📦 All-time orders: ${summary.total_orders || 0}\n\n` +
      "Choose an action below.";

    await renderAdminScreen(
      ctx,
      message,
      dashboardKeyboard()
    );
  }

  // Buttons depend on the order's current status.
  function actionButtonsFor(order) {
    if (order.status === "pending") {
      return [
        Markup.button.callback(
          `✅ Accept #${order.id}`,
          `ADMIN_ACCEPT_${order.id}`
        ),
        Markup.button.callback(
          `❌ Reject #${order.id}`,
          `ADMIN_REJECT_${order.id}`
        ),
      ];
    }

    if (nextStatus[order.status]) {
      const labels = {
        accepted: "👨‍🍳 Start Preparing",
        preparing: "🍽️ Mark Ready",
        ready: "🚚 Mark Delivered",
      };

      return [
        Markup.button.callback(
          `${labels[order.status]} #${order.id}`,
          `ADMIN_ADVANCE_${order.id}`
        ),
      ];
    }

    return [];
  }

  function describeOrder(order) {
    const customer = describeCustomer(order);

    return (
      `📦 Order #${order.id}\n` +
      `👤 Customer: ${customer}\n` +
      `📌 Status: ${statusLabels[order.status] || order.status}\n` +
      `💰 Total: ${order.total_etb} ETB\n` +
      `🕒 Created: ${formatLocalDateTime(order.created_at)}`
    );
  }

  function describeCustomer(order) {
    const name = order.first_name || "Customer";
    const account = order.username
      ? `@${order.username}`
      : `No username · ID ${order.telegram_id}`;
    return `${name} (${account})`;
  }

  async function showOrderList(ctx, title, statuses = null) {
    const orders = getAdminOrders(statuses, 10);
    const keyboard = [];
    const lines = [];

    for (const order of orders) {
      lines.push(describeOrder(order));

      const actions = actionButtonsFor(order);

      if (actions.length) {
        keyboard.push(actions);
      }

      keyboard.push([
        Markup.button.callback(
          `🔍 View #${order.id}`,
          `ADMIN_VIEW_${order.id}`
        ),
      ]);
    }

    let refreshAction = "ADMIN_RECENT";

    if (statuses?.length === 1 && statuses[0] === "pending") {
      refreshAction = "ADMIN_PENDING";
    } else if (
      statuses &&
      statuses.every((status) =>
        ["accepted", "preparing", "ready"].includes(status)
      )
    ) {
      refreshAction = "ADMIN_ACTIVE";
    }

    keyboard.push([
      Markup.button.callback("🔄 Refresh", refreshAction),
    ]);

    keyboard.push([
      Markup.button.callback("⬅️ Dashboard", "ADMIN_DASHBOARD"),
    ]);

    const body = orders.length
      ? lines.join("\n\n────────────────────\n\n")
      : "❌ No orders found for this view.";

    await renderAdminScreen(
      ctx,
      `👨‍🍳 ${title}\n\n${body}`,
      Markup.inlineKeyboard(keyboard)
    );
  }

  async function showTodaySummary(ctx) {
    const summary = getAdminSummary();

    const message =
      "📊 ABE FOOD — TODAY'S SUMMARY\n" +
      `(${BUSINESS_TIME_ZONE} time)\n\n` +
      `🧾 Orders placed today: ${summary.today_orders || 0}\n` +
      `💰 Value of non-cancelled orders: ${summary.today_order_value || 0} ETB\n\n` +
      `⏳ Pending now: ${summary.pending || 0}\n` +
      `✅ Accepted now: ${summary.accepted || 0}\n` +
      `👨‍🍳 Preparing now: ${summary.preparing || 0}\n` +
      `🍽️ Ready now: ${summary.ready || 0}\n` +
      `🚚 Delivered total: ${summary.delivered || 0}\n\n` +
      "📌 Order value is a summary, not an accounting report.";

    await renderAdminScreen(
      ctx,
      message,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Refresh", "ADMIN_TODAY"),
        ],
        [
          Markup.button.callback("⬅️ Dashboard", "ADMIN_DASHBOARD"),
        ],
      ])
    );
  }

  async function showMenuManagement(ctx, page = 0) {
    const items = getAllMenuItems();
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
    const start = currentPage * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    const activeCount = items.filter((item) => item.active).length;
    const hiddenCount = items.length - activeCount;
    const keyboard = [];
    for (const item of pageItems) {
      keyboard.push([
        Markup.button.callback(
          `${item.active ? "🟢 ደብቅ" : "⚪ አሳይ"} ${item.name}`,
          `ADMIN_MENU_TOGGLE_${item.id}_${currentPage}`
        ),
      ]);
      keyboard.push([
        Markup.button.callback(
          `✏️ ${item.price_etb} ብር`,
          `ADMIN_MENU_PRICE_${item.id}_${currentPage}`
        ),
      ]);
    }

    if (pageCount > 1) {
      const navigation = [];
      if (currentPage > 0) {
        navigation.push(
          Markup.button.callback("⬅️ ቀዳሚ", `ADMIN_MENU_PAGE_${currentPage - 1}`)
        );
      }
      if (currentPage < pageCount - 1) {
        navigation.push(
          Markup.button.callback("ቀጣይ ➡️", `ADMIN_MENU_PAGE_${currentPage + 1}`)
        );
      }
      keyboard.push(navigation);
    }

    keyboard.push([
      Markup.button.callback("🔄 አድስ", `ADMIN_MENU_PAGE_${currentPage}`),
      Markup.button.callback("⬅️ ዋና ገጽ", "ADMIN_DASHBOARD"),
    ]);

    const lines = pageItems.map(
      (item) => `${item.active ? "🟢 ይገኛል" : "⚪ ተደብቋል"} · ${item.name} — ${item.price_etb} ብር`
    );
    const message =
      `🍽️ የምግብ ዝርዝር አስተዳደር\n\n` +
      `የሚገኙ: ${activeCount} · የተደበቁ: ${hiddenCount}\n` +
      `${lines.length ? `\n${lines.join("\n")}\n` : "\nምንም ምግብ አልተጨመረም።\n"}` +
      "\nምግቡን ለመደበቅ ወይም ለማሳየት የምግቡን ቁልፍ ይጠቀሙ። ዋጋውን ለመቀየር ✏️ ይንኩ።" +
      (pageCount > 1 ? `\nገጽ ${currentPage + 1} / ${pageCount}` : "");

    await renderAdminScreen(ctx, message, Markup.inlineKeyboard(keyboard));
  }

  // Notify customers when their orders change status.
  async function notifyCustomer(order, status) {
    if (status === "accepted") return;

    const orderName = `Abe Food order #${order.id}`;

    const messages = {
      preparing:
        `👨‍🍳 Your ordered food #${order.id} is now being prepared.\n\n` +
        `💰 Total: ${order.total_etb} ETB\n\n` +
        "The restaurant will let you know when it is ready.",

      ready:
        `🍽️ Your ${orderName} is ready!`,

      delivered:
        `🚚 Your ${orderName} has been delivered.\n\n` +
        "Thank you for ordering with Abe Food!",

      cancelled:
        `❌ Your ${orderName} has been cancelled by the restaurant.`,
    };

    try {
      await bot.telegram.sendMessage(
        order.telegram_id,
        messages[status]
      );
    } catch (error) {
      console.error(
        `Could not notify customer for order #${order.id}:`,
        error.message
      );
    }
  }

  async function showUpdatedOrder(ctx, order, note) {
    const current = getOrderById(order.id);

    if (!current) {
      return renderAdminScreen(
        ctx,
        "⚠️ Order not found.",
        dashboardKeyboard()
      );
    }

    const actions = actionButtonsFor(current);
    const keyboard = actions.map((button) => [button]);

    keyboard.push([
      Markup.button.callback(
        "📦 Pending Orders",
        "ADMIN_PENDING"
      ),
    ]);

    keyboard.push([
      Markup.button.callback(
        "⬅️ Admin Dashboard",
        "ADMIN_DASHBOARD"
      ),
    ]);

    const items = (current.items || [])
      .map(
        (item) =>
          `• ${item.name} × ${item.quantity} — ` +
          `${item.line_total_etb} ETB`
      )
      .join("\n");

    const message =
      `${note}\n\n` +
      `📦 Order #${current.id}\n` +
      `👤 Customer: ${describeCustomer(current)}\n` +
      `📌 Status: ${statusLabels[current.status] || current.status}\n\n` +
      `${items || "No order items found."}\n\n` +
      `💰 Total: ${current.total_etb} ETB\n` +
      `🕒 Created: ${formatLocalDateTime(current.created_at)}`;

    await renderAdminScreen(
      ctx,
      message,
      Markup.inlineKeyboard(keyboard)
    );
  }

  async function handleDecision(ctx, orderId, next) {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();

    const order = getOrderById(orderId);

    if (!order) {
      return renderAdminScreen(
        ctx,
        "⚠️ Order not found.",
        dashboardKeyboard()
      );
    }

    const expectedCurrent = "pending";
    const changed = updateOrderStatus(
      orderId,
      expectedCurrent,
      next
    );

    const updatedOrder = getOrderById(orderId);

    if (!changed) {
      return renderAdminScreen(
        ctx,
        `⚠️ Order #${orderId} has already changed.\n` +
        `Current status: ${updatedOrder?.status || "unknown"}`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "⬅️ Admin Dashboard",
              "ADMIN_DASHBOARD"
            ),
          ],
        ])
      );
    }

    await notifyCustomer(updatedOrder, next);

    const note =
      next === "accepted"
        ? "✅ Order accepted. Start preparing when the kitchen is ready."
        : "❌ Order rejected and cancelled.";

    await showUpdatedOrder(ctx, updatedOrder, note);
  }

  async function handleAdvance(ctx, orderId) {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();

    const order = getOrderById(orderId);

    if (!order) {
      return renderAdminScreen(
        ctx,
        "⚠️ Order not found.",
        dashboardKeyboard()
      );
    }

    const next = nextStatus[order.status];

    if (!next) {
      return renderAdminScreen(
        ctx,
        `ℹ️ Order #${orderId} is already at a final status: ${order.status}.`,
        dashboardKeyboard()
      );
    }

    const changed = updateOrderStatus(
      orderId,
      order.status,
      next
    );

    const updatedOrder = getOrderById(orderId);

    if (!changed) {
      return renderAdminScreen(
        ctx,
        `⚠️ Order #${orderId} was updated elsewhere.\n` +
        `Current status: ${updatedOrder?.status || "unknown"}.`,
        dashboardKeyboard()
      );
    }

    await notifyCustomer(updatedOrder, next);

    const notes = {
      preparing: "👨‍🍳 Order moved to PREPARING.",
      ready: "🍽️ Order marked READY.",
      delivered: "🚚 Order marked DELIVERED.",
    };

    await showUpdatedOrder(
      ctx,
      updatedOrder,
      notes[next]
    );
  }

  // -------------------- OWNER COMMANDS --------------------

  bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply(
        "⛔ You are not authorized to access admin tools."
      );
    }

    await showDashboard(ctx);
  });

  bot.command("pending", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    await showOrderList(
      ctx,
      "PENDING ORDERS",
      ["pending"]
    );
  });

  bot.command("active", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    await showOrderList(
      ctx,
      "ACTIVE ORDERS",
      ["accepted", "preparing", "ready"]
    );
  });

  bot.command("allorders", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    await showOrderList(ctx, "RECENT ORDERS");
  });

  bot.command("today", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    await showTodaySummary(ctx);
  });

  bot.command("menuadmin", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    await showMenuManagement(ctx);
  });

  bot.command("cancelprice", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply("⛔ You are not authorized.");
    }

    pendingMenuPriceEdits.delete(ctx.from.id);
    await ctx.reply("Price change cancelled.", Markup.inlineKeyboard([
      [Markup.button.callback("🍽️ Back to Menu Management", "ADMIN_MENU")],
    ]));
  });

  bot.command("help", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply(
        "⛔ You are not authorized to access admin tools."
      );
    }

    await ctx.reply(
      "👨‍🍳 ABE FOOD — ADMIN COMMANDS\n\n" +
      "/admin — dashboard\n" +
      "/pending — pending orders to accept/reject\n" +
      "/active — accepted, preparing, and ready orders\n" +
      "/allorders — recent orders of every status\n" +
      "/today — today's summary\n" +
      "/menuadmin — manage menu availability and prices\n" +
      "/cancelprice — cancel a price update prompt\n" +
      "/help — show this help"
    );
  });

  // -------------------- DASHBOARD BUTTONS --------------------

  bot.action("ADMIN_DASHBOARD", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showDashboard(ctx);
  });

  bot.action("ADMIN_PENDING", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showOrderList(
      ctx,
      "PENDING ORDERS",
      ["pending"]
    );
  });

  bot.action("ADMIN_ACTIVE", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showOrderList(
      ctx,
      "ACTIVE ORDERS",
      ["accepted", "preparing", "ready"]
    );
  });

  bot.action("ADMIN_RECENT", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showOrderList(ctx, "RECENT ORDERS");
  });

  bot.action("ADMIN_TODAY", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showTodaySummary(ctx);
  });

  bot.action("ADMIN_MENU", async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showMenuManagement(ctx);
  });

  bot.action(/^ADMIN_MENU_PAGE_(\d+)$/, async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();
    await showMenuManagement(ctx, Number(ctx.match[1]));
  });

  bot.action(/^ADMIN_MENU_TOGGLE_(\d+)_(\d+)$/, async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    const itemId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const item = toggleMenuItemActive(itemId);

    if (!item) {
      await ctx.answerCbQuery("ይህ ምግብ አሁን የለም።", { show_alert: true });
      return showMenuManagement(ctx, page);
    }

    await ctx.answerCbQuery(
      `${item.name} ${item.active ? "አሁን ይገኛል።" : "አሁን ተደብቋል።"}`
    );
    await showMenuManagement(ctx, page);
  });

  bot.action(/^ADMIN_MENU_PRICE_(\d+)_(\d+)$/, async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    const itemId = Number(ctx.match[1]);
    const page = Number(ctx.match[2]);
    const item = getAllMenuItems().find((menuItem) => menuItem.id === itemId);
    if (!item) {
      await ctx.answerCbQuery("ይህ ምግብ አሁን የለም።", { show_alert: true });
      return showMenuManagement(ctx, page);
    }

    await ctx.answerCbQuery();
    pendingMenuPriceEdits.set(ctx.from.id, {
      itemId,
      chatId: ctx.chat.id,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    await ctx.reply(
      `ለ${item.name} አዲሱን ዋጋ በሙሉ ቁጥር በብር ይላኩ።\n` +
      `ያለው ዋጋ: ${item.price_etb} ብር\n\n` +
      "ለመሰረዝ /cancelprice ይጠቀሙ። ይህ ጥያቄ ከ5 ደቂቃ በኋላ ያበቃል።",
      Markup.forceReply()
    );
  });

  bot.on("text", async (ctx) => {
    if (!isAdmin(ctx) || ctx.chat?.type !== "private") return;

    const pending = pendingMenuPriceEdits.get(ctx.from.id);
    if (!pending || pending.chatId !== ctx.chat.id) return;

    if (Date.now() > pending.expiresAt) {
      pendingMenuPriceEdits.delete(ctx.from.id);
      return ctx.reply("የዋጋ ጥያቄው ጊዜ አልፎበታል። እንደገና ለመጀመር /menuadmin ይጠቀሙ።");
    }

    const input = ctx.message.text.trim();
    if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input))) {
      return ctx.reply("ትክክለኛ አዎንታዊ ሙሉ ቁጥር ዋጋ በብር ያስገቡ፣ ወይም /cancelprice ይጠቀሙ።");
    }

    const item = updateMenuItemPrice(pending.itemId, Number(input));
    pendingMenuPriceEdits.delete(ctx.from.id);
    if (!item) {
      return ctx.reply("ይህ ምግብ አሁን የለም። ዝርዝሩን ለማደስ /menuadmin ይጠቀሙ።");
    }

    await ctx.reply(
      `✅ ዋጋው ተቀይሯል\n\n🍽️ ${item.name}\n💰 አዲስ ዋጋ: ${item.price_etb} ብር\n\n` +
      "ይህ ዋጋ ለአዲስ ትዕዛዞች ይሠራል። የቀድሞ ትዕዛዞች ዋጋ አይቀየርም።",
      Markup.inlineKeyboard([
        [Markup.button.callback("🍽️ ወደ ምግብ ዝርዝር ተመለስ", "ADMIN_MENU")],
      ])
    );
  });

  bot.action(/^ADMIN_VIEW_(\d+)$/, async (ctx) => {
    if (!(await authorizeCallback(ctx))) return;

    await ctx.answerCbQuery();

    const order = getOrderById(Number(ctx.match[1]));

    if (!order) {
      return renderAdminScreen(
        ctx,
        "⚠️ Order not found.",
        dashboardKeyboard()
      );
    }

    await showUpdatedOrder(ctx, order, "📦 Order details");
  });

  // -------------------- ORDER STATUS BUTTONS --------------------

  bot.action(/^ADMIN_ACCEPT_(\d+)$/, async (ctx) => {
    await handleDecision(
      ctx,
      Number(ctx.match[1]),
      "accepted"
    );
  });

  bot.action(/^ADMIN_REJECT_(\d+)$/, async (ctx) => {
    await handleDecision(
      ctx,
      Number(ctx.match[1]),
      "cancelled"
    );
  });

  bot.action(/^ADMIN_ADVANCE_(\d+)$/, async (ctx) => {
    await handleAdvance(
      ctx,
      Number(ctx.match[1])
    );
  });

  // -------------------- OWNER COMMAND MENU --------------------

  bot.telegram.setMyCommands(
    [
      { command: "admin", description: "Open admin dashboard" },
      { command: "pending", description: "View pending orders" },
      { command: "active", description: "View active orders" },
      { command: "allorders", description: "View recent orders" },
      { command: "today", description: "Today's order summary" },
      { command: "menuadmin", description: "Manage menu and prices" },
      { command: "cancelprice", description: "Cancel a menu price update" },
      { command: "help", description: "Admin help" },
    ],
    {
      scope: {
        type: "chat",
        chat_id: adminTelegramId,
      },
    }
  ).catch((error) => {
    console.error(
      "Could not register owner commands:",
      error.message
    );
  });
}

module.exports = { registerAdminHandlers, isAwaitingMenuPrice };
