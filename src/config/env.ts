import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: intWithDefault("PORT", 3000),
  db: {
    host: required("DB_HOST"),
    port: intWithDefault("DB_PORT", 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
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
} as const;
