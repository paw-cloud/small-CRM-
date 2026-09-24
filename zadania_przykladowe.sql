-- ---------------------------------------------------------------------
-- Przykładowe PRYWATNE zadania (zmyślone), do obejrzenia okienka "Moje zadania" z wypełnioną listą.
-- Panel Supabase (SQL Editor) działa jako administrator, więc wstawi wiersze mimo reguł RLS.
-- Zadania widać po odblokowaniu kodem prywatnym (adres z dopiskiem #/moje).
-- Usunięcie przykładowych zadań przed prawdziwą pracą:  delete from public.my_tasks;
-- ---------------------------------------------------------------------
insert into public.my_tasks (title, due_date, done, done_at) values
  ('Zadzwonić do księgowej w sprawie rozliczenia', current_date, false, null),
  ('Zamówić próbki tkanin do nowej kolekcji', current_date - 2, false, null),
  ('Przygotować ofertę dla klienta z Norwegii', current_date + 1, false, null),
  ('Umówić przegląd samochodu dostawczego', current_date + 3, false, null),
  ('Odnowić ubezpieczenie magazynu', current_date + 7, false, null),
  ('Wysłać fakturę za zamówienie sezonowe', current_date - 1, true, now() - interval '1 day');