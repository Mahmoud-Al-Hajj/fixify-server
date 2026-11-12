import { createHash } from "node:crypto";
import type { DiagnosisInput, DiagnosisResult } from "./gemini";
import { buildContent, PROMPT_VERSION } from "./diagnosis-prompt";

// Reuses a valid diagnosis when the model would get exactly the same input
// again: the same prompt version, configured model, text and photo bytes, from
// any session. In memory only: a restart empties it. Failures are never cached.

export const DIAGNOSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSIS_CACHE_MAX_ENTRIES = 500;

export type CachedDiagnosis = Pick<DiagnosisResult, "model" | "diagnosis">;

// The hash of what the model is actually sent (buildContent leaves out
// session and message ids), so two sessions with the same input share a key.
export function diagnosisCacheKey(
  model: string,
  input: DiagnosisInput
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        PROMPT_VERSION,
        model,
        buildContent(input.messages, input.photos),
      ])
    )
    .digest("hex");
}

interface Entry {
  value: CachedDiagnosis;
  expiresAt: number;
}

export function createDiagnosisCache({
  ttlMs = DIAGNOSIS_CACHE_TTL_MS,
  maxEntries = DIAGNOSIS_CACHE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  // A Map keeps insertion order, so the first key is the oldest entry.
  const entries = new Map<string, Entry>();
  return {
    get(key: string): CachedDiagnosis | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: CachedDiagnosis): void {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
  };
}

export const diagnosisCache = createDiagnosisCache();
