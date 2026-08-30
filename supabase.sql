create table if not exists conversations (
  phone_number text primary key,
  name text,
  last_message text,
  last_message_at timestamptz,
  unread_count integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(phone_number) on delete cascade,
  phone_number text not null,
  wamid text unique not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender text not null,
  message_type text not null,
  content text,
  media_id text,
  timestamp timestamptz not null,
  status text not null default 'received',
  media_url text,
  created_at timestamptz not null default now()
);

create index if not exists messages_phone_timestamp_idx on messages(phone_number, timestamp);
create table if not exists contacts (
  phone_number text primary key,
  name text,
  updated_at timestamptz not null default now()
);
create table if not exists message_status (
  id bigint generated always as identity primary key,
  wamid text not null,
  status text not null,
  timestamp timestamptz not null default now()
);
