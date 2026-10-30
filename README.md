# Slot

Anonymous file drop for clients, a signed-in inbox for the team. Every file is deleted 24 hours after upload.

- `/` clients drop or paste files. No account.
- `/admin` team signs in with Authentik LDAP and sees every file from every client.
- `/d/<token>` link you give a client for a file you upload in the admin ("Send a file to a client").

## Run it

```bash
npm install
ADMIN_AUTH=dev ADMIN_DEV_PASSWORD=pick-something npm start   # UI work, no LDAP needed
```

Production: copy `.env.example` to `.env`, fill in the LDAP values, then `docker compose up -d --build`. Needs Node 22.13 or newer (uses the built-in SQLite). Put it behind HTTPS.

## Authentik LDAP

Sign-in is in `auth.js`. It does the usual three steps: the service account looks up the user, an optional group check runs, then the user binds with their own password. Set the `LDAP_*` variables in `.env`. The defaults in `.env.example` follow Authentik's outpost layout, but I could not test them against your instance, so check the base DN, bind DN and filter first. To use a different provider, replace the function exported from `auth.js`; it only has to return `{ username, displayName }` or `null`.

## How cleanup works

Every file has an `expires_at` set at upload. Expired files are hidden and undownloadable immediately, and a sweeper deletes them from disk and the database every minute. On boot it also removes orphaned files and abandoned partial uploads.

## Protections already in

Per-IP upload rate limit, per-file and total storage caps, partial uploads discarded on disconnect, files stored under random IDs (never the uploaded name), forced-download for everything except a short list of safe previews, `nosniff` and a strict CSP, SameSite=Strict session cookies plus a CSRF header, login throttling, LDAP filter escaping.

## Known limits

- Single instance. Rate-limit counters and the sweeper are in memory/one process.
- Uploads are one request per file. Behind Cloudflare's proxy plans the per-request cap (100 MB on Free) applies; chunked uploads would be the next step.
- No virus scan. Add ClamAV in `handleUpload` if clients are untrusted.
- Dropping a whole folder is not supported; the page tells people to zip it.
