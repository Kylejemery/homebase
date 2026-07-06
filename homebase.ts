/**
 * HOMEBASE — a distributable household logistics agent
 * =====================================================
 * Compiles to a single executable. No installs needed on the target machine.
 *
 *   bun build --compile homebase.ts --outfile homebase
 *
 * Three ways to run it:
 *   ./homebase                     interactive terminal chat
 *   ./homebase --task "..."        one-shot task (for cron / Task Scheduler)
 *   ./homebase --telegram          Telegram bot mode — your family texts the agent
 *
 * Capabilities (all local-first, zero external accounts required):
 *   • Named lists      — grocery, todos, packing, anything ("add milk to grocery")
 *   • Calendar         — add/list events, check a day, find conflicts
 *   • Family memory    — remembers facts ("Nora's shoe size is 13T")
 *   • Weather          — any city by name (Open-Meteo geocoding, no key)
 *   • Local files      — list directories on this machine
 *
 * Data lives in ~/.homebase/ as plain JSON — inspectable, portable, private.
 * First run asks for an Anthropic API key (stored locally; user pays own usage).
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as os from "os";
import * as http from "http";
import { exec } from "child_process";

// Keep in sync with package.json
const VERSION = "0.1.0";

const HELP_TEXT = `Homebase ${VERSION} — a distributable household logistics agent

Usage:
  homebase                       interactive terminal chat
  homebase --task "..."          one-shot task (for cron / Task Scheduler)
  homebase --task morning-briefing   preset: today's events + weather + open lists
  homebase --to-telegram         with --task: deliver output to the owner's Telegram chat
  homebase --telegram            Telegram bot mode — family texts the agent
  homebase --google-auth         connect Google Calendar (one-time OAuth in your browser)
  homebase --version, -v         print version
  homebase --help, -h            show this help

Data lives in ~/.homebase/ as plain JSON. First run walks through setup
(Anthropic API key, optional Vapi phone-calling config).`;

// ═══════════════════════════════════════════════════════════════════════════
// Storage — plain JSON files in ~/.homebase
// ═══════════════════════════════════════════════════════════════════════════

const DIR = path.join(os.homedir(), ".homebase");
const FILE = (name: string) => path.join(DIR, `${name}.json`);

function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(FILE(name), "utf-8"));
  } catch {
    return fallback;
  }
}
function save(name: string, data: unknown) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE(name), JSON.stringify(data, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// Config / API key
// ═══════════════════════════════════════════════════════════════════════════

interface Config {
  apiKey?: string;
  telegramBotToken?: string;
  homeCity?: string;
  vapiApiKey?: string;
  vapiPhoneNumberId?: string;
  ownerName?: string;
  ownerCallback?: string;
  setupComplete?: boolean;
  telegramOwnerChatId?: number;
  telegramApproved?: number[];
  telegramPending?: number[];
  googleClientId?: string;
  googleClientSecret?: string;
  googleTokens?: { access_token: string; refresh_token?: string; expires_at?: number };
}

function askOnce(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(question, (a) => {
      rl.close();
      res(a.trim());
    })
  );
}

async function getConfig(): Promise<Config> {
  const cfg = load<Config>("config", {});
  if (process.env.ANTHROPIC_API_KEY) cfg.apiKey = process.env.ANTHROPIC_API_KEY;

  if (!cfg.setupComplete) {
    console.log("Welcome to Homebase — first-run setup.\n");
    if (!cfg.apiKey) {
      cfg.apiKey = await askOnce("Anthropic API key: ");
    }
    const wantsCalls = await askOnce("Set up phone calling via Vapi now? (y/N): ");
    if (/^y/i.test(wantsCalls)) {
      cfg.vapiApiKey = (await askOnce("Vapi API key (dashboard.vapi.ai): ")) || cfg.vapiApiKey;
      cfg.vapiPhoneNumberId = (await askOnce("Vapi phone number id: ")) || cfg.vapiPhoneNumberId;
      cfg.ownerName = (await askOnce("Your name (used in call briefings): ")) || cfg.ownerName;
      cfg.ownerCallback = (await askOnce("Callback number for voicemails (+1...): ")) || cfg.ownerCallback;
    } else {
      console.log(`Skipping — add Vapi keys anytime by editing ${FILE("config")}\n`);
    }
    cfg.setupComplete = true;
    save("config", cfg);
    console.log(`Setup saved to ${FILE("config")}\n`);
  }
  return cfg;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tools
// ═══════════════════════════════════════════════════════════════════════════

type Handler = (input: any) => Promise<string>;
interface AgentTool {
  schema: Anthropic.Tool;
  handler: Handler;
}

// ── Named lists (grocery, todos, packing, ...) ─────────────────────────────

type Lists = Record<string, { id: number; item: string; done: boolean }[]>;

const listsTool: AgentTool = {
  schema: {
    name: "manage_lists",
    description:
      "Manage named household lists (e.g. 'grocery', 'todos', 'packing', 'hardware store'). " +
      "Actions: 'show' one list or all lists, 'add' an item, 'check' (mark done) by id, " +
      "'remove' by id, 'clear_done' to purge completed items from a list.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["show", "add", "check", "remove", "clear_done"] },
        list: { type: "string", description: "List name, lowercase. Omit with 'show' to see all lists." },
        item: { type: "string", description: "Item text (for 'add')" },
        id: { type: "number", description: "Item id (for 'check'/'remove')" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const lists = load<Lists>("lists", {});
    const name = input.list?.toLowerCase();
    switch (input.action) {
      case "show": {
        if (!name) {
          const names = Object.keys(lists);
          return names.length
            ? names.map((n) => `${n} (${lists[n].filter((i) => !i.done).length} open)`).join("\n")
            : "No lists yet.";
        }
        const l = lists[name] ?? [];
        return l.length
          ? `${name}:\n` + l.map((i) => `  [${i.done ? "x" : " "}] #${i.id} ${i.item}`).join("\n")
          : `'${name}' is empty.`;
      }
      case "add": {
        lists[name] ??= [];
        const id = (lists[name].at(-1)?.id ?? 0) + 1;
        lists[name].push({ id, item: input.item, done: false });
        save("lists", lists);
        return `Added to ${name}: #${id} ${input.item}`;
      }
      case "check": {
        const it = lists[name]?.find((i) => i.id === input.id);
        if (!it) return `No #${input.id} in ${name}.`;
        it.done = true;
        save("lists", lists);
        return `Checked off: ${it.item}`;
      }
      case "remove": {
        const l = lists[name] ?? [];
        const idx = l.findIndex((i) => i.id === input.id);
        if (idx === -1) return `No #${input.id} in ${name}.`;
        const [r] = l.splice(idx, 1);
        save("lists", lists);
        return `Removed: ${r.item}`;
      }
      case "clear_done": {
        if (!lists[name]) return `No list '${name}'.`;
        const before = lists[name].length;
        lists[name] = lists[name].filter((i) => !i.done);
        save("lists", lists);
        return `Cleared ${before - lists[name].length} completed item(s) from ${name}.`;
      }
      default:
        return "Unknown action.";
    }
  },
};

// ── Calendar (local event store) ───────────────────────────────────────────

interface CalEvent {
  id: number;
  title: string;
  start: string; // ISO datetime
  end?: string;
  who?: string;
  notes?: string;
}

const calendarTool: AgentTool = {
  schema: {
    name: "manage_calendar",
    description:
      "The family calendar. Actions: 'add' an event, 'day' to see a specific date's events, " +
      "'upcoming' for the next N days, 'remove' by id. When adding, resolve relative dates " +
      "('Saturday', 'tomorrow') to ISO datetimes yourself using today's date. Also report any " +
      "time conflicts you notice with existing events.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "day", "upcoming", "remove"] },
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime, e.g. 2026-07-11T15:00" },
        end: { type: "string", description: "ISO datetime (optional)" },
        who: { type: "string", description: "Family member(s) involved (optional)" },
        notes: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (for 'day')" },
        days: { type: "number", description: "How many days ahead (for 'upcoming', default 7)" },
        id: { type: "number", description: "Event id (for 'remove')" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const events = load<CalEvent[]>("calendar", []);
    const fmt = (e: CalEvent) => {
      const d = new Date(e.start);
      const when = d.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      return `#${e.id} ${when} — ${e.title}${e.who ? ` (${e.who})` : ""}${e.notes ? ` — ${e.notes}` : ""}`;
    };
    switch (input.action) {
      case "add": {
        const id = (events.at(-1)?.id ?? 0) + 1;
        const ev: CalEvent = { id, title: input.title, start: input.start, end: input.end, who: input.who, notes: input.notes };
        events.push(ev);
        events.sort((a, b) => a.start.localeCompare(b.start));
        save("calendar", events);
        // naive conflict check: same calendar day, overlapping hour
        const day = input.start.slice(0, 10);
        const clashes = events.filter(
          (e) => e.id !== id && e.start.slice(0, 10) === day &&
            Math.abs(new Date(e.start).getTime() - new Date(input.start).getTime()) < 90 * 60 * 1000
        );
        return `Added: ${fmt(ev)}` + (clashes.length ? `\n⚠ Possible conflict with: ${clashes.map(fmt).join("; ")}` : "");
      }
      case "day": {
        const dayEvents = events.filter((e) => e.start.slice(0, 10) === input.date);
        return dayEvents.length ? dayEvents.map(fmt).join("\n") : `Nothing on ${input.date}.`;
      }
      case "upcoming": {
        const now = new Date();
        const horizon = new Date(now.getTime() + (input.days ?? 7) * 86400000);
        const up = events.filter((e) => new Date(e.start) >= now && new Date(e.start) <= horizon);
        return up.length ? up.map(fmt).join("\n") : "Nothing coming up.";
      }
      case "remove": {
        const idx = events.findIndex((e) => e.id === input.id);
        if (idx === -1) return `No event #${input.id}.`;
        const [r] = events.splice(idx, 1);
        save("calendar", events);
        return `Removed: ${r.title}`;
      }
      default:
        return "Unknown action.";
    }
  },
};

// ── Family memory (facts the agent should remember) ────────────────────────

const memoryTool: AgentTool = {
  schema: {
    name: "family_memory",
    description:
      "Long-term memory for household facts: sizes, allergies, teacher names, wifi password locations, " +
      "preferences, anything worth remembering. Actions: 'remember' (key + fact), 'recall' (search by " +
      "keyword, or omit to see everything), 'forget' (by key). Proactively remember useful facts users mention.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["remember", "recall", "forget"] },
        key: { type: "string", description: "Short label, e.g. 'nora-shoe-size'" },
        fact: { type: "string" },
        query: { type: "string", description: "Keyword filter for 'recall'" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const mem = load<Record<string, string>>("memory", {});
    switch (input.action) {
      case "remember":
        mem[input.key] = input.fact;
        save("memory", mem);
        return `Remembered: ${input.key} = ${input.fact}`;
      case "recall": {
        const entries = Object.entries(mem).filter(
          ([k, v]) => !input.query || (k + " " + v).toLowerCase().includes(input.query.toLowerCase())
        );
        return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join("\n") : "Nothing found.";
      }
      case "forget":
        if (!(input.key in mem)) return `No memory '${input.key}'.`;
        delete mem[input.key];
        save("memory", mem);
        return `Forgot ${input.key}.`;
      default:
        return "Unknown action.";
    }
  },
};

// ── Weather with geocoding (city name → forecast, no API key) ──────────────

const weatherTool: AgentTool = {
  schema: {
    name: "get_weather",
    description: "Current weather + today's high/low for any city, by name.",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "e.g. 'Raleigh' or 'Raleigh, NC'" } },
      required: ["city"],
    },
  },
  handler: async (input) => {
    const geo: any = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.city)}&count=1`)
    ).json();
    const place = geo.results?.[0];
    if (!place) return `Couldn't find '${input.city}'.`;
    const wx: any = await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,precipitation,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`
      )
    ).json();
    const c = wx.current, d = wx.daily;
    return (
      `${place.name}, ${place.admin1 ?? place.country}: currently ${c.temperature_2m}°F, wind ${c.wind_speed_10m} km/h. ` +
      `Today: high ${d.temperature_2m_max[0]}°F / low ${d.temperature_2m_min[0]}°F, ` +
      `${d.precipitation_probability_max[0]}% chance of precipitation.`
    );
  },
};

// ── Local files ─────────────────────────────────────────────────────────────

const filesTool: AgentTool = {
  schema: {
    name: "list_files",
    description: "List files in a directory on this machine. '~' = home directory.",
    input_schema: {
      type: "object",
      properties: { directory: { type: "string" } },
      required: ["directory"],
    },
  },
  handler: async (input) => {
    const dir = input.directory.replace(/^~/, os.homedir());
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.slice(0, 60).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)";
    } catch (err: any) {
      return `Could not read ${dir}: ${err.message}`;
    }
  },
};

// ── Google Calendar (OAuth loopback flow; local calendar stays as fallback) ─
//
// Google's device flow doesn't allow Calendar scopes, so we use the standard
// installed-app loopback flow: a localhost listener that exists only for the
// seconds it takes the user to approve in their browser. One-time setup:
//   1. console.cloud.google.com → create project → enable Google Calendar API
//   2. OAuth consent screen → add yourself as a test user
//   3. Credentials → Create OAuth client ID → type "Desktop app"
//   4. Run: homebase --google-auth   (paste client id + secret when prompted)

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

async function googleAccessToken(): Promise<string | null> {
  const cfg = load<Config>("config", {});
  const t = cfg.googleTokens;
  if (!t || !cfg.googleClientId || !cfg.googleClientSecret) return null;
  if (t.expires_at && Date.now() < t.expires_at - 60_000) return t.access_token;
  if (!t.refresh_token) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json();
  if (!res.ok) return null;
  cfg.googleTokens = {
    ...t,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  save("config", cfg);
  return data.access_token;
}

async function googleConnect() {
  const cfg = load<Config>("config", {});
  if (!cfg.googleClientId || !cfg.googleClientSecret) {
    console.log(
      "One-time Google setup: console.cloud.google.com → enable Calendar API →\n" +
        "OAuth consent screen (add yourself as test user) → Credentials → OAuth client ID, type 'Desktop app'.\n"
    );
    cfg.googleClientId = await askOnce("Google OAuth client ID: ");
    cfg.googleClientSecret = await askOnce("Google OAuth client secret: ");
    save("config", cfg);
  }

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const c = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (!c && !err) { res.writeHead(404); res.end(); return; } // favicon etc.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(c ? "<h2>Homebase is connected to Google Calendar. You can close this tab.</h2>" : `<h2>Auth failed: ${err}</h2>`);
      const port = (server.address() as any).port;
      server.close();
      c ? resolve({ code: c, redirectUri: `http://127.0.0.1:${port}` }) : reject(new Error(err ?? "no code returned"));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: cfg.googleClientId!,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: "code",
          scope: GOOGLE_SCOPE,
          access_type: "offline",
          prompt: "consent",
        });
      console.log(`\nOpen this URL in your browser to approve access:\n\n${authUrl}\n`);
      const opener = process.platform === "win32" ? `start "" "${authUrl}"` : process.platform === "darwin" ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      exec(opener, () => {}); // best effort — the printed URL is the fallback
    });
    setTimeout(() => { server.close(); reject(new Error("Timed out waiting for browser approval (5 min).")); }, 300_000);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleClientId!,
      client_secret: cfg.googleClientSecret!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  cfg.googleTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  save("config", cfg);
  console.log("Google Calendar connected. Homebase will now prefer it over the local calendar.");
}

const GCAL_NOT_CONNECTED =
  "Google Calendar isn't connected (run: homebase --google-auth). Use the local manage_calendar tool instead.";

const gcalFmt = (e: any) => {
  const start = e.start?.dateTime ?? e.start?.date ?? "?";
  const when = e.start?.dateTime
    ? new Date(e.start.dateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : `${start} (all day)`;
  return `${when} — ${e.summary ?? "(untitled)"}${e.location ? ` @ ${e.location}` : ""}`;
};

const gcalListTool: AgentTool = {
  schema: {
    name: "google_calendar_list",
    description:
      "List events from the family's real Google Calendar (primary). Prefer this over manage_calendar for " +
      "READING the schedule when connected. Use 'date' for one day or 'days' for the next N days.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD for a single day" },
        days: { type: "number", description: "Days ahead from now (default 1)" },
      },
      required: [],
    },
  },
  handler: async (input) => {
    const token = await googleAccessToken();
    if (!token) return GCAL_NOT_CONNECTED;
    let timeMin: string, timeMax: string;
    if (input.date) {
      timeMin = new Date(`${input.date}T00:00:00`).toISOString();
      timeMax = new Date(`${input.date}T23:59:59`).toISOString();
    } else {
      timeMin = new Date().toISOString();
      timeMax = new Date(Date.now() + (input.days ?? 1) * 86400000).toISOString();
    }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "25" }),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data: any = await res.json();
    if (!res.ok) return `Google Calendar error: ${data.error?.message ?? res.status}`;
    const items = data.items ?? [];
    return items.length ? items.map(gcalFmt).join("\n") : "Nothing on the Google calendar for that window.";
  },
};

const gcalAddTool: AgentTool = {
  schema: {
    name: "google_calendar_add",
    description:
      "Add an event to the family's real Google Calendar (primary). Prefer this over manage_calendar for " +
      "ADDING events when connected. Resolve relative dates to ISO datetimes first.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime, e.g. 2026-07-11T15:00" },
        end: { type: "string", description: "ISO datetime (default: start + 1 hour)" },
        all_day: { type: "boolean", description: "All-day event (start is then YYYY-MM-DD)" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title", "start"],
    },
  },
  handler: async (input) => {
    const token = await googleAccessToken();
    if (!token) return GCAL_NOT_CONNECTED;
    const body: any = { summary: input.title, location: input.location, description: input.notes };
    if (input.all_day) {
      const day = input.start.slice(0, 10);
      const next = new Date(new Date(`${day}T00:00:00`).getTime() + 86400000).toISOString().slice(0, 10);
      body.start = { date: day };
      body.end = { date: next };
    } else {
      const startMs = new Date(input.start).getTime();
      body.start = { dateTime: new Date(startMs).toISOString() };
      body.end = { dateTime: new Date(input.end ? new Date(input.end).getTime() : startMs + 3600000).toISOString() };
    }
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await res.json();
    if (!res.ok) return `Google Calendar error: ${data.error?.message ?? res.status}`;
    return `Added to Google Calendar: ${gcalFmt(data)}${data.htmlLink ? `\n${data.htmlLink}` : ""}`;
  },
};

// ── Phone calls via Vapi (make appointments, check on service requests) ────
//
// Requires in ~/.homebase/config.json:
//   "vapiApiKey":        from dashboard.vapi.ai
//   "vapiPhoneNumberId": a phone number in your Vapi account (free Vapi number or imported Twilio)
//   "ownerName":         who the agent is calling on behalf of, e.g. "Kyle"
//   "ownerCallback":     callback number to leave in voicemails, e.g. "+19195551234"
//
// The voice assistant is created transiently per call with a briefing, and has
// Vapi's built-in dtmf tool — so it can navigate "press 2 for appointments"
// menus — plus endCall, and instructions for voicemail and graceful escalation.

function vapiCfg(): Config {
  return load<Config>("config", {});
}

const CALL_AGENT_PROMPT = (briefing: string, cfg: Config) => `
You are a polite, efficient phone assistant calling on behalf of ${cfg.ownerName ?? "your client"}.

YOUR TASK:
${briefing}

RULES:
- At the start of a human conversation, disclose naturally: "Hi, I'm an AI assistant calling on behalf of ${cfg.ownerName ?? "my client"}."
- Only share information included in your task briefing. If asked for anything else (SSN, payment details, medical history not in the briefing), say ${cfg.ownerName ?? "they"} will provide that directly, and offer the callback number.
- IVR MENUS: If you reach an automated menu, listen to ALL the options before acting. Then use the dtmf tool to press the right key. Send digits slowly with pauses (e.g. "1w2" not "12"). If tones don't register after two tries, SAY the option number out loud instead.
- HOLD: If placed on hold, wait patiently and silently.
- VOICEMAIL: If you reach voicemail, leave a brief message: who you're calling for, the purpose, and the callback number ${cfg.ownerCallback ?? "(none provided — just say they'll call back)"}. Then use endCall.
- If the office requires ${cfg.ownerName ?? "the client"} personally, don't push. Ask what they'll need when calling back, thank them, and end the call.
- When your task is complete or clearly cannot be completed, summarize the outcome verbally ("Great, so that's confirmed for...") then use endCall.
- Be warm and brief. Receptionists are busy.
`.trim();

const phoneCallTool: AgentTool = {
  schema: {
    name: "make_phone_call",
    description:
      "Place a real phone call via an AI voice agent (Vapi). Use for booking appointments, checking on " +
      "service requests, asking a business a question, etc. Provide the number in E.164 format (+1...) and a " +
      "COMPLETE briefing: purpose, what info may be shared (name, DOB, insurance if relevant), " +
      "acceptable outcomes (e.g. availability windows for appointments), and what to do on voicemail. " +
      "ALWAYS confirm the briefing and number with the user before calling. Returns a call id — check the " +
      "outcome later with check_phone_call.",
    input_schema: {
      type: "object",
      properties: {
        phone_number: { type: "string", description: "E.164, e.g. +19195551234" },
        briefing: { type: "string", description: "Complete task briefing for the voice agent" },
        first_message: {
          type: "string",
          description: "Opening line if a human answers, e.g. \"Hi! I'm an AI assistant calling on behalf of Kyle...\"",
        },
      },
      required: ["phone_number", "briefing"],
    },
  },
  handler: async (input) => {
    const cfg = vapiCfg();
    if (!cfg.vapiApiKey || !cfg.vapiPhoneNumberId)
      return "Phone calling isn't configured. Add vapiApiKey and vapiPhoneNumberId to " + FILE("config");
    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.vapiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumberId: cfg.vapiPhoneNumberId,
        customer: { number: input.phone_number },
        assistant: {
          firstMessageMode: "assistant-waits-for-user", // let them say "Doctor's office, how can I help?"
          firstMessage: input.first_message,
          model: {
            provider: "anthropic",
            // Vapi requires exact dated IDs (no aliases); fast model on live calls per CLAUDE.md
            model: "claude-haiku-4-5-20251001",
            messages: [{ role: "system", content: CALL_AGENT_PROMPT(input.briefing, cfg) }],
            tools: [{ type: "dtmf" }, { type: "endCall" }],
          },
          voicemailDetection: { provider: "twilio" },
          maxDurationSeconds: 900,
        },
      }),
    });
    const data: any = await res.json();
    if (!res.ok) return `Call failed to start: ${JSON.stringify(data)}`;
    const calls = load<CallLogEntry[]>("calls", []);
    calls.push({
      id: data.id,
      number: input.phone_number,
      purpose: input.briefing.slice(0, 140),
      placedAt: new Date().toISOString(),
      status: "in-progress",
    });
    save("calls", calls);
    PENDING_FOLLOWUPS.push(data.id);
    return `Call placed (id: ${data.id}). Dialing ${input.phone_number} now. I'll follow up with the outcome automatically, or use check_phone_call to check sooner.`;
  },
};

interface CallLogEntry {
  id: string;
  number: string;
  purpose: string;
  placedAt: string;
  status: string;
  summary?: string;
  endedAt?: string;
}

// Call ids awaiting an automatic outcome check — drained by the active interface
// (terminal/Telegram) after each turn; task mode exits too fast to follow up.
const PENDING_FOLLOWUPS: string[] = [];

function scheduleCallFollowups(notify: (text: string) => void) {
  for (const id of PENDING_FOLLOWUPS.splice(0)) {
    let attempts = 0;
    const poll = async () => {
      attempts++;
      let out: string;
      try {
        out = await checkCallTool.handler({ call_id: id });
      } catch (err: any) {
        out = `Followup check failed: ${err.message}`;
      }
      if (out.includes("Not finished yet") && attempts < 10) {
        setTimeout(poll, 120_000);
        return;
      }
      notify(`📞 Call followup:\n${out}`);
    };
    setTimeout(poll, 120_000);
  }
}

const checkCallTool: AgentTool = {
  schema: {
    name: "check_phone_call",
    description:
      "Check the status/outcome of a phone call placed with make_phone_call. Returns status, summary, " +
      "and transcript when the call has ended. OMIT call_id to see the call log (recent calls with " +
      "their outcomes) — use that for questions like 'what calls have you made?'.",
    input_schema: {
      type: "object",
      properties: { call_id: { type: "string", description: "Omit to list recent calls instead" } },
      required: [],
    },
  },
  handler: async (input) => {
    const cfg = vapiCfg();
    if (!cfg.vapiApiKey) return "Phone calling isn't configured.";
    if (!input.call_id) {
      const calls = load<CallLogEntry[]>("calls", []);
      if (!calls.length) return "No calls placed yet.";
      return calls
        .slice(-10)
        .reverse()
        .map((c) => {
          const when = new Date(c.placedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          return `${when} → ${c.number} [${c.status}] ${c.purpose}${c.summary ? `\n   outcome: ${c.summary}` : ""}\n   id: ${c.id}`;
        })
        .join("\n");
    }
    const res = await fetch(`https://api.vapi.ai/call/${input.call_id}`, {
      headers: { Authorization: `Bearer ${cfg.vapiApiKey}` },
    });
    const data: any = await res.json();
    if (!res.ok) return `Lookup failed: ${JSON.stringify(data)}`;
    if (data.status !== "ended")
      return `Call status: ${data.status}. Not finished yet — check again shortly.`;
    const summary = data.analysis?.summary ?? data.summary ?? "(no summary)";
    const transcript = (data.transcript ?? "").slice(0, 3000);
    const calls = load<CallLogEntry[]>("calls", []);
    const entry = calls.find((c) => c.id === input.call_id);
    if (entry && entry.status !== "ended") {
      entry.status = "ended";
      entry.summary = String(summary).slice(0, 300);
      entry.endedAt = new Date().toISOString();
      save("calls", calls);
    }
    return `Call ended (${data.endedReason ?? "unknown reason"}).\nSUMMARY: ${summary}\n\nTRANSCRIPT:\n${transcript}`;
  },
};

const TOOLS: AgentTool[] = [
  listsTool, calendarTool, memoryTool, weatherTool, filesTool,
  gcalListTool, gcalAddTool, phoneCallTool, checkCallTool,
];

// ═══════════════════════════════════════════════════════════════════════════
// Agent loop
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are Homebase, a household logistics agent running locally on the family's own machine.
Today is ${new Date().toDateString()} (${new Date().toISOString().slice(0, 10)}).
Resolve relative dates ("Saturday", "tomorrow") to ISO datetimes yourself before calling calendar tools.
Proactively store useful facts in family_memory when people mention them.
Be concise and practical — you're texting busy parents, not writing essays.
PHONE CALLS: you can place real calls with make_phone_call. Before calling, ALWAYS confirm with the user:
the number, the goal, and exactly what personal info you may share (pull known facts from family_memory,
ask for anything missing like DOB or insurance if the task needs it). After placing a call, tell the user
you'll check back — then use check_phone_call when they ask, or on your next scheduled run.`;

// Retries on transient overload/rate-limit errors (429/529/503) with exponential backoff + jitter.
async function createWithRetry(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  maxAttempts = 5
): Promise<Anthropic.Message> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err: any) {
      const status = err?.status;
      const retryable = status === 429 || status === 529 || status === 503;
      if (!retryable || attempt >= maxAttempts) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 20000) + Math.random() * 500;
      console.error(`  ⚠ API ${status} — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

async function runAgentTurn(client: Anthropic, history: Anthropic.MessageParam[], log = true): Promise<string> {
  while (true) {
    const response = await createWithRetry(client, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS.map((t) => t.schema),
      messages: history,
    });
    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      if (log) console.log(`  ⚙ ${block.name}(${JSON.stringify(block.input)})`);
      const tool = TOOLS.find((t) => t.schema.name === block.name);
      let out: string;
      try {
        out = tool ? await tool.handler(block.input) : `Unknown tool ${block.name}`;
      } catch (err: any) {
        out = `Tool error: ${err.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: out });
    }
    history.push({ role: "user", content: results });
  }
}

// Trim history so long-running Telegram sessions don't grow unboundedly
function trimHistory(history: Anthropic.MessageParam[], maxMessages = 40) {
  while (history.length > maxMessages) history.shift();
  // never start history on a tool_result turn
  while (history.length && Array.isArray(history[0].content) &&
         (history[0].content as any[])[0]?.type === "tool_result") {
    history.shift();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode 1: interactive terminal chat
// ═══════════════════════════════════════════════════════════════════════════

async function terminalMode(client: Anthropic) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];
  console.log("Homebase ready. ('quit' to exit)\n");
  const ask = () =>
    rl.question("you > ", async (line) => {
      const text = line.trim();
      if (!text) return ask();
      if (text.toLowerCase() === "quit") return rl.close();
      history.push({ role: "user", content: text });
      try {
        console.log(`\nhomebase > ${await runAgentTurn(client, history)}\n`);
      } catch (err: any) {
        console.error(`Error: ${err.message}\n`);
      }
      trimHistory(history);
      scheduleCallFollowups((t) => console.log(`\n${t}\n`));
      ask();
    });
  ask();
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode 2: one-shot task (for cron / Task Scheduler)
//   ./homebase --task "text me anything on the calendar today and the weather"
// ═══════════════════════════════════════════════════════════════════════════

const MORNING_BRIEFING_TASK = (cfg: Config) =>
  `Compose the family's morning briefing for today:
1. Today's calendar — check Google Calendar if connected, plus the local family calendar.
2. Current weather${cfg.homeCity ? ` in ${cfg.homeCity}` : " (look for a home city in family_memory; if none, skip weather)"}.
3. Open items across all lists (skip empty ones).
Format it as one friendly, compact message with short sections — it's going to a family group chat.`;

async function taskMode(client: Anthropic, cfg: Config, task: string, toTelegram: boolean) {
  if (task === "morning-briefing") task = MORNING_BRIEFING_TASK(cfg);
  const history: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const result = await runAgentTurn(client, history);
  if (toTelegram && cfg.telegramBotToken && cfg.telegramOwnerChatId) {
    const res: any = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramOwnerChatId, text: result }),
    }).then((r) => r.json());
    console.log(res.ok ? "Delivered to Telegram." : `Telegram delivery failed: ${JSON.stringify(res)}`);
  } else {
    if (toTelegram) console.error("(--to-telegram needs telegramBotToken + an owner chat — printing instead)");
    console.log(result);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mode 3: Telegram bot — the family texts the agent
//   Setup: message @BotFather on Telegram, /newbot, paste the token on first run.
//   No public server needed — long polling works from behind any home router.
// ═══════════════════════════════════════════════════════════════════════════

type StoredSessions = Record<string, Anthropic.MessageParam[]>;

async function telegramMode(client: Anthropic, cfg: Config) {
  if (!cfg.telegramBotToken) {
    cfg.telegramBotToken = await askOnce("Paste your Telegram bot token (from @BotFather): ");
    save("config", cfg);
  }
  const api = (method: string, params: any = {}) =>
    fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }).then((r) => r.json() as any);

  const stored = load<StoredSessions>("sessions", {});
  const sessions = new Map<number, Anthropic.MessageParam[]>(
    Object.entries(stored).map(([id, h]) => [Number(id), h])
  );
  const saveSessions = () => {
    const obj: StoredSessions = {};
    for (const [id, h] of sessions) obj[String(id)] = h;
    save("sessions", obj);
  };

  cfg.telegramApproved ??= [];
  cfg.telegramPending ??= [];

  let offset = 0;
  console.log("Homebase is live on Telegram. Ctrl-C to stop.");

  while (true) {
    const updates: any = await api("getUpdates", { offset, timeout: 30 });
    for (const u of updates.result ?? []) {
      offset = u.update_id + 1;
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId: number = msg.chat.id;
      const text: string = msg.text.trim();

      // First person to ever message the bot becomes the owner/approver.
      if (!cfg.telegramOwnerChatId) {
        cfg.telegramOwnerChatId = chatId;
        cfg.telegramApproved!.push(chatId);
        save("config", cfg);
        await api("sendMessage", {
          chat_id: chatId,
          text: "You're set as the Homebase owner. Anyone else who messages this bot will need your approval first.",
        });
      }

      const isOwner = chatId === cfg.telegramOwnerChatId;

      if (isOwner && text.startsWith("/approve")) {
        const id = Number(text.split(/\s+/)[1]);
        if (id && cfg.telegramPending!.includes(id)) {
          cfg.telegramPending = cfg.telegramPending!.filter((p) => p !== id);
          cfg.telegramApproved!.push(id);
          save("config", cfg);
          await api("sendMessage", { chat_id: id, text: "You've been approved — go ahead and message me." });
          await api("sendMessage", { chat_id: chatId, text: `Approved ${id}.` });
        } else {
          await api("sendMessage", { chat_id: chatId, text: `No pending request for ${id || "(missing id)"}.` });
        }
        continue;
      }

      const approved = isOwner || cfg.telegramApproved!.includes(chatId);
      if (!approved) {
        if (!cfg.telegramPending!.includes(chatId)) {
          cfg.telegramPending!.push(chatId);
          save("config", cfg);
          await api("sendMessage", {
            chat_id: cfg.telegramOwnerChatId,
            text: `${msg.from?.first_name ?? "Someone"} (chat id ${chatId}) wants to message Homebase. Reply /approve ${chatId} to allow.`,
          });
        }
        await api("sendMessage", { chat_id: chatId, text: "This bot is private. Waiting for the owner's approval." });
        continue;
      }

      const history = sessions.get(chatId) ?? [];
      sessions.set(chatId, history);
      history.push({ role: "user", content: `[from ${msg.from?.first_name ?? "family member"}] ${text}` });
      try {
        const reply = await runAgentTurn(client, history, false);
        trimHistory(history);
        await api("sendMessage", { chat_id: chatId, text: reply });
      } catch (err: any) {
        await api("sendMessage", { chat_id: chatId, text: `Error: ${err.message}` });
      }
      // Proactively message call outcomes back to whoever asked for the call.
      // Not appended to history — the call log (calls.json) is the source of truth.
      scheduleCallFollowups((t) => api("sendMessage", { chat_id: chatId, text: t }));
      saveSessions();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`homebase ${VERSION}`);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.includes("--google-auth")) return googleConnect();

  const cfg = await getConfig();
  const client = new Anthropic({ apiKey: cfg.apiKey });

  const taskIdx = args.indexOf("--task");
  if (taskIdx !== -1 && args[taskIdx + 1])
    return taskMode(client, cfg, args[taskIdx + 1], args.includes("--to-telegram"));
  if (args.includes("--telegram")) return telegramMode(client, cfg);
  return terminalMode(client);
}

main();
