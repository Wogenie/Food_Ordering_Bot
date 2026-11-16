const assert = require("node:assert/strict");
const test = require("node:test");
const { registerAdminHandlers } = require("../admin");
const { registerCustomerHandlers } = require("../customer");
const {
  BUSINESS_TIME_ZONE,
  formatLocalDateTime,
  getLocalDayRange,
} = require("../date-time");
const { initialMenu, legacyMenuTranslations } = require("../menu-data");

function createHarness() {
  const commands = new Map();
  const actions = [];
  const events = [];
  const sentMessages = [];
  const bot = {
    command(name, handler) {
      commands.set(name, handler);
    },
    start(handler) {
      commands.set("start", handler);
    },
    action(trigger, handler) {
      actions.push({ trigger, handler });
    },
    on(event, handler) {
      events.push({ event, handler });
    },
    telegram: {
      sendMessage: async (...args) => sentMessages.push(args),
      setMyCommands: async () => {},
    },
  };
  return { bot, commands, actions, events, sentMessages };
}

function createDatabase({ allAvailable = false } = {}) {
  const items = [
    { id: 1, name: "ዶሮ ወጥ", price_etb: 350, active: 1 },
    { id: 2, name: "ሽሮ በእንጀራ", price_etb: 180, active: allAvailable ? 1 : 0 },
  ];
  const order = {
    id: 32,
    telegram_id: 7,
    status: "pending",
    first_name: "Abuga",
    username: "WogenieL",
    created_at: "2026-10-27 23:29:56",
    total_etb: 1840,
    items: [{ name: "Doro Wat", quantity: 1, line_total_etb: 1840 }],
  };

  return {
    getAllMenuItems: () => items.map((item) => ({ ...item })),
    getMenu: () => items.filter((item) => item.active).map((item) => ({ ...item })),
    toggleMenuItemActive(id) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return null;
      item.active = item.active ? 0 : 1;
      return { ...item };
    },
    updateMenuItemPrice(id, priceEtb) {
      const item = items.find((entry) => entry.id === id);
      if (!item) return null;
      item.price_etb = priceEtb;
      return { ...item };
    },
    getOrderById: () => ({ ...order, items: order.items.map((item) => ({ ...item })) }),
    getAdminOrders: (statuses) => [
      { ...order, status: statuses?.[0] || order.status },
    ],
    getAdminSummary: () => ({
      total_orders: 0,
      pending: 0,
      accepted: 0,
      preparing: 0,
      ready: 0,
      delivered: 0,
      cancelled: 0,
      today_orders: 0,
      today_order_value: 0,
    }),
    updateOrderStatus(id, currentStatus, nextStatus) {
      if (id !== order.id || order.status !== currentStatus) return false;
      order.status = nextStatus;
      return true;
    },
    getCart: () => [],
    setCartQuantity: () => {},
    createOrder: () => null,
    getRecentOrders: () => [],
    cancelCustomerOrder: () => false,
  };
}

function createContext(userId) {
  const replies = [];
  const edits = [];
  const callbackAnswers = [];
  return {
    from: { id: userId, first_name: "Test Customer" },
    chat: { id: userId, type: "private" },
    replies,
    edits,
    callbackAnswers,
    reply: async (...args) => replies.push(args),
    editMessageText: async (...args) => edits.push(args),
    answerCbQuery: async (...args) => callbackAnswers.push(args),
  };
}

function createCallbackContext(userId, data, match = []) {
  const ctx = createContext(userId);
  ctx.callbackQuery = { data, message: {} };
  ctx.match = match;
  return ctx;
}

function registerHandlers(options) {
  const harness = createHarness();
  const database = createDatabase(options);
  registerAdminHandlers(harness.bot, database, 42);
  registerCustomerHandlers(harness.bot, database, 42);
  return { ...harness, database };
}

test("customer and owner commands are registered", () => {
  const { commands } = registerHandlers();
  for (const command of [
    "start",
    "menu",
    "cart",
    "orders",
    "admin",
    "pending",
    "active",
    "allorders",
    "today",
    "menuadmin",
    "cancelprice",
    "help",
  ]) {
    assert.ok(commands.has(command), `Missing /${command} handler`);
  }
});

