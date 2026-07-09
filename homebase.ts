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
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as os from "os";
import * as http from "http";
import { exec } from "child_process";
import { AsyncLocalStorage } from "async_hooks";

// Which phone/session is driving the current agent turn — lets tools like
// gmail_summary use the CALLER's personal credentials instead of household ones.
const TURN_CTX = new AsyncLocalStorage<{ sessionId?: string }>();

// Set once in main(); lets tool handlers (e.g. fetch_webpage's PDF reader) make
// their own model calls without threading the client through every signature.
let ANTHROPIC: Anthropic | null = null;
import { randomUUID } from "crypto";

// Keep in sync with package.json
const VERSION = "0.1.0";

const HELP_TEXT = `Homebase ${VERSION} — a distributable household logistics agent

Usage:
  homebase                       interactive terminal chat
  homebase --task "..."          one-shot task (for cron / Task Scheduler)
  homebase --task morning-briefing   preset: today's events + weather + open lists
  homebase --to-telegram         with --task: deliver output to the owner's Telegram chat
  homebase --to-push             with --task: push output to the mobile app (registered devices)
  homebase --telegram            Telegram bot mode — family texts the agent
  homebase --serve               HTTP brain for the mobile app (PORT env or 8080)
  homebase --google-auth         connect Google Calendar (one-time OAuth in your browser)
  homebase --setup-inbound       AI receptionist answers the household number (after Twilio import)
  homebase --version, -v         print version
  homebase --help, -h            show this help

Data lives in ~/.homebase/ as plain JSON. First run walks through setup
(Anthropic API key, optional Vapi phone-calling config).`;

// ═══════════════════════════════════════════════════════════════════════════
// Storage — plain JSON files in ~/.homebase
// ═══════════════════════════════════════════════════════════════════════════

// HOMEBASE_DIR lets the hosted (Railway) brain point storage at a persistent
// volume; locally it defaults to ~/.homebase. Same JSON-file model either way.
const DIR = process.env.HOMEBASE_DIR || path.join(os.homedir(), ".homebase");
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
  // Separate WEB-type OAuth client for per-person email connects from the app
  // (desktop clients can't use an https redirect). Redirect URI to register:
  // https://<your-server-domain>/oauth/google/callback
  googleWebClientId?: string;
  googleWebClientSecret?: string;
  publicUrl?: string; // https origin of this server (defaults to RAILWAY_PUBLIC_DOMAIN)
  haikuRouting?: boolean; // false disables fast-model routing of trivial turns
  mcpServers?: { name: string; command: string; args?: string[] }[];
  serverToken?: string; // shared secret the mobile app sends to the --serve brain
  displayToken?: string; // read-mostly key for the fridge/wall display page
  briefingTime?: string; // "HH:MM" — when --serve sends the daily briefing (default 07:00)
  briefingTimezone?: string; // IANA tz for briefingTime (default America/New_York)
  debriefTime?: string; // "HH:MM" — afternoon debrief (default 16:30)
  reflectionTime?: string; // "HH:MM" — silent nightly habit-learning pass (default 21:30)
  nudgeTime?: string; // "HH:MM" — evening look-ahead nudge, silent when nothing's notable (default 20:00)
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string; // E.164 — the agent's own number
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

async function getConfig(interactive = true): Promise<Config> {
  const cfg = load<Config>("config", {});
  if (process.env.ANTHROPIC_API_KEY) cfg.apiKey = process.env.ANTHROPIC_API_KEY;

  // Non-interactive (hosted --serve on Railway): never prompt. Secrets come from
  // env vars; the local JSON file (if any, e.g. on a volume) fills in the rest.
  if (!interactive) {
    if (!cfg.apiKey) throw new Error("ANTHROPIC_API_KEY not set (required in --serve mode).");
    return cfg;
  }

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
        if (name === "grocery") logCheckoff(it.item);
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
      const d = new Date(e.start.length === 16 ? `${e.start}:00Z` : hasOffset(e.start) ? e.start : `${e.start}Z`);
      // local-store times are naive household times; parse as UTC + format as UTC
      // so the wall-clock time survives regardless of the server's own zone
      const when = d.toLocaleString("en-US", {
        timeZone: hasOffset(e.start) ? HOUSEHOLD_TZ() : "UTC",
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

// calendar.events: read/write events. gmail.readonly: briefings summarize the
// inbox — read-only, granted (or not) by the user on the consent screen.
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly";

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

// ── Per-person Google tokens (personal email) ───────────────────────────────
// Keyed by the phone's sessionId; connected via the in-app browser OAuth flow.
// Personal tokens carry gmail.readonly only — the household calendar stays on
// the household-level connection.

type GTokens = { access_token: string; refresh_token?: string; expires_at?: number };

async function userAccessToken(sessionId: string): Promise<string | null> {
  const users = load<Record<string, GTokens>>("google-users", {});
  const t = users[sessionId];
  if (!t) return null;
  if (t.expires_at && Date.now() < t.expires_at - 60_000) return t.access_token;
  const cfg = load<Config>("config", {});
  if (!t.refresh_token || !cfg.googleWebClientId || !cfg.googleWebClientSecret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.googleWebClientId,
      client_secret: cfg.googleWebClientSecret,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data: any = await res.json();
  if (!res.ok) return null;
  users[sessionId] = { ...t, access_token: data.access_token, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
  save("google-users", users);
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

// ── Household timezone handling ──────────────────────────────────────────────
// The server runs in UTC (Railway); the family doesn't. Any datetime WITHOUT an
// explicit offset ("2026-07-10T15:00") means household local time, and all
// server-side formatting must render in the household zone.

const HOUSEHOLD_TZ = () => load<Config>("config", {}).briefingTimezone ?? "America/New_York";
const hasOffset = (s: string) => /Z$|[+-]\d{2}:\d{2}$/.test(s);

// Google event time: pass offset-carrying strings through; give naive ones the
// household timeZone so Google anchors them correctly (DST handled by Google).
const gTime = (s: string) =>
  hasOffset(s) ? { dateTime: s } : { dateTime: s.length === 16 ? `${s}:00` : s, timeZone: HOUSEHOLD_TZ() };

// naive "YYYY-MM-DDTHH:MM[:SS]" + ms → naive string (for default end = start+1h)
const naivePlus = (s: string, ms: number) =>
  new Date(new Date(`${s.length === 16 ? `${s}:00` : s}Z`).getTime() + ms).toISOString().slice(0, 19);

const gcalFmt = (e: any) => {
  const start = e.start?.dateTime ?? e.start?.date ?? "?";
  const when = e.start?.dateTime
    ? new Date(e.start.dateTime).toLocaleString("en-US", {
        timeZone: HOUSEHOLD_TZ(), // server is UTC; briefings must speak household time
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
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
    // private events never surface through the agent (briefings go to the whole family)
    const items = (data.items ?? []).filter((e: any) => e.visibility !== "private" && e.visibility !== "confidential");
    return items.length ? items.map(gcalFmt).join("\n") : "Nothing on the Google calendar for that window.";
  },
};

const gcalAddTool: AgentTool = {
  schema: {
    name: "google_calendar_add",
    description:
      "Add an event to the family's real Google Calendar (primary). Prefer this over manage_calendar for " +
      "ADDING events when connected. Resolve relative dates to ISO datetimes first. Include 'attendees' " +
      "(email addresses) to send real calendar INVITES — Google emails each person an Accept/Decline invite. " +
      "ALWAYS confirm with the user before inviting anyone: who, their email, and the event details. " +
      "Look up emails in manage_contacts first; ask for and save any that are missing.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime, e.g. 2026-07-11T15:00" },
        end: { type: "string", description: "ISO datetime (default: start + 1 hour)" },
        all_day: { type: "boolean", description: "All-day event (start is then YYYY-MM-DD)" },
        location: { type: "string" },
        notes: { type: "string" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses to invite (user-confirmed) — they receive a Google Calendar invite",
        },
        private: {
          type: "boolean",
          description:
            "true = personal event kept OFF all family surfaces (family calendar, Home, fridge, briefings). " +
            "Use when the user says to keep it private/off the family calendar. It stays on their Google Calendar.",
        },
      },
      required: ["title", "start"],
    },
  },
  handler: async (input) => {
    const token = await googleAccessToken();
    if (!token) return GCAL_NOT_CONNECTED;
    const body: any = { summary: input.title, location: input.location, description: input.notes };
    if (input.private) body.visibility = "private";
    if (Array.isArray(input.attendees) && input.attendees.length)
      body.attendees = input.attendees.map((email: string) => ({ email: String(email).trim() }));
    if (input.all_day) {
      const day = input.start.slice(0, 10);
      const next = new Date(new Date(`${day}T00:00:00`).getTime() + 86400000).toISOString().slice(0, 10);
      body.start = { date: day };
      body.end = { date: next };
    } else {
      body.start = gTime(input.start);
      body.end = input.end ? gTime(input.end) : gTime(hasOffset(input.start)
        ? new Date(new Date(input.start).getTime() + 3600000).toISOString()
        : naivePlus(input.start, 3600000));
    }
    // sendUpdates=all → Google emails real Accept/Decline invites to attendees
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await res.json();
    if (!res.ok) return `Google Calendar error: ${data.error?.message ?? res.status}`;
    let out = `Added to Google Calendar: ${gcalFmt(data)}${data.htmlLink ? `\n${data.htmlLink}` : ""}`;
    if (body.attendees?.length)
      out += `\nInvites emailed to: ${body.attendees.map((a: any) => a.email).join(", ")}`;
    // conflict watch: anything else that day within ±90 min of the new start
    if (!input.all_day) {
      const day = input.start.slice(0, 10);
      const dayRes: any = await (
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            new URLSearchParams({
              timeMin: new Date(`${day}T00:00:00`).toISOString(),
              timeMax: new Date(`${day}T23:59:59`).toISOString(),
              singleEvents: "true", orderBy: "startTime", maxResults: "20",
            }),
          { headers: { Authorization: `Bearer ${token}` } }
        )
      ).json();
      const startMs = new Date(input.start).getTime();
      const clashes = (dayRes.items ?? []).filter(
        (e: any) =>
          e.id !== data.id && e.start?.dateTime &&
          Math.abs(new Date(e.start.dateTime).getTime() - startMs) < 90 * 60 * 1000
      );
      if (clashes.length) out += `\n⚠ Possible conflict with: ${clashes.map(gcalFmt).join("; ")}`;
    }
    return out;
  },
};

// ── Gmail (read-only) — important-email summaries for briefings ─────────────

const gmailTool: AgentTool = {
  schema: {
    name: "gmail_summary",
    description:
      "List recent inbox emails (read-only) so you can summarize the important ones. Returns sender, " +
      "subject, and snippet for each. Skips promotions/social. Use for morning briefings and " +
      "'anything important in my email?' questions. Never invent emails not in the results.",
    input_schema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Look-back window in hours (default 24)" },
        query: { type: "string", description: "Extra Gmail search filter, e.g. 'from:school.org' (optional)" },
        detail: {
          type: "boolean",
          description: "true = include message bodies (needed to extract dates/times/addresses); default false = snippets only",
        },
      },
      required: [],
    },
  },
  handler: async (input) => {
    // The caller's own inbox when they've connected one; household connection otherwise.
    const sid = TURN_CTX.getStore()?.sessionId;
    const token = (sid ? await userAccessToken(sid) : null) ?? (await googleAccessToken());
    if (!token)
      return "No email connected. Connect a personal inbox from the app (✉ button), or the household one via: homebase --google-auth";
    const hours = input.hours ?? 24;
    const q = `in:inbox -category:promotions -category:social newer_than:${Math.max(1, Math.ceil(hours / 24))}d${input.query ? ` ${input.query}` : ""}`;
    const list: any = await (
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?` + new URLSearchParams({ q, maxResults: input.detail ? "8" : "15" }),
        { headers: { Authorization: `Bearer ${token}` } }
      )
    ).json();
    if (list.error) {
      return list.error.status === "PERMISSION_DENIED" || list.error.code === 403
        ? "Gmail scope not granted yet — re-run: homebase --google-auth (and enable the Gmail API in the Google Cloud project)."
        : `Gmail error: ${list.error.message}`;
    }
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    if (!ids.length) return "No inbox emails in that window.";
    const rows: string[] = [];
    for (const id of ids) {
      const format = input.detail ? "full" : "metadata&metadataHeaders=From&metadataHeaders=Subject";
      const msg: any = await (
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=${format}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json();
      const h = (name: string) => msg.payload?.headers?.find((x: any) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      const from = h("From").replace(/<.*>/, "").trim();
      let line = `FROM ${from} — ${h("Subject")}`;
      if (input.detail) {
        const plain = gmailPlainText(msg.payload);
        const html = plain ? "" : gmailHtml(msg.payload);
        const body = (plain || html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").slice(0, 1500);
        const links = extractLinks(`${plain} ${html}`).slice(0, 6);
        line += `\n  ${body || msg.snippet || "(no text)"}`;
        if (links.length) line += `\n  LINKS: ${links.join(" ")}`;
      } else if (msg.snippet) {
        line += ` — ${msg.snippet.slice(0, 140)}`;
      }
      rows.push(line);
    }
    return rows.join("\n");
  },
};

// Walk a Gmail payload tree for the first text/plain part (base64url-encoded).
function gmailPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    try {
      return Buffer.from(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  for (const part of payload.parts ?? []) {
    const t = gmailPlainText(part);
    if (t) return t;
  }
  return "";
}

// First text/html part (base64url) — many senders (schools) are HTML-only.
function gmailHtml(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    try {
      return Buffer.from(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    } catch {
      return "";
    }
  }
  for (const part of payload.parts ?? []) {
    const t = gmailHtml(part);
    if (t) return t;
  }
  return "";
}

// Pull http(s) URLs from body text + href attributes; dedupe, drop tracking-pixel noise.
function extractLinks(text: string): string[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(/href=["']([^"']+)["']/gi)) urls.add(m[1]);
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) urls.add(m[0]);
  return [...urls].filter((u) => /^https?:\/\//i.test(u) && !/\.(png|jpg|jpeg|gif|css|js)(\?|$)/i.test(u));
}

// Block obvious SSRF targets — this fetches URLs that arrive in emails.
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || h === "0.0.0.0" || h === "::1"
  );
}

const fetchWebTool: AgentTool = {
  schema: {
    name: "fetch_webpage",
    description:
      "Fetch a web page and return its readable text. Use this to follow a link from an email (e.g. a school " +
      "newsletter or event page the email just links to) so you can pull out dates, times, and details. " +
      "Follows redirects, including email tracking/redirect wrappers. After extracting dates, offer to add " +
      "them to the calendar (confirm first — never add silently).",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The http(s) URL to open" } },
      required: ["url"],
    },
  },
  handler: async (input) => {
    let u: URL;
    try {
      u = new URL(input.url);
    } catch {
      return "That doesn't look like a valid URL.";
    }
    if (!/^https?:$/.test(u.protocol)) return "Only http/https links can be opened.";
    if (isPrivateHost(u.hostname)) return "That link points to a private/internal address — not fetching it.";
    try {
      const res = await fetch(u.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (Homebase family agent)" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `Couldn't open the page (HTTP ${res.status}).`;
      const type = res.headers.get("content-type") ?? "";
      // PDFs (school flyers, event calendars): read via the model's native PDF support.
      if (/application\/pdf/i.test(type) || /\.pdf(\?|$)/i.test(u.pathname)) {
        if (!ANTHROPIC) return "PDF reading isn't available right now.";
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > 10 * 1024 * 1024) return "That PDF is too large to read (over 10MB).";
        const resp = await createWithRetry(ANTHROPIC, {
          model: FAST_MODEL,
          max_tokens: 1500,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } },
                {
                  type: "text",
                  text: "Extract this document's content as plain text, prioritizing any dates, times, events, deadlines, and contact info. Be thorough but skip decorative fluff.",
                },
              ],
            },
          ],
        });
        const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
        return text ? `[PDF contents]\n${text}` : "(couldn't read anything from that PDF)";
      }
      if (!/text|html|xml|json/i.test(type)) return `That link is a ${type || "non-text"} file I can't read as text.`;
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 6000);
      return text || "(the page had no readable text)";
    } catch (err: any) {
      return `Couldn't open the page: ${err.message}`;
    }
  },
};

