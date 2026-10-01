import { logAudit } from "./auditLog.js";

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
}

// "amara@lagosledger.example" -> "am***@lagosledger.example" — matches the
// masking convention withLogging.ts already applies to tool_calls rows.
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : email;
}

// Brevo's HTTP API (https://api.brevo.com), not SMTP — confirmed Render
// blocks outbound SMTP entirely (both port 465 direct-TLS and 587 STARTTLS
// hang until timeout from there, while both worked fine from an
// unrestricted network), but plain HTTPS on 443 is never blocked.
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;

  if (!apiKey || !fromEmail) {
    throw new Error("BREVO_API_KEY and EMAIL_FROM must be set");
  }

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: { email: fromEmail },
        to: [{ email: args.to }],
        subject: args.subject,
        textContent: args.text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brevo API returned ${res.status}: ${body.slice(0, 300)}`);
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
