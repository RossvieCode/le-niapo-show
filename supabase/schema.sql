-- Le Niapo Show – reservations, tickets and team roles
-- Run in Supabase → SQL Editor → New query → paste everything → Run.
-- Safe to re-run: it adds what is missing and recreates policies/functions, never deletes data.

-- ---------------------------------------------------------------------------
-- Team members and their role:
--   admin  – everything: client details, confirm payments, send tickets
--   door   – the door app (scan.html): scan tickets, record gate sales
--   viewer – collaborators: finance figures only, no client names, read-only
--   insert into public.staff (email, name, role) values ('prenom@exemple.com', 'Prénom', 'door');
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  email text primary key,
  name  text,
  added_at timestamptz not null default now()
);
alter table public.staff add column if not exists role text not null default 'admin';
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('admin', 'door', 'viewer'));
alter table public.staff enable row level security;

create or replace function public.my_role()
returns text
language sql stable security definer set search_path = public
as $$
  select role from public.staff where lower(email) = lower(auth.jwt() ->> 'email') limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(public.my_role() = 'admin', false);
$$;

-- any team member (kept for older dashboard versions)
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.my_role() is not null;
$$;

drop policy if exists "staff read staff" on public.staff;
create policy "staff read staff" on public.staff for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Reservations (one per booking; online or sold at the gate)
-- ---------------------------------------------------------------------------
create table if not exists public.reservations (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^LN-[A-Z0-9]{4,10}$'),
  name           text not null check (char_length(name) between 2 and 80),
  phone          text check (char_length(phone) between 8 and 24),
  participants   text check (char_length(participants) <= 200),
  qty            int  not null check (qty between 1 and 10),
  total          int  not null,
  ref            text check (char_length(ref) <= 32),
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  payment_method text check (payment_method in ('Mobile Money', 'Cash', 'Autre')),
  note           text check (char_length(note) <= 300),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     text,
  confirmed_at   timestamptz,
  confirmed_by   text,
  -- price per ticket: keep in sync with pricePerTicket in app.js
  constraint total_matches_price check (total = qty * 20000)
);

alter table public.reservations add column if not exists origin text not null default 'online';
alter table public.reservations add column if not exists ticket_key uuid not null default gen_random_uuid();
alter table public.reservations add column if not exists ticket_sent_at timestamptz;
alter table public.reservations add column if not exists sold_by text;
alter table public.reservations alter column phone drop not null;
alter table public.reservations drop constraint if exists reservations_origin_check;
alter table public.reservations add constraint reservations_origin_check check (origin in ('online', 'gate'));
-- online bookings always have a WhatsApp number; gate sales may not
alter table public.reservations drop constraint if exists phone_required_online;
alter table public.reservations add constraint phone_required_online check (origin = 'gate' or phone is not null);

create index if not exists reservations_status_created on public.reservations (status, created_at desc);
create unique index if not exists reservations_ticket_key on public.reservations (ticket_key);

-- Who/when is stamped by the database, never trusted from the browser.
-- Runs as the caller: requests from the website run as anon/authenticated and get
-- locked down; only the functions below (running as the owner) may insert a paid gate sale.
create or replace function public.reservations_stamp()
returns trigger
language plpgsql set search_path = public
as $$
declare
  trusted boolean := current_user not in ('anon', 'authenticated');
