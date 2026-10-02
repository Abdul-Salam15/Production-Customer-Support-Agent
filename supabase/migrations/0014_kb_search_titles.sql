-- Two retrieval misses, found when "Can RelayPay guarantee my payout arrives
-- by 9am tomorrow?" didn't return the "Can RelayPay Guarantee Payment
-- Timelines?" FAQ:
--
-- 1. Only the body was indexed. In the FAQ the question lives in the heading
--    (source_title), so "guarantee" appeared nowhere in what was searched.
--    The keyword index now covers title + body (the ingest script embeds
--    title + body too).
-- 2. plainto_tsquery ANDs every word, so a natural spoken question almost
--    never matched any chunk and keyword search contributed nothing. Terms
--    are now ORed and ranked, so the chunk matching the most (and rarest)
--    words wins.
alter table kb_chunks drop column fts;
alter table kb_chunks
  add column fts tsvector generated always as (
    to_tsvector('english', coalesce(source_title, '') || ' ' || content)
  ) stored;
create index on kb_chunks using gin (fts);

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
  with q as (
    select nullif(replace(plainto_tsquery('english', query_text)::text, '&', '|'), '')::tsquery as tsq
  ),
  scored as (
    select
      kb_chunks.id,
      kb_chunks.source_title,
      kb_chunks.source_summary,
      kb_chunks.content,
      1 - (kb_chunks.embedding <=> query_embedding) as vector_similarity,
      coalesce(ts_rank(kb_chunks.fts, q.tsq), 0) as text_rank
    from kb_chunks, q
  ),
  normalized as (
    select
      *,
      -- ts_rank returns a tiny nonzero noise floor for a non-match rather
      -- than exact 0, so compare against an epsilon well below any real match.
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
