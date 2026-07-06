/**
 * SERENITY MED SPA — demo MCP server (fictional business)
 * ========================================================
 * Stands in for the booking system a real business would expose to AI agents.
 * Homebase (or any MCP client) connects over stdio and gets four tools:
 * list_services, list_availability, book_appointment, cancel_appointment.
 *
 *   bun run demo-medspa-mcp/server.ts     (normally launched by the MCP client)
 *
 * Bookings persist to demo-medspa-mcp/bookings.json so a demo survives restarts.
 * Everything here is fictional — no real business, no real PII.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const DATA = path.join(import.meta.dirname, "bookings.json");

interface Booking {
  code: string;
  name: string;
  service: string;
  slot: string; // ISO datetime
  phone?: string;
}

const loadBookings = (): Booking[] => {
  try {
    return JSON.parse(fs.readFileSync(DATA, "utf-8"));
  } catch {
    return [];
  }
};
const saveBookings = (b: Booking[]) => fs.writeFileSync(DATA, JSON.stringify(b, null, 2));

const SERVICES = [
  { name: "Signature Facial", minutes: 60, price: 120 },
  { name: "Express Facial", minutes: 30, price: 65 },
  { name: "Massage (60 min)", minutes: 60, price: 110 },
  { name: "Botox Consultation", minutes: 30, price: 0 },
  { name: "Laser Hair Removal Consult", minutes: 30, price: 0 },
];

// Open Tue–Sat, 10:00–17:00, hourly slots. A slot is free if no booking holds it.
function slotsForDate(dateISO: string): string[] {
  const d = new Date(`${dateISO}T12:00:00`);
  const dow = d.getDay();
  if (dow === 0 || dow === 1) return []; // closed Sun/Mon
  const out: string[] = [];
  for (let h = 10; h < 17; h++) out.push(`${dateISO}T${String(h).padStart(2, "0")}:00`);
  return out;
}

const server = new McpServer({ name: "serenity-med-spa", version: "1.0.0" });

server.registerTool(
  "list_services",
  {
    description: "List the med spa's services with duration and price.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text",
        text: SERVICES.map((s) => `${s.name} — ${s.minutes} min — ${s.price ? `$${s.price}` : "free consult"}`).join("\n"),
      },
    ],
  })
);

server.registerTool(
  "list_availability",
  {
    description:
      "List open appointment slots for a given date (YYYY-MM-DD). Open Tue–Sat 10am–5pm. " +
      "Returns ISO datetimes that can be passed to book_appointment.",
    inputSchema: { date: z.string().describe("YYYY-MM-DD") },
  },
  async ({ date }) => {
    const taken = new Set(loadBookings().map((b) => b.slot));
    const open = slotsForDate(date).filter((s) => !taken.has(s));
    return {
      content: [
        {
          type: "text",
          text: open.length
            ? `Open slots on ${date}:\n` + open.map((s) => `  ${s}`).join("\n")
            : `No availability on ${date} (closed Sun/Mon, or fully booked).`,
        },
      ],
    };
  }
);

server.registerTool(
  "book_appointment",
  {
    description:
      "Book an appointment. Requires client name, service (see list_services), and an open slot " +
      "(ISO datetime from list_availability). Returns a confirmation code.",
    inputSchema: {
      name: z.string().describe("Client name"),
      service: z.string().describe("Service name"),
      slot: z.string().describe("ISO datetime from list_availability"),
      phone: z.string().optional().describe("Contact number (optional)"),
    },
  },
  async ({ name, service, slot, phone }) => {
    const bookings = loadBookings();
    if (!slotsForDate(slot.slice(0, 10)).includes(slot))
      return { content: [{ type: "text", text: `${slot} isn't a valid slot (Tue–Sat, 10:00–16:00 hourly).` }] };
    if (bookings.some((b) => b.slot === slot))
      return { content: [{ type: "text", text: `${slot} was just taken — pick another slot from list_availability.` }] };
    const code = `SMS-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    bookings.push({ code, name, service, slot, phone });
    saveBookings(bookings);
    return {
      content: [
        {
          type: "text",
          text: `Booked! ${service} for ${name} at ${slot}. Confirmation code: ${code}. Please arrive 10 minutes early.`,
        },
      ],
    };
  }
);

server.registerTool(
  "cancel_appointment",
  {
    description: "Cancel a booking by its confirmation code.",
    inputSchema: { code: z.string().describe("Confirmation code, e.g. SMS-A1B2C") },
  },
  async ({ code }) => {
    const bookings = loadBookings();
    const idx = bookings.findIndex((b) => b.code === code);
    if (idx === -1) return { content: [{ type: "text", text: `No booking found for code ${code}.` }] };
    const [b] = bookings.splice(idx, 1);
    saveBookings(bookings);
    return { content: [{ type: "text", text: `Cancelled ${b.service} for ${b.name} at ${b.slot}.` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Serenity Med Spa MCP server running on stdio"); // stderr — stdout is the protocol channel
