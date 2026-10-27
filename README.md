# Abhinav Stock Reconciliation

A private, mobile-friendly Node.js + Express + Neon PostgreSQL stock-reconciliation workspace. It includes saved chats, stock groups, deterministic product suggestions, manual review, quantity comparison, sortable/filterable reports, HTML chat export, JSON full backup/restore, and XLSX report export.

## Important before using real stock

This is a first implementation and has not been fully validated against every real-world product naming and packing convention. Test with copies of your stock lists first. Always manually verify uncertain product matches before acting on the report. The matching logic is deterministic and does not call an external AI API.

### Quantity rules

- Difference = Physical Quantity − Actual Quantity.
- Physical quantity is calculated from boxes × pieces per box + loose pieces when a pieces-per-box value can be recognized from the input (typically a trailing numeric pack-size marker such as `-4200` or `6300`).
- A `?` physical quantity is treated as zero.
- If pack size or quantity cannot be parsed safely, the row should be reviewed rather than silently guessed.
- Matching considers normalized product names and attribute differences; it is a heuristic, not a guarantee. Equal quantities alone do not confirm identity.

## Features

- Owner login configured through environment variables; password is hashed.
- PostgreSQL-backed saved chats, stock groups, reconciliation records, and session storage.
- ChatGPT-style sidebar, new chat, history, rename/delete, and supported English/Hinglish commands.
- Paste/import CSV or Excel lists, reconcile actual vs physical, manually review uncertain matches.
- Status multi-select filters, product search, clickable sortable columns, and discrepancy summary.
- Individual chat export to HTML (viewing archive) and JSON.
- Full account data backup as JSON with validation and Replace/Merge restore choices.
- Reconciliation report export to Excel.

## Deploy on Render + Neon from a phone

1. Create a Neon PostgreSQL project. Singapore is a reasonable region for users in India. Keep the database credentials private.
2. Copy the Neon **pooled** connection string and keep it private.
3. Create a **private GitHub repository** and upload the contents of this project (the `package.json` must be at repository root). Do not upload a real `.env` file or credentials.
4. In Render, create a Web Service connected to the private repository.
5. Set runtime to Node; build command `npm install`; start command `npm start`; health check path `/api/health`.
6. Add these environment variables in Render:
   - `DATABASE_URL`: Neon pooled connection string
   - `SESSION_SECRET`: a long random secret (at least 32 characters)
   - `ADMIN_EMAIL`: the login email you choose
   - `ADMIN_PASSWORD`: a strong, unique password
   - `NODE_ENV`: `production`
7. Deploy. Tables are created on startup, and the first owner account is initialized from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
8. Open the Render URL and sign in. Create your stock groups.

### Free-tier note

Choose the free Render web service plan in the dashboard if available. Free services can sleep and have usage limits; Neon free tier also has limits. Do not assume a one-minute ping loop will keep Render awake or bypass provider limits. The application handles common wake-up/retry messages, but a temporary hosting/database failure may still require waiting and retrying.

## Local run

Requires Node.js 20+ and PostgreSQL. Copy `.env.example` to `.env`, fill in the values, then run:

```bash
npm install
npm start
```

## Input format examples

Actual Quantity list (tab-separated or CSV-like rows):

```text
Particulars	Actual Quantity
100 ML PLAIN ABH 80 FOOD PACKAGING PRODUCT-6400	6400
250 ML PET ABH 80 DIA-2500	5000
```

Physical stock examples:

```text
100ml NW 13box 400pes
250ml PET ABH 2box 500pes
300ml NW ?
```

Use product names that include a clear pack size when possible. If a product's pack size is not present in either source, do not rely on the parser to infer it; correct/review that item manually.

## Backup format

- Individual chat HTML is intended for viewing and does not itself restore the app.
- Full JSON backup includes the account's chats, groups, and reconciliation records represented by the app. Store it privately; it contains business data.
- Restore offers Replace or Merge. Replace is destructive for existing account records; download a current backup first.
- Excel export is for analysis/reporting, not full restoration.

## Privacy and security

- This is not local-only: chats and stock records are stored in the Neon database you configure.
- No external AI API or analytics SDK is used.
- Keep the GitHub repository private, use HTTPS, and never share `DATABASE_URL`, `SESSION_SECRET`, or `ADMIN_PASSWORD`.
- Use a strong unique password and download periodic backups.
- Before production use, test authentication, restore behavior, exports, and reconciliation results with non-critical sample data.


## Optional one-minute self-ping loop

For diagnostics, set these Render environment variables:

- `SELF_PING_ENABLED=true`
- `SELF_PING_INTERVAL_MS=60000`

The loop makes a local request to `/api/health` every 60 seconds and intentionally does not log each ping. **This is not an uptime workaround:** because it runs inside the same process, it stops when Render suspends the free service and does not count as external inbound traffic. It therefore cannot guarantee that the service stays awake. The app should handle cold starts gracefully; use a plan that supports always-on service if continuous availability is required.

## Checklist coverage and testing status

Included in this project: login/session handling, PostgreSQL-backed chats/groups/reconciliation history, sidebar/new chat/rename/delete, supported rule-based English/Hinglish commands, pasted/imported input parsing, fuzzy candidate suggestions and manual review, quantity difference (`physical - actual`), multi-select status filters, clickable sorting, search, HTML chat export, JSON full backup/restore with replace/merge confirmation, Excel report export, Render configuration, and optional self-ping diagnostics.

Before real use, test all calculations against your stock data. Product matching is heuristic and must be manually checked; this app does not guarantee that fuzzy suggestions are correct. The HTML chat export is a readable archive; JSON is the restorable backup. The current export produces the saved report rather than necessarily applying the current on-screen filters. Automatic draft recovery, undo/audit history, cross-date comparison, and global search were explicitly deferred for a later version.

Use a private GitHub repository. Keep `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in Render environment variables only. Do not commit `.env` or share connection strings.

## Matching and physical packing inference update

The reconciliation logic normalizes spacing in size labels (for example, `80mm` and `80 MM`), scores shared core product-name tokens, and does not treat an attribute that is absent from one name as a contradiction by itself. When a physical line has boxes plus loose pieces but no explicit pieces-per-box, the app may infer the pack size from a strongly matched Actual product name ending in a numeric code (for example `SC-7200`). Such inferred quantities are marked `REVIEW` with an explanation and are not silently accepted as a final match. Please verify that the trailing code really represents pieces per box for that product.
