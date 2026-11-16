ABE FOOD TELEGRAM ORDERING BOT
==============================

What the bot does
-----------------
Customers browse the menu, manage a cart, submit orders, and see order updates in
Telegram. The owner manages incoming orders and can temporarily hide or show menu
items without editing files or the database manually.

There is no online payment integration. The bot tracks food orders and prices only.
Payment arrangements, if any, are handled outside this bot.

Setup
-----
1. Install Node.js 22 or newer.
2. Copy .env.example to .env if you do not already have a .env file.
3. Set BOT_TOKEN and ADMIN_TELEGRAM_ID in .env.
4. Install dependencies with: npm install
5. Start the bot with: npm start

Keep .env private. Never publish your Telegram bot token.

Troubleshooting
---------------
After starting with npm start, keep the terminal open. If Telegram commands get no
response, check that terminal for "Telegram polling stopped" or a 409 conflict.
A 409 conflict usually means another Abe Food process, or another deployment using
the same token, is already polling Telegram. Stop the duplicate and run only one
instance. If Telegram reports an unauthorized token, create a replacement token
with BotFather, update BOT_TOKEN in .env, then restart the bot.

Customer commands and flow
--------------------------
/start   - Open the welcome screen
/menu    - Browse available dishes and edit the cart
/cart    - Review the cart and submit an order
/orders  - View the five most recent orders and cancel an eligible order

Order states are Pending, Accepted, Preparing, Ready, Delivered, or Cancelled.
Customers can cancel orders while they are pending or accepted. The owner is
notified when an order is submitted or cancelled.

Owner commands and flow
-----------------------
/admin     - Dashboard and order counts
/pending   - Review pending orders
/active    - View accepted, preparing, and ready orders
/allorders - View recent orders
/today   - View today's order summary (BUSINESS_TIME_ZONE; defaults to Ethiopia time)
/menuadmin - Hide, show, or change menu item prices
/cancelprice - Cancel a menu price update prompt
/help      - Show owner commands

The owner can accept or reject a pending order, then advance accepted orders
through Preparing, Ready, and Delivered. Customers receive a Telegram message
when the order status changes.
Order timestamps and the /today date use BUSINESS_TIME_ZONE, which defaults to
Africa/Addis_Ababa and can be overridden in .env with an IANA timezone such as
Europe/London. This keeps reports correct even when the hosting computer uses UTC.
Telegram does not provide the customer's phone timezone to the bot.

Menu management
---------------
Open /menuadmin or choose Manage Menu from /admin. Each menu item has controls to
hide/show it or change its price. To change a price, tap Price, send the new
positive whole-number amount in ETB in the private chat, and the bot confirms it.
Use /cancelprice to cancel; the prompt expires after five minutes. Price updates
are stored in SQLite and survive restarts. They apply to new orders; existing
orders keep their original item prices and totals.

Hidden items remain in the database; their name and price, as well as past order
records, are preserved. When an item is hidden, it is removed from all current
carts so it will not unexpectedly return to a cart if shown again later.

Data storage
------------
The SQLite database is food-orders.db in this project folder. It stores customers,
menu items, carts, orders, and order-item snapshots. The database creates missing
tables and adds any missing supplied Amharic menu names at startup.
The first startup after this update enables all existing menu items, including the
older sample dishes and displays their names in Amharic. After that, owner
hide/show choices are preserved across restarts. Existing order records are preserved.

Existing databases from older versions may contain an unused chapa_payments table.
The bot no longer reads or writes that table, and it is left in place to preserve
existing data.
