-- What the caller just said, written by the agent backend before each turn.
-- search_knowledge_base searches with it as well as the model's own query:
-- the model rewrites questions ("guarantee my payout by 9am" became "payout
-- timing"), and some rewrites miss the article the caller's words would hit.
alter table conversations add column current_utterance text;
