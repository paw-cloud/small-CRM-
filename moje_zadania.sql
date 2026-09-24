-- =====================================================================
-- Migracja: PRYWATNE ZADANIA właściciela (przycisk "Moje zadania" w CRM)
-- Dla bazy, która już działa. Uruchom w Supabase -> SQL Editor -> New query -> Run.
-- Bezpieczne przy ponownym uruchomieniu; niczego nie usuwa i nie zmienia w zapytaniach, firmach i kontaktach.
--
-- Zadania trafiają do OSOBNEJ tabeli my_tasks. Widzi ją i zmienia tylko konto o adresie z funkcji
-- is_owner_user() poniżej (osobny użytkownik z własnym kodem), a NIE wspólne konto z linku.
-- Dzięki temu nikt inny nie zobaczy zadań, nawet wysyłając polecenia do bazy z pominięciem strony.
-- Zadania nie trafiają do historii zmian, eksportu CSV ani do kopii zapasowej JSON.
--
-- PRZED użyciem trzeba utworzyć tego użytkownika: Supabase -> Authentication -> Users -> Add user
--   -> Create new user; e-mail: __EMAIL_PRYWATNY__ (może być nieistniejący), hasło = Twój prywatny kod,
--   zaznacz "Auto Confirm User" -> Create user. Ten adres musi być taki sam jak PRIVATE_EMAIL w config.js.
--
-- Wycofanie funkcji: ustaw PRIVATE_EMAIL: '' w config.js (przycisk znika). Tabelę można też usunąć:
--   drop table public.my_tasks;   drop function public.is_owner_user();
-- =====================================================================

create table if not exists public.my_tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 500),
  due_date    date not null,
  done        boolean not null default false,
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists my_tasks_open_idx on public.my_tasks (done, due_date);

drop trigger if exists my_tasks_touch on public.my_tasks;
create trigger my_tasks_touch before update on public.my_tasks
  for each row execute function public.touch_row();

-- Adres konta prywatnego (ten sam co PRIVATE_EMAIL w config.js)
create or replace function public.is_owner_user()
returns boolean language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') = '__EMAIL_PRYWATNY__';
$$;

alter table public.my_tasks enable row level security;
revoke all on public.my_tasks from anon;

drop policy if exists my_tasks_owner on public.my_tasks;
create policy my_tasks_owner on public.my_tasks for all to authenticated
  using (public.is_owner_user()) with check (public.is_owner_user());

-- ---------------------------------------------------------------------
-- Kontrola (uruchom po migracji, wynik powinien być taki, jak w komentarzu):
--
--   select policyname, cmd, roles from pg_policies
--   where schemaname = 'public' and tablename = 'my_tasks';
--     -> jeden wiersz: my_tasks_owner, ALL
--
--   select has_table_privilege('anon', 'public.my_tasks', 'SELECT');
--     -> false
-- ---------------------------------------------------------------------