begin
  if tg_op = 'INSERT' then
    if not trusted then
      new.status := 'pending';
      new.origin := 'online';
      new.payment_method := null;
      new.note := null;
      new.confirmed_by := null;
      new.sold_by := null;
      new.updated_by := null;
      new.ticket_sent_at := null;
      new.ticket_key := gen_random_uuid();
    end if;
    new.confirmed_at := case when new.status = 'confirmed' then now() end;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- the booking itself can't be edited from the dashboard, only its status
  new.code := old.code; new.name := old.name; new.phone := old.phone;
  new.participants := old.participants; new.qty := old.qty; new.total := old.total;
  new.ref := old.ref; new.created_at := old.created_at;
  new.origin := old.origin; new.ticket_key := old.ticket_key; new.sold_by := old.sold_by;

  -- "tickets sent" is stamped once, with the server's clock
  if new.ticket_sent_at is not null then
    new.ticket_sent_at := coalesce(old.ticket_sent_at, now());
  end if;

  new.updated_at := now();
  new.updated_by := auth.jwt() ->> 'email';
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    new.confirmed_at := now();
    new.confirmed_by := auth.jwt() ->> 'email';
  elsif new.status <> 'confirmed' then
    new.confirmed_at := null;
    new.confirmed_by := null;
    if new.status = 'pending' then new.payment_method := null; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_stamp on public.reservations;
create trigger reservations_stamp before insert or update on public.reservations
  for each row execute function public.reservations_stamp();

-- ---------------------------------------------------------------------------
-- Tickets: one QR per person, created when a booking is first confirmed.
-- A ticket is valid only while its booking is confirmed (cancel = void,
-- re-confirm = valid again, same QR codes).
-- ---------------------------------------------------------------------------
create table if not exists public.tickets (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations (id),
  seq            int  not null check (seq between 1 and 10),
  token          uuid not null unique default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  checked_in_at  timestamptz,
  checked_in_by  text,
  unique (reservation_id, seq)
);
alter table public.tickets enable row level security;

create or replace function public.reservations_issue_tickets()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.tickets (reservation_id, seq)
  select new.id, g from generate_series(1, new.qty) g
  on conflict (reservation_id, seq) do nothing;
  return null;
end;
$$;

drop trigger if exists reservations_issue_tickets on public.reservations;
create trigger reservations_issue_tickets after insert or update of status on public.reservations
  for each row when (new.status = 'confirmed') execute function public.reservations_issue_tickets();

-- tickets for bookings confirmed before this existed
insert into public.tickets (reservation_id, seq)
select r.id, g from public.reservations r, generate_series(1, r.qty) g
where r.status = 'confirmed'
on conflict (reservation_id, seq) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
--   visitors (anon): may only ADD a reservation, cannot read or change any
--   admin:           read everything, change status / payment / note
--   door, viewer:    no direct access; only through the functions below
-- ---------------------------------------------------------------------------
alter table public.reservations enable row level security;

drop policy if exists "public can book" on public.reservations;
create policy "public can book" on public.reservations
  for insert to anon, authenticated
  with check (status = 'pending');

drop policy if exists "staff read" on public.reservations;
create policy "staff read" on public.reservations
  for select to authenticated using (public.is_admin());

drop policy if exists "staff update" on public.reservations;
create policy "staff update" on public.reservations
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.reservations from anon;
grant insert (code, name, phone, participants, qty, total, ref) on public.reservations to anon;
grant select, insert, update on public.reservations to authenticated;
-- no delete for anyone: cancelled reservations stay in the history

drop policy if exists "admin read tickets" on public.tickets;
create policy "admin read tickets" on public.tickets
  for select to authenticated using (public.is_admin());

revoke all on public.tickets from anon, authenticated;
grant select on public.tickets to authenticated;

-- ---------------------------------------------------------------------------
-- Ticket page (billet.html): anyone holding the secret link
-- ---------------------------------------------------------------------------
create or replace function public.get_booking(k uuid)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object(
    'code', r.code, 'name', r.name, 'qty', r.qty, 'status', r.status,
    'tickets', case when r.status = 'confirmed' then coalesce((
      select json_agg(json_build_object('seq', t.seq, 'token', t.token, 'used_at', t.checked_in_at) order by t.seq)
      from public.tickets t where t.reservation_id = r.id), '[]'::json) else '[]'::json end)
  from public.reservations r where r.ticket_key = k;
$$;

