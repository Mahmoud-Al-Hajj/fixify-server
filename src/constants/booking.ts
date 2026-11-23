// A job's length when nobody estimated it: the slot search's default and the
// first visit's length at quote acceptance (COALESCE(estimated_duration, 60)).
export const DEFAULT_VISIT_MINUTES = 60;

// A pending request whose requested start passed this long ago is cancelled
// by the server (request_expired). Counted from requested_start, not from
// either party's last action. The sweep runs on start and then every
// EXPIRY_SWEEP_MINUTES, at most EXPIRY_BATCH_SIZE requests per run.
export const PENDING_EXPIRY_HOURS = 24;
export const EXPIRY_SWEEP_MINUTES = 15;
export const EXPIRY_BATCH_SIZE = 100;

// The box a request's map pin must fall in (inclusive), the same box the
// mobile map picker keeps the pin inside. Checked at the edge only.
export const PIN_BOUNDS = {
  west: 35.05,
  south: 33.0,
  east: 36.7,
  north: 34.75,
} as const;

// REQUEST_CREATED payload.source for a booking from an intake session; a
// search booking's event carries no payload.
export const BOOKING_SOURCE = { INTAKE: "intake" } as const;
