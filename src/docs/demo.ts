import { env } from "../config/env";
import { beirutNow } from "../models-db/format-datetime";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";

// The demo accounts appear only outside production: the production docs are
// public, and the demo password works on the demo server.
export const SHOW_DEMO_DATA = env.nodeEnv !== "production";

// scripts/seed-demo.sql: every demo account's password, and its accounts.
export const DEMO_PASSWORD = "Demo1234!";

export const DEMO_ACCOUNTS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Rana Khoury",
    email: "rana@demo.fixify",
    role: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Karim Haddad",
    email: "karim@demo.fixify",
    role: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    id: "00000000-0000-4000-8000-000000000101",
    name: "Elie Nassar",
    email: "elie@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    name: "Maya Saab",
    email: "maya@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    id: "00000000-0000-4000-8000-000000000103",
    name: "Tony Aoun",
    email: "tony@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    id: "00000000-0000-4000-8000-000000000104",
    name: "Hadi Mansour",
    email: "hadi@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    id: "00000000-0000-4000-8000-000000000105",
    name: "Lara Fakhoury",
    email: "lara@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    id: "00000000-0000-4000-8000-000000000106",
    name: "Sami Karam",
    email: "sami@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
] as const;

export const [RANA, , , , TONY] = DEMO_ACCOUNTS;

// Tony's working days in scripts/seed-demo.sql (provider_availability):
// Monday, Tuesday and Thursday mornings.
const TONY_WORKDAYS = [1, 2, 4];

// A start for the booking examples that fits Tony's hours: 09:00 on the nth
// of his working days at least two days after the spec is built, so the
// examples stay in the future while the server runs.
export function demoStart(nth: number): string {
  const today = beirutNow();
  let found = -1;
  for (let ahead = 2; ; ahead++) {
    const day = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + ahead,
        9
      )
    );
    if (TONY_WORKDAYS.includes(day.getUTCDay()) && ++found === nth) {
      return day.toISOString().slice(0, 23);
    }
  }
}
