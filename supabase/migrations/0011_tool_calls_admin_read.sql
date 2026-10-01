-- tool_calls already has RLS enabled (0002) but no read policy — only the
-- service-role key could read it. Defense-in-depth, matching every other
-- admin-facing table: let admins read it directly too.
create policy "tool_calls readable by admins" on tool_calls
  for select using (is_admin(auth.uid()));
