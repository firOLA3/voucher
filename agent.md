# Project guide for coding agents

## What we are building

This project is a **MERN stack** (MongoDB, Express, React, Node.js) voucher campaign app for a Class of 2026 convocation celebration, structured for separate frontend (Vercel/Netlify) and backend (Render/Railway) deployment. Visitors enter a voucher code and verification answer to claim a voucher; once the campaign-wide limit is reached, new visitors see **“this voucher is no longer available”** below the input.

The visual theme follows the user's supplied nursing induction invitation: fuchsia, white, and gold, with the invitation shown on the claim page.

## Main parts

- `server/src/index.js` — connects to MongoDB via Mongoose, initializes campaign settings, and starts the Express HTTP server.
- `server/src/app.js` — Express routes, CORS (`CORS_ORIGIN`), signed `HttpOnly` cookie + Bearer session auth, JSON validation, and error handling.
- `server/src/services/voucherService.js` — campaign status, challenge validation, PBKDF2-SHA256 answer hashing, atomic quota enforcement (`findOneAndUpdate` with `$expr`), and dashboard statistics.
- `server/src/models/CampaignSettings.js` and `server/src/models/Voucher.js` — Mongoose schemas.
- `server/tests/voucher.test.js` — Node test suite using `mongodb-memory-server` covering exact voucher-code matching, question/answer checks, limit changes, public API privacy, concurrent claims, CORS, and session auth.
- `client/src/pages/ClaimPage.jsx` — React public voucher claim page (`/`).
- `client/src/pages/AdminPage.jsx` — React event team sign-in and dashboard page (`/admin`).
- `client/src/api/client.js` — API wrapper supporting `VITE_API_BASE_URL` and `credentials: "include"` + session token fallback for cross-origin deployments.
- `client/src/styles.css` — responsive layout and shared event theme.
- `client/public/convocation-invitation.jpg` — locally served invitation image supplied by the user.

## Important behavior

- The admin sets one shared voucher code. Any non-empty text up to 256 characters is accepted, including spaces, punctuation, and Unicode. Preserve it exactly; visitors must enter the same characters, including case and spaces. It can be used repeatedly until the global campaign limit is reached.
- The admin also configures a question and answer. Visitors must submit the correct shared code to reveal the question, then provide the matching answer before a claim is created. Answer matching normalizes Unicode (`NFKC`), ignores outer whitespace, and ignores letter case. Store only a salted PBKDF2-SHA256 hash; never send it in an API response.
- Voucher creation and admin limit changes use atomic MongoDB conditional updates (`findOneAndUpdate` with `$expr`) on `CampaignSettings` (`_id: "default"`). The server—not the browser's periodic availability check—is authoritative and prevents simultaneous requests from exceeding the limit.
- Admins can raise or lower the limit, but cannot lower it below the number of vouchers already claimed.
- Public availability and admin statistics refresh every five seconds.
- The public page and its API responses reveal whether claims are open, not the shared code or the number of vouchers remaining/claimed. Totals and the configured code belong to the authenticated admin dashboard.

## Run and test

Requires Node.js 20+.

```powershell
npm run install:all
npm test
npm run build
```

## Change guidance

- Keep the public claim flow and admin dashboard consistent with the invitation's fuchsia, white, and gold theme.
- Preserve the exact sold-out message (`"this voucher is no longer available"`) and keep quota enforcement atomic on the server/database.
- Add focused tests for backend changes in `server/tests/voucher.test.js` and run `npm test` + `npm run build` after changes.
- Keep the user-supplied invitation as a local static asset in `client/public/convocation-invitation.jpg`.