// ── Send email — from the CALLER's own Gmail (never the household account) ──

const sendEmailTool: AgentTool = {
  schema: {
    name: "send_email",
    description:
      "Send an email from the asking person's own connected Gmail account. Draft it first, show the user " +
      "the complete draft (to, subject, full body), and ONLY send after they explicitly approve — never " +
      "send unprompted or with unapproved wording. Requires the person to have connected their email in " +
      "the app (✉ button). Use manage_contacts / gmail_summary to find addresses when needed.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        cc: { type: "string", description: "Optional CC address" },
      },
      required: ["to", "subject", "body"],
    },
  },
  handler: async (input) => {
    const sid = TURN_CTX.getStore()?.sessionId;
    const token = sid ? await userAccessToken(sid) : null;
    if (!token)
      return "Sending needs your personal email connected — tap the ✉ button in the app first.";
    const raw = [
      `To: ${input.to}`,
      ...(input.cc ? [`Cc: ${input.cc}`] : []),
      `Subject: ${input.subject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      input.body,
    ].join("\r\n");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      }),
    });
    const data: any = await res.json();
    if (!res.ok) {
      return data.error?.status === "PERMISSION_DENIED" || data.error?.code === 403
        ? "Your email connection doesn't have send permission yet — tap ✉ in the app to reconnect (the new consent includes sending)."
        : `Send failed: ${data.error?.message ?? res.status}`;
    }
    logComm({ at: new Date().toISOString(), type: "email", direction: "out", party: input.to, summary: `${input.subject} — ${input.body.slice(0, 150)}` });
    return `Email sent to ${input.to} (subject: "${input.subject}").`;
  },
};

// ── Email VIPs — senders that trigger an immediate alert ────────────────────
// Per-phone lists (the person who says "the school is important" gets the
// alerts). A 10-minute watcher checks each person's inbox for new VIP mail.

const emailVipsTool: AgentTool = {
  schema: {
    name: "manage_email_vips",
    description:
      "The user's important-sender list: email from these senders triggers an immediate push alert " +
      "(checked every ~10 minutes). Use when the user says things like 'alert me when the kids' school " +
      "emails' or 'emails from the dance studio are important'. A sender can be an address, a domain, " +
      "or a name (e.g. 'notifications@school.org', 'school.org', 'Miss Amy Dance'). " +
      "Actions: 'add', 'list', 'remove'. Lists are personal to whoever is asking.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove"] },
        sender: { type: "string", description: "Address, domain, or sender name" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const sid = TURN_CTX.getStore()?.sessionId ?? "household";
    const vips = load<Record<string, string[]>>("email-vips", {});
    vips[sid] ??= [];
    switch (input.action) {
      case "add": {
        if (!input.sender) return "Need the sender to watch for.";
        const s = input.sender.trim();
        if (!vips[sid].some((x) => x.toLowerCase() === s.toLowerCase())) vips[sid].push(s);
        save("email-vips", vips);
        return `Watching for email from "${s}" — you'll get an alert within ~10 minutes of one arriving.`;
      }
      case "list":
        return vips[sid].length ? `Watching: ${vips[sid].join(", ")}` : "No VIP senders yet.";
      case "remove": {
        if (!input.sender) return "Which sender should I stop watching?";
        const before = vips[sid].length;
        vips[sid] = vips[sid].filter((x) => x.toLowerCase() !== input.sender.trim().toLowerCase());
        save("email-vips", vips);
        return before === vips[sid].length ? `"${input.sender}" wasn't on the list.` : `Stopped watching "${input.sender}".`;
      }
      default:
        return "Unknown action.";
    }
  },
};

// ── SMS via Twilio — the agent texts family members or anyone else ──────────

// ── Contacts — remembered people so numbers don't get re-entered ────────────

interface Contact {
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
}

const contactsTool: AgentTool = {
  schema: {
    name: "manage_contacts",
    description:
      "The family's remembered contacts (name → phone and/or email). Use 'find' to LOOK UP details before " +
      "calling, texting, or sending calendar invites, so the user never re-enters them ('invite Grandma' → " +
      "find her email). Proactively 'add'/update a contact whenever a new name + number/email is used. " +
      "Actions: 'add' (name + phone and/or email, merges with existing), 'find' (query), 'list', 'remove' (name).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "find", "list", "remove"] },
        name: { type: "string" },
        phone: { type: "string", description: "E.164, e.g. +19195551234" },
        email: { type: "string", description: "Email address (used for calendar invites)" },
        notes: { type: "string", description: "Relation or context, e.g. 'wife', 'pediatrician'" },
        query: { type: "string", description: "Name or keyword to search (for 'find')" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const contacts = load<Record<string, Contact>>("contacts", {});
    const fmt = (c: Contact) =>
      `${c.name}: ${[c.phone, c.email].filter(Boolean).join(" · ") || "(no details)"}${c.notes ? ` (${c.notes})` : ""}`;
    switch (input.action) {
      case "add": {
        if (!input.name || (!input.phone && !input.email)) return "Need a name plus a phone number or email.";
        const key = input.name.toLowerCase().trim();
        const prev = contacts[key];
        contacts[key] = {
          name: input.name.trim(),
          phone: input.phone?.trim() ?? prev?.phone,
          email: input.email?.trim() ?? prev?.email,
          notes: input.notes ?? prev?.notes,
        };
        save("contacts", contacts);
        return `Saved contact: ${fmt(contacts[key])}`;
      }
      case "find": {
        const q = (input.query ?? input.name ?? "").toLowerCase().trim();
        const hits = Object.values(contacts).filter(
          (c) => !q || c.name.toLowerCase().includes(q) || (c.notes ?? "").toLowerCase().includes(q)
        );
        return hits.length
          ? hits.map(fmt).join("\n")
          : `No contact matching "${q}". Ask the user for the details, then save them.`;
      }
      case "list": {
        const all = Object.values(contacts);
        return all.length ? all.map(fmt).join("\n") : "No saved contacts yet.";
      }
      case "remove": {
        const key = (input.name ?? "").toLowerCase().trim();
        if (!contacts[key]) return `No contact named "${input.name}".`;
        delete contacts[key];
        save("contacts", contacts);
        return `Removed ${input.name}.`;
      }
      default:
        return "Unknown action.";
    }
  },
};

// ── Communication log — unified record of calls + texts, in and out ─────────

interface CommEntry {
  at: string;
  type: "call" | "sms" | "email";
  direction: "in" | "out";
  party: string; // the other number or address
  summary: string;
}

function logComm(entry: CommEntry) {
  const log = load<CommEntry[]>("comms", []);
  log.push(entry);
  save("comms", log.slice(-300));
}

const smsTool: AgentTool = {
  schema: {
    name: "send_sms",
    description:
      "Send a text message (SMS) from the family agent's own Twilio number. Use for reminders, " +
      "sharing lists, or notifying a family member. ALWAYS confirm the recipient number and exact " +
      "message text with the user before sending — never send unprompted. Numbers in E.164 (+1...).",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient, E.164 e.g. +19195551234" },
        body: { type: "string", description: "Message text (keep under 320 chars)" },
      },
      required: ["to", "body"],
    },
  },
  handler: async (input) => {
    const cfg = vapiCfg(); // same fresh-config loader the call tools use
    if (!cfg.twilioAccountSid || !cfg.twilioAuthToken || !cfg.twilioFromNumber)
      return "SMS isn't configured. Add twilioAccountSid, twilioAuthToken, twilioFromNumber to " + FILE("config");
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilioAccountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${cfg.twilioAccountSid}:${cfg.twilioAuthToken}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: input.to, From: cfg.twilioFromNumber, Body: input.body }),
      }
    );
    const data: any = await res.json();
    if (!res.ok) return `SMS failed: ${data.message ?? JSON.stringify(data)}`;
    logComm({ at: new Date().toISOString(), type: "sms", direction: "out", party: input.to, summary: input.body.slice(0, 200) });
    return `Text sent to ${input.to} (sid ${data.sid}, status ${data.status}).`;
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
    logComm({ at: new Date().toISOString(), type: "call", direction: "out", party: input.phone_number, summary: input.briefing.slice(0, 200) });
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

// ── Family profile — powers the app's Home page ─────────────────────────────

interface FamilyMember {
  name: string;
  role?: string; // "mom", "kid", "dog"...
  color: string;
}
interface Family {
  name?: string; // "The Emery Family"
  members: FamilyMember[];
}

const MEMBER_COLORS = ["#6c7dff", "#5dd39e", "#ffb454", "#ff6b9d", "#4dd0e1", "#b39ddb", "#ffd54f", "#81c784"];

