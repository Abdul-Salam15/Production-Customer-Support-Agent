import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../supabaseClient.js";
import { logAudit } from "../auditLog.js";
import { sendEmail } from "../mailer.js";
import { queueCallNote } from "../session/agentSession.js";
import { secondsIntoCall } from "../transcriptTiming.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CustomerUser {
  id: string;
  email: string;
  fullName: string | null;
}

type CustomerRequest = Request & { customerUser?: CustomerUser };

function getCustomerUser(req: Request): CustomerUser {
  const customerUser = (req as CustomerRequest).customerUser;
  if (!customerUser) throw new Error("verifyCustomerSession did not run before this handler");
  return customerUser;
}

function getBearerToken(req: Request): string | null {
  const header = req.headers["authorization"];
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
}

async function verifyCustomerSession(req: Request, res: Response, next: () => void): Promise<void> {
  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const supabase = getSupabaseClient();
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const { data: account } = await supabase
      .from("customer_accounts")
      .select("id, email, full_name")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (!account) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // Call history (and verified-caller status) is matched by email, so an
    // account must prove it owns that email before it can see anything.
    if (!userData.user.email_confirmed_at) {
      res.status(403).json({ error: "email_not_confirmed" });
      return;
    }

    (req as CustomerRequest).customerUser = { id: account.id, email: account.email, fullName: account.full_name };
    next();
  } catch (error) {
    console.error("customer: verifyCustomerSession failed", error);
    res.status(401).json({ error: "unauthorized" });
  }
}

// A customer's "calls" aren't stored against their account directly —
// matched by email at query time against the three places an email can
// show up: a verified account's customer record, a typed contact-form
// submission, or an escalation's own contact fields. Small dataset, so a
// few queries + in-JS merge is simpler than one complex SQL join.
async function findCustomerConversationIds(supabase: SupabaseClient, email: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: customerRows } = await supabase.from("customers").select("customer_id").eq("contact_email", email);
  const customerIds = (customerRows ?? []).map((row: { customer_id: string }) => row.customer_id);
  if (customerIds.length > 0) {
    const { data: convs } = await supabase.from("conversations").select("conversation_id").in("customer_id", customerIds);
    (convs ?? []).forEach((c: { conversation_id: string }) => ids.add(c.conversation_id));
  }

  const { data: submissions } = await supabase.from("contact_submissions").select("conversation_id").eq("email", email);
  (submissions ?? []).forEach((s: { conversation_id: string }) => ids.add(s.conversation_id));

  const { data: escalationRows } = await supabase.from("escalations").select("conversation_id").eq("user_email", email);
  (escalationRows ?? []).forEach((e: { conversation_id: string | null }) => {
    if (e.conversation_id) ids.add(e.conversation_id);
  });

  return Array.from(ids);
}

// A call's own final_status is fixed when it ends, but the case it opened
// keeps moving — so a case a specialist has picked up or resolved wins.
const STALE_CALL_MS = 2 * 60 * 60 * 1000;
function callStatus(
  conv: { started_at: string; ended_at: string | null; final_status: string | null },
  linkedCase: { status: string } | null
): string {
  if (linkedCase?.status === "closed") return "case_resolved";
  if (linkedCase?.status === "in_progress") return "case_in_progress";
  if (conv.final_status) return conv.final_status;
  // Calls from before end-of-call finalization worked never got an
  // ended_at; one this old is over, not still in progress.
  if (conv.ended_at || Date.now() - new Date(conv.started_at).getTime() > STALE_CALL_MS) return "abandoned";
  return "in_progress";
}

async function shapeCall(supabase: SupabaseClient, conversationId: string): Promise<Record<string, unknown> | null> {
  const { data: conv } = await supabase
    .from("conversations")
    .select("conversation_id, started_at, ended_at, ended_reason, final_status, summary")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (!conv) return null;

  const [{ data: escalation }, { data: ticket }, { data: turns }] = await Promise.all([
    supabase.from("escalations").select("escalation_id, status").eq("conversation_id", conversationId).limit(1).maybeSingle(),
    supabase.from("support_tickets").select("ticket_id, status").eq("conversation_id", conversationId).limit(1).maybeSingle(),
    supabase
      .from("conversation_turns")
      .select("role, transcript, turn_index, created_at")
      .eq("conversation_id", conversationId)
      .order("turn_index", { ascending: true }),
  ]);

  const duration = conv.ended_at
    ? Math.max(0, Math.round((new Date(conv.ended_at).getTime() - new Date(conv.started_at).getTime()) / 1000))
    : null;

  const transcript = (
    (turns ?? []) as { role: string; transcript: string; turn_index: number; created_at: string }[]
  ).map((turn) => ({
    speaker: turn.role,
    text: turn.transcript,
    at: secondsIntoCall(conv.started_at, turn.created_at),
  }));

  return {
    ref: escalation?.escalation_id ?? ticket?.ticket_id ?? null,
    at: conv.started_at,
    endedAt: conv.ended_at,
    duration,
    status: callStatus(conv, escalation ?? ticket),
    summary: conv.summary,
    transcript,
  };
}

