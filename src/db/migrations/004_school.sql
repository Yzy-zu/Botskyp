CREATE TABLE school_config (
  chat_id text PRIMARY KEY REFERENCES chats(id),
  target_group_id text NOT NULL REFERENCES chats(id),
  timezone text NOT NULL DEFAULT 'America/Mexico_City' CHECK(timezone='America/Mexico_City'),
  revision int NOT NULL DEFAULT 0,
  summary_schedule jsonb
);
CREATE TABLE school_subjects (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80), active boolean NOT NULL DEFAULT true,
  UNIQUE(chat_id,name), UNIQUE(chat_id,id)
);
CREATE UNIQUE INDEX school_subject_name ON school_subjects(chat_id,lower(name));
CREATE TABLE school_schedule (
  id bigserial PRIMARY KEY, chat_id text NOT NULL,
  subject_id bigint NOT NULL, weekday int NOT NULL CHECK(weekday BETWEEN 1 AND 7),
  start_time time NOT NULL, end_time time NOT NULL CHECK(end_time>start_time),
  FOREIGN KEY(chat_id,subject_id) REFERENCES school_subjects(chat_id,id),
  UNIQUE(chat_id,weekday,start_time)
);
CREATE TABLE school_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_id text NOT NULL REFERENCES chats(id),
  owner_id text NOT NULL, source_message_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('image','document')),
  mime text NOT NULL, data bytea, size int NOT NULL CHECK(size>0 AND size<=4000000),
  is_original boolean NOT NULL DEFAULT true CHECK(is_original),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(chat_id,owner_id,source_message_id,kind), UNIQUE(chat_id,id)
);
CREATE TABLE school_tasks (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id), subject_id bigint NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 1000),
  due_at timestamptz, due_source text CHECK(due_source IN ('explicit','next_class')),
  created_by text NOT NULL, source_message_id text NOT NULL,
  attachment_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  FOREIGN KEY(chat_id,subject_id) REFERENCES school_subjects(chat_id,id),
  CHECK((due_at IS NULL)=(due_source IS NULL)), UNIQUE(chat_id,created_by,source_message_id)
);
CREATE INDEX school_tasks_chat ON school_tasks(chat_id,due_at) WHERE deleted_at IS NULL;
CREATE TABLE school_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_id text NOT NULL REFERENCES chats(id), author_id text NOT NULL,
  source_attachment_id uuid, preview jsonb NOT NULL, args_hash text NOT NULL, base_revision int NOT NULL,
  status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','confirmed','expired','superseded')),
  source_message_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  FOREIGN KEY(chat_id,source_attachment_id) REFERENCES school_attachments(chat_id,id),
  UNIQUE(chat_id,author_id,source_message_id)
);
CREATE TABLE automations (
  id bigserial PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id), kind text NOT NULL CHECK(kind='school_summary'),
  owner_id text NOT NULL, enabled boolean NOT NULL DEFAULT false, config jsonb NOT NULL,
  next_run_at timestamptz NOT NULL, last_run_at timestamptz, catch_up boolean NOT NULL DEFAULT true CHECK(catch_up),
  outbox_id bigint REFERENCES outbox(id), UNIQUE(chat_id,kind)
);
