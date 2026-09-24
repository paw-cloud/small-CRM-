-- =====================================================================
-- DANE PRZYKŁADOWE (zmyślone). Służą tylko do obejrzenia, jak działa CRM.
-- Uruchom w Supabase -> SQL Editor po skrypcie 1_schema_do_wklejenia.sql.
-- PRZED rozpoczęciem prawdziwej pracy usuń je poleceniem z końca tego pliku.
--
-- W środku: 5 firm, 6 osób kontaktowych, 8 zapytań (z terminami, w trzech grupach i w archiwum)
-- oraz kilka notatek. Wszystko ma znacznik PRZYKŁAD (nazwy firm zaczynają się od "[PRZYKŁAD]"),
-- więc łatwo je odróżnić od prawdziwych danych i usunąć.
-- Skrypt można uruchomić ponownie: niczego nie dubluje.
-- =====================================================================

-- ---------- Firmy ----------
insert into public.companies (name, nip, phone, email, website, address, city, description)
select v.name, v.nip, v.phone, v.email, v.website, v.address, v.city, 'PRZYKŁAD'
from (values
  ('[PRZYKŁAD] Firma Testowa Sp. z o.o.', '123-456-78-90', '+48 22 000 00 01', 'biuro@firma-testowa.example', 'firma-testowa.example', 'ul. Przykładowa 1, 00-001 Warszawa, Polska', 'Warszawa'),
  ('[PRZYKŁAD] Nordic Home AB',           'SE556000000101', '+46 8 000 00 02', 'kontakt@nordichome.example', 'nordichome.example', 'Storgatan 12, 111 22 Sztokholm, Szwecja', 'Sztokholm'),
  ('[PRZYKŁAD] Bureau Moderne SARL',      'FR00000000101', '+33 4 00 00 00 03', 'bonjour@bureaumoderne.example', 'bureaumoderne.example', '5 Rue de la République, 69001 Lyon, Francja', 'Lyon'),
  ('[PRZYKŁAD] Holz & Form GmbH',         'DE000000101', '+49 89 000004', 'info@holzform.example', 'holzform.example', 'Hauptstraße 8, 80331 Monachium, Niemcy', 'Monachium'),
  ('[PRZYKŁAD] Biuro Plus Sp. z o.o.',    '987-654-32-10', '+48 58 000 00 05', 'biuro@biuroplus.example', 'biuroplus.example', 'ul. Długa 4, 80-001 Gdańsk, Polska', 'Gdańsk')
) as v(name, nip, phone, email, website, address, city)
where not exists (select 1 from public.companies c where c.name = v.name);

-- ---------- Osoby kontaktowe ----------
insert into public.contacts (company_id, first_name, last_name, position, email, phone, description)
select c.id, v.first_name, v.last_name, v.position, v.email, v.phone, 'PRZYKŁAD'
from (values
  ('[PRZYKŁAD] Firma Testowa Sp. z o.o.', 'Anna',  'Przykładowa', 'Kierownik zakupów',    'anna@firma-testowa.example', ''),
  ('[PRZYKŁAD] Nordic Home AB',           'Anna',  'Lindqvist',   'Kierownik zakupów',    'anna@nordichome.example',    '+46 70 000 00 06'),
  ('[PRZYKŁAD] Nordic Home AB',           'Johan', 'Berg',        'Dyrektor operacyjny',  'johan@nordichome.example',   ''),
  ('[PRZYKŁAD] Bureau Moderne SARL',      'Marc',  'Dupont',      'Właściciel',           'marc@bureaumoderne.example', '+33 6 00 00 00 07'),
  ('[PRZYKŁAD] Holz & Form GmbH',         'Stefan','Bauer',       'Architekt wnętrz',     'stefan@holzform.example',    ''),
  ('[PRZYKŁAD] Biuro Plus Sp. z o.o.',    'Ewa',   'Nowak',       'Asystentka zarządu',   'ewa@biuroplus.example',      '+48 601 000 008')
) as v(company, first_name, last_name, position, email, phone)
join public.companies c on c.name = v.company
where not exists (select 1 from public.contacts x where x.description = 'PRZYKŁAD' and x.first_name = v.first_name and x.last_name = v.last_name);