const familyTool: AgentTool = {
  schema: {
    name: "manage_family",
    description:
      "The family profile shown on the app's Home page. Actions: 'set_name' (e.g. \"The Emery Family\"), " +
      "'add_member' (name + optional role like mom/dad/kid/dog), 'remove_member' (name), 'list'. " +
      "Proactively add members as you learn who's in the household.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set_name", "add_member", "remove_member", "list"] },
        name: { type: "string", description: "Family name (set_name) or member name" },
        role: { type: "string", description: "Member role, e.g. 'mom', 'kid', 'dog' (optional)" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const fam = load<Family>("family", { members: [] });
    switch (input.action) {
      case "set_name":
        if (!input.name) return "Need the family name.";
        fam.name = input.name.trim();
        save("family", fam);
        return `Family name set: ${fam.name}`;
      case "add_member": {
        if (!input.name) return "Need the member's name.";
        if (fam.members.some((m) => m.name.toLowerCase() === input.name.toLowerCase().trim()))
          return `${input.name} is already on the family page.`;
        fam.members.push({
          name: input.name.trim(),
          role: input.role,
          color: MEMBER_COLORS[fam.members.length % MEMBER_COLORS.length],
        });
        save("family", fam);
        return `Added ${input.name}${input.role ? ` (${input.role})` : ""} to the family page.`;
      }
      case "remove_member": {
        const before = fam.members.length;
        fam.members = fam.members.filter((m) => m.name.toLowerCase() !== (input.name ?? "").toLowerCase().trim());
        save("family", fam);
        return before === fam.members.length ? `No member named "${input.name}".` : `Removed ${input.name}.`;
      }
      case "list":
        return fam.members.length
          ? `${fam.name ?? "(no family name set)"}\n` + fam.members.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ""}`).join("\n")
          : "No family members added yet.";
      default:
        return "Unknown action.";
    }
  },
};

// ── Commitments — standing tasks with a due date or trigger condition ───────

interface Commitment {
  id: number;
  text: string;
  due?: string; // YYYY-MM-DD when date-bound; condition lives in the text otherwise
  createdAt: string;
  status: "open" | "done";
}

const commitmentsTool: AgentTool = {
  schema: {
    name: "manage_commitments",
    description:
      "Standing follow-ups the user asked for later ('call Dr. Patel Tuesday if the referral hasn't arrived', " +
      "'remind me to sign the permission slip by Friday'). Actions: 'add' (text + optional due YYYY-MM-DD), " +
      "'list' (open commitments), 'complete' (by id). Proactively add one whenever the user requests a future " +
      "or conditional action. The daily briefing and evening nudge surface due/overdue ones — ALWAYS ask " +
      "before acting on a commitment, never execute it unprompted.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "complete"] },
        text: { type: "string", description: "What to follow up on, including any condition" },
        due: { type: "string", description: "YYYY-MM-DD (optional)" },
        id: { type: "number", description: "Commitment id (for 'complete')" },
      },
      required: ["action"],
    },
  },
  handler: async (input) => {
    const all = load<Commitment[]>("commitments", []);
    switch (input.action) {
      case "add": {
        if (!input.text) return "Need the commitment text.";
        const id = (all.at(-1)?.id ?? 0) + 1;
        all.push({ id, text: input.text, due: input.due, createdAt: new Date().toISOString(), status: "open" });
        save("commitments", all);
        return `Commitment #${id} stored: ${input.text}${input.due ? ` (due ${input.due})` : ""}`;
      }
      case "list": {
        const open = all.filter((c) => c.status === "open");
        if (!open.length) return "No open commitments.";
        const today = new Date().toISOString().slice(0, 10);
        return open
          .map((c) => {
            const flag = c.due && c.due <= today ? (c.due === today ? " ⏰ DUE TODAY" : " ⚠ OVERDUE") : "";
            return `#${c.id} ${c.text}${c.due ? ` (due ${c.due})` : ""}${flag}`;
          })
          .join("\n");
      }
      case "complete": {
        const c = all.find((x) => x.id === input.id);
        if (!c) return `No commitment #${input.id}.`;
        c.status = "done";
        save("commitments", all);
        return `Done: ${c.text}`;
      }
      default:
        return "Unknown action.";
    }
  },
};

// ── Inbound receptionist (Vapi) — the AI that ANSWERS the household number ──
// One-time setup after importing a Twilio number into Vapi: `--setup-inbound`
// creates a persistent assistant, points its end-of-call reports at this
// server's /vapi/webhook, and assigns it to the number.

const INBOUND_AGENT_PROMPT = (cfg: Config) => `
You are the friendly AI receptionist answering ${cfg.ownerName ?? "the family"}'s household line.

RULES:
- Greet callers warmly and disclose you're an AI assistant taking calls for ${cfg.ownerName ?? "the family"}.
- Your job: find out who's calling, what it's about, and take a complete message (name, reason,
  callback number). Confirm the message back briefly.
- NEVER share family information — schedules, addresses, who's home, phone numbers, anything.
  You take messages; you don't give out details.
- If the caller says it's URGENT or asks to speak to ${cfg.ownerName ?? "the owner"} directly, offer to
  transfer them${cfg.ownerCallback ? " and use the transferCall tool" : ""}. Otherwise assure them the
  message will be delivered right away (it is — the family gets an instant summary).
- Sales/robocalls: politely decline and end the call.
- Be warm and brief. Use endCall when the conversation is complete.
`.trim();

async function setupInboundAgent() {
  const cfg = load<Config>("config", {});
  hydrateConfigFromEnv(cfg);
  const token = process.env.HOMEBASE_SERVER_TOKEN || cfg.serverToken;
  if (!cfg.vapiApiKey || !cfg.vapiPhoneNumberId)
    return console.error("Needs vapiApiKey + vapiPhoneNumberId configured first.");
  if (!cfg.publicUrl || !token)
    return console.error("Needs the server's publicUrl + server token (deploy the brain first) so call reports can flow back.");

  const tools: any[] = [{ type: "endCall" }];
  if (cfg.ownerCallback)
    tools.push({
      type: "transferCall",
      destinations: [{ type: "number", number: cfg.ownerCallback, message: "Connecting you now — one moment." }],
    });

  const res = await fetch("https://api.vapi.ai/assistant", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.vapiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Homebase Receptionist",
      firstMessage: `Hi! You've reached ${cfg.ownerName ?? "the family"}'s assistant. How can I help you?`,
      model: {
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001", // fast beats smart on a live line
        messages: [{ role: "system", content: INBOUND_AGENT_PROMPT(cfg) }],
        tools,
      },
      server: { url: `${cfg.publicUrl}/vapi/webhook`, secret: token },
      maxDurationSeconds: 600,
    }),
  });
  const assistant: any = await res.json();
  if (!res.ok) return console.error(`Assistant create failed: ${JSON.stringify(assistant)}`);

  const patch = await fetch(`https://api.vapi.ai/phone-number/${cfg.vapiPhoneNumberId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${cfg.vapiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ assistantId: assistant.id }),
  });
  if (!patch.ok) return console.error(`Number assign failed: ${JSON.stringify(await patch.json())}`);
  console.log(
    `Inbound receptionist live (assistant ${assistant.id}). Calls to the Homebase number are now answered by the AI;\n` +
      `the family gets a push summary after each call.${cfg.ownerCallback ? ` Urgent calls transfer to ${cfg.ownerCallback}.` : ""}`
  );
}

const TOOLS: AgentTool[] = [
  listsTool, calendarTool, memoryTool, weatherTool, filesTool,
  gcalListTool, gcalAddTool, gmailTool, sendEmailTool, emailVipsTool, fetchWebTool, contactsTool, smsTool,
  phoneCallTool, checkCallTool, commitmentsTool, familyTool,
];

// ── MCP client — consume external MCP servers as extra agent tools ──────────
//
// This is how Homebase talks agent-to-agent with a business's booking system
// instead of phoning it. Configure in ~/.homebase/config.json:
//   "mcpServers": [{ "name": "medspa", "command": "bun",
//                    "args": ["run", "C:\\...\\demo-medspa-mcp\\server.ts"] }]
// Each remote tool is exposed to the agent as <server>_<tool>.

async function connectMcpServers(): Promise<AgentTool[]> {
  const cfg = load<Config>("config", {});
  const tools: AgentTool[] = [];
  for (const s of cfg.mcpServers ?? []) {
    try {
      const transport = new StdioClientTransport({ command: s.command, args: s.args ?? [] });
      const mcp = new McpClient({ name: "homebase", version: VERSION });
      await mcp.connect(transport);
      const { tools: remote } = await mcp.listTools();
      for (const rt of remote) {
        const name = `${s.name}_${rt.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        tools.push({
          schema: {
            name,
            description: `[${s.name} MCP server] ${rt.description ?? ""}`.slice(0, 1024),
            input_schema: rt.inputSchema as Anthropic.Tool["input_schema"],
          },
          handler: async (input) => {
            const res = await mcp.callTool({ name: rt.name, arguments: input });
            const content = (res.content ?? []) as any[];
            return content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n") || "(empty result)";
          },
        });
      }
      console.log(`  ⚡ MCP: connected '${s.name}' (${remote.map((t) => t.name).join(", ")})`);
    } catch (err: any) {
      console.error(`  ⚠ MCP: couldn't connect '${s.name}': ${err.message}`);
    }
  }
  return tools;
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent loop
// ═══════════════════════════════════════════════════════════════════════════

// A function, not a constant: the brain runs for days on Railway, so the date
// must be computed per turn — and the capability summary reads live config.
const SYSTEM_PROMPT = () => {
  const cfg = load<Config>("config", {});
  const tz = cfg.briefingTimezone ?? "America/New_York";
  return `You are Homebase, the family's household agent. The family reaches you through a phone app
(chat + push notifications), Telegram, and scheduled jobs on this always-on server.
Today is ${new Date().toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

WHAT THE FAMILY CAN DO (answer "what can you do" questions from this, and guide them to the right place):
- App tabs: Home (family cover page with today, alerts, stats), Chat (you), Lists (grocery first plus
  any named list — school supplies, packing…; tap crosses out, double-tap deletes; ＋Recipe imports
  ingredients; 📷 Scan photographs any printed list into items), Calendar (month grid, Google + family
  merged, tap a day, tap an event to edit, ＋ to add).
- 📄 Scan button in the app header: photograph a document (school calendar, insurance card, wifi label)
  and its facts land in family_memory — retrievable by asking you.
- Checked-off groceries teach the restock learner; staples bought on a steady rhythm get auto-added.
- You remember contacts (manage_contacts) — look up a saved number before calling/texting instead of
  asking again, and save new people automatically. When someone says "text/call <name>", find the contact first.
- The app's Home page shows the family profile (manage_family: family name + members with roles). Add
  members proactively as you learn who's in the household; suggest setting the family name if unset.
- There's a communication log of every call and text. When the user asks to see their calls/texts/history,
  render a button to open it with this EXACT syntax: {{open:comms|View communication log}} (the app makes it tappable).
DAILY RHYTHM (${tz}): restock check 05:30 → morning briefing ${cfg.briefingTime ?? "07:00"} (calendar,
weather, important emails, commitments, restocked staples) → afternoon debrief ${cfg.debriefTime ?? "16:30"}
(today's recap + tomorrow) → evening nudge ${cfg.nudgeTime ?? "20:00"} (only when something warrants it:
early events, conflicts, emails with dates not on the calendar) → habit reflection ${cfg.reflectionTime ?? "21:30"}
(silent). All delivered as push notifications and shown in the app's chat feed.

CALL SCREENING: The household's AI phone line is ${cfg.twilioFromNumber ?? "(not set — tell them to set TWILIO_FROM_NUMBER on the server first)"}.
If it isn't set, say so and stop. Otherwise: you MUST first know the person's carrier, because the codes
differ — if you don't know it, ASK ("Are you on AT&T/T-Mobile, or Verizon?") and wait. Then render ONLY that
one carrier's buttons — NEVER show both sets (duplicate buttons are confusing). Button syntax (the app turns
it into a tappable button): {{dial:Label|code}} — put the household line's number (digits only, no +) where
<NUMBER> is.
- AT&T / T-Mobile (and most GSM) — four options:
  {{dial:Forward missed calls|*61*<NUMBER>#}} {{dial:Forward when busy|*67*<NUMBER>#}}
  {{dial:Forward when phone is off|*62*<NUMBER>#}} {{dial:Turn off all forwarding|##002#}}
- Verizon — two options: {{dial:Forward missed calls|*71<NUMBER>}} {{dial:Turn off forwarding|*73}}
Recommend "Forward missed calls" so they still get calls normally and only unanswered ones reach the assistant.
Resolve relative dates ("Saturday", "tomorrow") to ISO datetimes yourself before calling calendar tools.
Proactively store useful facts in family_memory when people mention them.
Be concise and practical — you're texting busy parents, not writing essays.
ERRAND CHAINS: for multi-step requests ("book the haircut, add it to the calendar, text Aundrea the time"),
present ONE combined plan and get ONE confirmation covering every outward action (calls, texts) — then execute
the whole chain without re-asking between steps, and report each step's outcome at the end.
FOLLOW-UPS: when the user asks for a future or conditional follow-up ("call them Tuesday if X hasn't happened"),
store it with manage_commitments so the daily briefings can surface it. Never act on a stored commitment
without asking first.
EMAIL VIPs: when the user says a sender matters ("alert me when the school emails"), store it with
manage_email_vips — they'll get a push alert within ~10 minutes of that sender's next email.
EMAIL LINKS: many important emails (school newsletters, event invites) only LINK to the real content
instead of including it. When gmail_summary shows LINKS and the actual dates/details aren't in the email
body itself, use fetch_webpage on the relevant link to open it and read the real content, then extract the
dates and offer to add them to the calendar (confirm before adding).
CONFLICTS: when adding calendar events, watch for clashes — with existing events AND with known routines
in family_memory habits — and mention them.
PRIVATE EVENTS: when someone asks to keep an event off the family calendar ("just for me",
"private", "the family doesn't need to see this"), add it with private:true — it stays on their
Google Calendar but never appears on family surfaces, briefings, or the fridge. Offer this when
an event sounds personal (their own appointments, gifts, surprises).
INVITES: google_calendar_add with attendees sends real calendar invites by email. Treat like texts/calls:
show the user who's being invited (names + emails) and the event details, and only send after explicit
approval. Pull emails from manage_contacts; ask for and save missing ones.
TEXTS: you can send real SMS with send_sms. ALWAYS confirm the recipient and exact text with the user first.
EMAIL SENDING: you can draft and send email from the asker's own Gmail (send_email). Show the FULL draft
(to, subject, body) and send only after explicit approval. If they haven't connected their email (✉ in the
app), tell them that's the first step.
PHONE CALLS: you can place real calls with make_phone_call. Before calling, ALWAYS confirm with the user:
the number, the goal, and exactly what personal info you may share (pull known facts from family_memory,
ask for anything missing like DOB or insurance if the task needs it). After placing a call, tell the user
you'll check back — then use check_phone_call when they ask, or on your next scheduled run.`;
};

