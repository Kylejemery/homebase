# ROADMAP.md — prioritized milestones

Work top-down. Each milestone should end with `npm run typecheck` clean and a
manual test note added below it. Ask Kyle before adding new external services.

## M1 — Ship-ready quality on what exists (1 session)
- [x] Guided first-run setup: interactive prompts for Vapi keys + owner name/callback
      (currently manual JSON editing)
- [x] `--version` and `--help` flags
- [x] Persist Telegram per-chat history to ~/.homebase/sessions.json (survive restarts)
- [x] Telegram allowlist: only respond to chat IDs the owner approves (first user to
      message becomes owner; others need approval) — this is a privacy requirement
      before family use
- [x] Graceful handling when Anthropic API returns 429/529 (retry with backoff)

**Manual test note (2026-07-06):** `npm run typecheck` clean. `--version`/`--help`
verified to bypass config entirely. First-run setup smoke-tested end to end
(prompts for API key, offers/declines Vapi setup, writes `setupComplete: true` to
config.json) with a real `--task` call completing successfully. Telegram
allowlist and session persistence are implemented but not yet tested live against
the Telegram API (needs a bot token) — do that before family rollout.

## M2 — Real calendar + morning briefing (1–2 sessions)
- [x] Google Calendar integration — NOTE: device flow doesn't allow Calendar scopes
      (verified against Google's allowed-scope list), so this uses the standard
      installed-app loopback flow instead: `--google-auth` runs a localhost listener
      only for the seconds the browser approval takes. New tools google_calendar_list /
      google_calendar_add; local calendar remains the fallback
- [x] `--task` presets: `--task morning-briefing` = today's events + weather + open list items;
      `--to-telegram` delivers the output to the owner's Telegram chat instead of stdout

**Manual test note (2026-07-06):** typecheck clean. `--task morning-briefing --to-telegram`
tested live: agent tried Google Calendar (graceful "not connected" fallback), read local
calendar + memory + lists, and the briefing arrived in Kyle's Telegram chat. Google OAuth
itself not yet exercised — needs Kyle to create the OAuth client (Desktop app) in
console.cloud.google.com, then run `homebase --google-auth`. Cron/Task Scheduler entry
for the daily run is also still a user-side step.

## M3 — Call workflow polish (1 session)
- [x] Auto-followup: after make_phone_call, schedule a check (setTimeout in
      interactive/telegram modes) and proactively message the outcome summary
- [x] Call log: persist call outcomes to ~/.homebase/calls.json; "what calls have you made?"
      (check_phone_call with no call_id now returns the log)
- [ ] Wire Vapi webhook alternative for instant results (optional server on Railway;
      keep polling as the no-server default) — DEFERRED: new external service, needs
      Kyle's sign-off per the rule above; polling default works

**Manual test note (2026-07-06):** typecheck clean. Call log verified via earlier live
test call. Auto-followup logic implemented (2-min poll, max 10 attempts, notifies the
requesting chat); not yet exercised with a live call placed from telegram/interactive —
verify on next real call.

## M4 — Model tiering (0.5 session)
- [x] Route trivial single-tool turns (list add/check) to Haiku; keep orchestrator on the
      strong model. Config flag to disable (`"haikuRouting": false`). Mirror Arete router logic.

**Manual test note (2026-07-06):** typecheck clean. `--task "add apples to the grocery
list"` logged `⚡ routing trivial turn to claude-haiku-4-5` and completed correctly.
Routing is a regex heuristic on the latest user message (list add/check/show patterns).

## M5 — The consulting demo (1–2 sessions) — HIGH VALUE
- [x] Build a standalone MCP server (`demo-medspa-mcp/`) exposing a fictional med spa's
      booking calendar (list availability, book slot, cancel + list_services)
- [x] Add MCP client support to Homebase so it can consume that server as tools
      (generic: any `mcpServers` entry in config.json; tools appear as `<name>_<tool>`)
- [x] End-to-end demo script: "book me a facial Thursday" → agent-to-agent booking, no phone call
      (see demo-medspa-mcp/DEMO.md)
- [ ] This becomes the "here's how AI assistants will book with your business" sales video
      (video itself is Kyle's; the demo it records is done)

**Manual test note (2026-07-06):** typecheck clean (script now covers server.ts too).
Live end-to-end: agent connected to the spa server, listed availability, booked, cancelled,
rebooked — including graceful recovery from a malformed slot format. Gotcha hit: MCP SDK
+ zod need a single zod copy — repo pins zod ^4.4.3 (SDK accepts ^3.25 || ^4). One model
slip observed: "this Thursday" resolved to a Friday once — DEMO.md notes date-confirmation
guidance for date-critical flows.

## M6 — iOS surface (later; separate repo)
- React Native/Expo app: chat UI + push notifications, agent brain moves to Railway.
  Architecture sibling of arete-app. Do not start until M1–M3 are done.

## Non-goals (for now)
- Multi-tenant/cloud version (local-first is the product's identity)
- Windows code signing (revisit if a client needs it)
- Local LLM fallback
