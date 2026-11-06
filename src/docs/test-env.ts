// Imported first by openapi.test.ts: config/env refuses to load without
// these. Set before anything imports it, so they also win over a local .env;
// the test never connects to MySQL.
const TEST_ENV = {
  DB_HOST: "127.0.0.1",
  DB_USER: "docs-test",
  DB_PASSWORD: "",
  DB_NAME: "docs_test",
  JWT_SECRET: "docs-test",
  CORS_ORIGIN: "http://localhost",
};
for (const [name, value] of Object.entries(TEST_ENV)) {
  process.env[name] ??= value;
}
