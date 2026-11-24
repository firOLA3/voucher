# Goodday Voucher App

A small full-stack voucher campaign app with a customer claim page, an admin dashboard, and a SQLite-backed API. The database enforces the campaign limit atomically, so concurrent submissions cannot create more vouchers than the configured maximum.

The customer and admin screens use a fuchsia, white, and gold Class of 2026 convocation theme. The customer page includes the supplied ceremony invitation as local artwork at `public/convocation-invitation.jpg`.

## Run locally

Requires Python 3.10 or later; there are no third-party packages.

```powershell
$env:VOUCHER_ADMIN_PASSWORD = "choose-a-local-password"
python server.py
```

Open `http://127.0.0.1:8000` for the customer page and `http://127.0.0.1:8000/admin` for campaign management. If `VOUCHER_ADMIN_PASSWORD` is unset, the server generates and prints a temporary admin password at startup.

The SQLite database is created at `data/vouchers.sqlite3`. Set `VOUCHER_DATABASE` to use another path, `VOUCHER_HOST` to change the bind address, and `VOUCHER_PORT` to change the port.

## Voucher rules and reporting

- The admin sets one shared voucher code from the dashboard. Any non-empty text is accepted, including spaces, punctuation, and Unicode, up to 256 characters.
- The configured code is preserved exactly; visitors must enter the same characters, including the same spaces and letter case.
- The shared code can be used for multiple claims; the campaign-wide limit controls how many vouchers are created.
- After entering the correct code, visitors answer the admin's question. Answers are case-insensitive and ignore surrounding whitespace. A voucher is issued only for a correct answer; answers are stored as salted, iterated hashes and are never included in public responses or the admin dashboard.
- The admin can change the global limit, but cannot set it below the number already issued.
- The customer page and admin dashboard refresh campaign data every five seconds. The API checks the limit inside a SQLite write transaction for every claim; this server-side check is authoritative.
- The dashboard reports claims, remaining vouchers, elapsed campaign time (or time to sell-out), average pace between the first and latest claim, and recent activity.

## API

- `GET /api/v1/config` — public availability and challenge-configuration status; the shared code, question, answer, and voucher totals are not exposed.
- `POST /api/v1/voucher-question` — check the shared code and retrieve the configured question, `{ "code": "..." }`.
- `POST /api/v1/vouchers` — claim using `{ "code": "...", "answer": "..." }`.
- `POST /api/v1/admin/session` — sign in with `{ "password": "..." }`.
- `GET /api/v1/admin/dashboard` — authenticated campaign statistics.
- `PUT /api/v1/admin/settings` — authenticated limit update, `{ "limit": 250 }`.
- `PUT /api/v1/admin/voucher-code` — authenticated shared code update, `{ "code": "any text you choose" }`.
- `PUT /api/v1/admin/voucher-challenge` — authenticated question and answer update, `{ "question": "...", "answer": "..." }`.
- `DELETE /api/v1/admin/session` — sign out.

## Tests

```powershell
python -m unittest discover -s tests -v
```

## Production note

This is a runnable reference implementation, not a substitute for integrating your production identity provider or operational controls. Before public deployment, use HTTPS, set a strong `VOUCHER_ADMIN_PASSWORD`, set `VOUCHER_COOKIE_SECURE=1`, and review the authentication, rate limiting, backup, monitoring, and privacy requirements for your environment. For multiple app instances, use a shared database/service designed for your deployment rather than a local SQLite file.
