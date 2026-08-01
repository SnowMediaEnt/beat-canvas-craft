-- Plex member manager: connection settings, managed members (subscriptions),
-- and an audit log of every access change.
--
-- SECURITY: all three tables hold or reference the Plex auth token, so RLS is
-- enabled with NO policies — only the service role (used by this app's server
-- layer) can read or write. The browser never talks to these tables directly.

create table public.plex_settings (
  id text primary key default 'default',
  -- Owner (server admin) plex.tv account
  auth_token text,
  account_username text,
  account_email text,
  plex_pass boolean not null default false,
  -- Optional dedicated account that 4-digit-code devices get signed in to
  link_auth_token text,
  link_account_username text,
  link_account_email text,
  -- Stable X-Plex-Client-Identifier for all API calls from this app
  client_identifier text not null,
  -- Selected media server
  machine_identifier text,
  server_name text,
  server_url text,
  -- Behavior
  remove_friend_on_expiry boolean not null default true,
  default_library_ids text[] not null default '{}',
  -- Secret that authorizes the public /api/public/plex-enforce endpoint
  enforce_key text not null,
  last_enforced_at timestamptz,
  last_enforce_result jsonb,
  updated_at timestamptz not null default now()
);

alter table public.plex_settings enable row level security;

create table public.plex_members (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text,
  plex_username text,
  plex_user_id text,
  -- plex.tv shared-server id (used to revoke an invite-based share)
  shared_server_id text,
  access_type text not null check (access_type in ('invite', 'link_code')),
  invite_status text,
  -- Which stored account the member's devices are signed in to ('owner' | 'link')
  link_account text not null default 'owner',
  device_ids text[] not null default '{}',
  device_client_ids text[] not null default '{}',
  device_names text[] not null default '{}',
  library_ids text[] not null default '{}',
  notes text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'expired', 'removed')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plex_members enable row level security;

create index plex_members_expiry_idx on public.plex_members (status, expires_at);

create table public.plex_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.plex_members (id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.plex_events enable row level security;

create index plex_events_created_idx on public.plex_events (created_at desc);
