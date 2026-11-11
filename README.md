# Mekong Shop: E-Commerce (Server-Side Rendering)

Express (Node.js) + SQLite. Every page is rendered to HTML ON THE SERVER and sent ready to display
(view the page source in a browser: the products are already in the HTML, no JavaScript is needed). Good for speed and SEO.

## Requirement checklist
| Requirement | Where |
|---|---|
| Home: grid with name, price, description, thumbnail, View Details, Add to Cart | `/` |
| Product detail: full description, price, stock status, image, quantity, Add to Cart | `/product/:id` |
| Share to Facebook and Telegram | buttons on the product page (+ Open Graph tags for nice previews) |
| Cart: quantity, unit price, subtotal, total, update, remove, Proceed to Checkout | `/cart` |
| Checkout (guest): name, email, phone, address + KHQR code; order saved in database (after payment is confirmed when a token is set) | `/checkout` |
| Order confirmation: success message, Order ID, customer details, total | `/order/confirmation/:token` |
| Admin product list: ID, Name, Price, Stock, Status + Add / Edit / Delete | `/admin/products` |
| Admin product form: name, description, price, stock, image URL, status | `/admin/products/new`, `/admin/products/:id/edit` |
| Admin order history: Order ID, Customer, Phone, Total, Date + View Order Details | `/admin/orders`, `/admin/orders/:id` |

## Admin login
URL: `/admin/login`   Username: `admin`   Password: `admin123` (default; set your own with ADMIN_PASSWORD before submitting)

## KHQR payment (Bakong)
The checkout page shows a **dynamic KHQR code with the exact order amount** (generated with the official `bakong-khqr` SDK), then checks the payment.
Python sample from the teacher -> Node: `khqr.create_qr` = SDK `generateIndividual`, `khqr.generate_md5` = the `md5` it returns, `khqr.check_payment` = POST `/v1/check_transaction_by_md5` (Bakong Open API).

Three modes, chosen only by environment variables (see `.env.example`):
| You set | What happens |
|---|---|
| nothing | checkout shows the placeholder (or your own `public/khqr.png`); order saved as "Pending verification" |
| `BAKONG_ACCOUNT_ID` | dynamic QR with the amount; order saved as "Pending verification" (the shop checks its bank app) |
| `BAKONG_ACCOUNT_ID` + `BAKONG_TOKEN` | dynamic QR + automatic check: the order is saved ONLY after Bakong confirms the payment (status "Paid") |

Important:
- **Keep your API token secret.** Use a local `.env` file (already git-ignored) or Render's Environment tab. Never put it in the code or on GitHub.
- Get the token by registering at https://api-bakong.nbc.gov.kh/register with your email. Tokens expire (about every 90 days), so renew it.
- **The official Bakong API is restricted to Cambodian IP addresses.** It works when you run the shop on your computer in Cambodia, but a server abroad (Render) may be refused ("The payment service refused our access"). For a hosted demo either use the "account only" mode, or ask your teacher how they host it.
- A QR code is valid for 15 minutes (a new one is made automatically). Each paid QR can be used for one order only.
- Your Bakong account must be a real KYC-verified account that can receive the chosen currency.

## Run on your computer
1. Install Node.js 18+ (nodejs.org).
2. In this folder: `npm install` then `npm start`
3. Open http://localhost:3000 (admin: http://localhost:3000/admin/login)

## Environment variables
| Name | Meaning | Default |
|---|---|---|
| SHOP_NAME | Shop name shown on every page | Mekong Shop |
| ADMIN_USER / ADMIN_PASSWORD | Admin login | admin / admin123 |
| BAKONG_ACCOUNT_ID, BAKONG_TOKEN, MERCHANT_NAME, MERCHANT_CITY, KHQR_CURRENCY, KHR_RATE, KHQR_PHONE, KHQR_VERIFY, BAKONG_API_URL | KHQR payment (see section above) | |
| BASE_URL | Public site address (for share links), e.g. https://myshop.onrender.com | auto-detected |
| DB_PATH | Database file path (use a persistent disk on Render) | ./shop.db |
| NODE_ENV | Set to `production` online (secure cookies) | |
| SHOP_TZ | Time zone for dates | Asia/Phnom_Penh |

## Deploy on Render
1. Upload this folder to a GitHub repository (node_modules and *.db are ignored).
2. render.com > New > Web Service > connect the repo. Build: `npm install`  Start: `npm start`
3. Add the environment variables above (at least ADMIN_PASSWORD, NODE_ENV=production, SHOP_NAME).
4. Free plans erase the database file when the service sleeps or restarts. To KEEP orders and products, use a paid instance with a Disk
   (mount path e.g. `/opt/render/project/src/storage`) and set `DB_PATH=/opt/render/project/src/storage/shop.db`.

## Security notes
All SQL uses parameters; all output is HTML-escaped; admin pages need a login session (HttpOnly, SameSite=Strict cookie);
admin login is rate limited; guests can only open their own confirmation page through its secret link.
