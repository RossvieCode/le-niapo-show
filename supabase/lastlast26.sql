-- lastlast26 – graduation party: invite codes, location and who unlocked it.
-- Supabase → SQL Editor → New query → paste this whole file → Run.
-- Safe to re-run: it keeps existing codes, settings and unlocks.
-- The result of the last line is your HOST CODE: type it in the page's code box to see the stats.

create extension if not exists pgcrypto;

-- Invite codes. "label" is who the code belongs to (shown on the stats screen and on the guest's pass).
create table if not exists public.lastlast_codes (
  code   text primary key,           -- stored UPPERCASE, no spaces
  label  text not null,
  active boolean not null default true
);

-- One row of party settings. Only revealed after a valid code.
create table if not exists public.lastlast_settings (
  id         int primary key default 1 check (id = 1),
  venue      text not null default 'The house',
  address    text,                    -- optional, shown under the venue
  maps_link  text not null,
  map_query  text,                    -- optional "lat,lng" or address for the embedded map
  starts_at  text not null default 'Wed 25 Nov · 9:00 PM',
  dress_code text not null default 'Casual',
  host_code  text not null default ('HOST-' || upper(encode(gen_random_bytes(3), 'hex')))
);

-- Every successful unlock. One row per device per code (refreshing the page doesn't count twice).
create table if not exists public.lastlast_unlocks (
  id         bigserial primary key,
  code       text not null references public.lastlast_codes (code),
  guest      text not null,
  device     text not null,
  created_at timestamptz not null default now(),
  unique (code, device)
);

-- Wrong codes, so you can see if someone is guessing.
create table if not exists public.lastlast_misses (
  id         bigserial primary key,
  tried      text not null,
  created_at timestamptz not null default now()
);

-- No direct access from the page: everything goes through the two functions below.
alter table public.lastlast_codes    enable row level security;
alter table public.lastlast_settings enable row level security;
alter table public.lastlast_unlocks  enable row level security;
alter table public.lastlast_misses   enable row level security;

-- ---------------------------------------------------------------------------
-- Starting data (edit, then re-run; existing rows are left as they are)
-- ---------------------------------------------------------------------------
insert into public.lastlast_settings (id, maps_link)
values (1, 'https://maps.app.goo.gl/qrMXjm4ge2rzgE1j8')
on conflict (id) do nothing;

insert into public.lastlast_codes (code, label) values
  ('2026', 'General')
  -- one code per organiser, e.g.:
  -- , ('ALINE', 'Aline')
  -- , ('KEVIN', 'Kevin')
on conflict (code) do nothing;

-- Handy edits:
--   add a code:        insert into public.lastlast_codes (code, label) values ('JOSH', 'Josh');
--   turn a code off:   update public.lastlast_codes set active = false where code = '2026';
--   set the address:   update public.lastlast_settings set address = 'KG 123 St, Kigali', map_query = '-1.9441,30.0619';
--   new host code:     update public.lastlast_settings set host_code = 'HOST-' || upper(encode(gen_random_bytes(3), 'hex')) returning host_code;

-- ---------------------------------------------------------------------------
-- Guest: check a code, record the unlock, return the party details.
-- ---------------------------------------------------------------------------
create or replace function public.lastlast_unlock(c text, guest text, device text)
returns json language plpgsql security definer set search_path = public as $$
declare
  k  text := upper(regexp_replace(coalesce(c, ''), '\s', '', 'g'));
  g  text := left(btrim(regexp_replace(coalesce(guest, ''), '\s+', ' ', 'g')), 60);
  d  text := left(coalesce(device, ''), 64);
  lc public.lastlast_codes;
  s  public.lastlast_settings;
begin
  select * into s from public.lastlast_settings where id = 1;

  if s.host_code is not null and k = upper(s.host_code) then
    return json_build_object('ok', true, 'host', true);
  end if;

  select * into lc from public.lastlast_codes where code = k and active;
  if not found then
    if length(k) between 1 and 40 then insert into public.lastlast_misses (tried) values (k); end if;
    return json_build_object('ok', false);
  end if;

  if length(g) < 2 then return json_build_object('ok', false, 'reason', 'name'); end if;
  if length(d) < 8 then d := gen_random_uuid()::text; end if;

  insert into public.lastlast_unlocks (code, guest, device) values (k, g, d)
  on conflict on constraint lastlast_unlocks_code_device_key do update set guest = excluded.guest;

  return json_build_object(
    'ok', true, 'code', k, 'label', lc.label, 'guest', g,
    'venue', s.venue, 'address', s.address, 'maps_link', s.maps_link, 'map_query', s.map_query,
    'starts_at', s.starts_at, 'dress_code', s.dress_code
  );
end $$;

-- ---------------------------------------------------------------------------
-- Host: stats, only with the host code.
-- ---------------------------------------------------------------------------
create or replace function public.lastlast_stats(h text)
returns json language plpgsql security definer set search_path = public as $$
declare s public.lastlast_settings;
begin
  select * into s from public.lastlast_settings where id = 1;
  if s.host_code is null or upper(btrim(coalesce(h, ''))) <> upper(s.host_code) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return json_build_object(
    'total',   (select count(*) from public.lastlast_unlocks),
    'devices', (select count(distinct device) from public.lastlast_unlocks),
    'misses',  (select count(*) from public.lastlast_misses),
    'codes',   coalesce((select json_agg(x order by x.n desc, x.code) from (
                  select c.code, c.label, c.active, count(u.id) as n
                  from public.lastlast_codes c left join public.lastlast_unlocks u on u.code = c.code
                  group by c.code) x), '[]'::json),
    'recent',  coalesce((select json_agg(r) from (
                  select u.guest, u.code, c.label, u.created_at
                  from public.lastlast_unlocks u join public.lastlast_codes c on c.code = u.code
                  order by u.created_at desc limit 200) r), '[]'::json)
  );
end $$;

revoke all on function public.lastlast_unlock(text, text, text), public.lastlast_stats(text) from public;
grant execute on function public.lastlast_unlock(text, text, text), public.lastlast_stats(text) to anon, authenticated;

-- Your host code:
select host_code as "your host code (type it in the page)" from public.lastlast_settings where id = 1;
