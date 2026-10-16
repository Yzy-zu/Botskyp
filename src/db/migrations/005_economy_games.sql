CREATE TABLE wallets (
  user_id text PRIMARY KEY, balance integer NOT NULL DEFAULT 0 CHECK(balance>=0),
  last_daily_at timestamptz, streak integer NOT NULL DEFAULT 0 CHECK(streak>=0)
);
CREATE TABLE xp_ledger (
  id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES wallets(user_id), delta integer NOT NULL,
  reason text NOT NULL, ref text NOT NULL, chat_id text NOT NULL,
  config_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reason,user_id,ref)
);
CREATE TABLE activity_marks (
  user_id text NOT NULL, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  last_at timestamptz NOT NULL, PRIMARY KEY(user_id,chat_id)
);
CREATE TABLE games (
  id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  owner_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('blackjack','roulette','airdrop')),
  status text NOT NULL CHECK(status IN ('lobby','playing','open','done','cancelled','claimed','expired')),
  state jsonb NOT NULL, version integer NOT NULL DEFAULT 0, source_id text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chat_id,owner_id,source_id), UNIQUE(id,chat_id)
);
CREATE UNIQUE INDEX games_group_lobby ON games(chat_id) WHERE status='lobby';
CREATE UNIQUE INDEX games_airdrop_open ON games(chat_id) WHERE kind='airdrop' AND status='open';
CREATE INDEX games_due ON games(expires_at) WHERE status IN ('lobby','playing','open');
CREATE TABLE game_players (
  game_id uuid NOT NULL, chat_id text NOT NULL, user_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(game_id,user_id), FOREIGN KEY(game_id,chat_id) REFERENCES games(id,chat_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX game_player_active ON game_players(chat_id,user_id) WHERE active;
CREATE TABLE game_actions (
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id text NOT NULL, source_id text NOT NULL,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE, reply text NOT NULL,
  PRIMARY KEY(chat_id,user_id,source_id)
);
CREATE TABLE moderation_counts (
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id text NOT NULL,
  warns integer NOT NULL DEFAULT 0 CHECK(warns>=0), PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE moderation_events (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('warn','unwarn','kick','reset')),
  source text NOT NULL CHECK(source IN ('manual','roulette')), actor_id text NOT NULL,
  ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(chat_id,user_id,kind,ref)
);
CREATE TABLE obligations (
  id bigserial PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('roulette_kick','roulette_reinvite')),
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE, user_id text NOT NULL,
  ref text NOT NULL, due_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','queued','done','skipped','review')),
  attempts integer NOT NULL DEFAULT 0, attempted_at timestamptz, detail jsonb NOT NULL,
  outbox_id bigint REFERENCES outbox(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(kind,chat_id,user_id,ref)
);
CREATE UNIQUE INDEX obligations_one_kick ON obligations(chat_id,user_id) WHERE kind='roulette_kick' AND status IN ('pending','sending','review');
ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check CHECK(kind IN ('confirm','clarify','game'));