-- ---------- Zapytania (terminy liczone od dzisiaj) ----------
insert into public.inquiries (number, client, country, cc, description, next_step, status, due_date, received_at, done, archived_at, author, company_id) values
  ('P-001', 'Anna Lindqvist / Nordic Home',     'Szwecja', 'SE', 'Wycena 20 krzeseł do biura',       'Wysłać wycenę do końca tygodnia.',        'action',   current_date - 2, current_date - 6,   false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Nordic Home AB')),
  ('P-002', 'Marc Dupont / Bureau Moderne',     'Francja', 'FR', 'Seria 100 szt. wieszaków',         'Zadzwonić i dopytać o termin dostawy.',   'action',   current_date,     current_date - 4,   false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Bureau Moderne SARL')),
  ('P-003', 'Stefan Bauer / Holz & Form',       'Niemcy',  'DE', 'Stoły konferencyjne, 12 szt.',     'Przygotować rysunki techniczne.',         'action',   current_date + 2, current_date - 3,   false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Holz & Form GmbH')),
  ('P-004', 'Ewa Nowak / Biuro Plus',           'Polska',  'PL', 'Meble do recepcji',                'Przypomnieć się, jeśli brak odpowiedzi.', 'followup', current_date + 4, current_date - 15,  false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Biuro Plus Sp. z o.o.')),
  ('P-005', 'Anna Przykładowa / Firma Testowa', 'Polska',  'PL', 'Prototyp zatwierdzony',            'Czekamy na decyzję o zamówieniu serii.',  'waiting',  null,             current_date - 20,  false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Firma Testowa Sp. z o.o.')),
  ('P-006', 'Anna Lindqvist / Nordic Home',     'Szwecja', 'SE', 'Stoliki kawowe, 15 szt.',          'Wycena wysłana, czekamy na odpowiedź.',   'waiting',  null,             current_date - 8,   false, null, 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Nordic Home AB')),
  ('P-007', 'Marc Dupont / Bureau Moderne',     'Francja', 'FR', 'Krzesła barowe, 24 szt.',          '',                                        'waiting',  null,             current_date - 105, true,  now() - interval '70 days', 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Bureau Moderne SARL')),
  ('P-008', 'Anna Lindqvist / Nordic Home',     'Szwecja', 'SE', 'Stoły do restauracji, 8 szt.',     '',                                        'waiting',  null,             current_date - 120, true,  now() - interval '85 days', 'PRZYKŁAD', (select id from public.companies where name = '[PRZYKŁAD] Nordic Home AB'))
on conflict (number) do nothing;

-- ---------- Notatki ----------
insert into public.notes (inquiry_id, company_id, contact_id, kind, body, author)
select i.id, i.company_id, null::uuid, v.kind, v.body, 'PRZYKŁAD'
from (values
  ('P-001', 'call',  'Rozmowa z klientką: potrzebuje 20 krzeseł do nowego biura, zależy jej na dostawie przed końcem miesiąca.'),
  ('P-001', 'email', 'Wysłano rysunki wstępne i zapytanie o wykończenie (tkanina czy skóra).'),
  ('P-006', 'meeting', 'Spotkanie w showroomie, klient obejrzał próbki blatów.'),
  ('P-002', 'note',  'Klient prosi o dostawę w dwóch partiach.')
) as v(number, kind, body)
join public.inquiries i on i.number = v.number
where not exists (select 1 from public.notes n where n.inquiry_id = i.id and n.author = 'PRZYKŁAD' and n.body = v.body);

-- =====================================================================
-- USUWANIE DANYCH PRZYKŁADOWYCH (uruchom, gdy chcesz zacząć pracę na prawdziwych danych):
--
--   delete from public.notes     where author = 'PRZYKŁAD';
--   delete from public.inquiries where author = 'PRZYKŁAD';
--   delete from public.contacts  where description = 'PRZYKŁAD';
--   delete from public.companies where description = 'PRZYKŁAD';
-- =====================================================================