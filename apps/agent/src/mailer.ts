import { getEnv } from "./env.js";
import { logAudit } from "./auditLog.js";

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : email;
}

// Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email),
// not SMTP — confirmed Render blocks outbound SMTP entirely (both port 465
// direct-TLS and 587 STARTTLS hang until timeout from there), but plain
// HTTPS on 443 is never blocked. EMAIL_FROM must be on a domain verified in
// Resend; it may include a display name ("RelayPay Support <support@...>").
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const env = getEnv();
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [args.to],
        subject: args.subject,
        text: args.text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API returned ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (error) {
    // Logged to audit_log, not just the server console — a failed send is
    // otherwise invisible to anyone without direct hosting-platform log
    // access, which an admin diagnosing "I never got the email" doesn't have.
    const reason = error instanceof Error ? error.message : String(error);
    void logAudit("email", `Failed to send email to ${maskEmail(args.to)} — "${args.subject}" (${reason})`);
    throw error;
  }
  void logAudit("email", `Email sent to ${maskEmail(args.to)} — "${args.subject}"`);
}
