/** Environment-only implementation used in packaged self-hosted artifacts. */
export function getUnlimitedEmails(): string[] {
  return String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}
