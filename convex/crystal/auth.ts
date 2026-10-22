/**
 * Extract the stable user ID from identity.subject.
 * Convex Auth sets subject = "userId|sessionId" — we only want the userId part.
 */
export function stableUserId(subject: string): string {
  return subject.split("|")[0];
}
