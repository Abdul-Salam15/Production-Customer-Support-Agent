import nodemailer, { type Transporter } from "nodemailer";
import { getEnv } from "./env.js";
import { logAudit } from "./auditLog.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const env = getEnv();
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });
  return transporter;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : email;
}

// Email is a best-effort side effect, never the source of truth — callers
// must not let a send failure block whatever operation triggered it.
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const env = getEnv();
  try {
    await getTransporter().sendMail({
      from: env.GMAIL_USER,
      to: args.to,
      subject: args.subject,
      text: args.text,
    });
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