test("owner menu command shows hide/show controls", async () => {
  const { commands } = registerHandlers();
  const ctx = createContext(42);

  await commands.get("menuadmin")(ctx);

  assert.match(ctx.replies[0][0], /የምግብ ዝርዝር አስተዳደር/);
  assert.match(ctx.replies[0][0], /የሚገኙ: 1 · የተደበቁ: 1/);
  const keyboard = ctx.replies[0][1].reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].text, "🟢 ደብቅ ዶሮ ወጥ");
  assert.equal(keyboard[0][0].callback_data, "ADMIN_MENU_TOGGLE_1_0");
  assert.equal(keyboard[1][0].text, "✏️ 350 ብር");
  assert.equal(keyboard[1][0].callback_data, "ADMIN_MENU_PRICE_1_0");
  assert.equal(keyboard[2][0].text, "⚪ አሳይ ሽሮ በእንጀራ");
  assert.equal(keyboard[3][0].text, "✏️ 180 ብር");
});

test("all dishes are available to customers and the owner by default", async () => {
  const { commands, database } = registerHandlers({ allAvailable: true });

  const customer = createContext(7);
  await commands.get("menu")(customer);
  const customerButtons = customer.replies[0][1].reply_markup.inline_keyboard
    .flat()
    .map((button) => button.text);
  assert.ok(customerButtons.some((text) => text.includes("ዶሮ ወጥ — 350 ብር")));
  assert.ok(customerButtons.some((text) => text.includes("ሽሮ በእንጀራ — 180 ብር")));
  assert.equal(database.getMenu().length, 2);

  const owner = createContext(42);
  await commands.get("menuadmin")(owner);
  assert.match(owner.replies[0][0], /የሚገኙ: 2 · የተደበቁ: 0/);
  const keyboard = owner.replies[0][1].reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].text, "🟢 ደብቅ ዶሮ ወጥ");
  assert.equal(keyboard[2][0].text, "🟢 ደብቅ ሽሮ በእንጀራ");
});

test("customer /start opens the menu directly", async () => {
  const { commands } = registerHandlers({ allAvailable: true });
  const customer = createContext(7);

  await commands.get("start")(customer);

  assert.match(customer.replies[0][0], /የፆም ምግቦች/);
  const dishes = customer.replies[0][1].reply_markup.inline_keyboard
    .flat()
    .filter((button) => button.callback_data?.startsWith("TOGGLE_"));
  assert.equal(dishes.length, 2);
});

test("customer can browse, build a cart, confirm an order, and view order history", async () => {
  const harness = createHarness();
  const menuItem = { id: 1, name: "ሽሮ ፈስስ", price_etb: 100 };
  let quantity = 0;
  let placedOrder = null;
  const database = {
    getMenu: () => [menuItem],
    getCart: () =>
      quantity
        ? [{
            menu_item_id: menuItem.id,
            name: menuItem.name,
            price_etb: menuItem.price_etb,
            quantity,
            line_total_etb: menuItem.price_etb * quantity,
          }]
        : [],
    setCartQuantity: (_userId, itemId, nextQuantity) => {
      assert.equal(itemId, menuItem.id);
      quantity = nextQuantity;
    },
    createOrder: () => {
      if (!quantity) return null;
      const items = database.getCart();
      placedOrder = { orderId: 77, totalEtb: 200, items };
      quantity = 0;
      return placedOrder;
    },
    getRecentOrders: () =>
      placedOrder
        ? [{
            id: placedOrder.orderId,
            status: "pending",
            total_etb: placedOrder.totalEtb,
            created_at: "2026-11-09 00:00:00",
          }]
        : [],
    getOrderById: () => null,
    cancelCustomerOrder: () => false,
  };
  registerCustomerHandlers(harness.bot, database, 42);

  const customer = createContext(7);
  await harness.commands.get("start")(customer);
  assert.match(customer.replies[0][0], /የፆም ምግቦች/);

  const selectDish = harness.actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^TOGGLE_(\\d+)$"
  );
  const increaseQuantity = harness.actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^QTY_(\\d+)_(PLUS|MINUS)$"
  );
  const confirm = harness.actions.find(({ trigger }) => trigger === "CONFIRM");
  const placeOrder = harness.actions.find(({ trigger }) => trigger === "PLACE_ORDER");
  assert.ok(selectDish && increaseQuantity && confirm && placeOrder);

  await selectDish.handler(createCallbackContext(7, "TOGGLE_1", ["TOGGLE_1", "1"]));
  await increaseQuantity.handler(
    createCallbackContext(7, "QTY_1_PLUS", ["QTY_1_PLUS", "1", "PLUS"])
  );
  const cart = createContext(7);
  await harness.commands.get("cart")(cart);
  assert.match(cart.replies[0][0], /ሽሮ ፈስስ × 2 — 200 ብር/);

  const preview = createCallbackContext(7, "CONFIRM");
  await confirm.handler(preview);
  assert.match(preview.edits[0][0], /ትዕዛዝዎን ያረጋግጡ/);
  assert.equal(placedOrder, null, "Previewing should not create an order");

  const checkout = createCallbackContext(7, "PLACE_ORDER");
  await placeOrder.handler(checkout);
  assert.match(checkout.edits[0][0], /የትዕዛዝ ቁጥር: #77/);
  assert.equal(harness.sentMessages.length, 1, "The owner should be notified");
  assert.equal(harness.sentMessages[0][0], 42);
  assert.equal(quantity, 0, "Checkout should clear the customer's cart");

  const history = createContext(7);
  await harness.commands.get("orders")(history);
  assert.match(history.replies[0][0], /Order #77/);
  assert.match(history.replies[0][0], /Waiting for restaurant/);
});

