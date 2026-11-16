const Database = require("better-sqlite3");
const path = require("node:path");
const { getLocalDayRange } = require("./date-time");
const { initialMenu, legacyMenuTranslations } = require("./menu-data");

// -------------------- DATABASE CONNECTION --------------------
const db = new Database(path.join(__dirname, "food-orders.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// -------------------- TABLES --------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    telegram_id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    username TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    price_etb INTEGER NOT NULL CHECK (price_etb >= 0),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    telegram_id INTEGER NOT NULL
      REFERENCES customers(telegram_id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    PRIMARY KEY (telegram_id, menu_item_id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL REFERENCES customers(telegram_id),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'preparing', 'ready', 'delivered', 'cancelled')),
    total_etb INTEGER NOT NULL CHECK (total_etb >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
    item_name TEXT NOT NULL,
    unit_price_etb INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    line_total_etb INTEGER NOT NULL
  );
`);

db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const insertMenuItem = db.prepare(`
    INSERT OR IGNORE INTO menu_items (name, description, price_etb)
    VALUES (?, ?, ?)
  `);
  for (const item of initialMenu) insertMenuItem.run(...item);

  const renameLegacyMenuItem = db.prepare(`
    UPDATE menu_items SET name = ? WHERE name = ?
  `);
  for (const [englishName, amharicName] of legacyMenuTranslations) {
    renameLegacyMenuItem.run(amharicName, englishName);
  }

  const enableAllMenuItemsMigration = db.prepare(`
    INSERT OR IGNORE INTO app_migrations (migration_id)
    VALUES ('enable_all_existing_menu_items')
  `).run();
  if (enableAllMenuItemsMigration.changes === 1) {
    db.prepare("UPDATE menu_items SET active = 1").run();
  }
})();

// -------------------- CUSTOMER AND MENU DATA --------------------
function upsertCustomer(customer) {
  return db.prepare(`
    INSERT INTO customers (telegram_id, first_name, username)
    VALUES (@telegram_id, @first_name, @username)
    ON CONFLICT(telegram_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username
  `).run(customer);
}

function getMenu() {
  return db.prepare(`
    SELECT id, name, description, price_etb
    FROM menu_items
    WHERE active = 1
    ORDER BY id
  `).all();
}

function getAllMenuItems() {
  return db.prepare(`
    SELECT id, name, description, price_etb, active
    FROM menu_items
    ORDER BY id
  `).all();
}

const toggleMenuItemActive = db.transaction((itemId) => {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error("Menu item ID must be a positive integer.");
  }

  const item = db.prepare(`
    SELECT id, active FROM menu_items WHERE id = ?
  `).get(itemId);
  if (!item) return null;

  const active = item.active ? 0 : 1;
  db.prepare("UPDATE menu_items SET active = ? WHERE id = ?").run(active, itemId);

  if (!active) {
    db.prepare("DELETE FROM cart_items WHERE menu_item_id = ?").run(itemId);
  }

  return db.prepare(`
    SELECT id, name, description, price_etb, active
    FROM menu_items
    WHERE id = ?
  `).get(itemId);
});

function updateMenuItemPrice(itemId, priceEtb) {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error("Menu item ID must be a positive integer.");
  }
  if (!Number.isSafeInteger(priceEtb) || priceEtb <= 0) {
    throw new Error("Menu item price must be a positive whole number.");
  }

  const result = db.prepare(`
    UPDATE menu_items
    SET price_etb = ?
    WHERE id = ?
  `).run(priceEtb, itemId);

  if (result.changes === 0) return null;
  return db.prepare(`
    SELECT id, name, description, price_etb, active
    FROM menu_items
    WHERE id = ?
  `).get(itemId);
}

function getCart(telegramId) {
  return db.prepare(`
    SELECT
      mi.id AS menu_item_id,
      mi.name,
      mi.price_etb,
      ci.quantity,
      mi.price_etb * ci.quantity AS line_total_etb
    FROM cart_items AS ci
    JOIN menu_items AS mi ON mi.id = ci.menu_item_id
    WHERE ci.telegram_id = ? AND mi.active = 1
    ORDER BY mi.id
  `).all(telegramId);
}

function setCartQuantity(telegramId, itemId, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error("Quantity must be a non-negative integer.");
  }

  const menuItem = db.prepare(`
    SELECT id FROM menu_items WHERE id = ? AND active = 1
  `).get(itemId);
  if (!menuItem) throw new Error("Menu item is unavailable.");

  if (quantity === 0) {
    return db.prepare(`
      DELETE FROM cart_items
      WHERE telegram_id = ? AND menu_item_id = ?
    `).run(telegramId, itemId);
  }

  return db.prepare(`
    INSERT INTO cart_items (telegram_id, menu_item_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id, menu_item_id)
    DO UPDATE SET quantity = excluded.quantity
  `).run(telegramId, itemId, quantity);
}

// -------------------- ORDER CREATION AND CUSTOMER HISTORY --------------------
const createOrder = db.transaction((telegramId) => {
  const items = getCart(telegramId);
  if (items.length === 0) return null;

  const totalEtb = items.reduce((sum, item) => sum + item.line_total_etb, 0);
  const result = db.prepare(`
    INSERT INTO orders (telegram_id, total_etb) VALUES (?, ?)
  `).run(telegramId, totalEtb);
  const orderId = Number(result.lastInsertRowid);

  const insertItem = db.prepare(`
    INSERT INTO order_items (
      order_id, menu_item_id, item_name, unit_price_etb, quantity, line_total_etb
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    insertItem.run(
      orderId,
      item.menu_item_id,
      item.name,
      item.price_etb,
      item.quantity,
      item.line_total_etb
    );
  }

  db.prepare("DELETE FROM cart_items WHERE telegram_id = ?").run(telegramId);
  return { orderId, totalEtb, items };
});

function getRecentOrders(telegramId) {
  return db.prepare(`
    SELECT
      o.id,
      o.status,
      o.total_etb,
      o.created_at
    FROM orders AS o
    WHERE o.telegram_id = ?
    ORDER BY o.id DESC
    LIMIT 5
  `).all(telegramId);
}

function getOrderById(orderId) {
  const order = db.prepare(`
    SELECT
      o.id,
      o.telegram_id,
      o.status,
      o.total_etb,
      o.created_at,
      c.first_name,
      c.username
    FROM orders AS o
    LEFT JOIN customers AS c ON c.telegram_id = o.telegram_id
    WHERE o.id = ?
  `).get(orderId);
  if (!order) return null;

  const items = db.prepare(`
    SELECT
      item_name AS name,
      unit_price_etb AS price_etb,
      quantity,
      line_total_etb
    FROM order_items
    WHERE order_id = ?
    ORDER BY id
  `).all(orderId);

  return { ...order, items };
}

// -------------------- ORDER STATUS AND CANCELLATION --------------------
const allowedTransitions = {
  pending: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready"],
  ready: ["delivered"],
  delivered: [],
  cancelled: [],
};

// Status updates are conditional on the current status to stop double-click races.
function updateOrderStatus(orderId, currentStatus, nextStatus) {
  if (!allowedTransitions[currentStatus]?.includes(nextStatus)) {
    throw new Error(`Invalid order status transition: ${currentStatus} -> ${nextStatus}`);
  }

  const result = db.prepare(`
    UPDATE orders
    SET status = ?
    WHERE id = ? AND status = ?
  `).run(nextStatus, orderId, currentStatus);

  return result.changes === 1;
}

// Customers can cancel their own pending or accepted orders, but not once preparation begins.
function cancelCustomerOrder(orderId, telegramId) {
  const result = db.prepare(`
    UPDATE orders
    SET status = 'cancelled'
    WHERE id = ?
      AND telegram_id = ?
      AND status IN ('pending', 'accepted')
  `).run(orderId, telegramId);

  return result.changes === 1;
}

// -------------------- OWNER REPORTS --------------------
function getAdminOrders(statuses = null, limit = 10) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 30) : 10;
  const validStatuses = ["pending", "accepted", "preparing", "ready", "delivered", "cancelled"];

  if (statuses && (!Array.isArray(statuses) || statuses.some((status) => !validStatuses.includes(status)))) {
    throw new Error("Invalid order status filter.");
  }
  let query = `
    SELECT
      orders.id,
      orders.telegram_id,
      customers.first_name,
      customers.username,
      orders.status,
      orders.total_etb,
      orders.created_at
    FROM orders
    JOIN customers ON customers.telegram_id = orders.telegram_id
  `;
  const params = [];

  if (statuses?.length) {
    query += ` WHERE orders.status IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }

  query += " ORDER BY orders.id DESC LIMIT ?";
  params.push(safeLimit);
  return db.prepare(query).all(...params);
}

function getAdminSummary() {
  const [localDayStart, nextLocalDayStart] = getLocalDayRange();
  return db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END) AS preparing,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS today_orders,
      COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? AND status != 'cancelled'
                        THEN total_etb ELSE 0 END), 0) AS today_order_value
    FROM orders
  `).get(localDayStart, nextLocalDayStart, localDayStart, nextLocalDayStart);
}

module.exports = {
  db,
  upsertCustomer,
  getMenu,
  getAllMenuItems,
  toggleMenuItemActive,
  updateMenuItemPrice,
  getCart,
  setCartQuantity,
  createOrder,
  getRecentOrders,
  getOrderById,
  getAdminOrders,
  getAdminSummary,
  updateOrderStatus,
  cancelCustomerOrder,
};