async function sendConfirmationEmail(email: string, fullName: string | null, link: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Confirm your RelayPay support account",
    text: [
      fullName ? `Hi ${fullName},` : `Hi,`,
      ``,
      `Confirm your email to finish creating your RelayPay support account:`,
      link,
      ``,
      `If you didn't sign up, you can ignore this email.`,
      ``,
      `— RelayPay Support`,
    ].join("\n"),
  });
}

// An account that signed up but never clicked its link can ask again: a
// magic link confirms the email the same way a signup link does. Only ever
// sent to the address itself, so it reveals nothing to whoever asked.
async function resendConfirmation(supabase: SupabaseClient, email: string, redirectTo: string): Promise<boolean> {
  const { data: account } = await supabase
    .from("customer_accounts")
    .select("id, full_name")
    .eq("email", email)
    .maybeSingle();
  if (!account) return false;

  const { data: userData } = await supabase.auth.admin.getUserById(account.id);
  if (!userData.user || userData.user.email_confirmed_at) return false;

  const { data: link, error } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (error || !link.properties?.action_link) return false;

  await sendConfirmationEmail(email, account.full_name, link.properties.action_link);
  return true;
}

function registerCustomerAuthRoutes(router: Router): void {
  router.post("/api/customer/signup", async (req: Request, res: Response) => {
    try {
      const email = req.body?.email;
      const password = req.body?.password;
      const fullName = req.body?.fullName;

      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }
      if (typeof password !== "string" || password.length < 8) {
        res.status(400).json({ error: "invalid_password" });
        return;
      }

      const supabase = getSupabaseClient();
      const cleanEmail = email.trim();
      const cleanName = typeof fullName === "string" && fullName.trim().length > 0 ? fullName.trim() : null;
      // Must be on Supabase's Redirect URLs allow-list (Authentication → URL
      // Configuration), or the link falls back to the project's Site URL.
      const redirectTo = `${req.protocol}://${req.get("host")}/customer`;

      // Previously email_confirm: true — anyone could sign up with someone
      // else's email and read that person's call transcripts. The account
      // now stays unconfirmed until the link sent to that inbox is clicked.
      const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
        type: "signup",
        email: cleanEmail,
        password,
        options: { redirectTo },
      });

      if (linkError || !link.user || !link.properties?.action_link) {
        const alreadyExists = /already registered|already exists/i.test(linkError?.message ?? "");
        if (alreadyExists && (await resendConfirmation(supabase, cleanEmail, redirectTo))) {
          res.status(200).json({ created: true, confirmationSent: true });
          return;
        }
        res.status(400).json({ error: alreadyExists ? "email_in_use" : "signup_failed" });
        return;
      }

      const { error: accountError } = await supabase.from("customer_accounts").insert({
        id: link.user.id,
        email: cleanEmail,
        full_name: cleanName,
      });

      if (accountError) {
        res.status(500).json({ error: "failed_to_create_account" });
        return;
      }

      try {
        await sendConfirmationEmail(cleanEmail, cleanName, link.properties.action_link);
      } catch {
        // The account exists; signing up again with the same email resends.
        res.status(502).json({ error: "confirmation_email_failed" });
        return;
      }

      void logAudit("account", `New customer account created (${cleanEmail}), awaiting email confirmation.`);

      res.status(200).json({ created: true, confirmationSent: true });
    } catch (error) {
      console.error("customer: signup failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.get("/api/customer/me", verifyCustomerSession, (req: Request, res: Response) => {
    res.status(200).json({ account: getCustomerUser(req) });
  });

  // Fired once by /login right after a fresh sign-in resolves to a customer
  // account — same reasoning as /api/dashboard/login-event.
  router.post("/api/customer/login-event", verifyCustomerSession, (req: Request, res: Response) => {
    const who = getCustomerUser(req);
    void logAudit("account", `${who.fullName ?? who.email} logged in.`);
    res.status(200).json({ logged: true });
  });

  router.get("/api/customer/calls", verifyCustomerSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const account = getCustomerUser(req);
      const conversationIds = await findCustomerConversationIds(supabase, account.email);
      const shaped = await Promise.all(conversationIds.map((id) => shapeCall(supabase, id)));
      const calls = shaped.filter((call): call is Record<string, unknown> => call !== null);
      calls.sort((a, b) => new Date(b.at as string).getTime() - new Date(a.at as string).getTime());
      res.status(200).json({ calls });
    } catch (error) {
      console.error("customer: failed to load calls", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  // Links a signed-in customer to the call they just started from the home
  // page, so they're verified without proving who they are by voice. Only a
  // confirmed account counts (verifyCustomerSession), and only when its email
  // is the contact email of a real customer record.
  router.post("/api/calls/:callId/identity", verifyCustomerSession, async (req: Request, res: Response) => {
    try {
      const { callId } = req.params;
      const account = getCustomerUser(req);
      const supabase = getSupabaseClient();

      // Same upsert agentSession uses, so this works whether or not the
      // call's session has started yet.
      const { data: conversation, error } = await supabase
        .from("conversations")
        .upsert({ vapi_call_id: callId }, { onConflict: "vapi_call_id" })
        .select("conversation_id, customer_id, signed_in_account_id, ended_at")
        .single();

      if (error || !conversation || conversation.ended_at) {
        res.status(200).json({ verified: false });
        return;
      }

      // Recorded even when the login matches no business customer, so the
      // dashboard can say "Signed in · no business account" rather than
      // lumping the caller in with anonymous ones. First login wins.
      if (!conversation.signed_in_account_id) {
        await supabase
          .from("conversations")
          .update({ signed_in_account_id: account.id })
          .eq("conversation_id", conversation.conversation_id);
      }

      const escaped = account.email.replace(/[\\%_]/g, (c) => `\\${c}`);
      const { data: customer } = await supabase
        .from("customers")
        .select("customer_id, company_name, contact_email")
        .ilike("contact_email", escaped)
        .limit(1)
        .maybeSingle();

      if (!customer) {
        res.status(200).json({ verified: false });
        return;
      }
      // Never overwrite a different customer already verified on this call.
      if (conversation.customer_id && conversation.customer_id !== customer.customer_id) {
        res.status(200).json({ verified: false });
        return;
      }

      if (!conversation.customer_id) {
        await supabase
          .from("conversations")
          .update({ customer_id: customer.customer_id })
          .eq("conversation_id", conversation.conversation_id);
      }

      queueCallNote(
        callId,
        `[System note — not spoken by the caller: the caller is signed in to the RelayPay website with a confirmed email, ` +
          `so their identity is already confirmed as the account holder for ${customer.company_name} (customer ${customer.customer_id}). ` +
          `Treat them as verified from the start of this call and skip voice verification.]`
      );

      void logAudit("account", `${account.fullName ?? account.email} started a call signed in as ${customer.company_name}.`);

      const [local, domain] = customer.contact_email.split("@");
      res.status(200).json({
        verified: true,
        company_name: customer.company_name,
        masked_email: domain ? `${local.slice(0, 2)}***@${domain}` : customer.contact_email,
      });
    } catch (error) {
      console.error("customer: failed to link account to call", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  // Lets the universal /login page decide whether a freshly authenticated
  // Supabase session belongs to staff (-> /admin or /specialist) or a
  // customer (-> /customer), without the frontend needing to guess.
  router.get("/api/whoami", async (req: Request, res: Response) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const supabase = getSupabaseClient();
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("id, email, full_name, role")
        .eq("id", userData.user.id)
        .maybeSingle();
      if (profile) {
        res.status(200).json({
          kind: "staff",
          profile: { id: profile.id, email: profile.email, fullName: profile.full_name, role: profile.role },
        });
        return;
      }

      const { data: account } = await supabase
        .from("customer_accounts")
        .select("id, email, full_name")
        .eq("id", userData.user.id)
        .maybeSingle();
      if (account && !userData.user.email_confirmed_at) {
        res.status(403).json({ error: "email_not_confirmed" });
        return;
      }
      if (account) {
        res.status(200).json({ kind: "customer", account: { id: account.id, email: account.email, fullName: account.full_name } });
        return;
      }

      res.status(404).json({ error: "no_matching_account" });
    } catch (error) {
      console.error("whoami failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

export function createCustomerRouter(): Router {
  const router = createRouter();
  registerCustomerAuthRoutes(router);
  return router;
}
