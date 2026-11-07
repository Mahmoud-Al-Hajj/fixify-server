// A job's length when nobody estimated it: the slot search's default and the
// first visit's length at quote acceptance (COALESCE(estimated_duration, 60)).
export const DEFAULT_VISIT_MINUTES = 60;

// REQUEST_CREATED payload.source for a booking from an intake session; a
// search booking's event carries no payload.
export const BOOKING_SOURCE = { INTAKE: "intake" } as const;