// ── Model tiering (mirror of the Arete router pattern) ─────────────────────
// Trivial single-tool turns (list add/check/show) route to Haiku; everything
// else stays on the strong orchestrator model. Set "haikuRouting": false in
// config.json to disable.

const STRONG_MODEL = "claude-sonnet-4-5";
const FAST_MODEL = "claude-haiku-4-5";

const TRIVIAL_TURN =
  /^(add|put|buy)\b.{0,60}\b(to|on)\b.{0,40}\b(list|grocery|groceries|todos?|packing|shopping)\b|^(check( off)?|mark|uncheck|complete)\b.{0,50}(#?\d+|done)|^(show|what'?s on)\b.{0,30}\b(list|lists|grocery|groceries|todos?|packing|shopping)\b/i;

function pickModelForTurn(history: Anthropic.MessageParam[]): string {
  const cfg = load<Config>("config", {});
  if (cfg.haikuRouting === false) return STRONG_MODEL;
  const last = history.at(-1);
  if (typeof last?.content !== "string") return STRONG_MODEL;
  const text = last.content.replace(/^\[from [^\]]+\]\s*/, "").trim(); // strip Telegram sender prefix
  return TRIVIAL_TURN.test(text) ? FAST_MODEL : STRONG_MODEL;
}

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
  const model = pickModelForTurn(history);
  if (log && model === FAST_MODEL) console.log(`  ⚡ routing trivial turn to ${FAST_MODEL}`);
  while (true) {
    const response = await createWithRetry(client, {
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT(),
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
      if (text.toLowerCase() === "quit") { rl.close(); process.exit(0); } // exit even with MCP children alive
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
3. Important emails — if Gmail is connected (gmail_summary), pick out the 2-4 that actually matter; skip newsletters/receipts. If not connected, omit this section silently.
4. Open items across all lists (skip empty ones). Check family_memory for a 'restock-report' entry —
   if it's dated today, mention which staples were auto-added and invite removing any not needed.
5. Open commitments (manage_commitments list) — surface anything due today or overdue and ask
   whether to act; never act on one unprompted.
Check family_memory for 'habit' entries and tailor the briefing to them (e.g. lead with what this family checks first).
Format it as one friendly, compact message with short sections — it's going to a family group chat.`;

const AFTERNOON_DEBRIEF_TASK = (cfg: Config) =>
  `Compose the family's afternoon debrief:
1. Today's recap — which calendar events happened today (Google Calendar if connected, plus local).
2. Tomorrow's appointments — list them so the family can prepare tonight.
3. Important emails from today if Gmail is connected (gmail_summary, last ~10 hours); only ones needing action. Omit silently if not connected.
4. Open list items that still need attention.
Check family_memory for 'habit' entries and tailor accordingly.
Keep it brief and warm — this is the "how'd today go, what's tomorrow" message.`;

// Evening look-ahead: heads-up ONLY when something warrants it — otherwise
// reply exactly NOTHING and no notification goes out. Also the email→calendar
// bridge: proposes found events, never adds them without the user confirming.
const NUDGE_TASK = (cfg: Config) =>
  `You are doing the evening look-ahead scan. Check, in order:
1. TOMORROW's calendar (Google if connected, plus local): anything unusually early (before 9am),
   overlapping/back-to-back events, or events that clearly need prep tonight.
2. Recent emails if Gmail is connected (gmail_summary with detail:true, last 48h): concrete
   events with dates/times (school events, appointments, invitations, deliveries needing someone
   home) that are NOT already on the calendar. List each as a proposal:
   "📩 From your email: <event> — <date/time>. Want it on the calendar? Just reply here."
   NEVER add calendar events yourself during this scan — only propose.
3. family_memory 'habit' entries vs tomorrow: conflicts with known routines.
4. Open commitments (manage_commitments list): anything due tomorrow — include it as a reminder
   with a question ("want me to handle it?"), never act on it yourself during this scan.
RULES: Be selective — a nudge that fires nightly gets ignored. If NOTHING genuinely warrants a
heads-up, reply with exactly the single word: NOTHING
Otherwise reply with the nudge message only (short, friendly, actionable)${cfg.ownerName ? ` — it goes to ${cfg.ownerName}'s family` : ""}.`;

// Nightly, silent: review today's conversations and persist durable habits so
// briefings get smarter over time. The agent writes via family_memory itself.
const REFLECTION_TASK = (transcript: string) =>
  `Below are today's conversations between the family and Homebase. Identify at most 3 DURABLE
habits or preferences worth remembering long-term (recurring requests, standing preferences,
schedules — NOT one-off facts already stored). Store each with family_memory using a key
prefixed 'habit-' (update existing habit keys if refined). If nothing new, store nothing.
Reply with one line describing what you stored or "nothing new".

TODAY'S CONVERSATIONS:
${transcript}`;

// Deliver a message to every phone that registered via /register-push. Expo's
// push API needs no key for sends; returns per-message tickets. Used by the
// morning briefing (and available for call followups) so the app gets notified.
async function sendExpoPush(title: string, body: string, onlySessionId?: string): Promise<string> {
  const registry = load<Record<string, string>>("push", {});
  const tokens = onlySessionId
    ? registry[onlySessionId]
      ? [registry[onlySessionId]]
      : []
    : Object.values(registry);
  if (!tokens.length) return "No registered push tokens.";
  const messages = tokens.map((to) => ({ to, title, body, sound: "default" }));
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) return `Push failed: ${JSON.stringify(data)}`;
  const errors = (data.data ?? []).filter((t: any) => t.status === "error");
  return `Pushed to ${tokens.length} device(s)${errors.length ? `, ${errors.length} error(s): ${JSON.stringify(errors)}` : ""}.`;
}

async function taskMode(client: Anthropic, cfg: Config, task: string, toTelegram: boolean, toPush: boolean) {
  const isBriefing = task === "morning-briefing";
  if (isBriefing) task = MORNING_BRIEFING_TASK(cfg);
  const history: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const result = await runAgentTurn(client, history);
  let delivered = false;
  if (toTelegram && cfg.telegramBotToken && cfg.telegramOwnerChatId) {
    const res: any = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramOwnerChatId, text: result }),
    }).then((r) => r.json());
    console.log(res.ok ? "Delivered to Telegram." : `Telegram delivery failed: ${JSON.stringify(res)}`);
    delivered = true;
  }
  if (toPush) {
    console.log(await sendExpoPush(isBriefing ? "Morning briefing" : "Homebase", result));
    delivered = true;
  }
  if (!delivered) {
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
// Mode 4: HTTP server — the "brain" the mobile app (M6) talks to
//   ./homebase --serve            (PORT env or 8080)
//
// Reuses every tool and the same agent loop as the other modes. Auth is a shared
// bearer token (env HOMEBASE_SERVER_TOKEN, else config.serverToken, else a
// generated one printed at startup). Sessions persist to the storage dir so a
// Railway redeploy with a volume keeps history. Endpoints:
//   GET  /health                       → { ok, version }         (no auth)
//   POST /chat  { sessionId, message } → { reply }
//   POST /register-push { sessionId, pushToken } → { ok }        (push comes later)
// ═══════════════════════════════════════════════════════════════════════════

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// Merge secrets from env (Railway service variables) into the config so the
// file-reading tools (Vapi, Google) work without a config.json on the box.
function hydrateConfigFromEnv(cfg: Config) {
  const map: [keyof Config, string | undefined][] = [
    ["vapiApiKey", process.env.VAPI_API_KEY],
    ["vapiPhoneNumberId", process.env.VAPI_PHONE_NUMBER_ID],
    ["ownerName", process.env.OWNER_NAME],
    ["ownerCallback", process.env.OWNER_CALLBACK],
    ["homeCity", process.env.HOME_CITY],
    ["googleClientId", process.env.GOOGLE_CLIENT_ID],
    ["googleClientSecret", process.env.GOOGLE_CLIENT_SECRET],
    ["telegramBotToken", process.env.TELEGRAM_BOT_TOKEN],
    ["googleWebClientId", process.env.GOOGLE_WEB_CLIENT_ID],
    ["googleWebClientSecret", process.env.GOOGLE_WEB_CLIENT_SECRET],
    ["publicUrl", process.env.PUBLIC_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined)],
    ["briefingTime", process.env.BRIEFING_TIME],
    ["briefingTimezone", process.env.BRIEFING_TZ],
    ["debriefTime", process.env.DEBRIEF_TIME],
    ["reflectionTime", process.env.REFLECTION_TIME],
    ["nudgeTime", process.env.NUDGE_TIME],
    ["twilioAccountSid", process.env.TWILIO_ACCOUNT_SID],
    ["twilioAuthToken", process.env.TWILIO_AUTH_TOKEN],
    ["twilioFromNumber", process.env.TWILIO_FROM_NUMBER],
  ];
  let dirty = false;
  for (const [k, v] of map) if (v && (cfg as any)[k] !== v) { (cfg as any)[k] = v; dirty = true; }
  const ownerChat = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (ownerChat && cfg.telegramOwnerChatId !== ownerChat) { cfg.telegramOwnerChatId = ownerChat; dirty = true; }
  // Google OAuth tokens as a JSON blob (copy from a local `--google-auth` run).
  // A new refresh_token means a new consent (e.g. scopes added) — adopt it even
  // over saved tokens; the stale expires_at just triggers a refresh on first use.
  if (process.env.GOOGLE_TOKENS) {
    try {
      const envTokens = JSON.parse(process.env.GOOGLE_TOKENS);
      if (!cfg.googleTokens || (envTokens.refresh_token && envTokens.refresh_token !== cfg.googleTokens.refresh_token)) {
        cfg.googleTokens = envTokens;
        dirty = true;
      }
    } catch {}
  }
  if (dirty) save("config", cfg);
}

