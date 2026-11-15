# Deploying Fly Dragon AI to Cloudflare

Everything runs on one Worker: `public/` is served by the Worker's static-assets binding and
`/api/*` is the Hono app. No Pages project is needed (Workers Assets replaced that split), so
there is only one URL, one deploy, and cookies are first-party.

---

## 0. What you need once

| Thing | Value |
|---|---|
| Cloudflare account | free plan is enough to start |
| Local Node | **22.4+** (`node --version`) - uses `node:sqlite` for the test harness |
| Project code | this folder |
| Google Cloud project | only if you want Google sign-in |

```bash
npm install
```

---

## 1. Create the D1 database

```bash
npx wrangler login
npx wrangler d1 create fly-dragon-db
```

Wrangler prints a `database_id`. Put it in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "fly-dragon-db"
database_id = "paste-the-id-here"
```

## 2. Create the R2 bucket

```bash
npx wrangler r2 bucket create fly-dragon-uploads
```

`wrangler.toml` already binds it as `UPLOADS` with `bucket_name = "fly-dragon-uploads"`.
Files are private: the bucket has no public domain, downloads go through
`GET /api/files/:id/download` which re-checks ownership before handing out a ~2-minute
signed URL.

## 3. Apply the schema

```bash
npx wrangler d1 execute fly-dragon-db --local  --file ./src/db/schema.sql   # dev copy
npx wrangler d1 execute fly-dragon-db --remote --file ./src/db/schema.sql   # production
```

Re-run any time - every statement is `CREATE ... IF NOT EXISTS`. Do **not** drop the old
`users`/`sessions` tables until the new app is live: the login path still accepts the previous
app's `sha256(salt + password)` rows and upgrades them to bcrypt on the next good sign-in.

## 4. Secrets

```bash
npx wrangler secret put JWT_SECRET               # openssl rand -base64 32
npx wrangler secret put MCP_ENCRYPTION_KEY       # openssl rand -base64 32
npx wrangler secret put OPENAI_API_KEY           # optional, see "Model" below
npx wrangler secret put RESEND_API_KEY           # optional, forgot-password email
npx wrangler secret put IATA_API_KEY             # optional: live visa rules
npx wrangler secret put AMADEUS_CLIENT_ID        # optional, flights
npx wrangler secret put AMADEUS_CLIENT_SECRET    # optional
npx wrangler secret put PARALLEL_API_KEY         # optional, web search
npx wrangler secret list
```

For local development put the same names in `.dev.vars` (copy from `.env.example`).
`.dev.vars` and `.env*` are gitignored; they never ship.

## 5. Model

Two options, both supported by `src/lib/ai.js`:

* **Workers AI (default, no key).** In the Cloudflare dashboard turn on Workers AI for the
  account, then optionally pin models with `AI_MODEL` / `AI_IMAGE_MODEL` in `[vars]`.
* **OpenAI.** Set the `OPENAI_API_KEY` secret (and `OPENAI_MODEL`, default `gpt-4o-mini`).
  When the key exists it wins - that is the path with tool calling and image generation
  through `gpt-image-1`.

Never hardcode either: the code reads `env`, and nothing logs the key.

## 6. Google sign-in (optional)

1. Google Cloud Console -> APIs & Services -> Credentials -> OAuth client (Web).
2. Authorized **redirect URI** - exact, including the path:
   ```
   https://<your-host>/api/auth/google/callback
   http://127.0.0.1:8788/api/auth/google/callback     # development
   ```
3. Secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. The client only needs `openid email profile`; verified addresses only, and email must match
   an existing account to link to it (otherwise a new `provider='google'` user is created).

Without those secrets `GET /api/auth/google` answers 503 and the UI shows a toast - no crash.

## 7. Run it locally

```bash
npm run dev          # http://127.0.0.1:8788  (wrangler + D1 + R2, local state)
```

`npm run dev` uses the `.dev.vars` secrets and the local D1 copy from step 3. Sign up once:
the first account in the database becomes `role='admin'` (see §6D of the brief); make your own
admin row later, or demote that one.

## 8. Go live

```bash
npx wrangler deploy
```

Then, in the dashboard (or `_redirects`-style rules if you keep the marketing site separate):

* `PUBLIC_ORIGIN` in `[vars]` = the exact public origin, e.g. `https://flytripvisa.site`.
  It is used for OAuth redirect URIs and reset links. A bare domain without a scheme is
  accepted and treated as https.
* If you serve the site on a `www.` hostname too, add it to `ADDITIONAL_ORIGINS` (CORS allow-list).
* Custom domain: Workers -> your worker -> Triggers -> Custom domains -> `flytripvisa.site`.
  Cloudflare issues the TLS certificate; the app always sets `Secure` cookies, so https is
  mandatory.
* Keep the chat page reachable at `/` and the admin view at `/admin` - the Worker serves
  `public/` first and only handles `/api/*`, `/oauth*`, `/reset-password`.

## 9. Verify the deployment

```bash
curl -s https://<host>/api/health | jq
# {"ok":true,"chat":{"provider":"...","model":"..."},"tools":[...5 entries...]}
```

Manual smoke test: sign up -> welcome screen disappears on the first message -> tool status
lines appear -> page refresh restores the thread -> Settings -> File Manager shows the upload
-> Database stats count the messages -> Log out returns the gate.

## 10. Tests in this repo

```bash
npm test                  # 33 API checks: real routes + real SQLite + in-memory R2
npm run test:browser      # 45 checks driving public/chat.js in Chromium
npm run check:imports     # static check that no route imports a name that isn't exported
```

`npm run test:browser` needs Google Chrome for Testing available to Playwright; set
`CHROME_PATH=/path/to/chrome` if it is not found. Everything binds ephemeral ports, so you can
run the suites repeatedly without port fights.

## 11. Operations

| Task | Command / where |
|---|---|
| Live logs | `npx wrangler tail` |
| Query production data | `npx wrangler d1 execute fly-dragon-db --remote --command "SELECT COUNT(*) FROM chats"` |
| Admin panel | log in as the admin account -> header menu -> Database |
| See who is stuck on legacy password hashes | `SELECT email FROM users WHERE hash_alg IS NOT 'bcrypt'` |
| Storage used | header menu -> R2 Storage (from D1, no bucket listing needed) |
| Wipe a test tenant | `DELETE FROM users WHERE email = '...'` (cascades to chats/messages/files) |

Rollback: `npx wrangler deploy` is atomic per version; Workers -> Versions -> Roll back to the
previous upload. The schema is additive, so an older build keeps running against a newer DB.

## 12. Known limits to tell users about

* PDF attachment text extraction is a lightweight built-in (`src/lib/store.js`): scanned
  passports without a text layer are summarised from the filename only, and the model says so.
* Tools whose upstream credentials are missing report `needs_setup` in the chat and refuse to
  invent prices or rules.
* The rate limiters are per-isolate plus per-account; the hard ceiling is your Cloudflare plan.
