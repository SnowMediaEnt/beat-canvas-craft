-- Resellers: sub-operators who get credit balances from the owner and spend
-- them to add/extend their own customers through a limited /reseller portal.
-- 1 credit = 30 days of access for one customer.

create table public.plex_resellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- The reseller's own Plex account; their customers' devices sign in to it.
  plex_email text,
  plex_username text,
  auth_token text,
  credits integer not null default 0 check (credits >= 0),
  -- Secret that unlocks their portal at /reseller
  portal_code text not null unique,
  status text not null default 'active' check (status in ('active', 'disabled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plex_resellers enable row level security;

alter table public.plex_members
  add column reseller_id uuid references public.plex_resellers (id) on delete restrict;

create index plex_members_reseller_idx on public.plex_members (reseller_id);

-- Atomic credit spend: deducts only when the balance covers the cost and the
-- reseller is active. Returns the new balance, or no row when insufficient.
create or replace function public.plex_spend_credits(p_reseller_id uuid, p_amount integer)
returns integer
language sql
volatile
as $$
  update public.plex_resellers
     set credits = credits - p_amount,
         updated_at = now()
   where id = p_reseller_id
     and p_amount > 0
     and credits >= p_amount
     and status = 'active'
  returning credits;
$$;

revoke execute on function public.plex_spend_credits(uuid, integer) from public, anon, authenticated;
