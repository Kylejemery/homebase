# Deploying the Homebase brain to Railway

The mobile app (`homebase-app`) needs the agent running as an always-on HTTP
server. This deploys `homebase --serve` to Railway.

## One-time setup (dashboard, ~5 min)

1. **railway.app → New Project → Deploy from GitHub repo → `Kylejemery/homebase`.**
   Railway auto-detects Bun (via `bun.lock`) and uses the start command from
   `railway.json`: `bun run homebase.ts --serve`.

2. **Add a persistent volume** (so lists/calendar/memory/sessions survive redeploys):
   - Service → Settings → Volumes → New Volume, mount path `/data`.

3. **Set service variables** (Variables tab). These are runtime env vars — do NOT
   put them in the build, and never commit them:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your Anthropic key (required) |
   | `HOMEBASE_DIR` | `/data` (points storage at the volume) |
   | `HOMEBASE_SERVER_TOKEN` | a long random string — the shared app/server secret |
   | `VAPI_API_KEY` | (optional) enables phone calls |
   | `VAPI_PHONE_NUMBER_ID` | (optional) |
   | `OWNER_NAME` | (optional) e.g. `Kyle` |
   | `OWNER_CALLBACK` | (optional) e.g. `+16175295115` |
   | `HOME_CITY` | (optional) e.g. `Raleigh` for weather |
   | `SCHOOL_MENU_ID` | (optional) MealViewer school id, e.g. `HunterElementaryNC` — adds tomorrow's school lunch to the afternoon debrief |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (optional) for Calendar |
   | `GOOGLE_TOKENS` | (optional) the JSON blob from a local `--google-auth` run — see below |
   | `SUPABASE_URL` | (accounts) the Homebase Supabase project URL |
   | `SUPABASE_ANON_KEY` | (accounts) the project's anon/publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | (accounts) the service role key — mark sensitive |
   | `HOMEBASE_INVITE_CODE` | (accounts) what family members type to create an account |
   | `RESEND_API_KEY` / `HOMEBASE_EMAIL_FROM` | (accounts) sends the "forgot username" email, e.g. `Homebase <hello@yourdomain>` |

   Railway injects `PORT` automatically; the server reads it.

4. **Generate a domain**: Service → Settings → Networking → Generate Domain.
   That HTTPS URL is `extra.serverUrl` in the app's app.json.

## Household accounts

App 1.1.0+ signs each person in with a username or email and a password,
through `/auth/*` here, with Supabase Auth behind it. The schema lives in the
homebase-app repo (`supabase/migrations/`) and the full contract in its
`docs/brain-auth.md`. In the Supabase dashboard:

- Authentication → Sign In / Providers: turn **off** "Allow new users to sign up"
  (the brain creates users after checking `HOMEBASE_INVITE_CODE`).
- Authentication → Emails → SMTP: set up custom SMTP (e.g. Resend). The built-in
  mailer only reaches the project's team members.
- Authentication → Emails → Reset Password template: send the code, e.g.
  `Your Homebase reset code is {{ .Token }}. It expires in 1 hour.`

Without the `SUPABASE_*` variables accounts stay off and only
`HOMEBASE_SERVER_TOKEN` works. With them, both work, so 1.0.0 phones keep running
until they update.

## Google Calendar on the server (optional)

Google's tokens are per-OAuth-client. Easiest path: run `homebase --google-auth`
locally once (already done), then copy the `googleTokens` object from
`~/.homebase/config.json` and paste it as the `GOOGLE_TOKENS` variable (as a single
JSON line). The server refreshes the access token automatically from the refresh
token. Also set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Verify

```bash
curl https://<your-domain>/health          # → {"ok":true,"version":"0.1.0"}
curl -X POST https://<your-domain>/chat \
  -H "Authorization: Bearer <HOMEBASE_SERVER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test","message":"add milk to the grocery list"}'
```

Then open the app → Connect → paste the domain + token → chat.

## Notes
- The Telegram bot and Task Scheduler morning-briefing keep running wherever you
  run them (your machine or a second Railway service with `--telegram`); they're
  independent of this server.
- Secrets are read at runtime from env (see `hydrateConfigFromEnv`), so they are
  not baked into the build image.
