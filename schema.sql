-- =====================================================================
-- CRM: schemat bazy danych (Supabase / PostgreSQL)
-- Wersja z dostępem przez link: jedno wspólne konto techniczne, którego kod
-- jest zaszyty w linku przekazywanym 2-3 osobom. Brak indywidualnych kont.
--
-- Wklej całość w Supabase -> SQL Editor -> New query -> Run.
-- Skrypt można uruchomić ponownie bez szkody (jest idempotentny).
--
-- WAŻNE: po wykonaniu skryptu WYŁĄCZ w Supabase publiczną rejestrację
-- (Authentication -> Sign In / Providers: "Allow new users to sign up" = OFF
-- oraz "Allow anonymous sign-ins" = OFF). Inaczej ktokolwiek mógłby założyć
-- konto i zobaczyć dane. Szczegóły w README.md.
-- =====================================================================

-- ---------- Firmy ---------------------------------------------------
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  nip         text not null default '',
  phone       text not null default '',
  email       text not null default '',
  website     text not null default '',
  address     text not null default '',
  city        text not null default '',
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Kontakty (osoby) ----------------------------------------
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete set null,
  first_name  text not null default '',
  last_name   text not null default '',
  position    text not null default '',
  email       text not null default '',
  phone       text not null default '',
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (length(trim(first_name || last_name)) > 0)
);

-- ---------- Zapytania (główny obiekt CRM) ---------------------------
-- status: action = wymaga działania, followup = do przypomnienia,
--         waiting = czekamy na odpowiedź drugiej strony
-- cc: kod kraju (np. SE, FR)
-- author: imię osoby, która dodała wpis (podawane przy pierwszym wejściu do aplikacji)
create table if not exists public.inquiries (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique check (length(trim(number)) > 0),
  client      text not null default '',
  country     text not null default '',
  cc          text not null default '',
  description text not null default '',
  next_step   text not null default '',
  due_date    date,
  received_at date,          -- data zapytania (puste = w filtrach liczy się data dodania)
  archived_at timestamptz,   -- kiedy przeniesiono do archiwum
  status      text not null default 'action' check (status in ('action', 'followup', 'waiting')),
  done        boolean not null default false,   -- true = zapytanie jest w archiwum
  company_id  uuid references public.companies(id) on delete set null,
  author      text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- dla baz utworzonych wcześniejszą wersją skryptu (bez terminu)
alter table public.inquiries add column if not exists due_date date;
alter table public.inquiries add column if not exists received_at date;
alter table public.inquiries add column if not exists archived_at timestamptz;

-- ---------- Historia kontaktów / notatki ----------------------------
create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  inquiry_id uuid references public.inquiries(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  kind       text not null default 'note' check (kind in ('note', 'call', 'email', 'meeting')),
  body       text not null check (length(trim(body)) > 0),
  author     text not null default '',
  created_at timestamptz not null default now(),
  check (inquiry_id is not null or company_id is not null or contact_id is not null)
);

create index if not exists contacts_company_idx  on public.contacts (company_id);
create index if not exists inquiries_status_idx  on public.inquiries (done, status);
create index if not exists notes_inquiry_idx     on public.notes (inquiry_id, created_at desc);
create index if not exists notes_company_idx     on public.notes (company_id, created_at desc);
create index if not exists notes_contact_idx     on public.notes (contact_id, created_at desc);

-- updated_at ustawiane automatycznie
create or replace function public.touch_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists companies_touch on public.companies;
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_row();

drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_row();

drop trigger if exists inquiries_touch on public.inquiries;
create trigger inquiries_touch before update on public.inquiries
  for each row execute function public.touch_row();

-- ---------- Bezpieczeństwo wierszy (RLS) ----------------------------
-- Dane widzi i zmienia wyłącznie wspólne konto dostępowe (to z linku).
-- Rola "anon" (każdy, kto zna adres strony i publiczny klucz) nie ma dostępu do niczego.
-- Drugie zabezpieczenie: nawet inne ZALOGOWANE konto (np. gdyby ktoś przez pomyłkę
-- włączył rejestrację) nie zobaczy danych, bo reguły sprawdzają adres e-mail konta.
-- Adres poniżej musi być taki sam jak ACCESS_EMAIL w config.js.
create or replace function public.is_crm_user()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = '__EMAIL_DOSTEPOWY__';
$$;

alter table public.companies enable row level security;
alter table public.contacts  enable row level security;
alter table public.inquiries enable row level security;
alter table public.notes     enable row level security;

revoke all on public.companies, public.contacts, public.inquiries, public.notes from anon;

drop policy if exists companies_all on public.companies;
create policy companies_all on public.companies for all to authenticated
  using (public.is_crm_user()) with check (public.is_crm_user());

drop policy if exists contacts_all on public.contacts;
create policy contacts_all on public.contacts for all to authenticated
  using (public.is_crm_user()) with check (public.is_crm_user());

-- Zapytań nie da się usunąć (unikalne numery nie mogą tworzyć dziur w historii): tylko odczyt, dodanie i zmiana.
-- Zamiast usuwania zapytanie przenosi się do archiwum (ten sam blok jest w migracja_bez_usuwania.sql).
drop policy if exists inquiries_all    on public.inquiries;
drop policy if exists inquiries_select on public.inquiries;
drop policy if exists inquiries_insert on public.inquiries;
drop policy if exists inquiries_update on public.inquiries;
create policy inquiries_select on public.inquiries for select to authenticated
  using (public.is_crm_user());
create policy inquiries_insert on public.inquiries for insert to authenticated
  with check (public.is_crm_user());
create policy inquiries_update on public.inquiries for update to authenticated
  using (public.is_crm_user()) with check (public.is_crm_user());
revoke delete on public.inquiries from authenticated;

drop policy if exists notes_all on public.notes;
create policy notes_all on public.notes for all to authenticated
  using (public.is_crm_user()) with check (public.is_crm_user());

-- =====================================================================
-- Ochrona danych: historia zmian, ustawienia aplikacji, ping
-- (dla starszych baz: ten sam blok jest w migracja_ochrona.sql)
-- =====================================================================

-- ---------- Autor ostatniej zmiany -----------------------------------
alter table public.inquiries add column if not exists updated_by text not null default '';
alter table public.companies add column if not exists updated_by text not null default '';
alter table public.contacts  add column if not exists updated_by text not null default '';

-- ---------- Historia zmian ------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   uuid not null,
  action      text not null check (action in ('insert', 'update', 'delete')),
  changed_by  text not null default '',
  changed_at  timestamptz not null default now(),
  changes     jsonb not null default '{}'::jsonb   -- update: {pole: [stara, nowa]}; delete: cały usunięty wiersz
);
create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id, changed_at desc);

