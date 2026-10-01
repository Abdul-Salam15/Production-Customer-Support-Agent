import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../supabaseClient.js";
import { secondsIntoCall } from "../transcriptTiming.js";
import { sendEmail } from "../mailer.js";
import { logAudit } from "../auditLog.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StaffUser {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "specialist";
}

type StaffRequest = Request & { staffUser?: StaffUser };

function getStaffUser(req: Request): StaffUser {
  const staffUser = (req as StaffRequest).staffUser;
  if (!staffUser) throw new Error("verifyStaffSession did not run before this handler");
  return staffUser;
}

async function verifyStaffSession(req: Request, res: Response, next: () => void): Promise<void> {
  try {
    const header = req.headers["authorization"];
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
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

    if (!profile) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    (req as StaffRequest).staffUser = {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role as "admin" | "specialist",
    };
    next();
  } catch (error) {
    console.error("dashboard: verifyStaffSession failed", error);
    res.status(401).json({ error: "unauthorized" });
  }
}

function requireAdmin(req: Request, res: Response, next: () => void): void {
  if (getStaffUser(req).role !== "admin") {
    res.status(403).json({ error: "admin_only" });
    return;
  }
  next();
}

function toneFor(status: string): "ok" | "warn" | "bad" {
  if (status === "failed") return "bad";
  if (status === "review required" || status === "pending") return "warn";
  return "ok";
}

type CaseType = "ticket" | "escalation";

interface FoundCase {
  table: "support_tickets" | "escalations";
  idColumn: "ticket_id" | "escalation_id";
  caseType: CaseType;
  row: Record<string, any>;
}

async function findCase(supabase: SupabaseClient, reference: string): Promise<FoundCase | null> {
  const { data: ticket } = await supabase
    .from("support_tickets")
    .select("*")
    .eq("ticket_id", reference)
    .maybeSingle();
  if (ticket) return { table: "support_tickets", idColumn: "ticket_id", caseType: "ticket", row: ticket };

  const { data: escalation } = await supabase
    .from("escalations")
    .select("*")
    .eq("escalation_id", reference)
    .maybeSingle();
  if (escalation) return { table: "escalations", idColumn: "escalation_id", caseType: "escalation", row: escalation };

  return null;
}

