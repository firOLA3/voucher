# Goodday Voucher App (MERN Stack)

A full-stack **MERN** (MongoDB, Express, React, Node.js) voucher campaign app with a customer claim page, an admin dashboard, and a MongoDB-backed API. The server enforces the campaign voucher limit atomically in MongoDB, so concurrent submissions cannot issue more vouchers than the configured maximum.

The customer and admin screens use a fuchsia, white, and gold Class of 2026 convocation theme. The customer page includes the supplied ceremony invitation as local artwork at `client/public/convocation-invitation.jpg`.

## Architecture

- **`server/`** — Express + Mongoose API (deployable independently to Render or Railway)
- **`client/`** — React + Vite SPA (deployable independently to Vercel or Netlify)

## Run locally

Requires **Node.js 20+** and a **MongoDB** connection string (e.g., MongoDB Atlas or local `mongod`).

### 1. Install dependencies

```powershell
npm run install:all
```

### 2. Configure environment variables

Copy `server/.env.example` to `server/.env` and set your MongoDB URI and admin password:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/vouch?retryWrites=true&w=majority
VOUCHER_ADMIN_PASSWORD=choose-a-local-password
CORS_ORIGIN=http://localhost:5173
```

If `VOUCHER_ADMIN_PASSWORD` is unset, the server generates and prints a temporary admin password at startup.

### 3. Start backend and frontend

In two terminals (or run each command separately):

```powershell
npm run dev:server
```

```powershell
npm run dev:client
```

Open `http://localhost:5173` for the customer claim page and `http://localhost:5173/admin` for the event team dashboard. Vite proxies `/api/*` requests to `http://127.0.0.1:8000` during local development.

## Deployment (Separate Frontend & Backend)

### Backend (`server/`) on Render or Railway

1. Create a Web Service with **Root Directory** set to `server` (or use `render.yaml` Blueprint on Render).
2. Build command: `npm install`
3. Start command: `npm start`
4. Health check path: `/api/v1/config`
5. Set environment variables:
   - `NODE_ENV=production`
   - `MONGODB_URI` — your MongoDB Atlas connection string
   - `VOUCHER_ADMIN_PASSWORD` — strong admin password
   - `VOUCHER_SESSION_SECRET` — random secret string
   - `CORS_ORIGIN` — exact deployed frontend origin, e.g. `https://your-app.vercel.app` (comma-separated for multiple origins)
   - `VOUCHER_COOKIE_SAMESITE=none`
   - `VOUCHER_COOKIE_SECURE=1`

### Frontend (`client/`) on Vercel or Netlify

1. Import the repo with **Root Directory** set to `client`.
2. Build command: `npm run build`
3. Output directory: `dist`
4. Set environment variable:
   - `VITE_API_BASE_URL` — your deployed backend URL without trailing slash, e.g. `https://convocation-voucher-api.onrender.com`
5. SPA routing for `/admin` is preconfigured via `client/vercel.json`, `client/netlify.toml`, and `client/public/_redirects`.

## Voucher rules and reporting

- The admin sets one shared voucher code from the dashboard. Any non-empty text is accepted, including spaces, punctuation, and Unicode, up to 256 characters.
- The configured code is preserved exactly; visitors must enter the same characters, including the same spaces and letter case.
- The shared code can be used for multiple claims; the campaign-wide limit controls how many vouchers are created.
- After entering the correct code, visitors answer the admin's question. Answers are case-insensitive and ignore surrounding whitespace. A voucher is issued only for a correct answer; answers are stored as salted PBKDF2-SHA256 hashes and are never included in public responses or the admin dashboard.
- The admin can change the global limit, but cannot set it below the number already issued.
- The customer page and admin dashboard refresh campaign data every five seconds. The API checks and increments `issuedCount` atomically via MongoDB single-document conditional update (`findOneAndUpdate` with `$expr: { $lt: ["$issuedCount", "$maxVouchers"] }`).
- The dashboard reports claims, remaining vouchers, elapsed campaign time (or time to sell-out), average pace between the first and latest claim, and recent activity.

## API

- `GET /health` / `GET /api/v1/health` — service health check.
- `GET /api/v1/config` — public availability and challenge-configuration status; the shared code, question, answer, and voucher totals are not exposed.
- `POST /api/v1/voucher-question` — check the shared code and retrieve the configured question, `{ "code": "..." }`.
- `POST /api/v1/vouchers` — claim using `{ "code": "...", "answer": "..." }`.
- `POST /api/v1/admin/session` — sign in with `{ "password": "..." }`.
- `GET /api/v1/admin/dashboard` — authenticated campaign statistics.
- `PUT /api/v1/admin/settings` — authenticated limit update, `{ "limit": 250 }`.
- `PUT /api/v1/admin/voucher-code` — authenticated shared code update, `{ "code": "any text you choose" }`.
- `PUT /api/v1/admin/voucher-challenge` — authenticated question and answer update, `{ "question": "...", "answer": "..." }`.
- `DELETE /api/v1/admin/session` — sign out.

## Tests & Build

```powershell
npm test
npm run build
```
