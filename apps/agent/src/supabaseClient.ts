import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "./env.js";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;
  const env = getEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  return client;
}
