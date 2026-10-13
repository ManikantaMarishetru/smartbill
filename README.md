# SmartBill

Billing & khata for your shop. Static site (zero npm/CDN deps) — data stays on device (localStorage).

Live: https://smartbill-delta.vercel.app/#/dashboard

## Files

- `index.html` — app shell (Dashboard, New Bill, Invoices, Customers, Credit Ledger, Settings)
- `css/styles.css` — styles
- `js/app.js` — renders all views, toast, print receipts/statements

## Run locally

Open `index.html` directly, or serve the folder:

```sh
npx serve .
# or
python -m http.server
```

## Source note

Reconstructed 2026-10-13 from the live Vercel deployment
(`smartbill-delta.vercel.app`), which had no linked GitHub repo or local source on this PC.