// Shapes one DB row to match queue.js's existing CASE object fields, so the
// frontend rendering code (renderQueue/renderDetail) needs no changes beyond
// its data source. Small dataset (a demo seed, not production volume), so a
// few lookups per case here is simpler than batching across the whole list.
async function shapeCase(
  supabase: SupabaseClient,
  caseType: CaseType,
  row: Record<string, any>
): Promise<Record<string, unknown>> {
  const reference = caseType === "ticket" ? row.ticket_id : row.escalation_id;

  const [{ data: customer }, { data: assignedProfile }, { data: notes }, { data: turns }, { data: submission }, { data: conversation }] =
    await Promise.all([
      row.customer_id
        ? supabase
            .from("customers")
            .select("company_name, contact_name, contact_email, plan, account_status")
            .eq("customer_id", row.customer_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      row.assigned_to
        ? supabase.from("profiles").select("full_name, email").eq("id", row.assigned_to).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("case_notes")
        .select("body, created_at, author_id")
        .eq("reference", reference)
        .eq("case_type", caseType)
        .order("created_at", { ascending: true }),
      row.conversation_id
        ? supabase
            .from("conversation_turns")
            .select("role, transcript, turn_index, created_at")
            .eq("conversation_id", row.conversation_id)
            .order("turn_index", { ascending: true })
        : Promise.resolve({ data: [] }),
      row.conversation_id
        ? supabase
            .from("contact_submissions")
            .select("name, email, callback_time, created_at")
            .eq("conversation_id", row.conversation_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      row.conversation_id
        ? supabase
            .from("conversations")
            .select("started_at, signed_in_account_id")
            .eq("conversation_id", row.conversation_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const noteRows = (notes ?? []) as { body: string; created_at: string; author_id: string | null }[];
  const authorIds = Array.from(new Set(noteRows.map((n) => n.author_id).filter((id): id is string => id !== null)));
  let authorsById: Record<string, string> = {};
  if (authorIds.length > 0) {
    const { data: authors } = await supabase.from("profiles").select("id, full_name, email").in("id", authorIds);
    authorsById = Object.fromEntries(
      (authors ?? []).map((a: any) => [a.id, a.full_name || a.email])
    );
  }

  let linkedTransactionOrPayout: Record<string, unknown> | null = null;
  if (row.related_transaction_id) {
    const { data: txn } = await supabase
      .from("transactions")
      .select("transaction_id, status")
      .eq("transaction_id", row.related_transaction_id)
      .maybeSingle();
    if (txn) {
      linkedTransactionOrPayout = { type: "Transaction", reference: txn.transaction_id, status: txn.status, tone: toneFor(txn.status) };
    }
  } else if (row.related_payout_id) {
    const { data: payout } = await supabase
      .from("payouts")
      .select("payout_id, status")
      .eq("payout_id", row.related_payout_id)
      .maybeSingle();
    if (payout) {
      linkedTransactionOrPayout = { type: "Payout", reference: payout.payout_id, status: payout.status, tone: toneFor(payout.status) };
    }
  }

  const conv = conversation as { started_at?: string; signed_in_account_id?: string | null } | null;
  const callStartedAt = conv?.started_at;

  // The website login the caller was signed in with, if any — shown when
  // the case isn't linked to a business customer record.
  let signedInAccount: { name: string | null; email: string } | null = null;
  if (!customer && conv?.signed_in_account_id) {
    const { data: account } = await supabase
      .from("customer_accounts")
      .select("full_name, email")
      .eq("id", conv.signed_in_account_id)
      .maybeSingle();
    if (account) signedInAccount = { name: account.full_name, email: account.email };
  }
  const turnRows = (turns ?? []) as { role: string; transcript: string; turn_index: number; created_at: string }[];
  const transcript: Record<string, unknown>[] = turnRows.map((turn) => ({
    speaker: turn.role,
    text: turn.transcript,
    at: secondsIntoCall(callStartedAt, turn.created_at),
  }));
  if (submission) {
    const formAt = secondsIntoCall(callStartedAt, submission.created_at);
    // Placed where it happened in the call, not tacked on at the end.
    const insertAt = transcript.findIndex((line) => (line.at as number) > formAt);
    transcript.splice(insertAt < 0 ? transcript.length : insertAt, 0, {
      type: "form",
      at: formAt,
      name: submission.name,
      email: submission.email,
      callbackTime: submission.callback_time,
    });
  }

  const contactEmail = caseType === "escalation" ? row.user_email : submission?.email ?? customer?.contact_email ?? null;
  const contactName = caseType === "escalation" ? row.user_name : submission?.name ?? customer?.contact_name ?? null;

  return {
    reference,
    caseType,
    priority: row.priority,
    category: row.category,
    companyName: customer?.company_name ?? null,
    signedInAccount,
    contactName,
    contactEmail,
    summary: row.summary ?? row.reason,
    createdAt: row.created_at,
    status: row.status,
    resolvedAt: row.resolved_at ?? undefined,
    callbackTime: caseType === "escalation" ? row.preferred_time ?? undefined : undefined,
    linkedAccount: customer ? { plan: customer.plan, accountStatus: customer.account_status } : undefined,
    linkedTransactionOrPayout,
    transcript,
    claimedBy: assignedProfile ? assignedProfile.full_name || assignedProfile.email : null,
    notes: noteRows.map((n) => ({
      author: n.author_id ? authorsById[n.author_id] ?? "Unknown" : "Unknown",
      at: n.created_at,
      text: n.body,
    })),
  };
}

// Best-effort: the status change is already committed by the time this
// runs, so a Gmail failure here must not surface as a failed resolve action.
async function notifyCaseResolved(supabase: SupabaseClient, found: FoundCase): Promise<void> {
  const row = found.row;
  let email: string | null = null;
  let name: string | null = null;

  if (found.caseType === "escalation") {
    email = row.user_email ?? null;
    name = row.user_name ?? null;
  } else if (row.customer_id) {
    const { data: customer } = await supabase
      .from("customers")
      .select("contact_email, contact_name")
      .eq("customer_id", row.customer_id)
      .maybeSingle();
    email = customer?.contact_email ?? null;
    name = customer?.contact_name ?? null;
  }

  if (!email && row.conversation_id) {
    const { data: submission } = await supabase
      .from("contact_submissions")
      .select("name, email")
      .eq("conversation_id", row.conversation_id)
      .maybeSingle();
    email = email ?? submission?.email ?? null;
    name = name ?? submission?.name ?? null;
  }

  const reference = found.caseType === "ticket" ? row.ticket_id : row.escalation_id;

  if (!email) {
    console.error(`dashboard: no email on file to notify resolution for ${reference}`);
    return;
  }

  try {
    await sendEmail({
      to: email,
      subject: `Your request ${reference} has been resolved`,
      text: [
        `Hi ${name ?? "there"},`,
        ``,
        `Your ${found.caseType === "escalation" ? "escalation" : "support ticket"} (${reference}) has been resolved.`,
        row.resolution_notes ? `Resolution notes: ${row.resolution_notes}` : null,
        ``,
        `— RelayPay Support`,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    });
  } catch (error) {
    console.error("dashboard: resolved-notification email failed", error);
  }
}

function registerCaseRoutes(router: Router): void {
  router.get("/api/dashboard/cases", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const [{ data: tickets, error: ticketsError }, { data: escalations, error: escalationsError }] = await Promise.all([
        supabase.from("support_tickets").select("*"),
        supabase.from("escalations").select("*"),
      ]);

      if (ticketsError || escalationsError) {
        res.status(500).json({ error: "failed_to_load_cases" });
        return;
      }

      const shaped = await Promise.all([
        ...(tickets ?? []).map((row) => shapeCase(supabase, "ticket", row)),
        ...(escalations ?? []).map((row) => shapeCase(supabase, "escalation", row)),
      ]);

      res.status(200).json({ cases: shaped });
    } catch (error) {
      console.error("dashboard: failed to load cases", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/cases/:reference/claim", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      const { data, error } = await supabase
        .from(found.table)
        .update({ assigned_to: getStaffUser(req).id, status: "in_progress" })
        .eq(found.idColumn, req.params.reference)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "failed_to_claim" });
        return;
      }

      const claimer = getStaffUser(req);
      void logAudit("case", `${claimer.fullName ?? claimer.email} claimed case ${req.params.reference}.`);

      res.status(200).json(await shapeCase(supabase, found.caseType, data));
    } catch (error) {
      console.error("dashboard: claim failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/cases/:reference/unclaim", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      const nextStatus = found.row.status === "in_progress" ? "open" : found.row.status;
      const { data, error } = await supabase
        .from(found.table)
        .update({ assigned_to: null, status: nextStatus })
        .eq(found.idColumn, req.params.reference)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "failed_to_unclaim" });
        return;
      }

      const unclaimer = getStaffUser(req);
      void logAudit("case", `${unclaimer.fullName ?? unclaimer.email} unclaimed case ${req.params.reference}.`);

      res.status(200).json(await shapeCase(supabase, found.caseType, data));
    } catch (error) {
      console.error("dashboard: unclaim failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/cases/:reference/resolve", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      const notes = typeof req.body?.notes === "string" ? req.body.notes : found.row.resolution_notes ?? null;

      const { data, error } = await supabase
        .from(found.table)
        .update({
          status: "closed",
          resolved_at: new Date().toISOString(),
          assigned_to: found.row.assigned_to ?? getStaffUser(req).id,
          resolution_notes: notes,
        })
        .eq(found.idColumn, req.params.reference)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "failed_to_resolve" });
        return;
      }

      // Not awaited — notifyCaseResolved already try/catches its own send
      // internally, but a slow/hanging Gmail connection must not delay the
      // resolve response itself.
      void notifyCaseResolved(supabase, { ...found, row: data });

      const resolver = getStaffUser(req);
      void logAudit("case", `${resolver.fullName ?? resolver.email} marked case ${req.params.reference} resolved.`);

      res.status(200).json(await shapeCase(supabase, found.caseType, data));
    } catch (error) {
      console.error("dashboard: resolve failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/cases/:reference/reopen", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      const { data, error } = await supabase
        .from(found.table)
        .update({
          status: found.row.assigned_to ? "in_progress" : "open",
          resolved_at: null,
        })
        .eq(found.idColumn, req.params.reference)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "failed_to_reopen" });
        return;
      }

      const reopener = getStaffUser(req);
      void logAudit("case", `${reopener.fullName ?? reopener.email} reopened case ${req.params.reference}.`);

      res.status(200).json(await shapeCase(supabase, found.caseType, data));
    } catch (error) {
      console.error("dashboard: reopen failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.post("/api/dashboard/cases/:reference/notes", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const text = req.body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        res.status(400).json({ error: "text_required" });
        return;
      }

      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      const { error } = await supabase.from("case_notes").insert({
        reference: req.params.reference,
        case_type: found.caseType,
        author_id: getStaffUser(req).id,
        body: text.trim(),
      });

      if (error) {
        res.status(500).json({ error: "failed_to_add_note" });
        return;
      }

      const noteAuthor = getStaffUser(req);
      void logAudit("case", `${noteAuthor.fullName ?? noteAuthor.email} added a note to case ${req.params.reference}.`);

      res.status(200).json(await shapeCase(supabase, found.caseType, found.row));
    } catch (error) {
      console.error("dashboard: add note failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

function registerTeamRoutes(router: Router): void {
  router.get("/api/dashboard/me", verifyStaffSession, (req: Request, res: Response) => {
    res.status(200).json({ profile: getStaffUser(req) });
  });

  router.get("/api/dashboard/team", verifyStaffSession, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, invited_by, role_changed_at, role_changed_by, created_at")
        .order("created_at", { ascending: true });

      if (error) {
        res.status(500).json({ error: "failed_to_load_team" });
        return;
      }

      const rows = data ?? [];
      const namesById = Object.fromEntries(rows.map((r) => [r.id, r.full_name || r.email]));

      // "Invited, pending" vs "Active" isn't stored in profiles — it's whether
      // that Supabase Auth user has ever actually signed in. Small dataset,
      // so one lookup per row (matching shapeCase's own N+1-is-fine approach)
      // is simpler than a bulk admin.listUsers() pagination loop.
      const team = await Promise.all(
        rows.map(async (row) => {
          const { data: authUser } = await supabase.auth.admin.getUserById(row.id);
          return {
            id: row.id,
            email: row.email,
            fullName: row.full_name,
            role: row.role,
            status: authUser?.user?.last_sign_in_at ? "active" : "invited",
            invitedByName: row.invited_by ? namesById[row.invited_by] ?? null : null,
            roleChanged: row.role_changed_at
              ? { at: row.role_changed_at, by: row.role_changed_by ? namesById[row.role_changed_by] ?? null : null }
              : null,
          };
        })
      );

      res.status(200).json({ team });
    } catch (error) {
      console.error("dashboard: failed to load team", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/team/:userId/name", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const staffUser = getStaffUser(req);
      const name = req.body?.name;
      if (typeof name !== "string" || name.trim().length < 2) {
        res.status(400).json({ error: "invalid_name" });
        return;
      }
      // Anyone can rename themself; only an admin can rename someone else.
      if (req.params.userId !== staffUser.id && staffUser.role !== "admin") {
        res.status(403).json({ error: "admin_only" });
        return;
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("profiles")
        .update({ full_name: name.trim() })
        .eq("id", req.params.userId)
        .select("id, full_name")
        .maybeSingle();

      if (error || !data) {
        res.status(500).json({ error: "failed_to_update_name" });
        return;
      }

      res.status(200).json({ id: data.id, fullName: data.full_name });
    } catch (error) {
      console.error("dashboard: update name failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.post("/api/dashboard/team/invite", verifyStaffSession, requireAdmin, async (req: Request, res: Response) => {
    try {
      const email = req.body?.email;
      const fullName = req.body?.fullName;
      const role = req.body?.role;

      if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }
      if (role !== "admin" && role !== "specialist") {
        res.status(400).json({ error: "invalid_role" });
        return;
      }

      const supabase = getSupabaseClient();
      // Without an explicit redirectTo, Supabase sends the invite link to
      // the project's default Site URL — which is the customer home page,
      // not the dashboard login that actually handles #type=invite. Must
      // match a URL on Supabase's Redirect URLs allow-list exactly.
      const redirectTo = `${req.protocol}://${req.get("host")}/admin`;
      const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email.trim(), {
        redirectTo,
      });
      if (inviteError || !invited.user) {
        res.status(500).json({ error: "failed_to_invite" });
        return;
      }

      const { error: profileError } = await supabase.from("profiles").insert({
        id: invited.user.id,
        email: email.trim(),
        full_name: typeof fullName === "string" && fullName.trim().length > 0 ? fullName.trim() : null,
        role,
        invited_by: getStaffUser(req).id,
      });

      if (profileError) {
        res.status(500).json({ error: "failed_to_create_profile" });
        return;
      }

      const inviter = getStaffUser(req);
      void logAudit("team", `${inviter.fullName ?? inviter.email} invited ${email.trim()} as ${role}.`);

      res.status(200).json({ invited: true });
    } catch (error) {
      console.error("dashboard: invite failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.patch("/api/dashboard/team/:userId/role", verifyStaffSession, requireAdmin, async (req: Request, res: Response) => {
    try {
      const role = req.body?.role;
      if (role !== "admin" && role !== "specialist") {
        res.status(400).json({ error: "invalid_role" });
        return;
      }

      const supabase = getSupabaseClient();
      const { data: target } = await supabase
        .from("profiles")
        .select("id, email, full_name, role")
        .eq("id", req.params.userId)
        .maybeSingle();

      if (!target) {
        res.status(404).json({ error: "not_found" });
        return;
      }

      if (target.role === "admin" && role !== "admin") {
        const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
        if ((count ?? 0) <= 1) {
          res.status(400).json({ error: "would_remove_last_admin" });
          return;
        }
      }

      const staffUser = getStaffUser(req);
      const { data: updated, error } = await supabase
        .from("profiles")
        .update({ role, role_changed_at: new Date().toISOString(), role_changed_by: staffUser.id })
        .eq("id", req.params.userId)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: "failed_to_update_role" });
        return;
      }

      // Not awaited: a slow email send must not delay this response — this
      // is exactly what made the Confirm change button look broken (it was
      // just waiting on an email send with zero feedback) before this and
      // the fire-and-forget pattern below were in place.
      const changedAt = new Date().toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      });

      sendEmail({
        to: target.email,
        subject: "Your RelayPay role has changed",
        text: [
          `Hi ${target.full_name ?? ""},`.trim(),
          ``,
          `Your role was changed from ${target.role} to ${role}.`,
          ``,
          `Changed by: ${staffUser.fullName ?? staffUser.email}`,
          `Changed at: ${changedAt}`,
          ``,
          `— RelayPay Support`,
        ].join("\n"),
      }).catch((emailError) => {
        console.error("dashboard: role-change email failed", emailError);
      });

      void logAudit(
        "team",
        `${staffUser.fullName ?? staffUser.email} changed ${target.full_name ?? target.email}'s role from ${target.role} to ${role}.`
      );

      res.status(200).json({ profile: updated });
    } catch (error) {
      console.error("dashboard: role change failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.delete("/api/dashboard/team/:userId", verifyStaffSession, requireAdmin, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const { data: target } = await supabase
        .from("profiles")
        .select("id, email, full_name, role")
        .eq("id", req.params.userId)
        .maybeSingle();

      if (!target) {
        res.status(404).json({ error: "not_found" });
        return;
      }

      if (target.role === "admin") {
        const { count } = await supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
        if ((count ?? 0) <= 1) {
          res.status(400).json({ error: "would_remove_last_admin" });
          return;
        }
      }

      await supabase
        .from("support_tickets")
        .update({ assigned_to: null, status: "open" })
        .eq("assigned_to", req.params.userId)
        .eq("status", "in_progress");
      await supabase
        .from("escalations")
        .update({ assigned_to: null, status: "open" })
        .eq("assigned_to", req.params.userId)
        .eq("status", "in_progress");

      const { error: authError } = await supabase.auth.admin.deleteUser(req.params.userId);
      if (authError) {
        res.status(500).json({ error: "failed_to_delete_auth_user" });
        return;
      }

      await supabase.from("profiles").delete().eq("id", req.params.userId);

      const remover = getStaffUser(req);
      void logAudit("team", `${remover.fullName ?? remover.email} removed ${target.full_name ?? target.email} from the team.`);

      res.status(200).json({ removed: true });
    } catch (error) {
      console.error("dashboard: remove staff failed", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

function registerAuditRoutes(router: Router): void {
  // Fired once by the frontend right after a fresh sign-in (not on every
  // session-restore page load) — the only way the backend finds out "someone
  // logged in", since Supabase Auth itself is never told.
  router.post("/api/dashboard/login-event", verifyStaffSession, (req: Request, res: Response) => {
    const who = getStaffUser(req);
    void logAudit("team", `${who.fullName ?? who.email} logged in.`);
    res.status(200).json({ logged: true });
  });

  // Any signed-in staff member can see a case's own tool-call history (not
  // admin-only like the full audit log) — it's the same thing a specialist
  // already sees in that case's transcript, just the machine side of it.
  // Polled by the case detail pane's "Tool calls, live" panel while the
  // case is open; `callEnded` lets the frontend know when to stop polling.
  router.get("/api/dashboard/cases/:reference/tool-calls", verifyStaffSession, async (req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const found = await findCase(supabase, req.params.reference);
      if (!found) {
        res.status(404).json({ error: "case_not_found" });
        return;
      }

      if (!found.row.conversation_id) {
        res.status(200).json({ toolCalls: [], callEnded: true });
        return;
      }

      const [{ data: toolCalls, error }, { data: conversation }] = await Promise.all([
        supabase
          .from("tool_calls")
          .select("id, tool_name, purpose, input_summary, result_summary, status, error_message, duration_ms, created_at")
          .eq("conversation_id", found.row.conversation_id)
          .order("created_at", { ascending: true }),
        supabase.from("conversations").select("ended_at").eq("conversation_id", found.row.conversation_id).maybeSingle(),
      ]);

      if (error) {
        res.status(500).json({ error: "failed_to_load_tool_calls" });
        return;
      }

      res.status(200).json({ toolCalls: toolCalls ?? [], callEnded: !!conversation?.ended_at });
    } catch (error) {
      console.error("dashboard: failed to load case tool calls", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  // Full historical tool-call log — admin-only, structured (vs. the plain-
  // English /audit-log feed below), for the Audit Logs tab's "Tool Calls"
  // table: filterable by tool/status, with input/output detail and CSV
  // export.
  router.get("/api/dashboard/tool-calls", verifyStaffSession, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("tool_calls")
        .select("id, conversation_id, tool_name, purpose, input_summary, result_summary, status, error_message, duration_ms, created_at")
        .order("created_at", { ascending: false })
        .limit(500);

      if (error) {
        res.status(500).json({ error: "failed_to_load_tool_calls" });
        return;
      }

      res.status(200).json({ toolCalls: data ?? [] });
    } catch (error) {
      console.error("dashboard: failed to load tool calls", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });

  router.get("/api/dashboard/audit-log", verifyStaffSession, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("audit_log")
        .select("id, category, message, created_at")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) {
        res.status(500).json({ error: "failed_to_load_audit_log" });
        return;
      }

      res.status(200).json({ events: data ?? [] });
    } catch (error) {
      console.error("dashboard: failed to load audit log", error);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  });
}

export function registerDashboardRoutes(router: Router): void {
  registerCaseRoutes(router);
  registerTeamRoutes(router);
  registerAuditRoutes(router);
}

export function createDashboardRouter(): Router {
  const router = createRouter();
  registerDashboardRoutes(router);
  return router;
}
