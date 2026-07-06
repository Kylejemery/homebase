# The agent-to-agent booking demo

**The pitch:** today, an AI assistant books with your business by *phoning you* —
navigating your IVR menu, waiting on hold, talking to your receptionist. Homebase
already does that (see `make_phone_call`). But when your business exposes its
booking system as an MCP server, the same assistant books in **two seconds, with
zero phone call** — and this folder is a working model of that future.

Serenity Med Spa is fictional. Its "booking system" is `server.ts`: four MCP
tools (list_services, list_availability, book_appointment, cancel_appointment)
over stdio, with bookings persisted to `bookings.json`.

## Run it

1. Add the server to `~/.homebase/config.json`:

```json
"mcpServers": [
  {
    "name": "medspa",
    "command": "bun",
    "args": ["run", "C:\\path\\to\\homebase\\demo-medspa-mcp\\server.ts"]
  }
]
```

(Use the full path to `bun.exe` if it's not on PATH for spawned processes.)

2. Start Homebase (any mode). You'll see:
   `⚡ MCP: connected 'medspa' (list_services, list_availability, book_appointment, cancel_appointment)`

3. Say: **"Book me a facial Thursday afternoon at the med spa. My name is Kyle."**

The agent discovers the spa's tools, checks real availability, books an open
slot, and hands back a confirmation code — no call, no hold music, no
receptionist interruption. Cancel with: *"cancel my med spa appointment SMS-XXXXX"*.

## The sales-video contrast shot

Same request, two worlds:

| | Phone call (today) | MCP (the pitch) |
|---|---|---|
| Ask | "book me a facial Thursday" | "book me a facial Thursday" |
| What happens | AI dials, discloses itself, navigates "press 2 for appointments", waits on hold, negotiates a slot verbally | agent-to-agent tool calls |
| Time | 3–8 minutes | ~5 seconds |
| Staff time consumed | a receptionist conversation | none |
| Failure modes | busy line, voicemail, misheard times | none observed |

**Verified live 2026-07-06:** booking + cancel + rebook round-trip, including
graceful recovery when the agent first passed a malformed slot time (it listed
availability and retried — the return-error-strings-never-throw convention
doing its job).

## Notes for client adaptations

- The server is ~150 lines. A real integration swaps the JSON file for the
  business's actual calendar/booking API — the MCP surface stays the same.
- Homebase-side MCP client support is generic: any `mcpServers` config entry
  works, not just this demo. Tools appear to the agent as `<name>_<tool>`.
- Watch the model's relative-date reasoning: in testing it once resolved "this
  Thursday" to a Friday. For date-critical flows, have the agent confirm the
  resolved date with the user (already the convention for phone-call briefings).
