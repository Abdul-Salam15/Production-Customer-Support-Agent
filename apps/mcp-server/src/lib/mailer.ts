import nodemailer, { type Transporter } from "nodemailer";
import { logAudit } from "./auditLog.js";

let transporter: Transporter | null = null;

// Lazy, same pattern as getSupabaseClient() in this app: reads process.env
// directly since mcp-server has no centralized env-validation module, and
// fails at first use rather than at import time.
function getTransporter(): Transporter {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return transporter;
}

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

// Email is a best-effort side effect, never the source of truth — callers
// must not let a send failure block the operation that triggered it (the
// escalation/ticket row is already committed by the time this runs).
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const user = process.env.GMAIL_USER;
  await getTransporter().sendMail({
    from: user,
    to: args.to,
    subject: args.subject,
    text: args.text,
  });
  void logAudit("email", `Email sent to ${maskEmail(args.to)} — "${args.subject}"`);
}
