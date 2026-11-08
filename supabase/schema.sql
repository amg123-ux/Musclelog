-- MuscleLog: Supabase schema
-- Run this once in Supabase SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('admin','user')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role, is_active)
  values (new.id, new.email, 'user', true)
  on conflict (id) do update set email = excluded.email;
  insert into public.user_data (user_id, data)
  values (new.id, '{}'::jsonb)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_data enable row level security;

create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $admin$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin' and is_active = true
  );
$admin$;

drop policy if exists "Read own profile or admin" on public.profiles;
create policy "Read own profile or admin" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or (select public.is_active_admin()));

drop policy if exists "Read own app data when active" on public.user_data;
create policy "Read own app data when active" on public.user_data
for select to authenticated
using (
  user_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active = true)
);

drop policy if exists "Insert own app data when active" on public.user_data;
create policy "Insert own app data when active" on public.user_data
for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active = true)
);

drop policy if exists "Update own app data when active" on public.user_data;
create policy "Update own app data when active" on public.user_data
for update to authenticated
using (
  user_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active = true)
)
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_active = true)
);

-- After creating your first account in Supabase Auth, promote it to administrator:
-- update public.profiles set role = 'admin' where email = 'YOUR_EMAIL';
