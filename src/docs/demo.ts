import { env } from "../config/env";
import { REQUEST_ACTOR_ROLE } from "../constants/request-status";

// The demo accounts appear only outside production: the production docs are
// public, and the demo password works on the demo server.
export const SHOW_DEMO_DATA = env.nodeEnv !== "production";

// scripts/seed-demo.sql: every demo account's password, and its accounts.
export const DEMO_PASSWORD = "Demo1234!";

export const DEMO_ACCOUNTS = [
  {
    name: "Rana Khoury",
    email: "rana@demo.fixify",
    role: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    name: "Karim Haddad",
    email: "karim@demo.fixify",
    role: REQUEST_ACTOR_ROLE.CUSTOMER,
  },
  {
    name: "Elie Nassar",
    email: "elie@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    name: "Maya Saab",
    email: "maya@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    name: "Tony Aoun",
    email: "tony@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    name: "Hadi Mansour",
    email: "hadi@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    name: "Lara Fakhoury",
    email: "lara@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
  {
    name: "Sami Karam",
    email: "sami@demo.fixify",
    role: REQUEST_ACTOR_ROLE.PROVIDER,
  },
] as const;

export const [RANA, , , , TONY] = DEMO_ACCOUNTS;
