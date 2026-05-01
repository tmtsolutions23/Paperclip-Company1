create extension if not exists "pgcrypto";

create table if not exists call_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  twilio_call_sid text not null unique,
  direction text not null default 'inbound',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active',
  caller_phone_e164 text not null,
  caller_name text,
  prompt_version text,
  final_disposition text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  speaker text not null,
  utterance_index integer not null,
  text text not null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (call_session_id, utterance_index)
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  call_session_id uuid not null unique references call_sessions(id) on delete cascade,
  caller_phone_e164 text not null,
  caller_name text,
  email text,
  service_address text,
  city text,
  postal_code text,
  service_category text not null,
  urgency text not null,
  summary text not null,
  source text not null default 'voice_call',
  disposition text not null,
  qualification_status text not null,
  transcript_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists callback_tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  lead_id uuid not null references leads(id) on delete cascade,
  call_session_id uuid not null references call_sessions(id) on delete cascade,
  requested_for_lead_phone text not null,
  reason text not null,
  priority text not null default 'normal',
  status text not null default 'open',
  notes text not null,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration_sync_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  lead_id uuid references leads(id) on delete set null,
  callback_task_id uuid references callback_tasks(id) on delete set null,
  integration_key text not null,
  external_object_type text not null,
  external_object_id text,
  idempotency_key text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  last_attempted_at timestamptz,
  next_attempt_at timestamptz,
  request_payload jsonb not null,
  response_payload jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (integration_key, idempotency_key)
);

create index if not exists idx_call_transcripts_call_session_id
  on call_transcripts (call_session_id);

create index if not exists idx_callback_tasks_status_due_at
  on callback_tasks (status, due_at);

create index if not exists idx_integration_sync_events_status_next_attempt_at
  on integration_sync_events (status, next_attempt_at);

