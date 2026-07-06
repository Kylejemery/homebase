# CLAUDE.md — Homebase

## What this is
Homebase is a **distributable household logistics agent**: a single TypeScript file
that compiles (via `bun build --compile`) into standalone executables for Mac/Windows/Linux.
No runtime installs on target machines. All user data is local JSON in `~/.homebase/`.
The end user supplies their own Anthropic API key on first run.

This is also the reference architecture for Kyle's AI agent consulting business —
patterns proven here (briefed voice calls, tool tiering, local-first storage,
Telegram interface) get adapted for client deliverables.

## Architecture (all in homebase.ts, intentionally single-file for compile simplicity)
1. **Storage** — `load()`/`save()` helpers, plain JSON per domain in `~/.homebase/`
2. **Config** — `~/.homebase/config.json`: apiKey, telegramBotToken, vapiApiKey,
   vapiPhoneNumberId, ownerName, ownerCallback
3. **Tools** — each is `{ schema: Anthropic.Tool, handler: (input) => Promise<string> }`
   in the `TOOLS` array: manage_lists, manage_calendar, family_memory, get_weather,
   list_files, make_phone_call (Vapi), check_phone_call
4. **Agent loop** — `runAgentTurn()`: call Claude with tools → execute tool_use blocks →
   feed tool_results back → repeat until stop_reason != "tool_use"
5. **Interfaces** — terminal chat (default), `--task "..."` one-shot for cron,
   `--telegram` long-polling bot (multi-user, per-chat history)

## Model strategy (mirror of the Arete router pattern)
- Orchestrator (this agent): strongest available model for planning/briefing
- Voice calls (Vapi assistant): fast model — latency beats intelligence on a live call
- Trivial turns (list adds): candidate for Haiku routing (not yet implemented, see ROADMAP)
- Verify current model IDs/pricing at docs.claude.com before changing defaults

## Conventions
- Single file until it genuinely hurts; if splitting, keep compile target trivial
- Every tool handler returns a plain string (what the model sees) — never throw, return error text
- Never log or persist the user's API keys anywhere except ~/.homebase/config.json
- Phone call briefings MUST be confirmed with the user before dialing (enforced in system prompt —
  keep it that way)
- The call agent must always disclose it's an AI assistant; never share info outside its briefing
- Type-check with `npm run typecheck` before any compile; smoke-test storage logic on change

## Commands
- `bun install` then `bun run dev` — interactive
- `npm run typecheck` — strict tsc pass (must be clean)
- `npm run build:all` — Mac + Windows executables into dist/

## Key external services
- Anthropic API (agent brain) — user's own key
- Vapi (voice calls, dtmf/IVR navigation, voicemail detection) — https://docs.vapi.ai
  - Outbound: POST https://api.vapi.ai/call with transient assistant + phoneNumberId + customer.number
  - Built-in tools used: dtmf, endCall
- Telegram Bot API (family interface) — long polling, no server needed
- Open-Meteo (weather + geocoding) — no key

## Gotchas
- Bun compile embeds the runtime: binaries are 60–95MB, that's expected
- macOS quarantines unsigned binaries: `xattr -d com.apple.quarantine` for dev;
  codesign + notarize (Team ID VAAKMM3C9G) for distribution
- Telegram history is in-memory only (resets on restart) — persistence is a roadmap item
- Vapi DTMF: send digits paced (1w2w3), fall back to speaking the option — already in the call prompt
- The readline interface and Telegram loop must never run simultaneously