// ── Daily briefing on the server ─────────────────────────────────────────────
// Runs in-process on the always-on brain (a cron redeploy never executes), at
// briefingTime in briefingTimezone, against the SERVER's data — the same data
// the family's app reads. Delivers to every registered phone + Telegram owner.

function msUntil(timeStr: string, tz: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const nowSec = get("hour") * 3600 + get("minute") * 60 + get("second");
  let delta = (h ?? 7) * 3600 + (m ?? 0) * 60 - nowSec;
  if (delta <= 0) delta += 86400;
  return delta * 1000;
}

async function runBriefingAndDeliver(client: Anthropic, kind: "morning" | "debrief" = "morning"): Promise<string> {
  const cfg = load<Config>("config", {});
  const pushCount = Object.keys(load<Record<string, string>>("push", {})).length;
  const hasTelegram = !!(cfg.telegramBotToken && cfg.telegramOwnerChatId);
  if (!pushCount && !hasTelegram)
    return "Skipped: no delivery targets (no registered phones, no Telegram owner).";
  const task = kind === "debrief" ? AFTERNOON_DEBRIEF_TASK(cfg) : MORNING_BRIEFING_TASK(cfg);
  const title = kind === "debrief" ? "Afternoon debrief" : "Morning briefing";
  const history: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const result = await runAgentTurn(client, history, false);
  recordFeed(title, result, undefined, "briefing");
  const report: string[] = [];
  if (pushCount) report.push(await sendExpoPush(title, result));
  if (hasTelegram) {
    const r: any = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramOwnerChatId, text: result }),
    }).then((x) => x.json());
    report.push(r.ok ? "Telegram delivered." : `Telegram failed: ${JSON.stringify(r)}`);
  }
  const personal = await deliverPersonalEmailDigests(client, kind);
  if (personal) report.push(`${personal} personal inbox digest(s).`);
  return report.join(" ");
}

// Every outbound notification is also recorded here so (a) the app can show it
// in the chat feed and (b) the agent gets it as context on the next turn.
interface FeedItem {
  at: string;
  title: string;
  body: string;
  sessionId?: string; // present = personal (one phone only); absent = household-wide
  dismissed?: boolean; // checked off on the Home page — hidden from alert surfaces
  kind?: "briefing" | "nudge" | "call" | "vip" | "digest"; // routing: only alert-worthy kinds hit Home/fridge
}

// Kinds that belong on the shared "Family alerts" surfaces (Home page, fridge):
// actionable household stuff — nudge findings (early events, conflicts, email
// deadlines) and VIP-sender alerts. Calls live in the comms log; briefings are
// routine and live in chat.
const ALERT_KINDS = new Set(["nudge", "vip"]);

function recordFeed(title: string, body: string, sessionId?: string, kind?: FeedItem["kind"]) {
  const feed = load<FeedItem[]>("feed", []);
  feed.push({ at: new Date().toISOString(), title, body, ...(sessionId ? { sessionId } : {}), ...(kind ? { kind } : {}) });
  save("feed", feed.slice(-80));
}

const feedFor = (sessionId?: string) =>
  load<FeedItem[]>("feed", []).filter((f) => !f.sessionId || f.sessionId === sessionId);

// Local + Google events for a window — the one calendar the whole household sees.
type MergedEvent = { id: string; title: string; start: string; end?: string; who?: string; notes?: string; source: string };

async function mergedCalendar(start: Date, days: number): Promise<MergedEvent[]> {
  const horizon = new Date(start.getTime() + days * 86400000);
  const events: MergedEvent[] = load<CalEvent[]>("calendar", [])
    .filter((e) => new Date(e.start) >= start && new Date(e.start) <= horizon)
    .map((e) => ({ id: String(e.id), title: e.title, start: e.start, end: e.end, who: e.who, notes: e.notes, source: "local" }));
  const gtoken = await googleAccessToken();
  if (gtoken) {
    const g: any = await (
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
          new URLSearchParams({
            timeMin: start.toISOString(),
            timeMax: horizon.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "100",
          }),
        { headers: { Authorization: `Bearer ${gtoken}` } }
      )
    ).json();
    for (const e of g.items ?? []) {
      // Events marked private in Google stay off every family surface.
      if (e.visibility === "private" || e.visibility === "confidential") continue;
      events.push({
        id: String(e.id),
        title: e.summary ?? "(untitled)",
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date,
        notes: e.location,
        source: "google",
      });
    }
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

// Lightweight inbox fetch for personal digests (metadata only, ~12 messages).
async function fetchInboxRows(token: string, hours: number): Promise<string[]> {
  const q = `in:inbox -category:promotions -category:social newer_than:${Math.max(1, Math.ceil(hours / 24))}d`;
  const list: any = await (
    await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?` + new URLSearchParams({ q, maxResults: "12" }),
      { headers: { Authorization: `Bearer ${token}` } }
    )
  ).json();
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  const rows: string[] = [];
  for (const id of ids) {
    const msg: any = await (
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
    ).json();
    const h = (n: string) => msg.payload?.headers?.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    rows.push(`FROM ${h("From").replace(/<.*>/, "").trim()} — ${h("Subject")}${msg.snippet ? ` — ${String(msg.snippet).slice(0, 120)}` : ""}`);
  }
  return rows;
}

// Personal inbox digests ride along with each briefing: every phone that
// connected its own email gets a private "Your inbox" push — recorded in the
// feed as a personal item, invisible to the rest of the household.
async function deliverPersonalEmailDigests(client: Anthropic, kind: "morning" | "debrief"): Promise<number> {
  const users = load<Record<string, GTokens>>("google-users", {});
  const pushReg = load<Record<string, string>>("push", {});
  let delivered = 0;
  for (const sessionId of Object.keys(users)) {
    if (!pushReg[sessionId]) continue;
    try {
      const token = await userAccessToken(sessionId);
      if (!token) continue;
      const rows = await fetchInboxRows(token, kind === "debrief" ? 10 : 24);
      if (!rows.length) continue;
      const resp = await createWithRetry(client, {
        model: FAST_MODEL,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `From these inbox emails, write a 2-4 line personal digest covering ONLY the ones that matter (skip newsletters, promos, receipts, routine notifications). If nothing matters, reply with exactly the single word NOTHING.\n\n${rows.join("\n")}`,
          },
        ],
      });
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
      if (!text || /^NOTHING\b/i.test(text)) continue;
      recordFeed("Your inbox", text, sessionId, "digest");
      await sendExpoPush("Your inbox", text, sessionId);
      delivered++;
    } catch {}
  }
  return delivered;
}

// VIP watcher: every ~10 min, check each person's inbox for new mail from their
// important senders and push an alert to their phone only. No model calls —
// a plain Gmail search from the last checkpoint forward.
async function checkVipEmails(): Promise<void> {
  const vips = load<Record<string, string[]>>("email-vips", {});
  const lastChecks = load<Record<string, number>>("vip-last-check", {});
  let dirty = false;
  for (const [sid, senders] of Object.entries(vips)) {
    if (!senders.length) continue;
    try {
      // Personal inbox when connected; the household connection as fallback.
      const token = (await userAccessToken(sid)) ?? (await googleAccessToken());
      if (!token) continue;
      const since = lastChecks[sid] ?? Date.now() - 3600_000;
      const q = `in:inbox after:${Math.floor(since / 1000)} (${senders.map((s) => `from:"${s}"`).join(" OR ")})`;
      const list: any = await (
        await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?` + new URLSearchParams({ q, maxResults: "5" }),
          { headers: { Authorization: `Bearer ${token}` } }
        )
      ).json();
      lastChecks[sid] = Date.now();
      dirty = true;
      for (const m of list.messages ?? []) {
        const msg: any = await (
          await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
            { headers: { Authorization: `Bearer ${token}` } }
          )
        ).json();
        const h = (n: string) => msg.payload?.headers?.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        const from = h("From").replace(/<.*>/, "").trim();
        const body = `${from}: ${h("Subject")}${msg.snippet ? `\n${String(msg.snippet).slice(0, 160)}` : ""}`;
        recordFeed("📬 Important email", body, sid === "household" ? undefined : sid, "vip");
        await sendExpoPush("📬 Important email", body, sid === "household" ? undefined : sid);
      }
    } catch {}
  }
  if (dirty) save("vip-last-check", lastChecks);
}

// Evening nudge: runs the look-ahead scan; delivers only when the agent found
// something (the NOTHING sentinel suppresses delivery entirely — no noise).
async function runNudgeAndDeliver(client: Anthropic): Promise<string> {
  const cfg = load<Config>("config", {});
  const pushCount = Object.keys(load<Record<string, string>>("push", {})).length;
  const hasTelegram = !!(cfg.telegramBotToken && cfg.telegramOwnerChatId);
  if (!pushCount && !hasTelegram) return "Skipped: no delivery targets.";
  const history: Anthropic.MessageParam[] = [{ role: "user", content: NUDGE_TASK(cfg) }];
  const result = (await runAgentTurn(client, history, false)).trim();
  if (/^NOTHING\b/i.test(result)) return "Quiet night — nothing worth a nudge.";
  recordFeed("Heads up for tomorrow", result, undefined, "nudge");
  const report: string[] = [];
  if (pushCount) report.push(await sendExpoPush("Heads up for tomorrow", result));
  if (hasTelegram) {
    const r: any = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegramOwnerChatId, text: result }),
    }).then((x) => x.json());
    report.push(r.ok ? "Telegram delivered." : `Telegram failed: ${JSON.stringify(r)}`);
  }
  return `Nudged: ${report.join(" ")}`;
}

// Nightly habit learning: feed today's conversations back through the agent so
// it stores durable patterns via family_memory. Silent — no delivery.
async function runNightlyReflection(client: Anthropic): Promise<string> {
  const stored = load<StoredSessions>("sessions", {});
  // Sessions don't carry timestamps, so "today" ≈ the trailing window of each session.
  const lines: string[] = [];
  for (const [id, history] of Object.entries(stored)) {
    for (const m of history.slice(-20)) {
      if (m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[system note"))
        lines.push(`[${id}] ${m.content.slice(0, 300)}`);
    }
  }
  if (lines.length < 3) return "Skipped: not enough conversation today to learn from.";
  const history: Anthropic.MessageParam[] = [{ role: "user", content: REFLECTION_TASK(lines.slice(-60).join("\n")) }];
  return runAgentTurn(client, history, false);
}

// ── Recipe → grocery ingredients (link or photo) ─────────────────────────────
// Fast path: most recipe sites embed schema.org/Recipe JSON-LD with the exact
// ingredient list — no model call needed. Fallback: strip the page to text (or
// take the photo) and have the fast model return a JSON array of ingredients.

function findJsonLdIngredients(html: string): string[] | null {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    try {
      const data = JSON.parse(m[1]);
      const nodes: any[] = Array.isArray(data) ? data : data["@graph"] ?? [data];
      for (const n of nodes) {
        if (Array.isArray(n?.recipeIngredient) && n.recipeIngredient.length)
          return n.recipeIngredient.map((x: unknown) => String(x).trim());
      }
    } catch {}
  }
  return null;
}

async function extractIngredients(
  client: Anthropic,
  input: { url?: string; image?: string; mediaType?: string }
): Promise<string[]> {
  let content: Anthropic.MessageParam["content"];
  if (input.url) {
    const html = await (
      await fetch(input.url, { headers: { "User-Agent": "Mozilla/5.0 (Homebase family agent)" } })
    ).text();
    const ld = findJsonLdIngredients(html);
    if (ld) return ld;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 15000);
    content = `Extract the recipe's ingredient list from this page text. Reply with ONLY a JSON array of strings, each a shopping-list item like "2 lbs chicken thighs". No commentary. If there's no recipe, reply []. PAGE TEXT: ${text}`;
  } else if (input.image) {
    content = [
      {
        type: "image",
        source: { type: "base64", media_type: (input.mediaType as any) ?? "image/jpeg", data: input.image },
      },
      {
        type: "text",
        text: 'Extract the recipe\'s ingredient list from this photo. Reply with ONLY a JSON array of strings, each a shopping-list item like "2 lbs chicken thighs". No commentary. If no recipe is visible, reply [].',
      },
    ];
  } else {
    return [];
  }
  const resp = await createWithRetry(client, { model: FAST_MODEL, max_tokens: 1200, messages: [{ role: "user", content }] });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return (JSON.parse(match[0]) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Document memory: photo of a school calendar / insurance card / router label →
// vision-extract the durable facts → family_memory. Strong model on purpose —
// a misread policy number is worse than a slow scan.
async function extractDocumentFacts(
  client: Anthropic,
  input: { image: string; mediaType?: string; hint?: string }
): Promise<{ summary: string; facts: { key: string; fact: string }[] }> {
  const resp = await createWithRetry(client, {
    model: STRONG_MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: (input.mediaType as any) ?? "image/jpeg", data: input.image } },
          {
            type: "text",
            text:
              `This is a photo of a household document (school calendar, insurance card, appliance manual, ` +
              `wifi router label, permission slip, etc.).${input.hint ? ` The user says: "${input.hint}".` : ""} ` +
              `Identify it and extract the durable facts a family assistant should remember. Copy numbers/codes ` +
              `EXACTLY as printed — if a character is ambiguous, note it in the fact. Reply with ONLY JSON: ` +
              `{"summary": "one line saying what this is", "facts": [{"key": "kebab-case-specific-key", "fact": "value"}]} ` +
              `— max 10 facts, keys specific (e.g. "insurance-anthem-member-id", "wifi-network-password", ` +
              `"school-fall-break-dates"). If unreadable: {"summary": "unreadable", "facts": []}`,
          },
        ],
      },
    ],
  });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { summary: "unreadable", facts: [] };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      summary: String(parsed.summary ?? "document"),
      facts: (parsed.facts ?? [])
        .filter((f: any) => f?.key && f?.fact)
        .slice(0, 10)
        .map((f: any) => ({ key: String(f.key).toLowerCase().replace(/[^a-z0-9-]+/g, "-"), fact: String(f.fact) })),
    };
  } catch {
    return { summary: "unreadable", facts: [] };
  }
}

