/**
 * Outbound email. Sending ONLY ever happens from an approved approval (see domain/approvals.ts).
 *
 * No provider is bundled: Gmail/Google Workspace requires an OAuth client + refresh token for the
 * sending mailbox, and Microsoft 365 requires a Graph app registration. Until one is configured,
 * `getEmailSender()` returns null and approved messages are marked "manual_required".
 */
export interface EmailSender {
  name: string;
  send(msg: { to: string; subject: string; body: string }): Promise<void>;
}

let override: EmailSender | null | undefined;

/** Test hook / future provider registration. */
export function setEmailSender(sender: EmailSender | null) {
  override = sender;
}

export function getEmailSender(): EmailSender | null {
  if (override !== undefined) return override;
  // Placeholder for Gmail API integration: requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
  // GMAIL_REFRESH_TOKEN and GMAIL_SENDER. Not implemented until credentials are provided.
  return null;
}
