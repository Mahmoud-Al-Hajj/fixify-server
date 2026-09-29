import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// DB_PASSWORD may legitimately be an empty string (e.g. a local root user with
// no password) — only an unset variable counts as missing.
function requiredAllowEmpty(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intWithDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
}

// AI is optional: enabled only when both GEMINI_API_KEY and GEMINI_MODEL are
// set, with no default model. null means the intake diagnosis is unavailable.
// GEMINI_FALLBACK_MODEL is optional; without it the analysis does not hedge.
function gemini(): {
  apiKey: string;
  model: string;
  fallbackModel: string | null;
} | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL?.trim() || null;
  return apiKey && model ? { apiKey, model, fallbackModel } : null;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: intWithDefault("PORT", 3000),
  db: {
    host: required("DB_HOST"),
    port: intWithDefault("DB_PORT", 3306),
    user: required("DB_USER"),
    password: requiredAllowEmpty("DB_PASSWORD"),
    database: required("DB_NAME"),
  },
  jwt: {
    secret: required("JWT_SECRET"),
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  },
  bcryptRounds: intWithDefault("BCRYPT_ROUNDS", 12),
  corsOrigins: required("CORS_ORIGIN")
    .split(",")
    .map((o) => o.trim()),
  gemini: gemini(),
} as const;
