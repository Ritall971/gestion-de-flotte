-- Gestion de flotte : base de données Supabase
-- À coller dans Supabase > SQL Editor > New query, puis cliquer sur "Run".
-- Le script peut être relancé sans risque : il met la base à jour sans effacer les données.

-- ============ Tables ============
create table if not exists public.vehicules (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.historique (
  id text primary key,
  date timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb
);
create index if not exists historique_date_idx on public.historique (date desc);
create table if not exists public.documents (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============ Rôles : admin ou user ============
create table if not exists public.profils (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  nom text,
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profils where user_id = auth.uid() and role = 'admin');
$$;
grant execute on function public.is_admin() to authenticated;

-- Chaque nouveau compte créé dans Authentication > Users devient automatiquement "user"
create or replace function public.creer_profil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profils (user_id, email) values (new.id, new.email) on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists creer_profil_apres_inscription on auth.users;
create trigger creer_profil_apres_inscription after insert on auth.users
  for each row execute function public.creer_profil();

-- Comptes déjà existants : un profil "user" pour chacun, et le plus ancien devient admin s'il n'y en a aucun
insert into public.profils (user_id, email)
  select id, email from auth.users on conflict (user_id) do nothing;
update public.profils set role = 'admin'
  where not exists (select 1 from public.profils where role = 'admin')
    and user_id = (select user_id from public.profils order by created_at, email limit 1);

-- Un admin ne peut pas se retirer lui-même le rôle admin (évite de se retrouver sans admin)
create or replace function public.proteger_role()
returns trigger language plpgsql as $$
begin
  if new.role <> old.role and old.user_id = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  return new;
end $$;
drop trigger if exists proteger_role on public.profils;
create trigger proteger_role before update on public.profils for each row execute function public.proteger_role();

-- ============ Droits ============
-- admin : tout. user : voir la flotte, l'historique et les documents, sortir et rendre un véhicule.
alter table public.vehicules enable row level security;
alter table public.historique enable row level security;
alter table public.documents enable row level security;
alter table public.profils enable row level security;

drop policy if exists "equipe" on public.vehicules;
drop policy if exists "equipe" on public.historique;
drop policy if exists "equipe" on public.documents;
drop policy if exists "lecture" on public.vehicules;
drop policy if exists "admin ecrit" on public.vehicules;
drop policy if exists "lecture" on public.historique;
drop policy if exists "ajout" on public.historique;
drop policy if exists "lecture" on public.documents;
drop policy if exists "admin ecrit" on public.documents;
drop policy if exists "lecture" on public.profils;
drop policy if exists "admin modifie" on public.profils;

create policy "lecture" on public.vehicules for select to authenticated using (true);
create policy "admin ecrit" on public.vehicules for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "lecture" on public.historique for select to authenticated using (true);
create policy "ajout" on public.historique for insert to authenticated with check (true);
create policy "lecture" on public.documents for select to authenticated using (true);
create policy "admin ecrit" on public.documents for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "lecture" on public.profils for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "admin modifie" on public.profils for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Mise à jour d'un véhicule. Un admin peut tout changer ; un user peut seulement sortir ou rendre un véhicule.
create or replace function public.merge_vehicule(p_id text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  statut_actuel text;
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  if not public.is_admin() then
    if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('statut', 'conducteur', 'depuis', 'motif', 'km')) then
      raise exception 'Seul un administrateur peut modifier la fiche d''un véhicule.';
    end if;
    select data->>'statut' into statut_actuel from public.vehicules where id = p_id;
    if coalesce(p_patch->>'statut', '') not in ('sortie', 'attente') or statut_actuel = 'maintenance' then
      raise exception 'Seul un administrateur peut gérer la maintenance.';
    end if;
  end if;
  update public.vehicules set data = data || p_patch, updated_at = now() where id = p_id;
end $$;
grant execute on function public.merge_vehicule(text, jsonb) to authenticated;

-- ============ Documents (PV de CT, carte grise, etc.) ============
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do nothing;

drop policy if exists "equipe lit documents" on storage.objects;
drop policy if exists "equipe ajoute documents" on storage.objects;
drop policy if exists "equipe supprime documents" on storage.objects;
drop policy if exists "admin ajoute documents" on storage.objects;
drop policy if exists "admin supprime documents" on storage.objects;
create policy "equipe lit documents" on storage.objects for select to authenticated using (bucket_id = 'documents');
create policy "admin ajoute documents" on storage.objects for insert to authenticated with check (bucket_id = 'documents' and public.is_admin());
create policy "admin supprime documents" on storage.objects for delete to authenticated using (bucket_id = 'documents' and public.is_admin());

-- ============ Mise à jour en direct entre le PC et le téléphone ============
do $$
begin
  begin alter publication supabase_realtime add table public.vehicules; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.historique; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end;
end $$;