test("admin dashboard and today report render current summary and navigation", async () => {
  const { commands, actions } = registerHandlers();
  const admin = createContext(42);
  await commands.get("admin")(admin);

  assert.match(admin.replies[0][0], /ABE FOOD — ADMIN PANEL/);
  assert.match(admin.replies[0][0], /All-time orders: 0/);
  const dashboardButtons = admin.replies[0][1].reply_markup.inline_keyboard.flat();
  assert.ok(dashboardButtons.some((button) => button.callback_data === "ADMIN_PENDING"));
  assert.ok(dashboardButtons.some((button) => button.callback_data === "ADMIN_TODAY"));

  const todayAction = actions.find(({ trigger }) => trigger === "ADMIN_TODAY");
  assert.ok(todayAction, "Missing dashboard Today button");
  const today = createCallbackContext(42, "ADMIN_TODAY");
  await todayAction.handler(today);
  assert.match(today.edits[0][0], /Africa\/Addis_Ababa time/);
  assert.match(today.edits[0][0], /Orders placed today: 0/);
  assert.ok(today.edits[0][1].reply_markup.inline_keyboard.flat()
    .some((button) => button.callback_data === "ADMIN_DASHBOARD"));
});

test("admin pending, active, and recent order views render order actions", async () => {
  const { commands } = registerHandlers();
  const views = [
    ["pending", "PENDING ORDERS", "ADMIN_ACCEPT_32"],
    ["active", "ACTIVE ORDERS", "ADMIN_ADVANCE_32"],
    ["allorders", "RECENT ORDERS", "ADMIN_ACCEPT_32"],
  ];

  for (const [command, title, actionData] of views) {
    const admin = createContext(42);
    await commands.get(command)(admin);
    assert.match(admin.replies[0][0], new RegExp(title));
    assert.match(admin.replies[0][0], /Customer: Abuga \(@WogenieL\)/);
    const buttons = admin.replies[0][1].reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some((button) => button.callback_data === actionData));
    assert.ok(buttons.some((button) => button.callback_data === "ADMIN_DASHBOARD"));
  }
});

test("non-owner cannot open either dashboard", async () => {
  const { commands, actions } = registerHandlers();
  const customer = createContext(7);
  await commands.get("admin")(customer);
  assert.match(customer.replies[0][0], /not authorized/i);

  const pendingAction = actions.find(({ trigger }) => trigger === "ADMIN_PENDING");
  const unauthorizedCallback = createCallbackContext(7, "ADMIN_PENDING");
  await pendingAction.handler(unauthorizedCallback);
  assert.equal(unauthorizedCallback.edits.length, 0);
  assert.equal(unauthorizedCallback.callbackAnswers.length, 1);
});

