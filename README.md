# CRM zapytań ofertowych (szablon)

Prosty, darmowy CRM do obsługi zapytań ofertowych w małej firmie (2–3 osoby). To **statyczna aplikacja bez budowania**
(zwykły HTML, CSS i JavaScript) z bazą i logowaniem w **Supabase (plan Free)** i hostingiem np. w **Cloudflare**.
Nie ma serwera aplikacji, kont użytkowników ani płatnych usług.

> **Status: wersja do testów i przeglądu technicznego.** Wszystkie dane w repozytorium i na zrzutach ekranu są zmyślone.
> Kod jest udostępniony w stanie „tak jak jest”, bez gwarancji. Przed przetwarzaniem prawdziwych danych osobowych
> zapoznaj się z sekcją [Ograniczenia i RODO](#ograniczenia-i-rodo).

![Pełny widok: lista zapytań z paskiem „Dzisiaj” i otwarte okienko prywatnych zadań „Moje zadania”](zrzuty/00-pelny-widok.png)

*Pełny widok (zmyślone dane): lista zapytań, przyciski „Co nowego” i „Moje zadania” oraz otwarte okienko z prywatnymi zadaniami.*

## Co potrafi

- **Zapytania** z numerem, datą, klientem, krajem, opisem, następnym krokiem, terminem i grupą
  (wymaga działania / do przypomnienia / czekamy) oraz **archiwum**. Zapytań się nie usuwa, tylko archiwizuje
  (numery są unikalne i nie mogą tworzyć dziur w historii; blokada jest także w bazie).
- **Pasek „Dzisiaj”**: liczniki *po terminie / na dziś / bez ruchu 14+ dni*, odhaczanie zadań z terminem („✓ Zrobione” i „Cofnij”).
- **Co nowego**: okienko z podglądem zmian (dopisane fragmenty, nowe notatki, nowe zapytania) od ostatniej wizyty.
- **Firmy, kontakty, notatki** (rozmowa, e-mail, spotkanie), **historia zmian** (trigger w bazie) i ostrzeżenie o równoczesnej edycji.
- **Plan tygodnia w PDF** zgodny z ekranem, przypomnienia w Kalendarzu Google (gotowy link, bez integracji i bez kont).
- **Kopia zapasowa JSON** z przypomnieniem, eksport do CSV, odświeżanie na żywo, praca na telefonie (także jako ikona), notatka głosowa.
- **Prywatne zadania właściciela** *(wersja próbna, w tej paczce włączone)*: własny kalendarz i przypomnienia w osobnej, chronionej tabeli,
  widoczne tylko po wpisaniu drugiego kodu. Szczegóły niżej.

**Pełna wersja do przeglądu.** Paczka ma wszystkie funkcje włączone, a zrzuty ekranu pokazują je tak, jak widzi je właściciel
(z przyciskiem „Moje zadania” w pasku). Po uruchomieniu pliku z danymi przykładowymi dostajesz wypełnione zakładki, „Co nowego”
oraz prywatne zadania, wszystko na zmyślonych danych.

Zrzuty ekranu (zmyślone dane) są w folderze [`zrzuty`](zrzuty), a opis krok po kroku w [`START-TUTAJ.html`](START-TUTAJ.html)
i [`INSTRUKCJA.txt`](INSTRUKCJA.txt).

| Lista zapytań | Co nowego | Moje zadania |
|---|---|---|
| ![Lista](zrzuty/01-lista-zapytan.png) | ![Co nowego](zrzuty/11-co-nowego.png) | ![Moje zadania](zrzuty/12-moje-zadania.png) |

## Architektura

```
przeglądarka (index.html + app.js, bez frameworka i bez budowania)
      |  HTTPS, klucz publishable + sesja użytkownika
      v
Supabase: Auth (e-mail + hasło) + Postgres z RLS + PostgREST     hosting plików statycznych: Cloudflare
```

- `strona/` – pliki aplikacji do wgrania na hosting: `index.html`, `app.js` (jedno IIFE, własny helper `h()` do DOM,
  tekst zawsze jako węzeł tekstowy, więc bez XSS), `styles.css`, `config.js`, manifest, `_headers` (CSP i inne nagłówki).
- `supabase/schema.sql` – tabele, funkcje, wyzwalacze i reguły RLS. `supabase/dane_przykladowe.sql` – zmyślone dane.
  `supabase/moje_zadania.sql` – opcjonalna tabela prywatnych zadań.
- `przygotuj.ps1` (`URUCHOM.bat`) – wypełnia szablony (nazwa firmy, adres bazy, klucz, ikony) i generuje gotowe skrypty SQL.
  `sprawdz.ps1` (`SPRAWDZ.bat`) – kontrola z zewnątrz, czy dane są zabezpieczone.
- Biblioteka `supabase-js` jest przypięta do wersji z kontrolą integralności (SRI), a `pdfmake` ładuje się dopiero przy generowaniu PDF.

## Model bezpieczeństwa

Klucz **publishable** jest z założenia publiczny i jest w kodzie strony. Dane chronią reguły bazy, a nie ukrywanie klucza:

- **Bez logowania nic nie da się odczytać ani zmienić.** Rola `anon` nie ma uprawnień do tabel (`revoke`), a `sprawdz.ps1` to weryfikuje.
- **Wspólne konto dostępowe.** Zespół wchodzi jednym linkiem `…/#k=KOD` (kod jest po znaku `#`, więc nie trafia do serwera ani w nagłówek Referer);
  kod to hasło jednego użytkownika Supabase. Reguły RLS dodatkowo sprawdzają **e-mail konta** (`auth.jwt() ->> 'email'`), więc inne konto,
  nawet zalogowane, nie zobaczy danych. **Rejestracja w Supabase musi być wyłączona** (krok obowiązkowy w instrukcji i test w `sprawdz.ps1`).
- **Zapytań nie da się usunąć** kontem z linku (polityki tylko na SELECT/INSERT/UPDATE oraz `revoke delete`).
  Firmy, kontakty i notatki można usuwać, a **historia zmian** (`audit_log`, trigger) zachowuje ich treść.
- **Prywatne zadania właściciela:** osobna tabela `my_tasks`, do której RLS przepuszcza tylko drugie konto
  (adres z `PRIVATE_EMAIL`, własny kod). Aplikacja używa **drugiego klienta bazy z osobną sesją**; wspólne konto z linku nie ma do tabeli dostępu,
  także przez API. Zadania nie trafiają do historii zmian, eksportu ani kopii zapasowej.
- **Strona:** CSP w nagłówkach, przypięte biblioteki z SRI, brak kluczy tajnych (`sprawdz.ps1` szuka `service_role` i `sb_secret_`).

## Ograniczenia i RODO

To narzędzie dla małego zespołu, a nie system spełniający wszystkie wymagania organizacyjne:

- **Brak indywidualnych kont.** Wspólny link nie daje rozliczalności, a imię w historii zmian wpisuje przeglądarka. Osobne konta per osoba
  są naturalnym kolejnym krokiem (Supabase Auth i RLS po e-mailu to umożliwiają).
- **Brak 2FA, brak automatycznych kopii zapasowych** na darmowym planie (jest ręczna kopia JSON z przypomnieniem) i brak logowania odczytów.
- **Notatka głosowa** korzysta z rozpoznawania mowy w przeglądarce (w Chrome dźwięk jest wysyłany do serwerów Google). Można ją pominąć.
- **Prawo do usunięcia danych** wymaga ręcznej operacji administratora (SQL Editor), także w historii zmian.
- **RODO to głównie obowiązki organizacyjne:** podstawa prawna i klauzula informacyjna, rejestr czynności, umowy powierzenia
  z dostawcami (Supabase, Cloudflare), region danych w UE, zasady przechowywania i procedura naruszeń. Zajmij się nimi przed użyciem z prawdziwymi danymi.

## Szybki start

1. Rozpakuj repozytorium na komputerze z Windows i otwórz `START-TUTAJ.html` (albo `INSTRUKCJA.txt`).
2. Załóż darmowy projekt w Supabase, kliknij `URUCHOM.bat` i odpowiedz na pytania (nazwa firmy, adres e-mail wspólnego konta, adres projektu,
   klucz publishable, adres konta prywatnego: Enter przyjmie `prywatne@example.com`, myślnik wyłącza prywatne zadania).
3. W Supabase (SQL Editor) wklej `1_schema_do_wklejenia.sql` (tabele, reguły dostępu i tabela prywatnych zadań), a dla pełnego pokazu także
   `2_dane_przykladowe_OPCJONALNIE.sql` (zmyślone firmy, zapytania, notatki i prywatne zadania).
4. Wyłącz rejestrację, utwórz **dwa konta** (wspólne konto dostępowe i konto prywatne z własnym kodem), wgraj folder `do-publikacji` na hosting
   i uruchom `SPRAWDZ.bat`.
5. Wejdź w link z kodem, a prywatne zadania odblokuj adresem z dopiskiem `#/moje`.

Skrypty `.ps1` zapisują wynik do folderu `GOTOWE`, który zawiera adres i klucz projektu i **nie jest śledzony przez git** (`.gitignore`).

## Licencja

Nie wybrano jeszcze licencji, więc obowiązuje domyślna zasada „wszelkie prawa zastrzeżone”. Autor może dodać plik `LICENSE`.
