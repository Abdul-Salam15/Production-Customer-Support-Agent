import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY live in apps/agent/.env per Section 3.
loadEnv({ path: join(__dirname, "..", "apps", "agent", ".env") });

interface Chunk {
  source_title: string;
  source_summary: string;
  content: string;
}

function buildSummary(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return firstSentence.trim().slice(0, 160);
}

// Splits the knowledge base on every "###" heading. Each chunk's source_title
// is its full heading path: "<## section> › <### heading>". Text between a
// "##" heading and its first "###" becomes its own chunk titled with the
// section alone: Policies And Compliance opens with the regulations RelayPay
// follows and "decisions cannot be overridden by customer support", which
// were otherwise never indexed.
function parseKnowledgeBase(markdown: string): Chunk[] {
  const lines = markdown.split("\n");
  const chunks: Chunk[] = [];

  let currentH2 = "";
  let currentH3: string | null = null;
  // True between a "##" heading and its first "###".
  let inIntro = false;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    buffer = [];
    if (!content || (currentH3 === null && !inIntro)) return;
    chunks.push({
      source_title: currentH3 === null ? currentH2 : `${currentH2} › ${currentH3}`,
      source_summary: buildSummary(content),
      content,
    });
  };

  for (const line of lines) {
    if (line.startsWith("### ")) {
      flush();
      inIntro = false;
      currentH3 = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      currentH3 = null;
      currentH2 = line.slice(3).trim();
      inIntro = true;
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      currentH3 = null;
      inIntro = false;
      continue;
    }
    if (currentH3 !== null || inIntro) {
      buffer.push(line);
    }
  }
  flush();

  return chunks;
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

  const markdownPath = join(__dirname, "..", "assets", "relaypay-knowledge-base.md");
  const markdown = readFileSync(markdownPath, "utf-8");
  const chunks = parseKnowledgeBase(markdown);

  console.log(`Parsed ${chunks.length} chunks from "###" headings in the knowledge base.`);

  const rows: {
    source_title: string;
    source_summary: string;
    content: string;
    embedding: number[];
  }[] = [];

  for (const chunk of chunks) {
    const { data, error } = await supabase.functions.invoke("embed-kb", {
      // Title + body: in the FAQ the question is the heading, and a chunk
      // embedded without it ("No. Payment timelines depend on…") doesn't
      // look like the question callers actually ask.
      body: { text: `${chunk.source_title.split(" › ").pop()}\n\n${chunk.content}` },
    });
    if (error) {
      throw new Error(`embed-kb failed for "${chunk.source_title}": ${error.message}`);
    }
    rows.push({
      source_title: chunk.source_title,
      source_summary: chunk.source_summary,
      content: chunk.content,
      embedding: data.embedding,
    });
  }

  // Safe to re-run: clear existing chunks before reinserting, rather than
  // failing or duplicating rows on a second run.
  const { error: deleteError } = await supabase.from("kb_chunks").delete().gte("id", 0);
  if (deleteError) {
    throw new Error(`failed to clear kb_chunks: ${deleteError.message}`);
  }

  const { error: insertError } = await supabase.from("kb_chunks").insert(rows);
  if (insertError) {
    throw new Error(`failed to insert kb_chunks: ${insertError.message}`);
  }

  console.log(`Inserted ${rows.length} rows into kb_chunks.`);
}

main().catch((error) => {
  console.error("Knowledge base ingestion failed:", error);
  process.exitCode = 1;
});
