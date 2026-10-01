// Typed environment loader for apps/agent — variables from implementation.md
// Section 3's agent-backend table. Call loadEnv() once at process start
// (src/index.ts), before anything else reads process.env.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadEnv(): void {
  loadDotenv({ path: join(__dirname, "..", ".env") });
}

export interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MCP_SERVER_URL: string;
  MCP_SERVER_TOKEN: string;
  VAPI_PRIVATE_KEY: string;
  VAPI_SERVER_SECRET: string;
  PORT: number;
  // Browser-exposed, not secret (Section 3) — served to the frontend via
  // GET /api/config so the Vapi Web SDK can initialize (Stage 8).
  VAPI_PUBLIC_KEY: string;
  VAPI_ASSISTANT_ID: string;
  // Also browser-exposed via GET /api/config — the anon key is safe
  // client-side by design (RLS governs what it can reach), unlike
  // SUPABASE_SERVICE_ROLE_KEY above, which never leaves the server.
  SUPABASE_ANON_KEY: string;
  // Resend's HTTP API, for the escalation/call-summary/role-change/resolved
  // emails — not SMTP: Render blocks outbound SMTP (confirmed — both port
  // 465 and 587 hang until timeout), but plain HTTPS is never blocked.
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  SUPPORT_TEAM_EMAIL: string;
}

const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MCP_SERVER_URL",
  "MCP_SERVER_TOKEN",
  "VAPI_PRIVATE_KEY",
  "VAPI_SERVER_SECRET",
  "VAPI_PUBLIC_KEY",
  "VAPI_ASSISTANT_ID",
  "SUPABASE_ANON_KEY",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "SUPPORT_TEAM_EMAIL",
] as const;

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  cachedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    MCP_SERVER_URL: process.env.MCP_SERVER_URL!,
    MCP_SERVER_TOKEN: process.env.MCP_SERVER_TOKEN!,
    VAPI_PRIVATE_KEY: process.env.VAPI_PRIVATE_KEY!,
    VAPI_SERVER_SECRET: process.env.VAPI_SERVER_SECRET!,
    VAPI_PUBLIC_KEY: process.env.VAPI_PUBLIC_KEY!,
    VAPI_ASSISTANT_ID: process.env.VAPI_ASSISTANT_ID!,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,
    RESEND_API_KEY: process.env.RESEND_API_KEY!,
    EMAIL_FROM: process.env.EMAIL_FROM!,
    SUPPORT_TEAM_EMAIL: process.env.SUPPORT_TEAM_EMAIL!,
    // Render sets this; read it, don't hardcode.
    PORT: Number(process.env.PORT ?? 3000),
  };

  return cachedEnv;
}
