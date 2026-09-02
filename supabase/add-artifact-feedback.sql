-- Thumbs up / down on a DealRipe artifact.
--
-- Alexandra Suntrup asked for this on 2026-09-02, on a call where she was
-- otherwise describing what does not work: "That would be amazing. That
-- actually would be fantastic... give some concrete kind of results for you and
-- your team to be able to see like, okay, these ones are good."
--
-- It is also the cleanest signal in the system. Follow-through is INFERRED from
-- transcripts and mailboxes and took four rounds of fixes in one week to stop
-- being wrong; a rep clicking thumbs-down is a labelled judgement with no
-- inference layer between the rep and the row.
--
-- THE TOKEN, not the row id. The artifact HTML is rendered before the row
-- exists, so the link cannot carry a primary key that has not been generated
-- yet. A random token is created with the artifact, embedded in it, and stored
-- alongside. Unguessable, so the link needs no auth and works from any mail
-- client.

alter table sent_messages
  add column if not exists feedback_token uuid,
  add column if not exists feedback text check (feedback in ('up', 'down')),
  add column if not exists feedback_at timestamptz,
  -- Free text for later. A thumbs-down with a reason is worth ten without one,
  -- and the column costs nothing until there is a form to fill it.
  add column if not exists feedback_note text;

create unique index if not exists sent_messages_feedback_token_idx
  on sent_messages (feedback_token)
  where feedback_token is not null;

comment on column sent_messages.feedback is
  'up | down, set by the rep clicking the footer link on the artifact itself. Null means not rated, never rated neutral.';
