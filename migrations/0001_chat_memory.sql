-- Shared contract v1. Fresh chat_memory schema.
-- chat-memory-agent owns this initializer. There is no down migration:
-- rolling back a deployment keeps the tables and stored rows.

CREATE SCHEMA IF NOT EXISTS chat_memory;

COMMENT ON SCHEMA chat_memory IS
  'Cumulative chat summaries and retained raw messages. Contract v1.';

CREATE OR REPLACE FUNCTION chat_memory.is_canonical_chat_id(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value IS NOT NULL
    AND value ~ '^-?(0|[1-9][0-9]*)$'
    AND length(value) <= 20
    AND value::numeric <> 0
    AND value::numeric >= -9223372036854775808
    AND value::numeric <= 9223372036854775807
$$;

CREATE TABLE IF NOT EXISTS chat_memory.chat_memories (
  telegram_chat_id text PRIMARY KEY,
  summary_text text NOT NULL DEFAULT '',
  summary_version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  summarized_at timestamptz,
  processing_token uuid,
  processing_lease_expires_at timestamptz,
  CONSTRAINT chat_memories_chat_id_canonical
    CHECK (chat_memory.is_canonical_chat_id(telegram_chat_id)),
  CONSTRAINT chat_memories_summary_length
    CHECK (char_length(summary_text) <= 8000),
  CONSTRAINT chat_memories_version_nonnegative
    CHECK (summary_version >= 0),
  CONSTRAINT chat_memories_lease_pair
    CHECK (
      (
        processing_token IS NULL
        AND processing_lease_expires_at IS NULL
      )
      OR (
        processing_token IS NOT NULL
        AND processing_lease_expires_at IS NOT NULL
      )
    )
);

COMMENT ON TABLE chat_memory.chat_memories IS
  'One cumulative summary row per chat. Version 0 is the empty parent created on first ingestion.';

CREATE TABLE IF NOT EXISTS chat_memory.raw_messages (
  raw_message_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_chat_id text NOT NULL,
  event_key text NOT NULL,
  turn_id text NOT NULL,
  source_update_id bigint NOT NULL,
  source_message_id bigint,
  role text NOT NULL,
  content text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'non-process',
  processed_at timestamptz,
  processed_summary_version bigint,
  CONSTRAINT raw_messages_chat_event_key
    UNIQUE (telegram_chat_id, event_key),
  CONSTRAINT raw_messages_chat_fk
    FOREIGN KEY (telegram_chat_id)
    REFERENCES chat_memory.chat_memories (telegram_chat_id),
  CONSTRAINT raw_messages_role
    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT raw_messages_status
    CHECK (status IN ('non-process', 'processed-completed')),
  CONSTRAINT raw_messages_content_nonempty
    CHECK (char_length(content) > 0),
  CONSTRAINT raw_messages_source_update_nonnegative
    CHECK (source_update_id >= 0),
  CONSTRAINT raw_messages_source_message_positive
    CHECK (source_message_id IS NULL OR source_message_id > 0),
  CONSTRAINT raw_messages_completion_consistency
    CHECK (
      (
        status = 'non-process'
        AND processed_at IS NULL
        AND processed_summary_version IS NULL
      )
      OR (
        status = 'processed-completed'
        AND processed_at IS NOT NULL
        AND processed_summary_version IS NOT NULL
        AND processed_summary_version > 0
      )
    )
);

COMMENT ON TABLE chat_memory.raw_messages IS
  'Retained raw user and assistant events. Processing updates status and does not delete rows.';

CREATE INDEX IF NOT EXISTS raw_messages_pending_chronological_idx
  ON chat_memory.raw_messages (
    telegram_chat_id,
    occurred_at,
    source_update_id,
    (CASE role WHEN 'user' THEN 0 ELSE 1 END),
    raw_message_id
  )
  WHERE status = 'non-process';

CREATE INDEX IF NOT EXISTS raw_messages_pending_oldest_chat_idx
  ON chat_memory.raw_messages (received_at, telegram_chat_id)
  WHERE status = 'non-process';

CREATE INDEX IF NOT EXISTS raw_messages_pending_turn_idx
  ON chat_memory.raw_messages (telegram_chat_id, turn_id)
  WHERE status = 'non-process';
