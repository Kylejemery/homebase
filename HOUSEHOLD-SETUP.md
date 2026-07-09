# Set up Homebase for YOUR household

Every household runs its own private brain — your data lives on your own server,
your own API keys pay for your own usage, and nobody else (including other
Homebase households) can see any of it. Setup is ~20 minutes.

## 1. Accounts you need (all free to create)

- **Anthropic API key** — console.anthropic.com → API keys (the agent's brain; pay-per-use, a few $/month for a family)
- **Railway account** — railway.com (hosts your brain; ~$5/month hobby plan)
- Optional, add anytime later:
  - **Vapi** (dashboard.vapi.ai) — lets the agent make real phone calls
  - **Google Cloud OAuth client** — connects Google Calendar + Gmail (see step 4)
  - **Telegram bot** (@BotFather) — text the agent from Telegram too

## 2. Deploy the brain on Railway

1. Fork or use this repo: `github.com/Kylejemery/homebase`
2. Railway → New Project → **Deploy from GitHub repo** → pick it
   (the included `Dockerfile` is used automatically)
3. **Attach a Volume** (⌘K → "volume") with mount path `/data` — REQUIRED,
   this is where your family's data lives; without it every deploy wipes it
4. Service → **Variables** — set at minimum:
   ```
   ANTHROPIC_API_KEY   = sk-ant-...
   HOMEBASE_DIR        = /data
   HOMEBASE_SERVER_TOKEN = <a long random string you make up — this is your family's password>
   ```
   Optional: `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `OWNER_NAME`, `OWNER_CALLBACK`,
   `HOME_CITY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`,
   `BRIEFING_TIME` / `DEBRIEF_TIME` / `NUDGE_TIME` / `REFLECTION_TIME`, `BRIEFING_TZ`
5. Settings → Networking → **Generate Domain** → note the URL
6. Check `https://<your-domain>/health` in a browser → `{"ok":true}` = live

## 3. Get the app on your phones

Ask Kyle for a TestFlight invite (App Store release may come later). Install,
open, and on the Connect screen enter your server URL + your
`HOMEBASE_SERVER_TOKEN`. Allow notifications — that's how the daily briefings
arrive. Every phone in your household uses the same URL + token and shares the
same lists/calendar/memory.

## 4. Google Calendar + email (optional)

Create a Google Cloud project → enable **Calendar API** and **Gmail API** →
OAuth consent screen (add your family as test users) → create TWO OAuth clients:

- **Desktop app** client → put its id/secret in the server config, run
  `homebase --google-auth` locally once, then copy the tokens to Railway as
  `GOOGLE_TOKENS` (plus `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). This is the
  HOUSEHOLD calendar connection used by briefings.
- **Web application** client with redirect URI
  `https://<your-domain>/oauth/google/callback` → set `GOOGLE_WEB_CLIENT_ID` and
  `GOOGLE_WEB_CLIENT_SECRET` on Railway. This powers the ✉ button in the app:
  each person connects their OWN email, and their inbox summaries appear ONLY
  on their own phone.

## What you get

- Chat with a family agent that manages lists, calendar, memory, weather
- Grocery tab (shared, tap to check off, recipe import from link or photo)
- Calendar tab (Google + family events, tap to edit)
- 📄 document scanning into family memory
- Daily rhythm: 5:30 restock → 7:00 briefing → 4:30 debrief → 8:00 heads-up
  nudge → 9:30 habit learning — pushed to every phone
- Optional: real phone calls (Vapi), SMS (Twilio), Telegram
