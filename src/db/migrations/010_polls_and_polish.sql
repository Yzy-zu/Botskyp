CREATE TABLE polls (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id), author_id text NOT NULL,
  source_id text NOT NULL, question text NOT NULL CHECK(length(question) BETWEEN 1 AND 300),
  multi boolean NOT NULL DEFAULT false CHECK(NOT multi),
  closes_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  UNIQUE(chat_id,author_id,source_id)
);
CREATE INDEX polls_due ON polls(closes_at,id) WHERE status='open';
CREATE TABLE poll_options (
  poll_id bigint NOT NULL REFERENCES polls(id), idx int NOT NULL CHECK(idx BETWEEN 1 AND 10),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 100), PRIMARY KEY(poll_id,idx), UNIQUE(poll_id,label)
);
CREATE TABLE poll_votes (
  poll_id bigint NOT NULL REFERENCES polls(id), voter_id text NOT NULL, option_idx int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(poll_id,voter_id),
  FOREIGN KEY(poll_id,option_idx) REFERENCES poll_options(poll_id,idx)
);
-- Retained with the poll: replay of an old change must never revert a later vote.
CREATE TABLE poll_vote_events (
  poll_id bigint NOT NULL REFERENCES polls(id), voter_id text NOT NULL, source_id text NOT NULL,
  option_idx int NOT NULL, PRIMARY KEY(poll_id,voter_id,source_id),
  FOREIGN KEY(poll_id,option_idx) REFERENCES poll_options(poll_id,idx)
);
CREATE INDEX seen_events_retention ON seen_events(seen_at,provider_msg_id);
CREATE INDEX inbox_retention ON inbox(received_at,id) WHERE status='done';
CREATE INDEX context_retention ON context_msgs(created_at,id);
CREATE INDEX outbox_chat_order ON outbox(chat_id,id) WHERE status IN ('queued','sending','uncertain');
CREATE INDEX outbox_chat_sending ON outbox(chat_id,sending_at) WHERE sending_at IS NOT NULL;
CREATE INDEX inbox_message_scope ON inbox(chat_id,(payload->>'id'));
CREATE INDEX inbox_actor_recent ON inbox(chat_id,(payload->>'senderId'),received_at DESC);
