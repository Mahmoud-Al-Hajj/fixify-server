import { listFeedForUser, countUnreadForUser } from "../models-db/job-events";
import { markNotificationsReadUpTo } from "../models-db/users";
import { toEventEntry, type EventEntry } from "./event-entries";

// The newest page only; a cursor can be added later without changing the
// shape.
const FEED_LIMIT = 50;

export interface Notification extends EventEntry {
  requestId: string;
  categoryName: string;
  otherPartyName: string;
  unread: boolean;
}

// The feed is derived from job_events and users.notifications_read_at; there
// is no notifications table (CLAUDE.md). Each item is the other party's
// action on one of the user's requests, in the public event shape.
export async function getFeed(
  userId: string
): Promise<{ unreadCount: number; notifications: Notification[] }> {
  const [events, unreadCount] = await Promise.all([
    listFeedForUser(userId, FEED_LIMIT),
    countUnreadForUser(userId),
  ]);
  const notifications = events.map((event) => {
    const entry = toEventEntry(event, event);
    return {
      id: entry.id,
      requestId: event.requestId,
      categoryName: event.categoryName,
      otherPartyName: event.otherPartyName,
      type: entry.type,
      at: entry.at,
      actor: entry.actor,
      details: entry.details,
      unread: event.unread,
    };
  });
  return { unreadCount, notifications };
}

export async function markRead(
  userId: string,
  readUpTo: Date
): Promise<number> {
  await markNotificationsReadUpTo(userId, readUpTo);
  return countUnreadForUser(userId);
}
