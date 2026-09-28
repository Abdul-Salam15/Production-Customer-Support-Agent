// Supabase Edge Function: returns a gte-small embedding for a given text.
// Uses the built-in Supabase.ai inference session — no external embeddings API or key.
const session = new Supabase.ai.Session("gte-small");

Deno.serve(async (req: Request) => {
  const { text } = await req.json();

  if (!text || typeof text !== "string") {
    return new Response(JSON.stringify({ error: "text is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const embedding = await session.run(text, {
    mean_pool: true,
    normalize: true,
  });

  return new Response(JSON.stringify({ embedding }), {
    headers: { "Content-Type": "application/json" },
  });
});