// Rolling record of grocery check-offs — the signal the restock learner reads.
function logCheckoff(item: string) {
  const log = load<{ item: string; at: string }[]>("restock-log", []);
  log.push({ item: item.toLowerCase().trim(), at: new Date().toISOString() });
  save("restock-log", log.slice(-500));
}

// Recurring restock: items checked off ≥3 times on a steady cadence (3–21 days),
// overdue by their own rhythm, and not already on the list → pre-add them.
// Purely statistical — no model call. The morning briefing announces the result.
function runRestock(): string {
  const log = load<{ item: string; at: string }[]>("restock-log", []);
  const lists = load<Lists>("lists", {});
  const openNames = new Set((lists["grocery"] ?? []).filter((i) => !i.done).map((i) => i.item.toLowerCase().trim()));
  const byItem = new Map<string, number[]>();
  for (const e of log) {
    const k = e.item;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k)!.push(Date.parse(e.at));
  }
  const now = Date.now();
  const added: string[] = [];
  for (const [name, times] of byItem) {
    if (openNames.has(name)) continue;
    const recent = times.filter((t) => now - t < 60 * 86400000).sort((a, b) => a - b);
    if (recent.length < 3) continue;
    const gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median < 3 * 86400000 || median > 21 * 86400000) continue; // steady household cadence only
    if (now - recent[recent.length - 1] < median) continue; // not due yet by its own rhythm
    addToList("grocery", [name]);
    added.push(name);
  }
  if (added.length) {
    const mem = load<Record<string, string>>("memory", {});
    mem["restock-report"] = `${new Date().toISOString().slice(0, 10)}: auto-added ${added.join(", ")} (based on the family's buying rhythm)`;
    save("memory", mem);
  }
  return added.length ? `Restocked: ${added.join(", ")}` : "No restock due.";
}

// Photo of any printed list (school supply sheet, packing list, team snack
// signup) → items. Generic sibling of the recipe extractor.
async function extractListItems(
  client: Anthropic,
  input: { image: string; mediaType?: string; hint?: string }
): Promise<string[]> {
  const resp = await createWithRetry(client, {
    model: FAST_MODEL,
    max_tokens: 1200,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: (input.mediaType as any) ?? "image/jpeg", data: input.image } },
          {
            type: "text",
            text:
              `This photo shows a list of items (school supply list, packing list, signup sheet, etc.).` +
              `${input.hint ? ` The user says: "${input.hint}".` : ""} Extract every item as a JSON array of ` +
              `strings, keeping quantities (e.g. "24 #2 pencils"). Reply with ONLY the JSON array. ` +
              `If there's no list in the photo, reply [].`,
          },
        ],
      },
    ],
  });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return (JSON.parse(match[0]) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function addToList(listName: string, items: string[]): { id: number; item: string }[] {
  const lists = load<Lists>("lists", {});
  lists[listName] ??= [];
  const added: { id: number; item: string }[] = [];
  for (const item of items) {
    const id = (lists[listName].at(-1)?.id ?? 0) + 1;
    lists[listName].push({ id, item, done: false });
    added.push({ id, item });
  }
  save("lists", lists);
  return added;
}

// Repair a session whose tool_use/tool_result pairing got broken (e.g. a message
// was injected mid-turn, or the process died between the two). The API rejects the
// whole conversation otherwise, permanently bricking the persisted session.
function sanitizeHistory(history: Anthropic.MessageParam[]) {
  while (history.length && history[0].role !== "user") history.shift();
  while (history.length && Array.isArray(history[0].content) &&
         (history[0].content as any[])[0]?.type === "tool_result") {
    history.shift();
  }
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const ids = (msg.content as any[]).filter((b) => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;
    const next = history[i + 1];
    const nextResults =
      next?.role === "user" && Array.isArray(next.content)
        ? new Set((next.content as any[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id))
        : new Set<string>();
    const missing = ids.filter((id) => !nextResults.has(id));
    if (!missing.length) continue;
    const synthetic = missing.map((id) => ({
      type: "tool_result" as const, tool_use_id: id, content: "(result lost — session was interrupted)",
    }));
    if (next?.role === "user" && Array.isArray(next.content) && (next.content as any[])[0]?.type === "tool_result") {
      (next.content as any[]).unshift(...synthetic);
    } else {
      history.splice(i + 1, 0, { role: "user", content: synthetic });
    }
  }
}

// Weather for the display, cached 15 min so a 60s-refresh tablet doesn't hammer APIs.
let WEATHER_CACHE: { at: number; data: any } | null = null;
async function displayWeather(): Promise<any | null> {
  const cfg = load<Config>("config", {});
  if (!cfg.homeCity) return null;
  if (WEATHER_CACHE && Date.now() - WEATHER_CACHE.at < 15 * 60 * 1000) return WEATHER_CACHE.data;
  try {
    const geo: any = await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cfg.homeCity)}&count=1`)
    ).json();
    const place = geo.results?.[0];
    if (!place) return null;
    const wx: any = await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`
      )
    ).json();
    const data = {
      city: place.name,
      now: Math.round(wx.current?.temperature_2m),
      hi: Math.round(wx.daily?.temperature_2m_max?.[0]),
      lo: Math.round(wx.daily?.temperature_2m_min?.[0]),
      rain: wx.daily?.precipitation_probability_max?.[0] ?? 0,
    };
    WEATHER_CACHE = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

