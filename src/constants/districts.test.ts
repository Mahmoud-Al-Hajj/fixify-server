import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DISTRICT_NAMES } from "./districts";

const ROOT = path.resolve(__dirname, "../..");

// The quoted names inside chk_providers_area's IN (...), in order.
function checkList(sql: string): string[] {
  const start = sql.indexOf("chk_providers_area CHECK");
  assert.notEqual(start, -1, "chk_providers_area not found");
  const inList = sql.slice(start).match(/IN \(([^)]*)\)/);
  assert.ok(inList?.[1], "chk_providers_area has no IN (...) list");
  return [...inList[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

test("there are 26 districts, each once", () => {
  assert.equal(DISTRICT_NAMES.length, 26);
  assert.equal(new Set(DISTRICT_NAMES).size, 26);
});

test("schema.sql's chk_providers_area lists exactly DISTRICT_NAMES", () => {
  const sql = readFileSync(path.join(ROOT, "schema.sql"), "utf8");
  assert.deepEqual(checkList(sql), [...DISTRICT_NAMES]);
});

test("migration 007 adds the same list", () => {
  const sql = readFileSync(
    path.join(ROOT, "migrations/007_provider_area_districts.sql"),
    "utf8"
  );
  assert.deepEqual(checkList(sql), [...DISTRICT_NAMES]);
});