create or replace function public.get_ticket(t uuid)
returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object(
    'code', r.code, 'name', r.name, 'qty', r.qty, 'status', r.status,
    'tickets', case when r.status = 'confirmed'
      then json_build_array(json_build_object('seq', tk.seq, 'token', tk.token, 'used_at', tk.checked_in_at))
      else '[]'::json end)
  from public.tickets tk join public.reservations r on r.id = tk.reservation_id
  where tk.token = t;
$$;

-- ---------------------------------------------------------------------------
-- Door app (scan.html): door staff and admins
-- ---------------------------------------------------------------------------
create or replace function public.require_role(allowed text[])
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  r text := public.my_role();
begin
  if r is null or not (r = any (allowed)) then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
  return r;
end;
$$;

-- one scan = one entry; the "where checked_in_at is null" makes double entry impossible
create or replace function public.check_in(t uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  tk public.tickets;
  r  public.reservations;
  admitted int;
  done int;
begin
  perform public.require_role(array['admin', 'door']);

  select * into tk from public.tickets where token = t;
  if not found then return json_build_object('result', 'invalid'); end if;
  select * into r from public.reservations where id = tk.reservation_id;

  if r.status <> 'confirmed' then
    return json_build_object('result', 'not_paid', 'code', r.code, 'name', r.name, 'seq', tk.seq, 'qty', r.qty, 'status', r.status);
  end if;

  update public.tickets set checked_in_at = now(), checked_in_by = auth.jwt() ->> 'email'
  where id = tk.id and checked_in_at is null;
  get diagnostics admitted = row_count;
  select count(*) into done from public.tickets where reservation_id = r.id and checked_in_at is not null;

  if admitted = 0 then
    select * into tk from public.tickets where id = tk.id;
    return json_build_object('result', 'already', 'code', r.code, 'name', r.name, 'seq', tk.seq, 'qty', r.qty,
      'used_at', tk.checked_in_at, 'used_by', tk.checked_in_by, 'entered', done);
  end if;
  return json_build_object('result', 'ok', 'code', r.code, 'name', r.name, 'seq', tk.seq, 'qty', r.qty, 'entered', done);
end;
$$;

-- manual fallback: type the booking code (LN-XXXXXX or just XXXXXX)
create or replace function public.lookup_code(c text)
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  norm text := upper(regexp_replace(coalesce(c, ''), '[^A-Za-z0-9]', '', 'g'));
  r public.reservations;
begin
  perform public.require_role(array['admin', 'door']);
  if norm like 'LN%' then norm := substr(norm, 3); end if;
  select * into r from public.reservations where code = 'LN-' || norm;
  if not found then return null; end if;
  return json_build_object(
    'code', r.code, 'name', r.name, 'qty', r.qty, 'status', r.status,
    'tickets', coalesce((select json_agg(json_build_object('seq', t.seq, 'token', t.token, 'used_at', t.checked_in_at) order by t.seq)
      from public.tickets t where t.reservation_id = r.id), '[]'::json));
end;
$$;

-- a sale at the gate: paid, ticketed and admitted in one go
create or replace function public.gate_sale(n int, method text, buyer text default null, tel text default null)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  me  text := auth.jwt() ->> 'email';
  abc text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  c   text;
  rid uuid;
begin
  perform public.require_role(array['admin', 'door']);
  if n is null or n < 1 or n > 10 then raise exception 'Entre 1 et 10 billets par vente'; end if;
  if method is null or method not in ('Cash', 'Mobile Money') then raise exception 'Moyen de paiement invalide'; end if;

  loop
    select 'LN-' || string_agg(substr(abc, 1 + floor(random() * 32)::int, 1), '') into c from generate_series(1, 6);
    exit when not exists (select 1 from public.reservations where code = c);
  end loop;

  insert into public.reservations (code, name, phone, qty, total, origin, status, payment_method, confirmed_by, sold_by, updated_by)
  values (c, coalesce(nullif(trim(buyer), ''), 'Vente à la porte'), nullif(trim(tel), ''), n, n * 20000,
          'gate', 'confirmed', method, me, me, me)
  returning id into rid;

  update public.tickets set checked_in_at = now(), checked_in_by = me where reservation_id = rid;

  return json_build_object('code', c, 'qty', n, 'total', n * 20000, 'method', method);
end;
$$;

-- door phone header: entries so far + the cash this person is holding
create or replace function public.door_summary()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me text := auth.jwt() ->> 'email';
begin
  perform public.require_role(array['admin', 'door']);
  return json_build_object(
    'entries', (select count(*) from public.tickets t join public.reservations r on r.id = t.reservation_id
                where r.status = 'confirmed' and t.checked_in_at is not null),
    'sold', (select coalesce(sum(qty), 0) from public.reservations where status = 'confirmed'),
    'my_tickets', (select coalesce(sum(qty), 0) from public.reservations where status = 'confirmed' and origin = 'gate' and sold_by = me),
    'my_cash', (select coalesce(sum(total), 0) from public.reservations where status = 'confirmed' and origin = 'gate' and sold_by = me and payment_method = 'Cash'),
    'my_momo', (select coalesce(sum(total), 0) from public.reservations where status = 'confirmed' and origin = 'gate' and sold_by = me and payment_method = 'Mobile Money'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Finance overview: admins and viewers. Totals only – no names, phones or codes.
-- ---------------------------------------------------------------------------
create or replace function public.finance_summary()
returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_role(array['admin', 'viewer']);
  return (
    with paid as (select * from public.reservations where status = 'confirmed')
    select json_build_object(
      'collected',       (select coalesce(sum(total), 0) from paid),
      'tickets_sold',    (select coalesce(sum(qty), 0) from paid),
      'bookings_paid',   (select count(*) from paid),
      'expected',        (select coalesce(sum(total), 0) from public.reservations where status = 'pending'),
      'pending_tickets', (select coalesce(sum(qty), 0) from public.reservations where status = 'pending'),
      'pending_count',   (select count(*) from public.reservations where status = 'pending'),
      'cancelled',       (select count(*) from public.reservations where status = 'cancelled'),
      'entries',         (select count(*) from public.tickets t join paid on paid.id = t.reservation_id where t.checked_in_at is not null),
      'by_method', (select coalesce(json_object_agg(m, amt), '{}'::json) from (
          select coalesce(payment_method, 'Autre') m, sum(total) amt from paid group by 1) x),
      'by_origin', (select coalesce(json_object_agg(origin, json_build_object('tickets', tix, 'amount', amt)), '{}'::json) from (
          select origin, sum(qty) tix, sum(total) amt from paid group by 1) x),
      'by_day', (select coalesce(json_agg(json_build_object('day', d, 'tickets', tix, 'amount', amt) order by d), '[]'::json) from (
          select (confirmed_at at time zone 'Africa/Kigali')::date d, sum(qty) tix, sum(total) amt
          from paid where confirmed_at > now() - interval '30 days' group by 1) x),
      'by_ref', (select coalesce(json_agg(json_build_object('ref', ref, 'bookings', n, 'tickets', tix, 'amount', amt) order by amt desc, tix desc), '[]'::json) from (
          select coalesce(nullif(ref, ''), '—') ref, count(*) n, sum(qty) tix, sum(total) amt
          from paid where origin = 'online' group by 1) x),
      'at', now())
  );
end;
$$;

-- functions that only make sense for signed-in team members
revoke execute on function public.check_in(uuid), public.lookup_code(text), public.gate_sale(int, text, text, text),
  public.door_summary(), public.finance_summary(), public.require_role(text[]) from anon, public;
grant execute on function public.check_in(uuid), public.lookup_code(text), public.gate_sale(int, text, text, text),
  public.door_summary(), public.finance_summary(), public.require_role(text[]) to authenticated;

-- Live updates in the dashboard
do $$
begin
  alter publication supabase_realtime add table public.reservations;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.tickets;
exception when duplicate_object then null;
end $$;
