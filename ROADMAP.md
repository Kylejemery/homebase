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
- [ ] Google Calendar integration via OAuth2 device flow (no browser redirect server):
      new tools google_calendar_list / google_calendar_add; keep local calendar as fallback
- [ ] `--task` presets: `--task morning-briefing` = today's events + weather + open list items,
      formatted for Telegram delivery (add sendToTelegram option so cron output goes to the
      family chat, not stdout)

## M3 — Call workflow polish (1 session)
- [ ] Auto-followup: after make_phone_call, schedule a check (setTimeout in
      interactive/telegram modes) and proactively message the outcome summary
- [ ] Call log: persist call outcomes to ~/.homebase/calls.json; "what calls have you made?"
- [ ] Wire Vapi webhook alternative for instant results (optional server on Railway;
      keep polling as the no-server default)

## M4 — Model tiering (0.5 session)
- [ ] Route trivial single-tool turns (list add/check) to Haiku; keep orchestrator on the
      strong model. Config flag to disable. Mirror Arete router logic.

## M5 — The consulting demo (1–2 sessions) — HIGH VALUE
- [ ] Build a standalone MCP server (`demo-medspa-mcp/`) exposing a fictional med spa's
      booking calendar (list availability, book slot, cancel)
- [ ] Add MCP client support to Homebase so it can consume that server as tools
- [ ] End-to-end demo script: "book me a facial Thursday" → agent-to-agent booking, no phone call
- [ ] This becomes the "here's how AI assistants will book with your business" sales video

## M6 — iOS surface (later; separate repo)
- React Native/Expo app: chat UI + push notifications, agent brain moves to Railway.
  Architecture sibling of arete-app. Do not start until M1–M3 are done.

## Non-goals (for now)
- Multi-tenant/cloud version (local-first is the product's identity)
- Windows code signing (revisit if a client needs it)
- Local LLM fallback