test("only the owner can hide or show menu items", async () => {
  const { actions, database } = registerHandlers();
  const route = actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^ADMIN_MENU_TOGGLE_(\\d+)_(\\d+)$"
  );
  assert.ok(route, "Missing menu toggle action");

  const unauthorized = createContext(7);
  unauthorized.match = ["ADMIN_MENU_TOGGLE_1_0", "1", "0"];
  await route.handler(unauthorized);
  assert.equal(database.getMenu().length, 1);
  assert.equal(unauthorized.callbackAnswers.length, 1);

  const owner = createContext(42);
  owner.match = ["ADMIN_MENU_TOGGLE_1_0", "1", "0"];
  await route.handler(owner);
  assert.equal(database.getMenu().length, 0);
  assert.match(owner.callbackAnswers[0][0], /አሁን ተደብቋል/);
});

test("owner can change a menu price from Telegram", async () => {
  const { actions, commands, events, database } = registerHandlers();
  const priceAction = actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^ADMIN_MENU_PRICE_(\\d+)_(\\d+)$"
  );
  const textHandler = events.find(({ event }) => event === "text")?.handler;
  assert.ok(priceAction, "Missing menu price action");
  assert.ok(textHandler, "Missing menu price text handler");

  const unauthorized = createContext(7);
  unauthorized.match = ["ADMIN_MENU_PRICE_1_0", "1", "0"];
  await priceAction.handler(unauthorized);
  assert.equal(unauthorized.replies.length, 0);
  assert.equal(unauthorized.callbackAnswers.length, 1);

  const owner = createContext(42);
  owner.match = ["ADMIN_MENU_PRICE_1_0", "1", "0"];
  await priceAction.handler(owner);
  assert.match(owner.replies[0][0], /አዲሱን ዋጋ/);

  const priceReply = createContext(42);
  priceReply.message = { text: "275" };
  await textHandler(priceReply);
  assert.equal(database.getAllMenuItems()[0].price_etb, 275);
  assert.match(priceReply.replies[0][0], /አዲስ ዋጋ: 275 ብር/);
  assert.match(priceReply.replies[0][0], /የቀድሞ ትዕዛዞች ዋጋ/);

  const reopenMenu = actions.find(({ trigger }) => trigger === "ADMIN_MENU");
  assert.ok(reopenMenu, "Missing menu management button action");
  await reopenMenu.handler({
    ...createContext(42),
    callbackQuery: { data: "ADMIN_MENU" },
  });
});

test("owner price prompt rejects invalid prices and can be cancelled", async () => {
  const { actions, commands, events } = registerHandlers();
  const priceAction = actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^ADMIN_MENU_PRICE_(\\d+)_(\\d+)$"
  );
  const textHandler = events.find(({ event }) => event === "text")?.handler;

  const owner = createContext(42);
  owner.match = ["ADMIN_MENU_PRICE_1_0", "1", "0"];
  await priceAction.handler(owner);

  const invalidReply = createContext(42);
  invalidReply.message = { text: "12.5" };
  await textHandler(invalidReply);
  assert.match(invalidReply.replies[0][0], /አዎንታዊ ሙሉ ቁጥር/);

  const cancel = createContext(42);
  await commands.get("cancelprice")(cancel);
  assert.match(cancel.replies[0][0], /cancelled/i);
});

test("no registered customer action starts a payment flow", () => {
  const { actions } = registerHandlers();
  const patterns = actions.map(({ trigger }) => String(trigger));
  assert.ok(!patterns.some((pattern) => /PAY_|CHAPA|TELEBIRR/i.test(pattern)));
});

