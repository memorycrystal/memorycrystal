export async function resolveEffectiveUserId(
  _ctx: unknown,
  actorUserId: string,
  requestedAsUserId?: string | null,
): Promise<string> {
  if (requestedAsUserId && requestedAsUserId !== actorUserId) {
    throw new Error("No impersonation session active");
  }
  return actorUserId;
}