create or replace function public.log_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  o jsonb;
  n jsonb;
  k text;
  diff jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
    insert into public.audit_log (table_name, record_id, action, changed_by)
    values (tg_table_name, new.id, 'insert', coalesce(nullif(n ->> 'updated_by', ''), n ->> 'author', ''));
    return new;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old);
    n := to_jsonb(new);
    for k in select jsonb_object_keys(n) loop
      if k not in ('updated_at', 'updated_by', 'created_at') and (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k, jsonb_build_array(o -> k, n -> k));
      end if;
    end loop;
    if diff <> '{}'::jsonb then
      insert into public.audit_log (table_name, record_id, action, changed_by, changes)
      values (tg_table_name, new.id, 'update', coalesce(n ->> 'updated_by', ''), diff);
    end if;
    return new;
  else
    insert into public.audit_log (table_name, record_id, action, changed_by, changes)
    values (tg_table_name, old.id, 'delete', coalesce(to_jsonb(old) ->> 'updated_by', ''), to_jsonb(old));
    return old;
  end if;
end $$;

drop trigger if exists inquiries_audit on public.inquiries;
create trigger inquiries_audit after insert or update or delete on public.inquiries
  for each row execute function public.log_changes();
drop trigger if exists companies_audit on public.companies;
create trigger companies_audit after insert or update or delete on public.companies
  for each row execute function public.log_changes();
drop trigger if exists contacts_audit on public.contacts;
create trigger contacts_audit after insert or update or delete on public.contacts
  for each row execute function public.log_changes();

-- ---------- Wspólne ustawienia aplikacji (np. data ostatniej kopii) ----
create table if not exists public.app_state (
  key         text primary key,
  value       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);

-- ---------- Dostęp (RLS): tak samo jak reszta danych -------------------
alter table public.audit_log enable row level security;
alter table public.app_state enable row level security;
revoke all on public.audit_log, public.app_state from anon;

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_crm_user());

drop policy if exists app_state_all on public.app_state;
create policy app_state_all on public.app_state for all to authenticated
  using (public.is_crm_user()) with check (public.is_crm_user());

-- ---------- ping(): nie zwraca żadnych danych, tylko aktualny czas ------
-- Wywołanie (np. co kilka minut z darmowego monitoringu):
--   GET https://TWOJ-PROJEKT.supabase.co/rest/v1/rpc/ping?apikey=TWOJ_KLUCZ_PUBLISHABLE
create or replace function public.ping()
returns timestamptz language sql stable as $$ select now(); $$;
grant execute on function public.ping() to anon, authenticated;
