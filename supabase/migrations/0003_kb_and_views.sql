create extension if not exists vector;

create table kb_chunks (
  id bigint generated always as identity primary key,
  source_title text not null,      -- e.g. "Policies And Compliance › Account Restrictions And Suspensions"
  source_summary text not null,    -- one line, written at ingest
  content text not null,
  embedding vector(384),           -- gte-small dimension
  fts tsvector generated always as (to_tsvector('english', content)) stored
);

create index on kb_chunks using ivfflat (embedding vector_cosine_ops);
create index on kb_chunks using gin (fts);

alter table kb_chunks enable row level security;