test("admin can advance an order through preparation, ready, and delivery", async () => {
  const { actions, sentMessages, database } = registerHandlers();
  const owner = createContext(42);
  const accept = actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^ADMIN_ACCEPT_(\\d+)$"
  );
  const advance = actions.find(({ trigger }) =>
    trigger instanceof RegExp && trigger.source === "^ADMIN_ADVANCE_(\\d+)$"
  );
  assert.ok(accept, "Missing accept-order action");
  assert.ok(advance, "Missing advance-order action");

  owner.match = ["ADMIN_ACCEPT_32", "32"];
  await accept.handler(owner);
  assert.equal(sentMessages.length, 0, "Accepting should not send a customer message");

  const notifications = [];
  for (const expected of ["preparing", "ready", "delivered"]) {
    owner.match = ["ADMIN_ADVANCE_32", "32"];
    owner.callbackQuery = { data: "ADMIN_ADVANCE_32", message: {} };
    owner.edits.length = 0;
    await advance.handler(owner);
    assert.match(owner.edits[0][0], new RegExp(`Status: .*${expected}`, "i"));
    notifications.push(sentMessages.at(-1)[1]);
  }

  assert.equal(database.getOrderById(32).status, "delivered");
  assert.equal(sentMessages.length, 3);
  assert.equal(
    notifications[0],
    "👨‍🍳 Your ordered food #32 is now being prepared.\n\n" +
      "💰 Total: 1840 ETB\n\n" +
      "The restaurant will let you know when it is ready."
  );
  assert.match(notifications[1], /is ready/);
  assert.match(notifications[2], /has been delivered/);
});

test("admin orders include customer usernames and local created-at time", async () => {
  const { commands } = registerHandlers();
  const ctx = createContext(42);
  const expectedLocalDate = formatLocalDateTime("2026-10-27 23:29:56");

  await commands.get("pending")(ctx);

  assert.match(ctx.replies[0][0], /Customer: Abuga \(@WogenieL\)/);
  assert.ok(ctx.replies[0][0].includes(`Created: ${expectedLocalDate}`));
});

test("today summary uses the business timezone rather than the host timezone", () => {
  const now = new Date("2026-11-08T22:00:00Z");
  const [startUtc, endUtc] = getLocalDayRange(now, "Africa/Addis_Ababa");

  assert.equal(startUtc, "2026-11-08 21:00:00");
  assert.equal(endUtc, "2026-11-09 21:00:00");
  assert.equal(BUSINESS_TIME_ZONE, "Africa/Addis_Ababa");
});

test("order timestamps display in the business timezone", () => {
  assert.equal(
    formatLocalDateTime("2026-11-08 21:00:00", "Africa/Addis_Ababa"),
    "2026-11-09 00:00:00"
  );
});

test("business day range handles a daylight-saving transition", () => {
  const now = new Date("2026-03-29T12:00:00Z");
  const [startUtc, endUtc] = getLocalDayRange(now, "Europe/London");

  assert.equal(startUtc, "2026-03-29 00:00:00");
  assert.equal(endUtc, "2026-03-29 23:00:00");
});

test("the configured menu matches all supplied Amharic dishes and prices", () => {
  assert.equal(initialMenu.length, 22);
  assert.deepEqual(initialMenu.map(([name, , price]) => [name, price]), [
    ["በቃልህ", 150],
    ["ሽሮ ፈስስ", 130],
    ["ተጋቢና", 160],
    ["ፓስታ በክትክት", 150],
    ["ፓስታ በሳር", 150],
    ["ቲስቴ በፓስታ", 160],
    ["ሀፍ ሀፍ", 160],
    ["ቲስቴ ጥብስ", 160],
    ["ቲስቴ ወጥ", 160],
    ["ቲስቴ በአልጫ", 160],
    ["ፍርፍር", 120],
    ["ድርቆሽ ፍርፍር", 150],
    ["ጎመን ጥብስ", 160],
    ["ድንች ወጥ", 130],
    ["ምስር ወጥ", 150],
    ["መክረኒ በሳልስ", 150],
    ["መክረኒ በክትክት", 150],
    ["ድንች ሰላጣ", 180],
    ["አብካይ", 230],
    ["እፋዝ በክትክት", 150],
    ["ቲማቲም ለብ ለብ", 130],
    ["ቲማቲም ሳልስ", 130],
  ]);
  assert.deepEqual(legacyMenuTranslations, [
    ["Doro Wat with Injera", "ዶሮ ወጥ"],
    ["Shiro with Injera", "ሽሮ በእንጀራ"],
    ["Tibs with Injera", "ጥብስ በእንጀራ"],
    ["Beyaynetu", "በያይነቱ"],
    ["Kitfo", "ክትፎ"],
  ]);
});