// The fridge/wall page: one static HTML file, renders from /display/data, made
// to be read across a kitchen — big type, dark, auto-refreshing, zero chrome.
const DISPLAY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Homebase</title><style>
:root{--bg:#12141c;--card:#1c1f2b;--card2:#242838;--accent:#6c7dff;--text:#eef0f6;--dim:#9aa0b4;--ok:#5dd39e;--border:#2c3040}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:-apple-system,'Segoe UI',Roboto,sans-serif;height:100vh;overflow:hidden;padding:2.2vmin;display:flex;flex-direction:column;gap:1.6vmin}
header{display:flex;justify-content:space-between;align-items:baseline}
#fam{font-size:4.6vmin;font-weight:800}
#date{color:var(--dim);font-size:2.4vmin;margin-top:.4vmin}
#right{text-align:right}
#clock{font-size:5.6vmin;font-weight:800;font-variant-numeric:tabular-nums}
#wx{color:var(--dim);font-size:2.2vmin}
main{flex:1;display:grid;grid-template-columns:2fr 1fr;gap:1.6vmin;min-height:0}
.col{display:flex;flex-direction:column;gap:1.6vmin;min-height:0}
.card{background:var(--card);border:1px solid var(--border);border-radius:1.6vmin;padding:1.8vmin;overflow:hidden}
.card h2{font-size:1.9vmin;color:var(--accent);text-transform:uppercase;letter-spacing:.14em;margin-bottom:1.2vmin}
#agenda{flex:1;overflow:hidden}
.day{margin-bottom:1.6vmin}
.dayname{font-size:2vmin;font-weight:800;color:var(--dim);margin-bottom:.6vmin}
.dayname.today{color:var(--ok)}
.ev{display:flex;gap:1.2vmin;align-items:baseline;padding:.5vmin 0;font-size:2.5vmin}
.ev .t{color:var(--accent);font-weight:700;min-width:11vmin;font-size:2.1vmin}
.ev .dot{width:1.1vmin;height:1.1vmin;border-radius:50%;flex:none;align-self:center}
.ev .who{color:var(--dim);font-size:2vmin}
.none{color:var(--dim);font-size:2.2vmin}
#grocery{flex:1.4;overflow:hidden}
.g{display:flex;align-items:center;gap:1.2vmin;padding:.7vmin 0;font-size:2.4vmin;cursor:pointer}
.g .box{width:2.6vmin;height:2.6vmin;border:.3vmin solid var(--dim);border-radius:.7vmin;flex:none}
.chips{display:flex;flex-wrap:wrap;gap:1vmin}
.chip{background:var(--card2);border:1px solid var(--border);border-radius:2vmin;padding:.8vmin 1.5vmin;font-size:2vmin}
.chip b{color:var(--accent)}
.alert{padding:.8vmin 0;border-bottom:1px solid var(--border);font-size:2vmin;color:var(--dim)}
.alert b{color:var(--text);display:block;font-size:2.1vmin}
.alert:last-child{border-bottom:0}
</style></head><body>
<header><div><div id="fam">Homebase</div><div id="date"></div></div>
<div id="right"><div id="clock"></div><div id="wx"></div></div></header>
<main>
<div class="col"><div class="card" id="agenda"><h2>This week</h2><div id="days"></div></div>
<div class="card"><h2>Coming up</h2><div class="chips" id="countdowns"></div></div></div>
<div class="col"><div class="card" id="grocery"><h2>🛒 Grocery</h2><div id="glist"></div></div>
<div class="card"><h2>🔔 Alerts</h2><div id="alerts"></div></div></div>
</main>
<script>
const KEY=new URLSearchParams(location.search).get("key");
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function tick(){const d=new Date();document.getElementById("clock").textContent=d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"});document.getElementById("date").textContent=d.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}
setInterval(tick,1000);tick();
function memberColor(ev,members){if(ev.who)for(const m of members)if(ev.who.toLowerCase().includes(m.name.toLowerCase()))return m.color;
for(const m of members)if(ev.title.toLowerCase().includes(m.name.toLowerCase()))return m.color;
return ev.source==="google"?"#6c7dff":"#5dd39e"}
function timeLabel(ev){if(!ev.start.includes("T"))return "All day";return new Date(ev.start).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"})}
async function toggle(id){await fetch("/display/toggle?key="+KEY,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});refresh()}
async function refresh(){try{
const r=await fetch("/display/data?key="+KEY);if(!r.ok)return;const d=await r.json();
document.getElementById("fam").textContent=d.familyName;
document.getElementById("wx").textContent=d.weather?\`\${d.weather.city} \${d.weather.now}° · H \${d.weather.hi}° L \${d.weather.lo}°\${d.weather.rain>30?" · ☔ "+d.weather.rain+"%":""}\`:"";
const byDay={};for(const e of d.events){const k=e.start.slice(0,10);(byDay[k]??=[]).push(e)}
const days=[];const now=new Date();
for(let i=0;i<7;i++){const dt=new Date(now.getFullYear(),now.getMonth(),now.getDate()+i);
const k=\`\${dt.getFullYear()}-\${String(dt.getMonth()+1).padStart(2,"0")}-\${String(dt.getDate()).padStart(2,"0")}\`;
const evs=byDay[k]??[];if(i>1&&!evs.length)continue;
const label=i===0?"Today":i===1?"Tomorrow":dt.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});
days.push(\`<div class="day"><div class="dayname\${i===0?" today":""}">\${label}</div>\${
evs.length?evs.map(e=>\`<div class="ev"><span class="dot" style="background:\${memberColor(e,d.members)}"></span><span class="t">\${timeLabel(e)}</span><span>\${esc(e.title)}</span>\${e.who?\`<span class="who">· \${esc(e.who)}</span>\`:""}</div>\`).join(""):'<div class="none">Nothing scheduled</div>'}</div>\`)}
document.getElementById("days").innerHTML=days.join("");
document.getElementById("glist").innerHTML=d.grocery.length?d.grocery.slice(0,12).map(g=>\`<div class="g" onclick="toggle(\${g.id})"><span class="box"></span>\${esc(g.item)}</div>\`).join("")+(d.grocery.length>12?\`<div class="none">+\${d.grocery.length-12} more</div>\`:""):'<div class="none">List is empty 🎉</div>';
const cds=[];const seen=new Set();
for(const e of d.events){const dd=Math.round((new Date(e.start.slice(0,10)+"T12:00")-new Date(now.getFullYear(),now.getMonth(),now.getDate(),12))/86400000);
if(dd>=2&&dd<=30&&!seen.has(e.title)){seen.add(e.title);cds.push(\`<span class="chip"><b>\${dd} days</b> · \${esc(e.title)}</span>\`);if(cds.length>=4)break}}
document.getElementById("countdowns").innerHTML=cds.join("")||'<span class="none">Nothing on the horizon</span>';
document.getElementById("alerts").innerHTML=d.alerts.length?d.alerts.map(a=>\`<div class="alert"><b>\${esc(a.title)}</b>\${esc(a.body.slice(0,110))}</div>\`).join(""):'<div class="none">All quiet</div>';
}catch(e){}}
setInterval(refresh,60000);refresh();
</script></body></html>`;

async function serveMode(client: Anthropic, cfg: Config, port: number) {
  hydrateConfigFromEnv(cfg);
  let token = process.env.HOMEBASE_SERVER_TOKEN || cfg.serverToken;
  if (!token) {
    token = randomUUID();
    cfg.serverToken = token;
    save("config", cfg);
  }
  // Separate, weaker key for the fridge/wall display: read + grocery check-off
  // only, so a tablet on the fridge never holds the full server token.
  if (!cfg.displayToken) {
    cfg.displayToken = randomUUID();
    save("config", cfg);
  }
  const displayKey = cfg.displayToken;

  const sessions = new Map<string, Anthropic.MessageParam[]>(
    Object.entries(load<StoredSessions>("sessions", {}))
  );
  const saveSessions = () => save("sessions", Object.fromEntries(sessions));
  const pendingNotes = new Map<string, string[]>(); // call outcomes awaiting the session's next turn
  const pendingOAuth = new Map<string, { sessionId: string; at: number }>(); // state → phone, 10-min TTL

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") return send(204, {});
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, version: VERSION });

      // Browser lands here from Google — no bearer header, so it lives above the
      // auth gate; the one-time `state` (minted by the authed /init) is the auth.
      if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
        const html = (msg: string) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<div style="font-family:sans-serif;padding:40px;text-align:center"><h2>${msg}</h2></div>`);
        };
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code");
        const pending = pendingOAuth.get(state);
        pendingOAuth.delete(state);
        if (!pending || Date.now() - pending.at > 600_000) return html("This connect link expired — start again from the app.");
        if (!code) return html(`Google said: ${url.searchParams.get("error") ?? "no code"}`);
        const cfg = load<Config>("config", {});
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cfg.googleWebClientId!,
            client_secret: cfg.googleWebClientSecret!,
            code,
            redirect_uri: `${cfg.publicUrl}/oauth/google/callback`,
            grant_type: "authorization_code",
          }),
        });
        const tok: any = await r.json();
        if (!r.ok) return html(`Token exchange failed: ${tok.error_description ?? tok.error ?? r.status}`);
        const users = load<Record<string, GTokens>>("google-users", {});
        users[pending.sessionId] = {
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
        };
        save("google-users", users);
        return html("✅ Your email is connected to Homebase on this phone only. You can close this tab.");
      }

      // Vapi's end-of-call reports for the inbound receptionist — authenticated
      // by the x-vapi-secret header (set during --setup-inbound), not the bearer.
      if (req.method === "POST" && url.pathname === "/vapi/webhook") {
        if ((req.headers["x-vapi-secret"] ?? "") !== token) return send(401, { error: "bad secret" });
        const body = JSON.parse((await readBody(req)) || "{}");
        const msg = body.message ?? {};
        if (msg.type === "end-of-call-report") {
          const caller = msg.call?.customer?.number ?? "unknown number";
          const summary = msg.analysis?.summary ?? msg.summary ?? "(no summary)";
          const text = `From ${caller}:\n${String(summary).slice(0, 500)}`;
          recordFeed("📞 Incoming call", text, undefined, "call"); // chat feed + comms, not Family alerts
          sendExpoPush("📞 Incoming call", text).catch(() => {});
          const calls = load<CallLogEntry[]>("calls", []);
          calls.push({
            id: msg.call?.id ?? randomUUID(),
            number: caller,
            purpose: "inbound call",
            placedAt: new Date().toISOString(),
            status: "ended",
            summary: String(summary).slice(0, 300),
            endedAt: new Date().toISOString(),
          });
          save("calls", calls);
          logComm({ at: new Date().toISOString(), type: "call", direction: "in", party: caller, summary: String(summary).slice(0, 200) });
        }
        return send(200, { ok: true });
      }

      // ── Fridge / wall display (own weak key; tablet browsers, kiosk mode) ──
      if (url.pathname === "/display" || url.pathname.startsWith("/display/")) {
        if (url.searchParams.get("key") !== displayKey) return send(401, { error: "bad display key" });

        if (req.method === "GET" && url.pathname === "/display") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(DISPLAY_PAGE);
        }

        if (req.method === "GET" && url.pathname === "/display/data") {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const fam = load<Family>("family", { members: [] });
          const lists = load<Lists>("lists", {});
          return send(200, {
            familyName: fam.name ?? "Homebase",
            members: fam.members,
            events: await mergedCalendar(todayStart, 30),
            grocery: (lists["grocery"] ?? []).filter((i) => !i.done),
            weather: await displayWeather(),
            alerts: feedFor(undefined).filter((f) => !f.dismissed && ALERT_KINDS.has(f.kind ?? "")).slice(-3).reverse(),
          });
        }

        // The one write the display key allows: checking off a grocery item.
        if (req.method === "POST" && url.pathname === "/display/toggle") {
          const { id } = JSON.parse((await readBody(req)) || "{}");
          const lists = load<Lists>("lists", {});
          const it = (lists["grocery"] ?? []).find((i) => i.id === Number(id));
          if (!it) return send(404, { error: "no such item" });
          it.done = !it.done;
          save("lists", lists);
          if (it.done) logCheckoff(it.item);
          return send(200, { ok: true });
        }

        return send(404, { error: "not found" });
      }

      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) return send(401, { error: "unauthorized" });

      // Mint a personal-email connect URL for this phone (10-min single-use state).
      if (req.method === "POST" && url.pathname === "/oauth/google/init") {
        const { sessionId } = JSON.parse((await readBody(req)) || "{}");
        if (!sessionId) return send(400, { error: "sessionId required" });
        const cfg = load<Config>("config", {});
        if (!cfg.googleWebClientId || !cfg.googleWebClientSecret || !cfg.publicUrl)
          return send(400, {
            error:
              "Personal email connect isn't configured. Server needs GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET (a Web-type OAuth client with redirect URI <server>/oauth/google/callback), and a public URL.",
          });
        const state = randomUUID();
        pendingOAuth.set(state, { sessionId, at: Date.now() });
        const authUrl =
          "https://accounts.google.com/o/oauth2/v2/auth?" +
          new URLSearchParams({
            client_id: cfg.googleWebClientId,
            redirect_uri: `${cfg.publicUrl}/oauth/google/callback`,
            response_type: "code",
            scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            access_type: "offline",
            prompt: "consent",
            state,
          });
        return send(200, { url: authUrl });
      }

      if (req.method === "POST" && url.pathname === "/chat") {
        const { sessionId = "default", message } = JSON.parse((await readBody(req)) || "{}");
        if (!message || typeof message !== "string") return send(400, { error: "message (string) required" });
        const history = sessions.get(sessionId) ?? [];
        sessions.set(sessionId, history);
        sanitizeHistory(history); // repair sessions bricked by older followup injection
        const prefixes: string[] = [];
        const notes = pendingNotes.get(sessionId);
        pendingNotes.delete(sessionId);
        if (notes?.length) prefixes.push(`[system note — completed call outcome: ${notes.join(" | ")}]`);
        // Give the agent the notifications this session hasn't discussed yet, so
        // "yes, add that one" after a nudge/briefing has something to refer to.
        const feed = feedFor(sessionId);
        const reads = load<Record<string, string>>("feed-read", {});
        const unread = feed.filter((f) => f.at > (reads[sessionId] ?? "")).slice(-3);
        if (unread.length) {
          prefixes.push(
            `[system note — notifications recently sent: ${unread.map((f) => `${f.title}: ${f.body.slice(0, 400)}`).join(" ||| ")}]`
          );
          reads[sessionId] = feed.at(-1)!.at;
          save("feed-read", reads);
        }
        history.push({
          role: "user",
          content: prefixes.length ? `${prefixes.join("\n")}\n${message}` : message,
        });
        const reply = await TURN_CTX.run({ sessionId }, () => runAgentTurn(client, history, false));
        trimHistory(history);
        saveSessions();
        // Call outcomes go out as push notifications and surface as a note on the
        // next turn — never appended to a live history (that corrupts mid-flight turns).
        // Call outcomes are the caller's business: personal feed item + push to
        // their phone only. The shared comms log still records every call.
        scheduleCallFollowups((t) => {
          const q = pendingNotes.get(sessionId) ?? [];
          q.push(t);
          pendingNotes.set(sessionId, q);
          recordFeed("Call update", t, sessionId, "call");
          sendExpoPush("Call update", t, sessionId).catch(() => {});
        });
        return send(200, { reply });
      }

      // Manual "run it now" — also how delivery gets tested end to end.
      // Body: { kind?: "morning" | "debrief" | "nudge" | "reflection" }
      if (req.method === "POST" && url.pathname === "/briefing") {
        const { kind = "morning" } = JSON.parse((await readBody(req)) || "{}");
        if (kind === "reflection") return send(200, { report: await runNightlyReflection(client) });
        if (kind === "nudge") return send(200, { report: await runNudgeAndDeliver(client) });
        return send(200, { report: await runBriefingAndDeliver(client, kind === "debrief" ? "debrief" : "morning") });
      }

      if (req.method === "POST" && url.pathname === "/register-push") {
        const { sessionId = "default", pushToken } = JSON.parse((await readBody(req)) || "{}");
        if (!pushToken) return send(400, { error: "pushToken required" });
        const tokens = load<Record<string, string>>("push", {});
        tokens[sessionId] = pushToken;
        save("push", tokens);
        return send(200, { ok: true });
      }

      // Ops visibility: where is data actually going, and is anything in it?
      if (req.method === "GET" && url.pathname === "/status") {
        const cfgNow = load<Config>("config", {});
        return send(200, {
          dataDir: DIR,
          homebaseDirEnv: process.env.HOMEBASE_DIR ?? null,
          pushTokens: Object.keys(load<Record<string, string>>("push", {})).length,
          sessions: Object.keys(load<StoredSessions>("sessions", {})).length,
          listItems: Object.values(load<Lists>("lists", {})).reduce((n, l) => n + l.length, 0),
          displayUrl: cfgNow.publicUrl && cfgNow.displayToken ? `${cfgNow.publicUrl}/display?key=${cfgNow.displayToken}` : null,
        });
      }

      // Notification history — the app shows these inline in the chat feed.
      // Household items for everyone; personal items only to their own phone.
      if (req.method === "GET" && url.pathname === "/feed") {
        const sid = url.searchParams.get("sessionId") ?? undefined;
        return send(200, { items: feedFor(sid).slice(-20) });
      }

      // Check off a family alert — household-wide (handled is handled for everyone).
      if (req.method === "POST" && url.pathname === "/feed/dismiss") {
        const { at } = JSON.parse((await readBody(req)) || "{}");
        const feed = load<FeedItem[]>("feed", []);
        const item = feed.find((f) => f.at === at);
        if (!item) return send(404, { error: "no such alert" });
        item.dismissed = true;
        save("feed", feed);
        return send(200, { ok: true });
      }

      // Communication log — calls + texts, in and out, newest first (comms screen).
      if (req.method === "GET" && url.pathname === "/communications") {
        return send(200, { items: load<CommEntry[]>("comms", []).slice(-100).reverse() });
      }

      // ── Structured data for the app's Grocery + Calendar screens ──────────
      // Household-shared by design: one brain, one data set, every phone equal.

      if (req.method === "GET" && url.pathname === "/lists") {
        return send(200, { lists: load<Lists>("lists", {}) });
      }

      if (req.method === "POST" && url.pathname === "/lists/add") {
        const { list = "grocery", item } = JSON.parse((await readBody(req)) || "{}");
        if (!item || typeof item !== "string") return send(400, { error: "item (string) required" });
        addToList(String(list).toLowerCase(), [item.trim()]);
        return send(200, { lists: load<Lists>("lists", {}) });
      }

      if (req.method === "POST" && url.pathname === "/lists/toggle") {
        const { list, id } = JSON.parse((await readBody(req)) || "{}");
        const lists = load<Lists>("lists", {});
        const it = lists[String(list).toLowerCase()]?.find((i) => i.id === Number(id));
        if (!it) return send(404, { error: `no #${id} in ${list}` });
        it.done = !it.done;
        save("lists", lists);
        if (it.done && String(list).toLowerCase() === "grocery") logCheckoff(it.item);
        return send(200, { lists });
      }

      if (req.method === "POST" && url.pathname === "/lists/clear_done") {
        const { list = "grocery" } = JSON.parse((await readBody(req)) || "{}");
        const lists = load<Lists>("lists", {});
        const name = String(list).toLowerCase();
        if (lists[name]) {
          lists[name] = lists[name].filter((i) => !i.done);
          save("lists", lists);
        }
        return send(200, { lists });
      }

      if (req.method === "POST" && url.pathname === "/lists/remove") {
        const { list, id } = JSON.parse((await readBody(req)) || "{}");
        const lists = load<Lists>("lists", {});
        const arr = lists[String(list).toLowerCase()] ?? [];
        const idx = arr.findIndex((i) => i.id === Number(id));
        if (idx === -1) return send(404, { error: `no #${id} in ${list}` });
        arr.splice(idx, 1);
        save("lists", lists);
        return send(200, { lists });
      }

      if (req.method === "GET" && url.pathname === "/calendar") {
        const days = Math.min(62, Number(url.searchParams.get("days")) || 14);
        const from = url.searchParams.get("from"); // YYYY-MM-DD → month views
        const start = from ? new Date(`${from}T00:00:00`) : new Date();
        return send(200, { events: await mergedCalendar(start, days) });
      }

      // Add an event from the app's calendar form (Google when connected, else local).
      if (req.method === "POST" && url.pathname === "/calendar/add") {
        const { title, start, end, who, notes, allDay, private: priv } = JSON.parse((await readBody(req)) || "{}");
        if (!title || !start) return send(400, { error: "title and start required" });
        const gtoken = await googleAccessToken();
        if (gtoken) {
          const body: any = { summary: title, location: notes };
          if (priv) body.visibility = "private";
          if (allDay) {
            const day = String(start).slice(0, 10);
            const next = new Date(new Date(`${day}T00:00:00`).getTime() + 86400000).toISOString().slice(0, 10);
            body.start = { date: day };
            body.end = { date: next };
          } else {
            body.start = gTime(start);
            body.end = end ? gTime(end) : gTime(hasOffset(start)
              ? new Date(new Date(start).getTime() + 3600000).toISOString()
              : naivePlus(start, 3600000));
          }
          const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
            method: "POST",
            headers: { Authorization: `Bearer ${gtoken}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data: any = await r.json();
          if (!r.ok) return send(r.status, { error: data.error?.message ?? "google add failed" });
          return send(200, { ok: true, source: "google" });
        }
        const events = load<CalEvent[]>("calendar", []);
        const id = (events.at(-1)?.id ?? 0) + 1;
        events.push({ id, title, start, end: end || undefined, who: who || undefined, notes: notes || undefined });
        events.sort((a, b) => a.start.localeCompare(b.start));
        save("calendar", events);
        return send(200, { ok: true, source: "local" });
      }

      // Home page payload: family profile, what's AHEAD today (finished events
      // drop off), tomorrow once evening hits, alerts, quick stats.
      if (req.method === "GET" && url.pathname === "/household") {
        const fam = load<Family>("family", { members: [] });
        const cfgNow = load<Config>("config", {});
        const tz = cfgNow.briefingTimezone ?? "America/New_York";
        const now = new Date();
        // household-local date keys + hour (the server itself runs in UTC)
        const dayKeyIn = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
        const todayKey = dayKeyIn(now);
        const tomorrowKey = dayKeyIn(new Date(now.getTime() + 86400000));
        const hourNow = Number(
          new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(now)
        );
        const all = await mergedCalendar(new Date(now.getTime() - 86400000), 3);
        const notOver = (e: MergedEvent) => {
          if (!e.start.includes("T")) return true; // all-day stays all day
          const endMs = e.end?.includes("T") ? new Date(e.end).getTime() : new Date(e.start).getTime() + 3600000;
          return endMs > now.getTime();
        };
        const eventsToday = all.filter((e) => e.start.slice(0, 10) === todayKey && notOver(e));
        const evening = hourNow >= 17;
        const eventsTomorrow =
          evening || !eventsToday.length ? all.filter((e) => e.start.slice(0, 10) === tomorrowKey) : [];
        const lists = load<Lists>("lists", {});
        const openGrocery = (lists["grocery"] ?? []).filter((i) => !i.done).length;
        const commitmentsDue = load<Commitment[]>("commitments", []).filter(
          (c) => c.status === "open" && c.due && c.due <= todayKey
        ).length;
        return send(200, {
          familyName: fam.name ?? null,
          members: fam.members,
          eventsToday,
          eventsTomorrow,
          alerts: feedFor(undefined).filter((f) => !f.dismissed && ALERT_KINDS.has(f.kind ?? "")).slice(-5).reverse(),
          stats: { openGrocery, commitmentsDue },
        });
      }

      // Edit an event on either calendar. Google edits sync to the real calendar.
      if (req.method === "POST" && url.pathname === "/calendar/update") {
        const { source, id, title, start, end, notes, who, private: priv } = JSON.parse((await readBody(req)) || "{}");
        if (!id || !source) return send(400, { error: "source and id required" });
        if (source === "local") {
          const events = load<CalEvent[]>("calendar", []);
          const ev = events.find((e) => e.id === Number(id));
          if (!ev) return send(404, { error: `no local event ${id}` });
          if (title) ev.title = title;
          if (start) ev.start = start;
          if (end !== undefined) ev.end = end || undefined;
          if (notes !== undefined) ev.notes = notes || undefined;
          if (who !== undefined) ev.who = who || undefined;
          events.sort((a, b) => a.start.localeCompare(b.start));
          save("calendar", events);
          return send(200, { ok: true });
        }
        const token = await googleAccessToken();
        if (!token) return send(400, { error: "Google Calendar not connected" });
        const patch: any = {};
        if (title) patch.summary = title;
        if (notes !== undefined) patch.location = notes;
        if (priv !== undefined) patch.visibility = priv ? "private" : "default";
        if (start) {
          patch.start = gTime(start);
          patch.end = end ? gTime(end) : gTime(hasOffset(start)
            ? new Date(new Date(start).getTime() + 3600000).toISOString()
            : naivePlus(start, 3600000));
        }
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok) return send(res.status, { error: data.error?.message ?? "google update failed" });
        return send(200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/calendar/delete") {
        const { source, id } = JSON.parse((await readBody(req)) || "{}");
        if (!id || !source) return send(400, { error: "source and id required" });
        if (source === "local") {
          const events = load<CalEvent[]>("calendar", []);
          const idx = events.findIndex((e) => e.id === Number(id));
          if (idx === -1) return send(404, { error: `no local event ${id}` });
          events.splice(idx, 1);
          save("calendar", events);
          return send(200, { ok: true });
        }
        const token = await googleAccessToken();
        if (!token) return send(400, { error: "Google Calendar not connected" });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok && res.status !== 204 && res.status !== 410)
          return send(res.status, { error: "google delete failed" });
        return send(200, { ok: true });
      }

      // Recipe import: { url } or { image (base64), mediaType } → grocery list.
      if (req.method === "POST" && url.pathname === "/recipe") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.url && !body.image) return send(400, { error: "url or image required" });
        const ingredients = await extractIngredients(client, body);
        if (!ingredients.length) return send(200, { added: [], message: "No ingredients found — is that a recipe?" });
        const added = addToList(body.list ? String(body.list).toLowerCase() : "grocery", ingredients);
        return send(200, { added });
      }

      // List scan: photo of a printed list → items into a named list.
      if (req.method === "POST" && url.pathname === "/list-scan") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.image) return send(400, { error: "image required" });
        const items = await extractListItems(client, body);
        if (!items.length) return send(200, { added: [], message: "Couldn't find list items in that photo." });
        const added = addToList(body.list ? String(body.list).toLowerCase() : "grocery", items);
        return send(200, { added });
      }

      // Document scan: { image (base64), mediaType, hint? } → facts into family_memory.
      if (req.method === "POST" && url.pathname === "/document") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.image) return send(400, { error: "image required" });
        const { summary, facts } = await extractDocumentFacts(client, body);
        if (!facts.length) return send(200, { summary, stored: [], message: "Couldn't read anything durable from that photo." });
        const mem = load<Record<string, string>>("memory", {});
        for (const f of facts) mem[f.key] = f.fact;
        save("memory", mem);
        return send(200, { summary, stored: facts });
      }

      return send(404, { error: "not found" });
    } catch (err: any) {
      send(500, { error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`Homebase brain serving on :${port}`);
    console.log(`  health:  GET  /health`);
    console.log(`  chat:    POST /chat  { sessionId, message }  (Bearer ${token})`);
    console.log(`  brief:   POST /briefing  (run + deliver now)`);
    if (!process.env.HOMEBASE_SERVER_TOKEN) console.log(`\n  Auth token (set as HOMEBASE_SERVER_TOKEN on the app + Railway): ${token}`);
  });

  // Daily job loops — each reschedules after its run so DST shifts self-correct.
  const briefTz = cfg.briefingTimezone ?? "America/New_York";
  const daily = (label: string, timeStr: string, job: () => Promise<string>) => {
    const tick = async () => {
      try {
        console.log(`[${label}] ${await job()}`);
      } catch (err: any) {
        console.error(`[${label}] failed: ${err.message}`);
      }
      setTimeout(tick, msUntil(timeStr, briefTz));
    };
    setTimeout(tick, msUntil(timeStr, briefTz));
    console.log(`  ${label} scheduled daily at ${timeStr} ${briefTz}`);
  };
  // VIP email watcher — the one job on an interval rather than a daily clock.
  setInterval(() => checkVipEmails().catch(() => {}), 10 * 60 * 1000);
  console.log("  VIP email watcher running every 10 min");

  daily("restock check", "05:30", async () => runRestock()); // before the briefing so it can announce
  daily("morning briefing", cfg.briefingTime ?? "07:00", () => runBriefingAndDeliver(client, "morning"));
  daily("afternoon debrief", cfg.debriefTime ?? "16:30", () => runBriefingAndDeliver(client, "debrief"));
  daily("evening nudge", cfg.nudgeTime ?? "20:00", () => runNudgeAndDeliver(client));
  daily("nightly reflection", cfg.reflectionTime ?? "21:30", () => runNightlyReflection(client));
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
  if (args.includes("--setup-inbound")) return setupInboundAgent();

  const serve = args.includes("--serve");
  const cfg = await getConfig(!serve); // non-interactive in serve mode (no stdin on Railway)
  const client = new Anthropic({ apiKey: cfg.apiKey });
  ANTHROPIC = client;
  TOOLS.push(...(await connectMcpServers()));

  if (serve) {
    const port = Number(process.env.PORT) || 8080;
    return serveMode(client, cfg, port);
  }

  const taskIdx = args.indexOf("--task");
  if (taskIdx !== -1 && args[taskIdx + 1]) {
    await taskMode(client, cfg, args[taskIdx + 1], args.includes("--to-telegram"), args.includes("--to-push"));
    process.exit(0); // MCP child processes would otherwise keep the event loop alive
  }
  if (args.includes("--telegram")) return telegramMode(client, cfg);
  return terminalMode(client);
}

main();
