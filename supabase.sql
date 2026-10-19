-- Gestion de flotte : base de données Supabase
-- À coller dans Supabase > SQL Editor > New query, puis cliquer sur "Run".

-- Tables (chaque fiche est stockée en JSON dans la colonne data)
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

-- Sécurité : seules les personnes connectées (comptes créés par vous) accèdent aux données
alter table public.vehicules enable row level security;
alter table public.historique enable row level security;
alter table public.documents enable row level security;

drop policy if exists "equipe" on public.vehicules;
drop policy if exists "equipe" on public.historique;
drop policy if exists "equipe" on public.documents;
create policy "equipe" on public.vehicules for all to authenticated using (true) with check (true);
create policy "equipe" on public.historique for all to authenticated using (true) with check (true);
create policy "equipe" on public.documents for all to authenticated using (true) with check (true);

-- Mise à jour partielle d'un véhicule (évite d'écraser une modification faite au même moment sur un autre appareil)
create or replace function public.merge_vehicule(p_id text, p_patch jsonb)
returns void language sql security invoker as $$
  update public.vehicules set data = data || p_patch, updated_at = now() where id = p_id;
$$;
grant execute on function public.merge_vehicule(text, jsonb) to authenticated;

-- Espace de stockage privé pour les documents (PV de CT, carte grise, etc.)
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do nothing;

drop policy if exists "equipe lit documents" on storage.objects;
drop policy if exists "equipe ajoute documents" on storage.objects;
drop policy if exists "equipe supprime documents" on storage.objects;
create policy "equipe lit documents" on storage.objects for select to authenticated using (bucket_id = 'documents');
create policy "equipe ajoute documents" on storage.objects for insert to authenticated with check (bucket_id = 'documents');
create policy "equipe supprime documents" on storage.objects for delete to authenticated using (bucket_id = 'documents');

-- Mise à jour en direct entre le PC et le téléphone
do $$
begin
  begin alter publication supabase_realtime add table public.vehicules; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.historique; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end;
end $$;
