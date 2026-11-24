# Project guide for coding agents

## What we are building

This project is a small full-stack voucher campaign app for a Class of 2026 convocation celebration. Visitors enter a voucher code and submit it to create a voucher. The page confirms a successful claim; once the campaign-wide limit is reached, new visitors see **“this voucher is no longer available”** below the input.

The visual theme follows the user's supplied nursing induction invitation: fuchsia, white, and gold, with the invitation shown on the claim page. The source design is not currently imported from Figma because the shared Figma link required sign-in.

## Main parts

- `server.py` serves the pages and JSON API, manages admin sessions, and stores voucher claims and campaign settings in SQLite.
- `public/index.html` is the public voucher claim page.
- `public/admin.html` is the campaign team's sign-in and dashboard page.
- `public/styles.css` contains the responsive layout and shared event theme.
- `public/app.js` handles claim submission, admin sign-in and settings, and periodic dashboard/availability refresh.
- `public/convocation-invitation.jpg` is the locally served invitation image supplied by the user.
- `tests/test_server.py` covers exact voucher-code matching, question/answer checks, migrations, limit changes, public API privacy, and concurrent claims.

## Important behavior

- The admin sets one shared voucher code. Any non-empty text up to 256 characters is accepted, including spaces, punctuation, and Unicode. Preserve it exactly; visitors must enter the same characters, including case and spaces. It can be used repeatedly until the global campaign limit is reached.
- The admin also configures a question and answer. Visitors must submit the correct shared code to reveal the question, then provide the matching answer before a claim is created. Answer matching ignores letter case and surrounding whitespace. Store only a salted hash of the normalized answer; never send it in an API response.
- Voucher creation and admin limit changes use SQLite write transactions. The server—not the browser's periodic availability check—is authoritative and prevents simultaneous requests from exceeding the limit.
- The admin dashboard can configure/update the shared code, question, answer, and campaign-wide limit. Claims are unavailable until all three shared challenge settings are configured.
- The admin dashboard may display the configured question, but never returns the correct answer. Store the answer as a salted PBKDF2 hash and compare it server-side.
- Admins can raise or lower the limit, but cannot lower it below the number of vouchers already claimed.
- Public availability and admin statistics refresh every five seconds.
- The public page and its API responses reveal whether claims are open, not the shared code or the number of vouchers remaining/claimed. Totals and the configured code belong to the authenticated admin dashboard.
- The dashboard reports claims, remaining vouchers, campaign timing, average claim pace, and recent claims.

## Run and test

Use Python 3.10 or later; there are no third-party Python packages.

```powershell
$env:VOUCHER_ADMIN_PASSWORD = "choose-a-local-password"
python server.py
```

Open `http://127.0.0.1:8000` for the claim page or `http://127.0.0.1:8000/admin` for the admin dashboard. If no admin password is configured, the server generates and prints one at startup.

```powershell
python -m unittest discover -s tests -v
```

## Change guidance

- Keep the public claim flow and admin dashboard consistent with the invitation's fuchsia, white, and gold theme.
- Preserve the exact sold-out message and keep quota enforcement on the server/database.
- Add focused tests for changes to voucher or campaign behavior; run the test command above after backend changes.
- Keep the user-supplied invitation as a local static asset; the app should not need a Figma login or a third-party image host to display it.
- Treat this as a reference MVP. Before public production use, integrate the intended identity provider and review deployment security, rate limits, monitoring, backups, privacy, and shared-database needs. SQLite on a local disk is not a shared database for multiple app instances.
