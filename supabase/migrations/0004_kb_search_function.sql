-- Hybrid search over kb_chunks: combines pgvector cosine similarity with
-- Postgres full-text ranking. text_rank is normalized against the max rank
-- in the candidate set (via a window function) before blending, since raw
-- ts_rank values are typically much smaller in magnitude than cosine
-- similarity and would otherwise be drowned out.
--
-- Weights (60% vector / 40% keyword) and the sufficient_context threshold
-- are chosen and documented in scripts/tools/searchKnowledgeBase.ts.
create or replace function match_kb_chunks(
  query_embedding vector(384),
  query_text text,
  match_count int default 3
)
returns table (
  id bigint,
  source_title text,
  source_summary text,
  content text,
  combined_score float
)
language sql
stable
as $$
  with scored as (
    select
      kb_chunks.id,
      kb_chunks.source_title,
      kb_chunks.source_summary,
      kb_chunks.content,
      1 - (kb_chunks.embedding <=> query_embedding) as vector_similarity,
      ts_rank(kb_chunks.fts, plainto_tsquery('english', query_text)) as text_rank
    from kb_chunks
  ),
  normalized as (
    select
      *,
      -- ts_rank returns a tiny nonzero float noise floor (~1e-21) for a
      -- non-match rather than exact 0, so compare against an epsilon well
      -- below any real match (observed real matches: ~0.17-0.8).
      case
        when max(text_rank) over () < 0.000001 then 0
        else text_rank / max(text_rank) over ()
      end as text_rank_norm
    from scored
  )
  select
    id,
    source_title,
    source_summary,
    content,
    (0.6 * vector_similarity) + (0.4 * text_rank_norm) as combined_score
  from normalized
  order by combined_score desc
  limit match_count;
$$;
