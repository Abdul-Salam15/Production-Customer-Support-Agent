import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../supabaseClient.js";

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

async function shapeCall(supabase: SupabaseClient, conversationId: string): Promise<Record<string, unknown> | null> {
  const { data: conv } = await supabase
    .from("conversations")
    .select("conversation_id, started_at, ended_at, ended_reason, final_status, summary")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (!conv) return null;

  const [{ data: escalation }, { data: ticket }, { data: turns }] = await Promise.all([
    supabase.from("escalations").select("escalation_id").eq("conversation_id", conversationId).maybeSingle(),
    supabase.from("support_tickets").select("ticket_id").eq("conversation_id", conversationId).maybeSingle(),
    supabase
      .from("conversation_turns")
      .select("role, transcript, turn_index")
      .eq("conversation_id", conversationId)
      .order("turn_index", { ascending: true }),
  ]);

  const duration = conv.ended_at
    ? Math.max(0, Math.round((new Date(conv.ended_at).getTime() - new Date(conv.started_at).getTime()) / 1000))
    : null;

  const SECONDS_PER_TURN = 8;
  const transcript = ((turns ?? []) as { role: string; transcript: string; turn_index: number }[]).map((turn) => ({
    speaker: turn.role,
    text: turn.transcript,
    at: turn.turn_index * SECONDS_PER_TURN,
  }));

  return {
    ref: escalation?.escalation_id ?? ticket?.ticket_id ?? null,
    at: conv.started_at,
    endedAt: conv.ended_at,
    duration,
    status: conv.final_status ?? "in_progress",
    summary: conv.summary,
    transcript,
  };
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
      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email: email.trim(),
        password,
        email_confirm: true,
      });

      if (createError || !created.user) {
        const alreadyExists = /already registered|already exists/i.test(createError?.message ?? "");
        res.status(400).json({ error: alreadyExists ? "email_in_use" : "signup_failed" });
        return;
      }

      const { error: accountError } = await supabase.from("customer_accounts").insert({
        id: created.user.id,
        email: email.trim(),
        full_name: typeof fullName === "string" && fullName.trim().length > 0 ? fullName.trim() : null,
      });

      if (accountError) {
        res.status(500).json({ error: "failed_to_create_account" });
        return;
      }

      res.status(200).json({ created: true });
    } catch (error) {
      console.error("customer: signup failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.get("/api/customer/me", verifyCustomerSession, (req: Request, res: Response) => {
    res.status(200).json({ account: getCustomerUser(req) });
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
