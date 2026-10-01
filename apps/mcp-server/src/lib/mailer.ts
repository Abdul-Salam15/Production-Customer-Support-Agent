import nodemailer from "nodemailer";
import { resolve4 } from "node:dns/promises";
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

// nodemailer does its own DNS resolution (resolve4 + resolve6, independent
// of Node's dns.setDefaultResultOrder) and deliberately picks a RANDOM
// address from the combined results — on a host with no outbound IPv6
// route (Render's containers), that randomly produces ENETUNREACH. Passing
// an already-resolved IPv4 literal as `host` makes nodemailer skip its own
// resolution entirely (it only resolves hostnames, never IPs); `servername`
// keeps TLS validating against the real hostname instead of the IP.
async function buildTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }

  const addresses = await resolve4("smtp.gmail.com");
  if (addresses.length === 0) {
    throw new Error("no IPv4 address found for smtp.gmail.com");
  }
  const host = addresses[Math.floor(Math.random() * addresses.length)];

  return nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    servername: "smtp.gmail.com",
    auth: { user, pass },
  });
}

// Email is a best-effort side effect, never the source of truth — callers
// must not let a send failure block the operation that triggered it (the
// escalation/ticket row is already committed by the time this runs).
export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const user = process.env.GMAIL_USER;
  try {
    const transporter = await buildTransporter();
    await transporter.sendMail({
      from: user,
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
