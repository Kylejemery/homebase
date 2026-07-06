# Homebase — a distributable household logistics agent

Single executable. Nothing to install on the target machine. All data stays local
in `~/.homebase/` as plain JSON. First run asks for an Anthropic API key.

## Run modes

```bash
./homebase-mac                      # interactive terminal chat
./homebase-mac --task "what's on the calendar today? weather in Raleigh?"
./homebase-mac --telegram           # family texts the agent via Telegram
```

macOS note: first launch of an unsigned binary needs
`xattr -d com.apple.quarantine homebase-mac && chmod +x homebase-mac`
(or right-click → Open). For client delivery, sign + notarize with your
Apple Developer account (`codesign` + `notarytool`) — you already have Team ID VAAKMM3C9G.

## Telegram setup (5 minutes, free)
1. Message @BotFather on Telegram → /newbot → copy the token
2. `./homebase-mac --telegram` → paste token
3. Share the bot handle with the family. Long-polling — no server, no port forwarding.

## Scheduled runs (the "morning briefing" pattern)
cron (Mac/Linux):
```
0 7 * * * /path/to/homebase-mac --task "Summarize today's calendar and the weather" >> ~/homebase.log
```
Windows Task Scheduler → run `homebase-win.exe --task "..."`.

## What it can do
- Named lists: "add milk and eggs to grocery", "show packing list", "check off #3"
- Calendar: "Nora has soccer Saturday at 3", "what's happening this week?" (flags conflicts)
- Family memory: "remember Nora's teacher is Ms. Alvarez", "what's her shoe size?"
- Weather: any city by name (Open-Meteo, no key)
- Local files: "what's in my Downloads folder?"

## Rebuild / extend
```bash
bun install
bun build --compile homebase.ts --outfile homebase                 # this machine
bun build --compile --target=bun-darwin-arm64 homebase.ts --outfile homebase-mac
bun build --compile --target=bun-windows-x64  homebase.ts --outfile homebase-win.exe
```
Each tool is a schema + handler in the TOOLS array. Natural next additions:
Google Calendar OAuth (replace local calendar), Gmail parsing, Twilio SMS,
Home Assistant, MCP servers.

## Phone calling (Vapi)

Homebase can place real phone calls — book appointments, check on city service
requests — via an AI voice agent that can navigate IVR menus ("press 2 for
appointments") using native DTMF keypad tones, wait on hold, and leave voicemails.

Setup (~10 min):
1. Create an account at dashboard.vapi.ai → copy your API key
2. Get a phone number: free Vapi number (US calls) or import your Twilio number → copy its Phone Number ID
3. Add to `~/.homebase/config.json`:
```json
{
  "vapiApiKey": "...",
  "vapiPhoneNumberId": "...",
  "ownerName": "Kyle",
  "ownerCallback": "+1919XXXXXXX"
}
```

Usage: "Call Dr. Patel's office at +1919... and book me an appointment for my
elbow, any weekday after 4pm. You can give my name and DOB 01/01/1990."
The agent confirms the briefing, dials, and you check back for the summary +
transcript ("did the call to the doctor go through?").

Built-in behavior: discloses it's an AI assistant, only shares briefed info,
navigates keypad menus with paced DTMF tones (falls back to speaking the option),
leaves a voicemail with your callback number, escalates gracefully if the office
requires you personally. Cost ≈ 5–15¢/min of call time.
