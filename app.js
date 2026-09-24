(function () {
  'use strict';

  const cfg = window.CRM_CONFIG || {};
  const appName = cfg.APP_NAME || 'CRM';
  const company = cfg.COMPANY_NAME || '';   // nazwa firmy (opcjonalna): pojawia się w tytułach, PDF i wydarzeniach
  const root = document.getElementById('app');

  const STATUS = { action: 'Wymaga działania', followup: 'Do przypomnienia', waiting: 'Czekamy na odpowiedź' };
  const NOTE_KINDS = { note: 'Notatka', call: 'Rozmowa', email: 'E-mail', meeting: 'Spotkanie' };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  let sb = null;
  let psb = null;              // drugi klient bazy: prywatne zadania właściciela (osobna sesja, osobny kod)
  let privateSession = null;
  let session = null;
  let lastUserId = null;
  let routeToken = 0;
  let accessError = '';
  let nameAsked = false;

  // ---------------------------------------------------------------- helpers

  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach((x) => add(el, x));
    else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }

  // Tworzy element DOM; tekst zawsze trafia jako węzeł tekstowy (bez ryzyka XSS).
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  // Komórka tabeli z etykietą (na wąskich ekranach wiersz zamienia się w kartę)
  function td(label, ...content) {
    return h('td', { 'data-label': label }, ...content);
  }

  function field(label, input) {
    return h('label', { class: 'field' }, h('span', null, label), input);
  }

  let toastTimer = null;
  // action = { label, fn }: komunikat z przyciskiem (np. „Cofnij”), widoczny dłużej
  function toast(msg, bad, action) {
    const t = document.getElementById('toast');
    if (action) {
      t.replaceChildren(msg + ' ', h('button', { type: 'button', class: 'toast-act', onclick: () => { clearTimeout(toastTimer); t.className = ''; action.fn(); } }, action.label));
    } else {
      t.textContent = msg;
    }
    t.className = 'show' + (bad ? ' bad' : '') + (action ? ' act' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, action ? 9000 : 3500);
  }

  function errMsg(ex) {
    const m = (ex && ex.message) || String(ex);
    if (/invalid login credentials/i.test(m)) return 'Nieprawidłowy kod dostępu.';
    if (/row-level security|permission denied/i.test(m)) return 'Brak uprawnień do tej operacji.';
    if (/duplicate key.*number|inquiries_number_key/i.test(m)) return 'Zapytanie o takim numerze już istnieje.';
    if (/column .*does not exist|could not find the .* column|relation .* does not exist/i.test(m)) {
      return 'Baza wymaga aktualizacji: uruchom w Supabase (SQL Editor) plik migracja_ochrona.sql, potem odśwież stronę.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(m)) {
      return 'Brak połączenia z serwerem. Jeśli to trwa: darmowy projekt Supabase mógł zostać uśpiony, wejdź w jego panel i kliknij „Restore”.';
    }
    return m;
  }

  // Każde zapytanie do bazy przechodzi przez q(). Zapisy (insert/update/delete) są oznaczone w sb.from(...),
  // więc q() pokazuje ich stan we wskaźniku: Zapisywanie… / Zapisano / Nie zapisano.
  async function q(promise) {
    const write = !!(promise && promise.__write);
    if (write) saveState('saving');
    try {
      const { data, error } = await promise;
      if (error) throw error;
      if (write) { suggestCache = null; saveState('saved'); }   // podpowiedzi przy wpisywaniu zbudujemy od nowa
      return data;
    } catch (e) {
      if (write) saveState('error');
      throw e;
    }
  }

  // Pobiera wszystkie wiersze tabeli (Supabase zwraca maks. 1000 na zapytanie).
  async function fetchAll(table, cols) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await q(sb.from(table).select(cols || '*')
        .order('created_at', { ascending: true }).order('id', { ascending: true })
        .range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- konflikty zapisu

  const FIELD_LABELS = {
    inquiries: { number: 'Numer', client: 'Klient', country: 'Kraj', cc: 'Kod kraju', description: 'Opis', next_step: 'Następny krok',
      due_date: 'Termin', received_at: 'Data zapytania', status: 'Grupa', done: 'Archiwum', archived_at: 'Data archiwizacji', company_id: 'Firma' },
    companies: { name: 'Nazwa', nip: 'NIP', phone: 'Telefon', email: 'E-mail', website: 'WWW', address: 'Adres', city: 'Miasto', description: 'Opis' },
    contacts: { first_name: 'Imię', last_name: 'Nazwisko', position: 'Stanowisko', company_id: 'Firma', email: 'E-mail', phone: 'Telefon', description: 'Opis' }
  };
  const fieldLabel = (table, k) => (FIELD_LABELS[table] && FIELD_LABELS[table][k]) || k;
  function fieldValue(table, k, v) {
    if (v == null || v === '') return '(puste)';
    if (table === 'inquiries' && k === 'status') return STATUS[v] || v;
    if (k === 'done') return v ? 'tak' : 'nie';
    if (k === 'due_date' || k === 'received_at') return fmtDayShort(String(v).slice(0, 10));
    if (k === 'archived_at') return fmtDate(v);
    if (k === 'company_id') return '(inna firma)';
    return String(v);
  }
  const sameValue = (a, b) => (a == null ? '' : String(a)) === (b == null ? '' : String(b));

  class ConflictError extends Error {
    constructor(table, current, mine, fields) {
      super('Ktoś inny (' + (current.updated_by || 'nieznana osoba') + ') zmienił ten rekord w międzyczasie (pole: '
        + fields.map((k) => fieldLabel(table, k)).join(', ') + '). Sprawdź aktualne dane i zapisz ponownie.');
      this.name = 'ConflictError';
      this.table = table;
      this.current = current;
      this.mine = mine;
      this.fields = fields;
    }
  }

  // Zmiana rekordu; wykrywa sytuację, gdy reguły dostępu po cichu zablokowały zapis. Zwraca wiersz (id, updated_at).
  // base = stan rekordu, który widzisz w aplikacji: jeśli ktoś inny zdążył go zmienić, zapis nie nadpisze jego pracy po cichu:
  //  - zmienił INNE pola: nasza zmiana zostaje zapisana na aktualnym stanie,
  //  - zmienił TO SAMO pole: rzucamy ConflictError (użytkownik wybiera, którą wersję zachować).
  async function patch(table, id, data, base) {
    const payload = Object.assign({}, data);
    if (table === 'inquiries' || table === 'companies' || table === 'contacts') payload.updated_by = getAuthor();
    const run = (lock) => {
      let qb = sb.from(table).update(payload).eq('id', id);
      if (lock) qb = qb.eq('updated_at', lock);
      return q(qb.select('id,updated_at'));
    };
    let rows = await run(base && base.updated_at);
    if (rows && rows.length) return rows[0];
    if (!base || !base.updated_at) throw new Error('Brak uprawnień do zmiany tego rekordu.');

    const current = await q(sb.from(table).select('*').eq('id', id).maybeSingle());
    if (!current) throw new Error('Ten rekord został w międzyczasie usunięty przez inną osobę.');
    const clash = Object.keys(data).filter((k) => !sameValue(current[k], base[k]) && !sameValue(current[k], data[k]));
    if (clash.length) throw new ConflictError(table, current, data, clash);
    rows = await run(current.updated_at);
    if (rows && rows.length) return rows[0];
    throw new Error('Nie udało się zapisać, bo rekord właśnie się zmienia. Spróbuj ponownie.');
  }

  // Okno wyboru przy konflikcie: 'theirs' (domyślnie, także po zamknięciu okna) albo 'mine'
  function conflictModal(err) {
    return new Promise((resolve) => {
      const dlg = document.getElementById('modal');
      let done = false;
      const finish = (c) => {
        if (done) return;
        done = true;
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(c);
      };
      // zamknięcie okna (Esc) = zostaje wersja innej osoby; zaległe zdarzenie po poprzednim oknie (okno wciąż otwarte) ignorujemy
      const onClose = () => { if (!dlg.open) finish('theirs'); };
      const pick = finish;
      const rows = err.fields.map((k) => h('tr', null,
        h('td', { class: 'muted' }, fieldLabel(err.table, k)),
        h('td', null, fieldValue(err.table, k, err.current[k])),
        h('td', null, fieldValue(err.table, k, err.mine[k]))));
      dlg.replaceChildren(
        h('h2', null, 'Ktoś inny zmienił te dane'),
        h('p', null, (err.current.updated_by || 'Inna osoba') + ' zapisał(a) zmianę o ' + fmtDate(err.current.updated_at)
          + ', zanim zapisałeś(aś) swoją. Wybierz, którą wersję zachować:'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Pole', 'Wersja innej osoby', 'Twoja wersja'].map((t) => h('th', null, t)))),
          h('tbody', null, rows))),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', onclick: () => pick('theirs') }, 'Zachowaj wersję innej osoby'),
          h('button', { type: 'button', class: 'primary', onclick: () => pick('mine') }, 'Zapisz moją wersję')));
      dlg.addEventListener('close', onClose);
      if (!dlg.open) dlg.showModal();   // okno formularza może być już otwarte: podmieniamy tylko jego treść
    });
  }

  // Zapis z obsługą konfliktu. Zwraca { row } po zapisie albo { theirs: aktualny rekord }, gdy wybrano wersję innej osoby.
  async function patchResolving(table, it, data) {
    let base = it;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return { row: await patch(table, it.id, data, base) };
      } catch (ex) {
        if (!(ex instanceof ConflictError)) throw ex;
        if ((await conflictModal(ex)) === 'theirs') {
          const el = document.getElementById('savestate');
          if (el && !pendingWrites) el.className = '';
          return { theirs: ex.current };
        }
        base = ex.current;   // zapisujemy własną wersję na aktualnym stanie
      }
    }
    throw new Error('Nie udało się zapisać: dane zmieniają się zbyt szybko. Spróbuj ponownie.');
  }

  // ---------------------------------------------------------------- wskaźnik zapisu

  let pendingWrites = 0;
  let dirtyEdit = false;
  let savedTimer = null;
  function showSaveState(kind, text) {
    const el = document.getElementById('savestate');
    if (!el) return;
    el.className = 'show ' + kind;
    el.textContent = text;
  }
  function saveState(kind) {
    if (kind === 'saving') {
      pendingWrites += 1;
      dirtyEdit = false;
      showSaveState('saving', 'Zapisywanie…');
    } else if (kind === 'saved') {
      pendingWrites = Math.max(0, pendingWrites - 1);
      if (!pendingWrites) {
        const now = new Date();
        showSaveState('ok', '✓ Zapisano ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => {
          const el = document.getElementById('savestate');
          if (el && !pendingWrites && !dirtyEdit) el.className = '';
        }, 3500);
      }
    } else if (kind === 'error') {
      pendingWrites = Math.max(0, pendingWrites - 1);
      showSaveState('err', '⚠ Nie zapisano. Sprawdź połączenie i spróbuj ponownie.');
    } else if (kind === 'dirty') {
      dirtyEdit = true;
      showSaveState('dirty', 'Zmiana zapisze się po kliknięciu poza polem');
    }
  }

  // ---------------------------------------------------------------- odświeżanie na żywo
  // Co kilkanaście sekund (i po powrocie do karty) sprawdzamy „odcisk” danych oglądanego widoku. Gdy ktoś inny coś zmienił,
  // widok się odświeża, ale nigdy w trakcie edycji: wtedy odświeżenie czeka, aż skończysz pisać.

  const POLL_MS = (cfg.POLL_SECONDS || 20) * 1000;
  let watcher = null;
  let pendingChange = false;

  const SIG_COLS = { inquiries: 'id,updated_at', companies: 'id,updated_at', contacts: 'id,updated_at', notes: 'id,created_at' };
  const sigOfRows = (rows) => (rows || []).map((r) => r.id + '@' + (r.updated_at || r.created_at || '')).sort().join('|');
  async function tableSig(table, col, val) {
    if (!col) return sigOfRows(await fetchAll(table, SIG_COLS[table]));
    return sigOfRows(await q(sb.from(table).select(SIG_COLS[table]).eq(col, val)));
  }

  // sigFn: aktualny odcisk danych w bazie; apply: odświeża widok; initial: odcisk danych, które widok już wczytał
  function watch(sigFn, apply, initial) {
    watcher = { sigFn, apply, last: initial, busy: false };
    pendingChange = false;
  }
  // po własnym zapisie zakładamy, że baza wygląda jak nasze dane (zmiany innych osób nadal zostaną wykryte)
  const watchExpect = (sig) => { if (watcher) watcher.last = sig; };
  const reloadView = async () => {
    toast('Widok odświeżony: dane zostały zmienione przez inną osobę.');
    await route();
  };

  function userIsEditing() {
    const dlg = document.getElementById('modal');
    if (dlg && dlg.open) return true;
    const a = document.activeElement;
    if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    return [...root.querySelectorAll('.note-form textarea')].some((t) => t.value.trim());   // nieodesłany szkic notatki
  }

  async function pollTick() {
    const w = watcher;
    if (!w || w.busy || !session || document.hidden) return;
    w.busy = true;
    try {
      const s = await w.sigFn();
      if (w !== watcher || s === w.last) return;
      if (userIsEditing()) { pendingChange = true; return; }   // odświeżymy, gdy skończysz edycję
      w.last = s;
      pendingChange = false;
      await w.apply();
    } catch (_e) {
      /* chwilowy brak sieci: kolejna próba w następnym cyklu */
    } finally {
      w.busy = false;
    }
  }

  // Dopasowuje wysokość pola tekstowego do jego zawartości
  function fitTextarea(t) {
    t.style.height = 'auto';
    t.style.height = t.scrollHeight + 2 + 'px';
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const fmtDate = (s) => (s ? new Date(s).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const personName = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ');
  const byNumber = (a, b) => a.number.localeCompare(b.number, 'pl', { numeric: true });

  // ---- terminy i Kalendarz Google
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const fmtDay = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const DUE_LABEL = { late: 'po terminie', today: 'dziś' };
  // pasek „Dzisiaj” na liście zapytań: po terminie / na dziś / bez terminu i bez ruchu od STALE_DAYS dni
  const STALE_DAYS = 14;
  const FOCUS_LABEL = { late: 'Po terminie', today: 'Na dziś', stale: 'Bez ruchu ' + STALE_DAYS + '+ dni' };

  // '' = brak terminu lub zapytanie zamknięte, 'today' = termin dziś, 'late' = termin minął
  function dueState(it) {
    if (!it.due_date || it.done) return '';
    const today = ymd(new Date());
    return it.due_date < today ? 'late' : it.due_date === today ? 'today' : '';
  }

  // Gotowe wydarzenie w Kalendarzu Google w dniu terminu o CAL_HOUR:00, 30 minut (czas lokalny kalendarza użytkownika;
  // wydarzenie całodniowe dostawało domyślne powiadomienie „dzień wcześniej”). Bez logowania Claude i bez żadnego kodu dostępu w treści.
  const CAL_HOUR = 8;
  function calendarUrl(it) {
    const day = it.due_date.replace(/-/g, '');
    const start = day + 'T' + pad2(CAL_HOUR) + '0000';
    const end = day + 'T' + pad2(CAL_HOUR) + '3000';
    const title = (company ? company + ' ' : '') + it.number + (it.client ? ' — ' + it.client : '') + ': ' + (it.next_step || 'następny krok');
    const details = [it.description, it.next_step ? 'Następny krok: ' + it.next_step : '',
      'CRM: ' + location.origin + location.pathname + '#/inquiries/' + it.id].filter(Boolean).join('\n');
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title)
      + '&dates=' + start + '/' + end + '&details=' + encodeURIComponent(details);
  }
  const calendarLink = (it, label, cls) => h('a', { class: cls, href: calendarUrl(it), target: '_blank', rel: 'noopener noreferrer' }, label);

  // ---- Plan tygodnia w PDF (jedno kliknięcie)
  // Generator PDF (pdfmake) wczytuje się dopiero po kliknięciu; sumy kontrolne chronią przed podmianą plików.
  const PDFMAKE = {
    lib: { src: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.11/build/pdfmake.min.js', integrity: 'sha384-vsaIaEjAOZA6uoCQ2pryCKIc8YGpQ/0HK5krdezL4PYvnmLzrizBMDJCZulvIomS' },
    fonts: { src: 'https://cdn.jsdelivr.net/npm/pdfmake@0.3.11/build/vfs_fonts.js', integrity: 'sha384-pkBUW1wxcm6m7ZjKDxADnNHqnz+Sx9sAL1ndsLNv/GZnWZgodPYsju1yxeyQnn0c' }
  };
  let pdfFontsLoaded = false;

  function loadScript(def) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = def.src;
      s.integrity = def.integrity;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Nie udało się wczytać generatora PDF. Sprawdź połączenie z internetem i spróbuj ponownie.'));
      document.head.appendChild(s);
    });
  }

  async function ensurePdfMake() {
    if (!window.pdfMake) await loadScript(PDFMAKE.lib);
    if (!pdfFontsLoaded) { await loadScript(PDFMAKE.fonts); pdfFontsLoaded = true; }
  }

  // Numer tygodnia ISO oraz poniedziałek i niedziela tego tygodnia
  function isoWeekInfo(date) {
    const dayFromMonday = (date.getDay() + 6) % 7;
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dayFromMonday);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
    const daysSinceNewYear = (Date.UTC(thursday.getFullYear(), thursday.getMonth(), thursday.getDate()) - Date.UTC(thursday.getFullYear(), 0, 1)) / 86400000;
    return { week: Math.floor(daysSinceNewYear / 7) + 1, year: thursday.getFullYear(), monday, sunday };
  }
  const fmtShort = (d) => pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();

  // Tabela: wszystkie otwarte zapytania z aktualnym etapem, pogrupowane wg etapu (jak w panelu)
  // opts.ordered: lista jest już przefiltrowana i posortowana jak na ekranie (zostawiamy jej kolejność);
  // bez tego sortujemy tak, jak wybrano na liście zapytań. opts.total / opts.filterNote opisują filtr w nagłówku PDF.
  async function exportWeekPlan(allItems, btn, opts) {
    const label = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Generuję PDF…'; }
    try {
      const open = allItems.filter((i) => !i.done);
      if (!open.length) { toast('Brak otwartych zapytań do wydrukowania.', true); return; }

      const now = new Date();
      const wk = isoWeekInfo(now);
      // nazwa pliku: „<firma> CRM tydzień 38-2026” (bez nazwy firmy: „CRM tydzień 38-2026”)
      const title = ((company ? company + ' ' : '') + 'CRM tydzień ' + wk.week + '-' + wk.year).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
      const fileName = title + '.pdf';

      // Generator wczytuje się w tle, gdy użytkownik wybiera miejsce zapisu.
      const libReady = ensurePdfMake();
      libReady.catch(() => {});
      // Okno „Zapisz jako” (Chrome/Edge na komputerze): przeglądarka pamięta ostatnio wybrany folder (id) i otwiera go następnym razem.
      // Musi być wywołane od razu po kliknięciu. Inne przeglądarki (telefon, Firefox, Safari) po prostu pobierają plik.
      let handle = null;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: fileName, id: 'plan-tygodnia', startIn: 'documents', types: [{ description: 'Plik PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        } catch (e) {
          if (e && e.name === 'AbortError') { toast('Anulowano: plan nie został zapisany.'); return; }
          handle = null;   // okno wyboru niedostępne: zwykłe pobieranie
        }
      }
      await libReady;

      // logo jest opcjonalne: brak pliku albo nieobsługiwany plik SVG nie może zablokować raportu
      let logoSvg = null;
      let logoWidth = 96;
      try {
        const res = await fetch('logo.svg');
        if (res.ok) {
          const raw = await res.text();
          // uszkodzony plik SVG (niepoprawny XML) pomijamy: w PDF pojawi się nazwa firmy tekstem
          const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml');
          if (parsed.querySelector('parsererror') || parsed.documentElement.nodeName.toLowerCase() !== 'svg') throw new Error('nieprawidłowe logo');
          const vb = raw.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/);
          const vw = vb ? parseFloat(vb[1]) : 440;
          const vh = vb ? parseFloat(vb[2]) : 98;
          logoWidth = Math.min(96, 30 * vw / vh);
          logoSvg = raw.replace(/<style[\s\S]*?<\/style>/, '')
            .replace(/class="st2"/g, 'fill="#111111" stroke="#111111" stroke-miterlimit="10"')
            .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, '').replace('<svg', '<svg width="' + vw + '" height="' + vh + '"'));
        }
      } catch (_e) { /* bez logo */ }

      // kolejność w każdej grupie jest taka sama jak w tabeli na stronie
      const ordered = !!(opts && opts.ordered);
      const groups = Object.entries(STATUS).map(([key, name]) => {
        const rows = open.filter((i) => i.status === key);
        if (!ordered) rows.sort(sortComparator(listPrefs.active.sort));
        return { key, name, rows };
      });
      const sortLabel = (SORTS.find(([k]) => k === listPrefs.active.sort) || SORTS[0])[1];
      const BG = { action: '#fbdcd8', followup: '#fdf0c9', waiting: '#dde8fb' };
      // Wszystkie nagłówki i komórki: wyśrodkowane w poziomie i w pionie.
      // Wyjątek: tekst w kolumnie „Informacja zwrotna” jest wyśrodkowany tylko w pionie (w poziomie do lewej).
      const mid = (cell) => Object.assign({ alignment: 'center', verticalAlignment: 'middle' }, typeof cell === 'string' ? { text: cell } : cell);
      const th = (t) => mid({ text: t, bold: true, color: '#ffffff', fontSize: 8 });

      const body = [['Lp', 'Klient', 'Kraj', 'Nr zapytania', 'Treść zapytania', 'Informacja zwrotna / ostatnie ustalenia / następny krok', 'Etap', 'Termin'].map((t) => th(t))];
      let n = 0;
      groups.forEach((g) => {
        if (!g.rows.length) return;
        body.push([mid({ text: g.name + ' (' + g.rows.length + ')', colSpan: 8, bold: true, fontSize: 9, fillColor: BG[g.key], margin: [0, 2, 0, 2] }), {}, {}, {}, {}, {}, {}, {}]);
        g.rows.forEach((i) => {
          n += 1;
          const st = dueState(i);
          body.push([
            mid({ text: String(n), color: '#666666' }),
            mid({ text: i.client || '', bold: true }),
            mid((i.country || '') + (i.cc ? ' (' + i.cc + ')' : '')),
            mid({ text: i.number, bold: true }),
            mid(i.description || ''),
            { text: i.next_step || '', alignment: 'left', verticalAlignment: 'middle' },   // do lewej, ale w pionie na środku
            mid({ text: STATUS[i.status], color: '#444444' }),
            mid({ text: i.due_date ? fmtShort(new Date(i.due_date + 'T00:00:00')) + (st ? '\n' + DUE_LABEL[st] : '') : '', bold: !!st, color: st === 'late' ? '#c22f2f' : '#222222' })
          ]);
        });
      });

      const counts = groups.map((g) => g.name + ': ' + g.rows.length).join('  ·  ');
      const author = getAuthor();
      const buildDoc = (logo) => ({
        pageSize: 'A4',
        pageOrientation: 'landscape',
        pageMargins: [28, 78, 28, 44],
        info: { title, author: author || ((company ? company + ' ' : '') + appName) },
        defaultStyle: { fontSize: 8.5, lineHeight: 1.15 },
        header: () => ({
          margin: [28, 24, 28, 0],
          columns: [
            logo ? { svg: logo, width: logoWidth } : { text: (company || appName).toUpperCase(), bold: true, fontSize: 16 },
            { alignment: 'right', text: [{ text: 'Plan zadań: Tydzień ' + wk.week + '-' + wk.year + '\n', bold: true, fontSize: 14 }, { text: fmtShort(wk.monday) + ' – ' + fmtShort(wk.sunday), color: '#666666', fontSize: 9 }] }
          ]
        }),
        footer: (page, pages) => ({
          margin: [28, 0, 28, 0],
          columns: [
            { text: 'Wygenerowano: ' + fmtShort(now) + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + (author ? ' · ' + author : ''), color: '#777777', fontSize: 7.5 },
            { text: 'Strona ' + page + ' z ' + pages, alignment: 'right', color: '#777777', fontSize: 7.5 }
          ]
        }),
        content: [
          {
            margin: [0, 0, 0, 8], color: '#333333', fontSize: 9,
            text: [
              'Otwarte zapytania: ' + open.length + (opts && opts.total && opts.total !== open.length ? ' z ' + opts.total : '') + '     ' + counts + '     Sortowanie: ' + sortLabel,
              opts && opts.filterNote ? { text: '     ' + opts.filterNote, bold: true, color: '#c22f2f' } : ''
            ]
          },
          {
            table: { headerRows: 1, dontBreakRows: true, widths: [18, 88, 58, 44, 150, '*', 62, 52], body },
            layout: {
              fillColor: (row) => (row === 0 ? '#111111' : null),
              hLineColor: () => '#d3d8df', vLineColor: () => '#d3d8df', hLineWidth: () => 0.5, vLineWidth: () => 0.5,
              paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4
            }
          }
        ]
      });
      const save = async (doc) => {
        const pdf = window.pdfMake.createPdf(doc);
        if (!handle) { await pdf.download(fileName); return; }
        // pdfmake 0.3 zwraca obietnicę, starsze wersje wołają funkcję zwrotną: obsługujemy oba
        const blob = await new Promise((resolve, reject) => {
          try { const r = pdf.getBlob(resolve); if (r && typeof r.then === 'function') r.then(resolve, reject); } catch (e) { reject(e); }
        });
        const w = await handle.createWritable();
        try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch (_e) { /* już zamknięty */ } throw e; }
      };
      try {
        await save(buildDoc(logoSvg));
      } catch (e) {
        if (!logoSvg) throw e;
        // logo w nieobsługiwanym formacie: zapisz plan z nazwą firmy tekstem zamiast logo
        await save(buildDoc(null));
      }
      toast(handle ? 'Plan tygodnia zapisany: ' + handle.name : 'Plan tygodnia zapisany jako PDF.');
    } catch (ex) {
      toast(errMsg(ex), true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  // Imię osoby korzystającej z aplikacji (zapamiętane tylko w tej przeglądarce)
  function getAuthor() {
    try { return localStorage.getItem('crm_author') || ''; } catch (e) { return ''; }
  }
  function setAuthor(name) {
    try { localStorage.setItem('crm_author', name); } catch (e) { /* tryb prywatny: imię nie zostanie zapamiętane */ }
  }

  const mailLink = (e) => (e ? h('a', { href: 'mailto:' + e }, e) : '');
  const telLink = (p) => (p ? h('a', { href: 'tel:' + p.replace(/[^\d+]/g, '') }, p) : '');
  const webLink = (u) => (!u ? '' : /^https?:\/\//i.test(u)
    ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, u) : u);

  // ---------------------------------------------------------------- okno formularza

  function formModal(opts) {
    const dlg = document.getElementById('modal');
    const values = opts.values || {};
    const err = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { class: 'primary', type: 'submit' }, opts.submitLabel || 'Zapisz');
    const form = h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const data = {};
        opts.fields.forEach((f) => { data[f.name] = form.elements[f.name].value.trim(); });
        submit.disabled = true;
        try {
          await opts.onSave(data);
          dlg.close();
        } catch (ex) {
          err.textContent = errMsg(ex);
        } finally {
          submit.disabled = false;
        }
      }
    },
    opts.fields.map((f) => buildField(f, values[f.name])),
    err,
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', onclick: () => dlg.close() }, 'Anuluj'), submit));
    dlg.replaceChildren(h('h2', null, opts.title), form);
    dlg.showModal();
    if (opts.onReady) opts.onReady(form);
    const first = form.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  // ---------------------------------------------------------------- podpowiedzi przy wpisywaniu
  // Listy powstają z danych już wpisanych do CRM (najczęściej używane pierwsze), więc nazwy klientów, krajów itp. wpisuje się
  // spójnie. Odświeżają się po każdym zapisie, a błąd pobierania nigdy nie blokuje formularza.

  // Własna lista rozwijana pod polem (natywna lista przeglądarki jest mało widoczna): pojawia się po kliknięciu w pole
  // (najczęstsze wartości), zawęża się w trakcie pisania, obsługuje myszkę i strzałki + Enter. Zwraca element do wstawienia w formularz.
  // opts.max: ile pozycji pokazać po wpisaniu tekstu (domyślnie 8); opts.empty: lista pokazywana w CAŁOŚCI, gdy pole jest puste
  function suggestBox(input, items, opts) {
    const MAX = (opts && opts.max) || 8;
    const EMPTY = opts && opts.empty;
    // mousedown na liście (np. na jej pasku przewijania) nie może odebrać polu fokusu, bo lista by się zamknęła
    const list = h('ul', { class: 'ac-list', role: 'listbox', hidden: true, onmousedown: (e) => e.preventDefault() });
    const box = h('div', { class: 'ac' }, input, list);
    let shown = [];
    let active = -1;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');

    const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
    const paint = () => [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    function open() {
      const t = norm(input.value).trim();
      // najpierw początek nazwy, potem początek któregoś słowa, potem dowolne trafienie; w grupach zostaje kolejność wg częstości
      const rank = (s) => { const n = norm(s); return n.startsWith(t) ? 0 : (n.includes(' ' + t) || n.includes('/' + t) ? 1 : (n.includes(t) ? 2 : 3)); };
      const all = !t && EMPTY;   // puste pole i podana pełna lista: pokazujemy ją w całości (przewijaną)
      shown = (all ? EMPTY : items).filter((s) => norm(s) !== t && rank(s) < 3).map((s, i) => ({ s, r: t ? rank(s) : 0, i }))
        .sort((a, b) => a.r - b.r || a.i - b.i).slice(0, all ? EMPTY.length : MAX).map((x) => x.s);
      if (!shown.length) return close();
      list.replaceChildren(...shown.map((s, i) => h('li', {
        class: 'ac-item', role: 'option',
        // mousedown (a nie click), żeby pole nie straciło fokusu przed wyborem
        onmousedown: (e) => { e.preventDefault(); pick(s); }
      }, s)));
      active = -1;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function pick(s) {
      input.value = s;
      close();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    input.addEventListener('focus', open);
    input.addEventListener('click', () => { if (list.hidden) open(); });
    input.addEventListener('input', open);
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (e) => {
      if (list.hidden) { if (e.key === 'ArrowDown') { open(); e.preventDefault(); } return; }
      if (e.key === 'ArrowDown') { active = (active + 1) % shown.length; paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = (active <= 0 ? shown.length : active) - 1; paint(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { pick(shown[active]); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }   // zamyka listę, nie całe okno
      else if (e.key === 'Tab') close();
    });
    return box;
  }

  // kody krajów dla najczęstszych państw (uzupełnianie pola „Kod kraju” po wpisaniu kraju)
  const COUNTRY_CODES = {
    'Polska': 'PL', 'Niemcy': 'DE', 'Francja': 'FR', 'Wielka Brytania': 'GB', 'Szwecja': 'SE', 'Norwegia': 'NO', 'Dania': 'DK',
    'Finlandia': 'FI', 'Holandia': 'NL', 'Belgia': 'BE', 'Luksemburg': 'LU', 'Austria': 'AT', 'Szwajcaria': 'CH', 'Włochy': 'IT',
    'Hiszpania': 'ES', 'Portugalia': 'PT', 'Czechy': 'CZ', 'Słowacja': 'SK', 'Węgry': 'HU', 'Rumunia': 'RO', 'Bułgaria': 'BG',
    'Grecja': 'GR', 'Chorwacja': 'HR', 'Serbia': 'RS', 'Słowenia': 'SI', 'Litwa': 'LT', 'Łotwa': 'LV', 'Estonia': 'EE',
    'Irlandia': 'IE', 'Islandia': 'IS', 'Ukraina': 'UA', 'Turcja': 'TR', 'Malta': 'MT', 'Cypr': 'CY', 'Stany Zjednoczone': 'US',
    'Kanada': 'CA', 'Zjednoczone Emiraty Arabskie': 'AE', 'Arabia Saudyjska': 'SA', 'Izrael': 'IL', 'Senegal': 'SN'
  };
  const COUNTRY_ALIASES = { uk: 'GB', anglia: 'GB', holandia: 'NL', niderlandy: 'NL', usa: 'US' };

  // wartości posortowane wg częstości; warianty pisowni (wielkość liter, ogonki, spacje) liczone razem
  function rankStrings(values) {
    const m = new Map();
    values.forEach((raw) => {
      const s = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!s) return;
      const k = clientKey(s);
      const e = m.get(k) || { n: 0, forms: new Map() };
      e.n += 1;
      e.forms.set(s, (e.forms.get(s) || 0) + 1);
      m.set(k, e);
    });
    return [...m.entries()].map(([k, e]) => ({ k, n: e.n, label: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'pl'));
  }
  // łączy listy po kolei, pomijając powtórzenia
  function mergeRanked(...lists) {
    const seen = new Set();
    const out = [];
    lists.forEach((list) => list.forEach((e) => { if (!seen.has(e.k)) { seen.add(e.k); out.push(e.label); } }));
    return out;
  }

  let suggestCache = null;
  async function loadSuggestions() {
    if (suggestCache && Date.now() - suggestCache.at < 5 * 60 * 1000) return suggestCache;
    const empty = { at: 0, clients: [], countries: [], firstNames: [], lastNames: [], positions: [], cities: [], ccOf: () => '', countryMatch: () => null };
    try {
      const [inq, contacts, companies] = await Promise.all([
        fetchAll('inquiries', 'client,country,cc'), fetchAll('contacts', 'first_name,last_name,position'), fetchAll('companies', 'name,city')]);
      const codes = new Map();   // kraj -> kod
      Object.entries(COUNTRY_CODES).forEach(([n, c]) => codes.set(clientKey(n), c));
      Object.entries(COUNTRY_ALIASES).forEach(([n, c]) => codes.set(n, c));
      // kody faktycznie używane w CRM mają pierwszeństwo (najczęstszy kod dla danego kraju)
      const used = new Map();
      inq.forEach((i) => {
        if (!i.country || !i.cc) return;
        const k = clientKey(i.country);
        const e = used.get(k) || new Map();
        e.set(i.cc, (e.get(i.cc) || 0) + 1);
        used.set(k, e);
      });
      used.forEach((e, k) => codes.set(k, [...e.entries()].sort((a, b) => b[1] - a[1])[0][0]));
      const rankedCountries = rankStrings(inq.map((i) => i.country));
      const builtIn = Object.keys(COUNTRY_CODES).map((n) => ({ k: clientKey(n), n: 0, label: n }));
      const countries = mergeRanked(rankedCountries, builtIn);
      suggestCache = {
        at: Date.now(),
        // pełna nazwa kraju dla wpisanego tekstu: dokładna (bez wielkości liter i ogonków) albo jedyna zaczynająca się od niego
        countryMatch: (text) => {
          const t = clientKey(text);
          if (t.length < 2) return null;
          const exact = countries.find((n) => clientKey(n) === t);
          if (exact) return exact;
          const starts = countries.filter((n) => clientKey(n).startsWith(t));
          return starts.length === 1 ? starts[0] : null;
        },
        // klienci z zapytań, potem firmy i osoby z bazy kontaktów
        clients: mergeRanked(rankStrings(inq.map((i) => i.client)), rankStrings(companies.map((c) => c.name)),
          rankStrings(contacts.map((c) => personName(c)))),
        countries,
        firstNames: mergeRanked(rankStrings(contacts.map((c) => c.first_name))),
        lastNames: mergeRanked(rankStrings(contacts.map((c) => c.last_name))),
        positions: mergeRanked(rankStrings(contacts.map((c) => c.position))),
        cities: mergeRanked(rankStrings(companies.map((c) => c.city))),
        ccOf: (name) => codes.get(clientKey(name)) || ''
      };
      return suggestCache;
    } catch (_e) {
      return empty;
    }
  }
  // Porządkuje parę „kraj + kod kraju”: pełna nazwa wpisana w pole kodu przechodzi do pola kraju (a kod się uzupełnia),
  // niepełna nazwa kraju ("szwe") jest dopełniana, kod zapisujemy wielkimi literami
  function fixCountry(sug, country, cc) {
    let c = String(country || '').trim();
    let code = String(cc || '').trim();
    if (code.length > 3) {
      const full = sug.countryMatch(code);
      if (full) { c = full; code = sug.ccOf(full); }
      else if (!c) { c = code; code = ''; }
      else code = code.slice(0, 5);
    }
    const full = sug.countryMatch(c);
    if (full) { c = full; if (!code) code = sug.ccOf(full); }
    return { country: c, cc: code.length <= 3 ? code.toUpperCase() : code };
  }
  // dokłada podpowiedzi do wybranych pól formularza: map = { nazwa_pola: [wartości] }
  const withSuggest = (fields, map) => fields.map((f) => (map[f.name] ? Object.assign({}, f, { suggest: map[f.name] }) : f));

  function buildField(f, v) {
    let input;
    if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, rows: f.rows || 3, maxlength: f.max || 5000 });
      input.value = v == null ? '' : v;
    } else if (f.type === 'select') {
      input = h('select', { name: f.name },
        f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(v == null ? '' : v) }, o.label)));
    } else {
      input = h('input', {
        type: f.type || 'text', name: f.name, value: v == null ? '' : v, required: f.required,
        maxlength: f.max || 300, autocomplete: f.autocomplete || 'off'
      });
      if (f.suggest && f.suggest.length) {
        return h('label', { class: 'field' + (f.wide ? ' wide' : '') }, h('span', null, f.label + (f.required ? ' *' : '')),
          suggestBox(input, f.suggest));
      }
    }
    return h('label', { class: 'field' + (f.wide ? ' wide' : '') }, h('span', null, f.label + (f.required ? ' *' : '')), input);
  }

  // ---------------------------------------------------------------- szkielet strony

  // Logo z pliku logo.svg; gdy pliku nie ma, w tym miejscu pojawia się nazwa firmy zapisana tekstem
  function logoImg(alt) {
    const img = h('img', { class: 'logo', src: 'logo.svg', alt });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'logo logo-text' }, company || appName)));
    return img;
  }

  // ---------------------------------------------------------------- dodanie aplikacji do ekranu głównego telefonu
  // Chrome sam podpowiada instalację tylko czasami i łatwo to przeoczyć, więc pokazujemy własny baner (tylko na telefonie, gdy
  // aplikacja nie jest jeszcze zainstalowana). Android: przycisk „Zainstaluj” (jeśli przeglądarka go udostępnia) albo instrukcja;
  // iPhone/iPad: instrukcja (Safari nie ma przycisku instalacji).

  let installEvent = null;            // zdarzenie beforeinstallprompt (Chrome na Androidzie)
  let installHolder = null;           // miejsce w aktualnej stronie, w którym rysujemy baner
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function installPlatform() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return '';
  }
  const installHiddenUntil = () => { try { return Number(localStorage.getItem('crm_install_hide') || 0); } catch (_e) { return 0; } };
  function hideInstall(days) {
    try { localStorage.setItem('crm_install_hide', String(Date.now() + days * 864e5)); } catch (_e) { /* tryb prywatny */ }
    paintInstall();
  }
  function paintInstall() {
    if (!installHolder || !installHolder.isConnected) return;
    const platform = installPlatform();
    if (!platform || isStandalone() || installHiddenUntil() > Date.now()) return installHolder.replaceChildren();

    let text;
    let action = null;
    if (platform === 'ios') {
      const inApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|Messenger/.test(navigator.userAgent);
      text = inApp
        ? 'Otwórz ten link w przeglądarce Safari (menu … → „Otwórz w Safari”), a potem kliknij Udostępnij → „Dodaj do ekranu głównego”.'
        : 'Kliknij w dolnym pasku przeglądarki ikonę Udostępnij (kwadrat ze strzałką w górę), przewiń w dół i wybierz „Dodaj do ekranu głównego”.';
    } else if (installEvent) {
      text = 'Aplikacja otworzy się jak zwykła aplikacja, z własną ikoną i bez paska przeglądarki.';
      action = h('button', {
        class: 'primary', type: 'button',
        onclick: async () => {
          const ev = installEvent;
          installEvent = null;
          try { ev.prompt(); const r = await ev.userChoice; if (r && r.outcome === 'accepted') hideInstall(3650); else paintInstall(); } catch (_e) { paintInstall(); }
        }
      }, 'Zainstaluj aplikację');
    } else {
      text = 'Otwórz menu przeglądarki (trzy kropki ⋮ w rogu) i wybierz „Zainstaluj aplikację” albo „Dodaj do ekranu głównego”.';
    }
    installHolder.replaceChildren(h('div', { class: 'card banner install', role: 'region', 'aria-label': 'Dodaj aplikację do ekranu głównego' },
      h('img', { src: 'icon-192.png', alt: '', width: 44, height: 44, class: 'install-icon' }),
      h('div', { class: 'install-text' },
        h('strong', null, 'Dodaj ' + appName + ' do ekranu głównego telefonu'),
        h('span', null, text + (platform === 'ios' ? ' Jeśli po otwarciu ikony aplikacja poprosi o kod dostępu, wpisz kod otrzymany od administratora.' : ''))),
      h('div', { class: 'install-actions' }, action,
        h('button', { type: 'button', onclick: () => hideInstall(7) }, 'Nie teraz'),
        h('button', { type: 'button', class: 'link', onclick: () => hideInstall(3650) }, 'Mam już ikonę'))));
  }

  // Mały przycisk „wróć na stronę główną” (czarna strzałka z zaokrąglonymi końcami) na każdej podstronie; na stronie głównej go nie ma
  function backHomeButton() {
    const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if ((!a || a === 'inquiries') && !b) return null;
    const btn = h('a', { class: 'back-home', href: '#/inquiries', title: 'Wróć na stronę główną (Zapytania)', 'aria-label': 'Wróć na stronę główną' });
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';
    return btn;
  }

  function shell(active) {
    root.classList.remove('wide');
    installHolder = h('div', { class: 'install-holder' });
    const nav = [['#/inquiries', 'Zapytania', 'inquiries'], ['#/archive', 'Archiwum', 'archive'], ['#/companies', 'Firmy', 'companies'],
      ['#/contacts', 'Kontakty', 'contacts'], ['#/export', 'Eksport', 'export']];
    const main = h('main', null, backHomeButton(), installHolder);
    for (let i = 1; i < arguments.length; i++) add(main, arguments[i]);
    root.replaceChildren(
      h('header', { class: 'topbar' },
        h('a', { class: 'brand', href: '#/inquiries', 'aria-label': (company ? company + ' ' : '') + appName },
          logoImg(company), h('span', { class: 'brand-tag' }, appName)),
        h('nav', null, nav.map((n) => h('a', { href: n[0], class: n[2] === active ? 'active' : '' }, n[1]))),
        h('div', { class: 'user' },
          privateSession ? h('button', { class: 'link tasks-btn', type: 'button', onclick: openTasks, title: 'Twoje prywatne zadania i przypomnienia' },
            'Moje zadania', taskCount ? h('span', { class: 'news-n' }, String(taskCount)) : null) : null,
          h('button', { class: 'link', onclick: nameModal, title: 'Zmień imię' }, getAuthor() ? 'Jako: ' + getAuthor() : 'Podaj imię'),
          h('button', { class: 'ghost', onclick: signOut, title: 'Usuwa dostęp z tej przeglądarki' }, 'Wyloguj'))),
      main,
      h('footer', { class: 'foot' }, logoImg(''), h('span', null, 'Wewnętrzny CRM' + (company ? ' firmy ' + company : ''))),
      voiceFab());
    paintInstall();
  }

  const loading = (active) => shell(active, h('p', { class: 'muted' }, 'Ładowanie…'));
  const pageHead = (title, actions, crumb) => h('div', { class: 'page-head' },
    h('div', null, crumb ? h('p', { class: 'crumb muted' }, crumb) : null, h('h1', null, title)),
    h('div', { class: 'actions' }, actions));

  function notFound(active, what) {
    shell(active, h('div', { class: 'card empty' }, what + ' nie istnieje lub nie masz do niego dostępu.'));
  }

  // ---------------------------------------------------------------- dostęp

  function authPage(title, sub, ...content) {
    root.replaceChildren(h('div', { class: 'auth' },
      h('div', { class: 'brandmark' }, logoImg(company)),
      h('div', { class: 'card' }, h('h1', null, title), h('p', { class: 'muted' }, sub), ...content)));
  }

  function renderSetup() {
    authPage(appName, 'Aplikacja nie jest jeszcze skonfigurowana.',
      h('p', null, 'Uzupełnij plik ', h('code', null, 'config.js'),
        ' (adres projektu Supabase, klucz anon i adres konta dostępowego), a następnie odśwież stronę. Instrukcja jest w pliku README.md.'));
  }

  // Ekran widoczny tylko wtedy, gdy przeglądarka nie ma jeszcze dostępu (brak linku z kodem)
  function renderAccess() {
    const err = h('p', { class: 'error', role: 'alert' }, accessError);
    const code = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Wejdź');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        const { error } = await sb.auth.signInWithPassword({ email: cfg.ACCESS_EMAIL, password: code.value.trim() });
        if (error) { err.textContent = errMsg(error); btn.disabled = false; }
      }
    }, field('Kod dostępu', code), btn, err);
    authPage(appName, 'Ta aplikacja jest prywatna. Otwórz link otrzymany od administratora albo wpisz kod dostępu.', form);
  }

  function renderError(ex) {
    const body = h('div', { class: 'card empty' }, h('p', null, 'Nie udało się wczytać danych: ' + errMsg(ex)),
      h('button', { onclick: () => route() }, 'Spróbuj ponownie'));
    if (session) shell('', body); else authPage(appName, '', body);
  }

  async function signOut() {
    if (!confirm('Wylogować? Aby wrócić, będziesz potrzebować linku z kodem dostępu.')) return;
    if (psb) { try { await psb.auth.signOut(); } catch (_e) { /* ignorujemy */ } privateSession = null; taskCount = 0; }
    await sb.auth.signOut();
  }

  function nameModal() {
    formModal({
      title: 'Jak masz na imię?',
      values: { name: getAuthor() },
      fields: [{ name: 'name', label: 'Imię (będzie widoczne przy Twoich wpisach)', required: true, wide: true, max: 60 }],
      onSave: async (d) => { setAuthor(d.name); route(); }
    });
  }

  // ---------------------------------------------------------------- notatki / historia

  function notesPanel(ctx) {
    const kind = h('select', null, Object.entries(NOTE_KINDS).map(([v, l]) => h('option', { value: v }, l)));
    const contactSel = ctx.contacts && ctx.contacts.length
      ? h('select', null, h('option', { value: '' }, '— bez kontaktu —'),
        ctx.contacts.map((c) => h('option', { value: c.id }, personName(c))))
      : null;
    const body = h('textarea', { rows: 3, required: true, maxlength: 5000, placeholder: 'Treść notatki, ustalenia z rozmowy…' });
    const btn = h('button', { class: 'primary', type: 'submit' }, 'Dodaj wpis');
    const form = h('form', {
      class: 'note-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = body.value.trim();
        if (!text) return;
        btn.disabled = true;
        try {
          await q(sb.from('notes').insert({
            inquiry_id: ctx.inquiryId || null,
            company_id: ctx.companyId || null,
            contact_id: ctx.contactId || (contactSel && contactSel.value) || null,
            kind: kind.value,
            body: text,
            author: getAuthor()
          }));
          route();
        } catch (ex) {
          toast(errMsg(ex), true);
          btn.disabled = false;
        }
      }
    }, h('div', { class: 'row' }, kind, contactSel), body, btn);

    const list = ctx.notes.length ? ctx.notes.map((n) => {
      const contact = ctx.contactsById && n.contact_id ? ctx.contactsById[n.contact_id] : null;
      return h('article', { class: 'note' },
        h('div', { class: 'note-head' },
          h('span', { class: 'tag' }, NOTE_KINDS[n.kind] || n.kind),
          h('span', { class: 'muted' }, (n.author || 'nieznany autor') + ' · ' + fmtDate(n.created_at)),
          contact ? h('a', { href: '#/contacts/' + contact.id }, personName(contact)) : null,
          h('button', {
            class: 'link danger push',
            onclick: async () => {
              if (!confirm('Usunąć ten wpis?')) return;
              try { await q(sb.from('notes').delete().eq('id', n.id)); route(); } catch (ex) { toast(errMsg(ex), true); }
            }
          }, 'Usuń')),
        h('p', { class: 'note-body' }, n.body));
    }) : h('p', { class: 'muted' }, 'Brak wpisów.');

    return h('section', { class: 'card' }, h('h2', null, 'Historia i notatki'), form, list);
  }

  // ---------------------------------------------------------------- notatka głosowa
  // DODATKOWY sposób dodawania notatek (zwykłe pisanie w karcie zapytania działa bez zmian): okrągły przycisk z mikrofonem w rogu
  // ekranu otwiera okno, w którym wybierasz zapytanie i dyktujesz treść. Rozpoznawanie mowy robi przeglądarka (Chrome na Androidzie,
  // Chrome i Edge na komputerze). Tam, gdzie go nie ma (np. iPhone), okno nadal działa jako zwykłe pole tekstowe
  // (można użyć mikrofonu z klawiatury telefonu). Do zapisu nie jest potrzebny żaden model AI ani konto Claude.

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micSvg = (size) => '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2.2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

  function voiceFab() {
    const b = h('button', {
      class: 'voice-fab', type: 'button', title: 'Dodaj notatkę (można podyktować głosem)', 'aria-label': 'Dodaj notatkę głosową',
      onclick: () => openVoiceNote()
    });
    b.innerHTML = micSvg(24);
    return b;
  }

  // kolejny podyktowany fragment doklejamy do dotychczasowej treści, z kropką i wielką literą
  function joinDictation(base, add) {
    const a = String(add || '').trim();
    if (!a) return base;
    const cap = a.charAt(0).toUpperCase() + a.slice(1);
    if (!base) return cap;
    return base + (/[.!?…]$/.test(base) ? '' : '.') + ' ' + cap;
  }

  function speechErrorText(code) {
    switch (code) {
      case 'not-allowed':
      case 'service-not-allowed': return '⚠ Brak zgody na mikrofon. Zezwól na niego w ustawieniach strony w przeglądarce (ikona przy adresie).';
      case 'no-speech': return '⚠ Nic nie usłyszałem. Dotknij mikrofonu i spróbuj jeszcze raz.';
      case 'audio-capture': return '⚠ Nie wykryto mikrofonu.';
      case 'network': return '⚠ Rozpoznawanie mowy wymaga połączenia z internetem.';
      case 'aborted': return '';
      default: return '⚠ Błąd rozpoznawania mowy (' + code + ').';
    }
  }

  async function openVoiceNote() {
    const dlg = document.getElementById('modal');
    let items;
    try { items = await fetchAll('inquiries', 'id,number,client,description,done'); } catch (ex) { toast(errMsg(ex), true); return; }
    items.sort((x, y) => (Number(!!x.done) - Number(!!y.done)) || byNumber(y, x));   // najpierw aktualne, od najnowszych
    const label = (i) => i.number + ' · ' + (i.client || 'bez klienta') + (i.description ? ' · ' + i.description.slice(0, 40) : '') + (i.done ? ' (archiwum)' : '');
    const labels = items.map(label);
    const byLabel = new Map(items.map((i) => [label(i), i]));
    const find = (text) => {
      const t = String(text || '').trim();
      if (!t) return null;
      if (byLabel.has(t)) return byLabel.get(t);
      return items.find((i) => i.number === t.split(/[\s·]/)[0]) || null;   // wystarczy sam numer
    };

    const pick = h('input', { type: 'text', name: 'inquiry', placeholder: 'Wybierz z listy albo wpisz numer lub klienta', autocomplete: 'off' });
    const chosen = h('p', { class: 'muted voice-chosen' });
    const showChosen = () => {
      const it = find(pick.value);
      chosen.textContent = it ? 'Notatka trafi do zapytania ' + it.number + ' (' + (it.client || 'bez klienta') + ').' : '';
    };
    pick.addEventListener('input', showChosen);
    pick.addEventListener('change', showChosen);
    const [ra, rb] = location.hash.replace(/^#\/?/, '').split('/');
    const preset = ra === 'inquiries' && rb && UUID.test(rb) ? items.find((i) => i.id === rb) : null;   // z karty zapytania wybieramy je od razu
    if (preset) pick.value = label(preset);

    const kind = h('select', null, Object.entries(NOTE_KINDS).map(([v, l]) => h('option', { value: v }, l)));
    const text = h('textarea', { rows: 6, maxlength: 5000, placeholder: SpeechRec ? 'Dotknij mikrofonu i mów albo wpisz notatkę ręcznie.' : 'Wpisz notatkę (na telefonie możesz użyć mikrofonu z klawiatury).' });
    const status = h('p', { class: 'muted voice-status', role: 'status' });
    const err = h('p', { class: 'error', role: 'alert' });
    const save = h('button', { class: 'primary', type: 'submit' }, 'Zapisz notatkę');

    // rozpoznawanie mowy: jedna wypowiedź na dotknięcie mikrofonu (po chwili ciszy tekst się pojawia), kolejne dotknięcie dopisuje dalej
    let rec = null;
    let base = '';
    let failed = false;
    const mic = h('button', { type: 'button', class: 'voice-mic', title: 'Dotknij i mów', 'aria-label': 'Dyktuj notatkę' });
    mic.innerHTML = micSvg(28);
    function abortRec() { if (rec) { try { rec.abort(); } catch (_e) { /* ignorujemy */ } rec = null; } mic.classList.remove('on'); }
    function startRec() {
      abortRec();
      failed = false;
      base = text.value.trim();
      const r = new SpeechRec();
      rec = r;
      r.lang = 'pl-PL';
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      r.onstart = () => { mic.classList.add('on'); status.textContent = 'Słucham… mów teraz.'; };
      r.onresult = (e) => {
        let s = '';
        for (let i = 0; i < e.results.length; i += 1) s += e.results[i][0].transcript;
        text.value = joinDictation(base, s);
        fitTextarea(text);
      };
      r.onerror = (e) => { failed = true; status.textContent = speechErrorText(e.error); };
      r.onend = () => {
        mic.classList.remove('on');
        if (rec === r) rec = null;
        if (!failed) status.textContent = text.value.trim() ? 'Gotowe. Dotknij mikrofonu, żeby dopisać dalej, albo popraw tekst ręcznie.' : '';
      };
      try { r.start(); } catch (_e) { failed = true; status.textContent = '⚠ Nie udało się uruchomić mikrofonu.'; }
    }
    mic.addEventListener('click', () => { if (rec) rec.stop(); else startRec(); });
    if (!SpeechRec) status.textContent = 'Ta przeglądarka nie ma wbudowanego rozpoznawania mowy. Wpisz notatkę albo użyj mikrofonu na klawiaturze telefonu.';

    const form = h('form', {
      class: 'form voice-form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const it = find(pick.value);
        const body = text.value.trim();
        if (!it) { err.textContent = 'Wybierz zapytanie z listy (wpisz numer albo nazwę klienta).'; return; }
        if (!body) { err.textContent = 'Notatka jest pusta.'; return; }
        save.disabled = true;
        try {
          await q(sb.from('notes').insert({ inquiry_id: it.id, kind: kind.value, body, author: getAuthor() }));
          abortRec();
          dlg.close();
          toast('Notatka dodana do zapytania ' + it.number + '.');
          if (location.hash.includes(it.id)) route();   // jesteśmy na karcie tego zapytania: pokaż nową notatkę
        } catch (ex) {
          err.textContent = errMsg(ex);
        } finally {
          save.disabled = false;
        }
      }
    },
    // pusta lista = wszystkie bieżące zapytania (przewijana); po wpisaniu numeru lub nazwy szukamy też w archiwum
    h('label', { class: 'field wide' }, h('span', null, 'Zapytanie'),
      suggestBox(pick, labels, { max: 40, empty: items.filter((i) => !i.done).map(label) }), chosen),
    h('label', { class: 'field wide' }, h('span', null, 'Rodzaj wpisu'), kind),
    h('div', { class: 'voice-mic-row wide' }, SpeechRec ? mic : null, status),
    h('label', { class: 'field wide' }, h('span', null, 'Treść notatki'), text),
    err,
    h('div', { class: 'form-actions' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Anuluj'), save));

    dlg.replaceChildren(h('h2', null, 'Notatka głosowa'), form);
    dlg.addEventListener('close', abortRec, { once: true });
    dlg.showModal();
    showChosen();
    if (!preset) pick.focus();
  }

  // ---- historia zmian (wypełnia ją automatycznie baza danych: kto, kiedy i co zmienił)

  async function loadHistory(table, id) {
    try {
      return await q(sb.from('audit_log').select('*').eq('table_name', table).eq('record_id', id)
        .order('changed_at', { ascending: false }).limit(100));
    } catch (_e) {
      return null;   // brak historii nie może blokować otwarcia rekordu
    }
  }

  function describeChange(table, e) {
    if (e.action === 'insert') return ['Dodano do CRM'];
    if (e.action === 'delete') return ['Usunięto na stałe'];
    const ch = e.changes || {};
    const clip = (s) => (s.length > 140 ? s.slice(0, 140) + '…' : s);
    const out = [];
    Object.keys(ch).forEach((k) => {
      const [o, n] = ch[k];
      if (fieldValue(table, k, o) === fieldValue(table, k, n)) return;   // np. brak daty zapisany raz jako null, raz jako puste pole
      if (k === 'done') out.push(n ? 'Przeniesiono do archiwum' : 'Przywrócono z archiwum');
      else if (k === 'archived_at' && 'done' in ch) return;
      else if (k === 'company_id') out.push('Zmieniono firmę');
      else out.push(fieldLabel(table, k) + ': ' + clip(fieldValue(table, k, o)) + ' → ' + clip(fieldValue(table, k, n)));
    });
    return out;
  }

  function historyPanel(table, rows) {
    if (!rows) return null;
    return h('details', { class: 'card history' },
      h('summary', null, 'Historia zmian (' + rows.length + ')'),
      rows.length ? h('ul', { class: 'history-list' }, rows.map((e) => h('li', null,
        h('span', { class: 'muted' }, fmtDate(e.changed_at) + ' · ' + (e.changed_by || 'nieznana osoba')),
        describeChange(table, e).map((t) => h('div', null, t)))))
        : h('p', { class: 'muted' }, 'Brak zapisanych zmian (historia obejmuje zmiany od chwili włączenia tej funkcji).'));
  }

  // ---- „Co nowego”: przycisk na liście zapytań, a po kliknięciu okienko (tylko do czytania) z krótkim podsumowaniem zapytań,
  // które od ostatniego zamknięcia okienka ktoś (kto bądź, bez nazwisk) dodał, zmienił albo dostały nową notatkę.
  // Punkt odniesienia jest pamiętany w tej przeglądarce (bez osobnych kont); nie sięgamy dalej niż NEWS_DAYS dni wstecz.
  const NEWS_DAYS = 14;
  const SEEN_KEY = 'crm_seen_at';
  function newsSince() {
    let seen = new Date().toISOString();
    try {
      const stored = localStorage.getItem(SEEN_KEY);
      if (stored) seen = stored; else localStorage.setItem(SEEN_KEY, seen);   // pierwsza wizyta: zaczynamy od „teraz”, bez zalewu starą historią
    } catch (_e) { /* bez pamięci przeglądarki okienko nie ma czego pokazać */ }
    const floor = new Date(Date.now() - NEWS_DAYS * 86400000).toISOString();
    return seen > floor ? seen : floor;
  }
  function markNewsSeen() {
    try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch (_e) { /* ignorujemy */ }
  }
  // Punkt odniesienia tej sesji (od wczytania strony do jej odświeżenia lub zamknięcia aplikacji) jest stały: podsumowanie i licznik
  // zostają widoczne przez całą sesję, także po zamknięciu okienka. Otwarcie okienka przesuwa zapamiętany punkt na „teraz”, więc po
  // odświeżeniu strony zobaczysz już tylko to, co zmieniło się po tym, jak ostatnio patrzyłeś. Bez otwarcia okienka nowości się kumulują.
  const newsSessionSince = newsSince();

  // Nowe fragmenty tekstu: słowa z nowej wartości, których nie było w starej (porównanie słowo po słowie, najdłuższy wspólny ciąg).
  // Zwraca { parts: dopisane fragmenty, kept: ile słów starej treści zostało, removed: ile słów starej treści zniknęło } albo null (teksty zbyt długie).
  function addedParts(o, n) {
    const a = o.split(/\s+/).filter(Boolean);
    const b = n.split(/\s+/).filter(Boolean);
    if (a.length * b.length > 4e6) return null;
    // słowa porównujemy bez znaków interpunkcyjnych na brzegach („serii.” to to samo słowo co „serii”)
    const key = (s) => s.replace(/^[.,;:!?()"„”'-]+|[.,;:!?()"„”'-]+$/g, '') || s;
    const ka = a.map(key);
    const kb = b.map(key);
    const w = b.length + 1;
    const dp = new Uint16Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i * w + j] = ka[i] === kb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const keep = new Array(b.length).fill(false);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (ka[i] === kb[j]) { keep[j] = true; i += 1; j += 1; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1; else j += 1;
    }
    const parts = [];
    let cur = [];
    b.forEach((word, idx) => {
      if (keep[idx]) { if (cur.length) { parts.push(cur.join(' ')); cur = []; } } else cur.push(word);
    });
    if (cur.length) parts.push(cur.join(' '));
    const kept = keep.filter(Boolean).length;
    return { parts, kept, removed: a.length - kept };
  }

  // wpisy o zmianie pól zapytania: tylko to, co NOWE. Długie teksty (następny krok, opis): dopisane fragmenty, a gdy cały tekst jest inny,
  // nowy tekst; pozostałe pola: nowa wartość. Poprzedniej treści nie pokazujemy.
  const TEXT_FIELDS = ['next_step', 'description'];
  function changeEntries(table, e) {
    const ch = e.changes || {};
    const out = [];
    Object.keys(ch).forEach((k) => {
      const [o, n] = ch[k];
      const vo = fieldValue(table, k, o);
      const vn = fieldValue(table, k, n);
      if (vo === vn) return;   // np. brak daty zapisany raz jako null, raz jako puste pole
      const label = fieldLabel(table, k);
      if (k === 'done') out.push(n ? 'Przeniesiono do archiwum' : 'Przywrócono z archiwum');
      else if (k === 'archived_at' && 'done' in ch) return;
      else if (k === 'company_id') out.push('Zmieniono firmę');
      else if (k === 'due_date' && (n == null || n === '')) out.push('Termin zdjęty');
      else if (n == null || n === '') out.push(label + ': (usunięto treść)');
      else if (TEXT_FIELDS.includes(k) && typeof o === 'string' && o.trim() && typeof n === 'string') {
        const d = addedParts(o, n);
        if (!d || !d.kept) out.push(label + ': ' + n);                                          // cały tekst inny (albo za długi do porównania)
        else if (d.parts.length) out.push(label + ' — dopisano: ' + d.parts.join(' … '));       // dopisane fragmenty
        else if (d.removed) out.push(label + ' — usunięto część treści');                        // tylko skrócone
        // same odstępy albo zmiana kolejności bez nowych słów: nic do pokazania
      } else out.push(label + ': ' + vn);
    });
    return out;
  }

  // news = { since, log (audit_log zapytań), notes }; items = wszystkie zapytania.
  // Zwraca zapytania z nowościami (od najświeższych; isNew = dodane po punkcie odniesienia), a przy każdym dokładne wpisy,
  // które spowodowały zmianę (także od najświeższych): zmiany pól ze starą i nową wartością, treść nowej notatki, dodanie zapytania.
  // Oraz numery usuniętych zapytań.
  function newsRows(news, items) {
    if (!news) return { rows: [], deleted: [] };
    const byId = new Map(items.map((i) => [i.id, i]));
    const rows = new Map();
    const touch = (id, at, isNew, text) => {
      const it = byId.get(id);
      if (!it) return;
      const r = rows.get(id) || { it, isNew: false, at: '', entries: [] };
      if (isNew) r.isNew = true;
      if (at > r.at) r.at = at;
      r.entries.push({ at, text });
      rows.set(id, r);
    };
    news.log.forEach((e) => {
      if (e.action === 'insert') {
        const it = byId.get(e.record_id);
        touch(e.record_id, e.changed_at, true, 'Nowe zapytanie' + (it && it.description ? ': ' + it.description : ''));
      } else if (e.action === 'update') {
        changeEntries('inquiries', e).forEach((t) => touch(e.record_id, e.changed_at, false, t));
      }
    });
    news.notes.forEach((n) => {
      if (n.inquiry_id) touch(n.inquiry_id, n.created_at, false, 'Notatka' + (n.kind && n.kind !== 'note' ? ' (' + (NOTE_KINDS[n.kind] || n.kind).toLowerCase() + ')' : '') + ': ' + n.body);
    });
    const deleted = news.log.filter((e) => e.action === 'delete').map((e) => (e.changes && e.changes.number) || '').filter(Boolean);
    const byNewest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
    rows.forEach((r) => r.entries.sort(byNewest));   // sortowanie jest stabilne: kilka pól jednej zmiany zostaje w swojej kolejności
    return { rows: [...rows.values()].sort(byNewest), deleted };
  }

  let newsOpen = false;
  function showNewsPopup(news, items) {
    if (newsOpen) return;
    markNewsSeen();   // po następnym odświeżeniu strony pokażemy już tylko nowsze zmiany (bieżące podsumowanie zostaje do tego czasu)
    const { rows, deleted } = newsRows(news, items);
    const dlg = h('dialog', { class: 'news-pop', 'aria-label': 'Co nowego' });
    const close = () => { if (dlg.open) dlg.close(); };
    const CAP = 20;        // zapytań w okienku
    const CAP_EV = 12;     // wpisów przy jednym zapytaniu
    const when = (iso) => new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    // wiersz: klient i numer zapytania, pod spodem dokładne wpisy, które spowodowały zmianę (bez nazwisk autorów)
    const line = ({ it, isNew, entries }) => h('li', null,
      h('div', { class: 'news-inq' },
        isNew ? h('span', { class: 'news-tag' }, 'nowe') : null,
        it.client ? it.client + ' ' : '',
        h('a', { href: '#/inquiries/' + it.id, onclick: close }, it.number)),
      entries.slice(0, CAP_EV).map((en) => h('div', { class: 'news-ev' }, h('span', { class: 'news-when' }, when(en.at)), en.text)),
      entries.length > CAP_EV ? h('div', { class: 'news-ev news-more' }, '…i jeszcze ' + (entries.length - CAP_EV) + ' wpisów') : null);
    const body = h('div', { class: 'news-body' },
      h('h2', null, 'Co nowego'),
      news ? h('p', { class: 'news-since' }, 'Od ' + fmtDate(news.since)) : null,
      !news ? h('p', { class: 'news-empty' }, 'Nie udało się wczytać zmian.') : null,
      news && !rows.length && !deleted.length ? h('p', { class: 'news-empty' }, 'Brak nowych zmian.') : null,
      rows.length ? h('ul', null, rows.slice(0, CAP).map(line)) : null,
      rows.length > CAP ? h('p', { class: 'news-more' }, '…i jeszcze ' + (rows.length - CAP) + ' zapytań') : null,
      deleted.length ? h('p', { class: 'news-deleted' }, 'Usunięto: ' + deleted.join(', ')) : null);
    dlg.append(h('div', { class: 'news-frame' }, body,
      h('div', { class: 'news-foot' }, h('button', { type: 'button', class: 'primary', autofocus: true, onclick: close }, 'Zamknij'))));
    dlg.addEventListener('close', () => { newsOpen = false; dlg.remove(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) close(); });   // kliknięcie w tło też zamyka
    document.body.append(dlg);
    newsOpen = true;
    dlg.showModal();
  }

  // ---- Moje zadania (prywatne): osobna tabela `my_tasks` i osobne logowanie (drugi kod, konto PRIVATE_EMAIL). Widzi je tylko ten, kto zna
  // drugi kod, bo reguły bazy sprawdzają e-mail konta prywatnego (wspólne konto z linku nie ma do tabeli dostępu). Zadania nie trafiają
  // do historii zmian, eksportu ani kopii zapasowej. Bez PRIVATE_EMAIL w config.js funkcja jest wyłączona i niewidoczna.
  // Niezrobione zadanie z terminem w przeszłości jest pokazywane jako „na dziś” (data w bazie się nie zmienia), aż zostanie odhaczone lub usunięte.
  const pq = async (promise) => { const { data, error } = await promise; if (error) throw error; return data; };
  let taskCount = 0;      // otwarte zadania z terminem na dziś lub wcześniejszym (licznik przy przycisku)
  let tasksOpen = false;
  let tasksDlg = null;    // okno, które aktualnie zajmuje ekran (zdarzenie „close” starego okna nie może zwolnić nowego)
  const releaseTasks = (dlg) => { if (tasksDlg === dlg) { tasksOpen = false; tasksDlg = null; } };

  function paintTaskBtn() {
    document.querySelectorAll('.tasks-btn').forEach((b) => {
      b.replaceChildren('Moje zadania', ...(taskCount ? [h('span', { class: 'news-n' }, String(taskCount))] : []));
    });
  }
  async function refreshTaskCount() {
    if (!psb || !privateSession) return;
    try {
      const rows = await pq(psb.from('my_tasks').select('id,due_date').eq('done', false));
      const t0 = ymd(new Date());
      taskCount = rows.filter((t) => t.due_date <= t0).length;
      paintTaskBtn();
    } catch (_e) { /* chwilowy brak sieci: licznik odświeży się przy następnej próbie */ }
  }

  function openTasks() {
    if (!psb) { toast('Ta funkcja nie jest włączona w tej wersji aplikacji.', true); return; }
    if (tasksOpen) return;
    if (!privateSession) showTasksUnlock(); else showTasks();
  }

  // Okno wpisania drugiego kodu (raz na urządzenie; sesja zostaje zapamiętana w przeglądarce, jak przy pierwszym kodzie)
  function showTasksUnlock() {
    tasksOpen = true;
    const dlg = h('dialog', { class: 'news-pop tasks-pop', 'aria-label': 'Moje zadania' });
    tasksDlg = dlg;
    const err = h('p', { class: 'error', role: 'alert' });
    const code = h('input', { type: 'password', required: true, autocomplete: 'current-password', 'aria-label': 'Prywatny kod' });
    const btn = h('button', { type: 'submit', class: 'primary' }, 'Odblokuj');
    const form = h('form', {
      class: 'tasks-unlock',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        const { data, error } = await psb.auth.signInWithPassword({ email: cfg.PRIVATE_EMAIL, password: code.value.trim() });
        if (error) { err.textContent = /invalid login/i.test(error.message || '') ? 'Nieprawidłowy kod.' : errMsg(error); btn.disabled = false; return; }
        privateSession = data.session;
        dlg.close();
        releaseTasks(dlg);
        await refreshTaskCount();
        await route();          // odświeża pasek u góry, żeby pojawił się przycisk „Moje zadania”
        openTasks();
      }
    }, h('p', { class: 'muted' }, 'Ta część jest prywatna. Wpisz swój osobny kod.'), code, err,
    h('div', { class: 'news-foot' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Anuluj'), ' ', btn));
    dlg.append(h('div', { class: 'news-frame' }, h('div', { class: 'news-body' }, h('h2', null, 'Moje zadania'), form)));
    dlg.addEventListener('close', () => { releaseTasks(dlg); dlg.remove(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    code.focus();
  }

  async function showTasks() {
    tasksOpen = true;
    const dlg = h('dialog', { class: 'news-pop tasks-pop', 'aria-label': 'Moje zadania' });
    tasksDlg = dlg;
    const body = h('div', { class: 'news-body' });
    let open = [];
    let done = [];
    const today = () => ymd(new Date());
    const load = async () => {
      open = await pq(psb.from('my_tasks').select('*').eq('done', false).order('due_date', { ascending: true }).order('created_at', { ascending: true }));
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      done = await pq(psb.from('my_tasks').select('*').eq('done', true).gt('done_at', since).order('done_at', { ascending: false }).limit(100));
    };
    const patch = (t, data) => pq(psb.from('my_tasks').update(data).eq('id', t.id));
    const fail = (ex) => { toast(errMsg(ex), true); load().then(render).catch(() => {}); };
    const act = async (fn) => { try { await fn(); await load(); render(); } catch (ex) { fail(ex); } };

    const newTitle = h('input', { type: 'text', maxlength: 500, required: true, placeholder: 'Nowe zadanie…', 'aria-label': 'Nowe zadanie' });
    const newDate = h('input', { type: 'date', required: true, value: today(), 'aria-label': 'Termin' });
    const addBtn = h('button', { type: 'submit', class: 'primary' }, 'Dodaj');
    const addForm = h('form', {
      class: 'task-add',
      onsubmit: async (e) => {
        e.preventDefault();
        const v = newTitle.value.trim();
        if (!v || !newDate.value) return;
        addBtn.disabled = true;
        await act(async () => { await pq(psb.from('my_tasks').insert({ title: v, due_date: newDate.value })); newTitle.value = ''; });
        addBtn.disabled = false;
        newTitle.focus();
      }
    }, newTitle, newDate, addBtn);

    const daysLate = (due) => Math.round((new Date(today() + 'T00:00:00') - new Date(due + 'T00:00:00')) / 86400000);
    const row = (t, isDone) => {
      const title = h('textarea', {
        class: 'task-title', rows: 1, maxlength: 500, 'aria-label': 'Treść zadania',
        oninput: () => fitTextarea(title),
        onchange: () => { const v = title.value.trim(); if (!v) { title.value = t.title; return; } act(() => patch(t, { title: v })); }
      });
      title.value = t.title;
      const date = h('input', {
        type: 'date', class: 'task-date', value: t.due_date, 'aria-label': 'Termin',
        onchange: () => { if (!date.value) { date.value = t.due_date; return; } act(() => patch(t, { due_date: date.value })); }
      });
      const late = !isDone && t.due_date < today();
      return h('li', { class: 'task' + (isDone ? ' is-done' : '') },
        h('input', {
          type: 'checkbox', class: 'tick', checked: isDone, 'aria-label': isDone ? 'Cofnij wykonanie' : 'Zrobione',
          onchange: () => act(() => patch(t, isDone ? { done: false, done_at: null } : { done: true, done_at: new Date().toISOString() }))
        }),
        h('div', { class: 'task-main' }, title,
          late ? h('div', { class: 'task-late' }, 'zaległe od ' + fmtDayShort(t.due_date) + ' (' + daysLate(t.due_date) + ' dn.)') : null,
          isDone && t.done_at ? h('div', { class: 'task-meta' }, 'zrobione ' + fmtDayShort(ymd(new Date(t.done_at)))) : null),
        isDone ? null : date,
        h('button', {
          type: 'button', class: 'link danger', title: 'Usuń zadanie',
          onclick: () => { if (confirm('Usunąć zadanie „' + (t.title.length > 60 ? t.title.slice(0, 60) + '…' : t.title) + '”?')) act(() => pq(psb.from('my_tasks').delete().eq('id', t.id))); }
        }, 'Usuń'));
    };

    function render() {
      const t0 = today();
      const due = open.filter((t) => t.due_date <= t0);
      const later = open.filter((t) => t.due_date > t0);
      taskCount = due.length;
      paintTaskBtn();
      const days = new Map();
      later.forEach((t) => { if (!days.has(t.due_date)) days.set(t.due_date, []); days.get(t.due_date).push(t); });
      const scroll = body.scrollTop;
      body.replaceChildren(
        h('h2', null, 'Moje zadania'),
        h('p', { class: 'news-since' }, 'Prywatne: widzisz je tylko Ty'),
        addForm,
        h('h3', null, 'Na dziś' + (due.length ? ' (' + due.length + ')' : '')),
        due.length ? h('ul', { class: 'task-list' }, due.map((t) => row(t, false))) : h('p', { class: 'news-empty' }, 'Brak zadań na dziś.'),
        ...(days.size ? [h('h3', null, 'Nadchodzące'), ...[...days].map(([d, list]) => [h('div', { class: 'task-day' }, fmtDay(d)), h('ul', { class: 'task-list' }, list.map((t) => row(t, false)))]).flat()] : []),
        ...(done.length ? [h('details', { class: 'task-done' }, h('summary', null, 'Zrobione, ostatnie 30 dni (' + done.length + ')'), h('ul', { class: 'task-list' }, done.map((t) => row(t, true))))] : []));
      body.scrollTop = scroll;
      const fit = () => body.querySelectorAll('textarea.task-title').forEach(fitTextarea);
      fit();
      setTimeout(fit, 120);   // drugi pomiar po ułożeniu okna (pierwszy mógłby trafić w jeszcze nieukończony układ)
    }

    try {
      await load();
    } catch (ex) {
      releaseTasks(dlg);
      // sesja prywatna wygasła albo kod został zmieniony: prosimy o kod jeszcze raz
      if (/jwt|token|permission|row-level|not authenticated|401/i.test((ex && ex.message) || '')) {
        try { await psb.auth.signOut(); } catch (_e) { /* ignorujemy */ }
        privateSession = null;
        showTasksUnlock();
      } else toast(errMsg(ex), true);
      return;
    }
    dlg.append(h('div', { class: 'news-frame' }, body, h('div', { class: 'news-foot' }, h('button', { type: 'button', class: 'primary', onclick: () => dlg.close() }, 'Zamknij'))));
    dlg.addEventListener('close', () => { releaseTasks(dlg); dlg.remove(); refreshTaskCount(); });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    render();
  }

  function details(pairs) {
    const dl = h('dl', { class: 'details' });
    pairs.forEach(([k, v]) => { if (v) dl.append(h('dt', null, k), h('dd', null, v)); });
    return dl;
  }

  // ---------------------------------------------------------------- zapytania

  // Archiwum: zapytanie jest zarchiwizowane, gdy done = true; archived_at to data przeniesienia do archiwum.
  const isArchived = (it) => !!it.done;
  const MOVE_TARGETS = Object.assign({}, STATUS, { archive: 'Archiwum' });
  const localDate = (iso) => (iso ? ymd(new Date(iso)) : '');
  // data zapytania (jeśli jej nie wpisano: data dodania do CRM)
  const inquiryDate = (it) => it.received_at || localDate(it.created_at);
  const archiveDate = (it) => localDate(it.archived_at);
  const fmtDayShort = (s) => (s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : '');
  // klient to wolny tekst (np. „Jan Kowalski / Firma X”); porównujemy go bez wielkości liter, ogonków i nadmiarowych spacji
  const clientKey = (s) => norm(s).replace(/\s+/g, ' ').trim();
  const clientHref = (name) => '#/client/' + encodeURIComponent(name);

  const PERIODS = [['all', 'Wszystkie daty'], ['week', 'Ten tydzień'], ['month', 'Bieżący miesiąc'], ['lastmonth', 'Poprzedni miesiąc'],
    ['last3', 'Ostatnie 3 miesiące'], ['year', 'Bieżący rok'], ['lastyear', 'Poprzedni rok'], ['custom', 'Zakres dat…']];
  const SORTS = [['number-asc', 'Numer: rosnąco'], ['number-desc', 'Numer: malejąco'], ['date-desc', 'Data zapytania: najnowsze'], ['date-asc', 'Data zapytania: najstarsze']];
  const ARCHIVE_SORTS = [['arch-desc', 'Data archiwizacji: najnowsze'], ['arch-asc', 'Data archiwizacji: najstarsze']].concat(SORTS);

  // wybór okresu i sortowania zostaje zapamiętany na czas pracy w aplikacji
  const defaultPrefs = (mode) => (mode === 'archive'
    ? { q: '', period: 'all', from: '', to: '', sort: 'arch-desc', basis: 'inquiry' }
    : { q: '', period: 'all', from: '', to: '', sort: 'number-asc', focus: '' });
  const listPrefs = { active: defaultPrefs('active'), archive: defaultPrefs('archive') };

  function periodRange(key, from, to) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = (yy, mm, dd) => ymd(new Date(yy, mm, dd));
    switch (key) {
      case 'week': { const wk = isoWeekInfo(now); return [ymd(wk.monday), ymd(wk.sunday)]; }
      case 'month': return [d(y, m, 1), d(y, m + 1, 0)];
      case 'lastmonth': return [d(y, m - 1, 1), d(y, m, 0)];
      case 'last3': return [d(y, m - 2, 1), d(y, m + 1, 0)];
      case 'year': return [d(y, 0, 1), d(y, 11, 31)];
      case 'lastyear': return [d(y - 1, 0, 1), d(y - 1, 11, 31)];
      case 'custom': return [from || '', to || ''];
      default: return ['', ''];
    }
  }
  const inPeriod = (date, from, to) => {
    if (!from && !to) return true;
    if (!date) return false;
    return (!from || date >= from) && (!to || date <= to);
  };
  function sortComparator(key) {
    switch (key) {
      case 'number-desc': return (a, b) => byNumber(b, a);
      case 'date-desc': return (a, b) => inquiryDate(b).localeCompare(inquiryDate(a)) || byNumber(b, a);
      case 'date-asc': return (a, b) => inquiryDate(a).localeCompare(inquiryDate(b)) || byNumber(a, b);
      case 'arch-desc': return (a, b) => archiveDate(b).localeCompare(archiveDate(a)) || byNumber(b, a);
      case 'arch-asc': return (a, b) => archiveDate(a).localeCompare(archiveDate(b)) || byNumber(a, b);
      default: return byNumber;
    }
  }

  // „Zrobione”: odhacza zadanie z terminem (na dziś / po terminie), czyli zdejmuje termin. Zapytanie zostaje w swojej grupie,
  // a nowy następny krok i termin ustawia się jak zwykle. W komunikacie jest „Cofnij”. afterChange odświeża widok.
  async function markDone(it, afterChange) {
    const prev = it.due_date;
    const r = await patchResolving('inquiries', it, { due_date: null });
    if (r.theirs) { Object.assign(it, r.theirs); toast('Zostawiono wersję innej osoby (zapytanie ' + it.number + ').'); afterChange(); return; }
    Object.assign(it, { due_date: null, updated_at: r.row.updated_at, updated_by: getAuthor() });
    afterChange();
    toast('Odhaczono ' + it.number + ': termin zdjęty.', false, {
      label: 'Cofnij',
      fn: async () => {
        try {
          const back = await patchResolving('inquiries', it, { due_date: prev });
          if (back.theirs) Object.assign(it, back.theirs); else Object.assign(it, { due_date: prev, updated_at: back.row.updated_at, updated_by: getAuthor() });
        } catch (ex) { toast(errMsg(ex), true); }
        afterChange();
      }
    });
  }

  // Przeniesienie do jednej z trzech grup albo do archiwum (wraca się tą samą drogą, wybierając grupę)
  async function moveInquiry(it, target) {
    const data = target === 'archive'
      ? { done: true, archived_at: new Date().toISOString() }
      : { status: target, done: false, archived_at: null };
    const r = await patchResolving('inquiries', it, data);
    if (r.theirs) { Object.assign(it, r.theirs); toast('Zostawiono wersję innej osoby (zapytanie ' + it.number + ').'); return; }
    Object.assign(it, data, { updated_at: r.row.updated_at, updated_by: getAuthor() });
    toast('Zapytanie ' + it.number + ' przeniesione: ' + MOVE_TARGETS[target] + '.');
  }

  async function inquiryForm(existing, onDone, preset) {
    const companies = (await q(sb.from('companies').select('id,name').order('name'))) || [];
    companies.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const sug = await loadSuggestions();
    formModal({
      title: existing ? 'Edytuj zapytanie ' + existing.number : 'Nowe zapytanie',
      values: existing || Object.assign({ status: 'action', received_at: ymd(new Date()) }, preset || {}),
      // Kraj i kod kraju: po wpisaniu znanego kraju kod uzupełnia się sam (tylko gdy pole jest puste lub ma kod wstawiony automatycznie);
      // w polu kodu można też wpisać (lub wybrać z listy) pełną nazwę kraju, a niepełną nazwę w polu kraju ("szwe") dopełnia się do "Szwecja"
      onReady: (form) => {
        const country = form.elements.country;
        const cc = form.elements.cc;
        let auto = cc.value && cc.value === sug.ccOf(country.value) ? cc.value : '';   // kod zgodny z krajem można podmienić po zmianie kraju
        const fill = () => {
          const code = sug.ccOf(country.value);
          if (code && (!cc.value.trim() || cc.value === auto)) { cc.value = code; auto = code; }
        };
        const settle = () => {
          const r = fixCountry(sug, country.value, cc.value);
          country.value = r.country;
          cc.value = r.cc;
          auto = r.cc && r.cc === sug.ccOf(r.country) ? r.cc : auto;
        };
        country.addEventListener('input', fill);
        country.addEventListener('change', () => { settle(); fill(); });
        cc.addEventListener('change', settle);
      },
      fields: withSuggest([
        { name: 'number', label: 'Numer zapytania', required: true, max: 40 },
        { name: 'received_at', label: 'Data zapytania', type: 'date' },
        { name: 'client', label: 'Klient (firma / osoba kontaktowa)', wide: true },
        { name: 'country', label: 'Kraj (np. Szwecja)' },
        { name: 'cc', label: 'Kod kraju (np. SE) lub nazwa', max: 40 },
        { name: 'description', label: 'Opis zapytania', type: 'textarea', wide: true },
        { name: 'next_step', label: 'Następny krok', type: 'textarea', wide: true, rows: 2 },
        { name: 'due_date', label: 'Termin następnego kroku (przypomnienie)', type: 'date' },
        { name: 'status', label: 'Grupa', type: 'select', options: Object.entries(STATUS).map(([value, label]) => ({ value, label })) },
        { name: 'company_id', label: 'Firma (opcjonalnie)', type: 'select',
          options: [{ value: '', label: '— brak —' }].concat(companies.map((c) => ({ value: c.id, label: c.name }))) }
      ], { client: sug.clients, country: sug.countries, cc: sug.countries }),
      onSave: async (d) => {
        Object.assign(d, fixCountry(sug, d.country, d.cc));   // także przy zapisie Enterem, zanim pole zdążyło się „ustawić”
        d.company_id = d.company_id || null;
        d.due_date = d.due_date || null;
        d.received_at = d.received_at || null;
        if (existing) {
          await patchResolving('inquiries', existing, d);
          onDone(existing.id);
        } else {
          d.author = getAuthor();
          d.updated_by = getAuthor();
          const row = await q(sb.from('inquiries').insert(d).select().single());
          onDone(row.id);
        }
      }
    });
  }

  // Lista zapytań (archive = false) albo archiwum (archive = true)
  async function viewInquiries(token, archive) {
    const mode = archive ? 'archive' : 'active';
    const prefs = listPrefs[mode];
    const navKey = archive ? 'archive' : 'inquiries';
    loading(navKey);
    const items = await fetchAll('inquiries');
    if (token !== routeToken) return;
    const scoped = () => items.filter((i) => isArchived(i) === !!archive);

    // Ostatnia aktywność przy zapytaniu = późniejsza z dat: zmiana zapytania albo ostatnia notatka (notatki nie zmieniają daty zapytania)
    const lastNote = new Map();
    const loadActivity = async () => {
      lastNote.clear();
      (await fetchAll('notes', 'id,inquiry_id,created_at')).forEach((n) => {
        const t = Date.parse(n.created_at) || 0;
        if (n.inquiry_id && t > (lastNote.get(n.inquiry_id) || 0)) lastNote.set(n.inquiry_id, t);
      });
    };
    // „Co nowego”: dane do okienka z podsumowaniem (brak dostępu do historii nie może blokować listy)
    let news = null;
    const loadNews = async () => {
      const since = newsSessionSince;
      try {
        const [log, notes] = await Promise.all([
          q(sb.from('audit_log').select('id,record_id,action,changed_by,changed_at,changes').eq('table_name', 'inquiries')
            .gt('changed_at', since).order('changed_at', { ascending: false }).limit(200)),
          q(sb.from('notes').select('id,inquiry_id,kind,body,author,created_at').gt('created_at', since)
            .order('created_at', { ascending: false }).limit(100))
        ]);
        news = { since, log: log || [], notes: notes || [] };
      } catch (_e) { news = null; }
    };
    if (!archive) {
      await Promise.all([loadActivity(), loadNews()]);
      if (token !== routeToken) return;
    }
    const lastActivity = (it) => Math.max(Date.parse(it.updated_at) || 0, Date.parse(it.created_at) || 0, lastNote.get(it.id) || 0);
    // '' | 'late' | 'today' | 'stale' (bez terminu, a ruchu brak od STALE_DAYS dni; zapytania z terminem w przyszłości są „odłożone” celowo)
    const focusOf = (it) => {
      if (it.done) return '';
      const st = dueState(it);
      if (st) return st;
      return !it.due_date && Date.now() - lastActivity(it) >= STALE_DAYS * 86400000 ? 'stale' : '';
    };

    const opts = (list, cur) => list.map(([v, l]) => h('option', { value: v, selected: v === cur }, l));
    const search = h('input', { type: 'search', placeholder: 'Szukaj (numer, klient, kraj, opis, następny krok)…', oninput: () => { prefs.q = search.value; draw(); } });
    search.value = prefs.q;
    const periodSel = h('select', { 'aria-label': 'Okres', onchange: () => { prefs.period = periodSel.value; showRange(); draw(); } }, opts(PERIODS, prefs.period));
    const fromIn = h('input', { type: 'date', 'aria-label': 'Od daty', value: prefs.from, onchange: () => { prefs.from = fromIn.value; draw(); } });
    const toIn = h('input', { type: 'date', 'aria-label': 'Do daty', value: prefs.to, onchange: () => { prefs.to = toIn.value; draw(); } });
    const range = h('span', { class: 'range' }, 'od ', fromIn, ' do ', toIn);
    const showRange = () => { range.style.display = prefs.period === 'custom' ? 'inline-flex' : 'none'; };
    const sortSel = h('select', { 'aria-label': 'Sortowanie', onchange: () => { prefs.sort = sortSel.value; draw(); } }, opts(archive ? ARCHIVE_SORTS : SORTS, prefs.sort));
    const basisSel = archive
      ? h('select', { 'aria-label': 'Filtruj według daty', onchange: () => { prefs.basis = basisSel.value; draw(); } }, opts([['inquiry', 'daty zapytania'], ['archive', 'daty archiwizacji']], prefs.basis))
      : null;
    const summary = h('span', { class: 'muted summary' });
    const resetBtn = h('button', {
      class: 'link', type: 'button',
      onclick: () => {
        Object.assign(prefs, defaultPrefs(mode));
        search.value = ''; fromIn.value = ''; toIn.value = '';
        periodSel.value = prefs.period; sortSel.value = prefs.sort;
        if (basisSel) basisSel.value = prefs.basis;
        showRange(); draw();
      }
    }, 'Wyczyść filtry');
    const out = h('div');

    // opis aktywnych filtrów (trafia do nagłówka PDF, żeby plan z filtrem nie został wzięty za pełny)
    const filterNote = () => {
      const parts = [];
      if (prefs.period !== 'all') {
        const [f, t] = periodRange(prefs.period, prefs.from, prefs.to);
        parts.push('okres: ' + PERIODS.find(([k]) => k === prefs.period)[1]
          + (prefs.period === 'custom' ? ' (' + (f ? fmtDayShort(f) : '…') + ' – ' + (t ? fmtDayShort(t) : '…') + ')' : ''));
      }
      if (prefs.q) parts.push('szukane: „' + prefs.q + '”');
      if (!archive && prefs.focus) parts.push('tylko: ' + FOCUS_LABEL[prefs.focus].toLowerCase());
      return parts.length ? 'FILTR: ' + parts.join(', ') : '';
    };

    const textMatch = (it, t) => !t || norm([it.number, it.client, it.country, it.cc, it.description, it.next_step].join(' ')).includes(t);
    const visible = () => {
      const t = norm(prefs.q);
      const [from, to] = periodRange(prefs.period, prefs.from, prefs.to);
      const dateOf = archive && prefs.basis === 'archive' ? archiveDate : inquiryDate;
      return scoped()
        .filter((it) => (archive || !prefs.focus || focusOf(it) === prefs.focus) && textMatch(it, t) && inPeriod(dateOf(it), from, to))
        .sort(sortComparator(prefs.sort));
    };

    // Szukany tekst pasuje też do zapytań z drugiej zakładki (aktualne <-> archiwum): pokazujemy podpowiedź z odnośnikami
    const otherHint = h('div');
    function drawOtherHint() {
      const t = norm(prefs.q).trim();
      const other = t ? items.filter((i) => isArchived(i) !== !!archive && textMatch(i, t)).sort(byNumber) : [];
      if (!other.length) return otherHint.replaceChildren();
      const where = archive ? 'w aktualnych zapytaniach' : 'w archiwum';
      const shownList = other.slice(0, 5);
      otherHint.replaceChildren(h('div', { class: 'card banner info', role: 'status' },
        h('span', null, 'Pasuje też ' + where + ' (' + other.length + '): ',
          ...shownList.flatMap((i, idx) => [idx ? ', ' : '', h('a', { href: '#/inquiries/' + i.id }, i.number + (i.client ? ' (' + i.client + ')' : ''))]),
          other.length > shownList.length ? ' i inne.' : ''),
        h('button', {
          type: 'button',
          onclick: () => {
            // te same słowa w drugiej zakładce, bez filtrów okresu, żeby wynik na pewno było widać
            Object.assign(listPrefs[archive ? 'active' : 'archive'], defaultPrefs(archive ? 'active' : 'archive'), { q: prefs.q });
            location.hash = archive ? '#/inquiries' : '#/archive';
          }
        }, archive ? 'Pokaż w Zapytaniach' : 'Pokaż w Archiwum')));
    }

    async function save(it, data) {
      try {
        const r = await patchResolving('inquiries', it, data);
        if (r.theirs) { Object.assign(it, r.theirs); toast('Zostawiono wersję innej osoby.'); } else Object.assign(it, data, { updated_at: r.row.updated_at, updated_by: getAuthor() });
        watchExpect(sigOfRows(items));
        draw();
      } catch (ex) {
        toast(errMsg(ex), true);
        route();
      }
    }
    async function move(it, target) {
      try { await moveInquiry(it, target); watchExpect(sigOfRows(items)); draw(); } catch (ex) { toast(errMsg(ex), true); route(); }
    }
    function tickDone(it) {
      markDone(it, () => { watchExpect(sigOfRows(items)); draw(); }).catch((ex) => { toast(errMsg(ex), true); route(); });
    }

    // n = numer porządkowy wiersza (Lp.): ciągły przez wszystkie grupy na stronie, więc ostatni numer to łączna liczba wyświetlanych zapytań
    function inquiryRow(it, n) {
      // pola rosną razem z tekstem, żeby cały opis i następny krok były widoczne (zapis po opuszczeniu pola)
      const next = h('textarea', {
        class: 'next-step', rows: 1, maxlength: 500, 'aria-label': 'Następny krok',
        oninput: () => fitTextarea(next),
        onchange: () => save(it, { next_step: next.value.trim() })
      });
      next.value = it.next_step;
      const desc = h('textarea', {
        class: 'next-step', rows: 1, maxlength: 2000, 'aria-label': 'Opis',
        oninput: () => fitTextarea(desc),
        onchange: () => save(it, { description: desc.value.trim() })
      });
      desc.value = it.description;

      // menu przenoszenia: w aktualnych pokazuje bieżącą grupę i pozwala wybrać inną lub archiwum; w archiwum pozwala przywrócić do wybranej grupy
      const moveSel = archive
        ? h('select', { 'aria-label': 'Przywróć do', onchange: () => { if (moveSel.value) move(it, moveSel.value); } },
          h('option', { value: '' }, 'Przywróć do…'),
          Object.entries(STATUS).map(([v, l]) => h('option', { value: v }, l)))
        : h('select', { 'aria-label': 'Przenieś do', onchange: () => move(it, moveSel.value) },
          Object.entries(MOVE_TARGETS).map(([v, l]) => h('option', { value: v, selected: v === it.status }, l)));

      let dateCell;
      if (archive) {
        dateCell = td('Zarchiwizowano', h('div', { class: 'due' }, archiveDate(it) ? fmtDayShort(archiveDate(it)) : '—'));
      } else {
        const due = h('input', {
          type: 'date', value: it.due_date || '', 'aria-label': 'Termin',
          onchange: () => save(it, { due_date: due.value || null })
        });
        const state = dueState(it);
        dateCell = td('Termin', h('div', { class: 'due' }, due,
          state ? h('span', { class: 'badge ' + state }, DUE_LABEL[state]) : null,
          state ? h('button', { type: 'button', class: 'link tick-btn', title: 'Odhacz jako zrobione (zdejmuje termin)', onclick: () => tickDone(it) }, '✓ Zrobione') : null,
          it.due_date ? calendarLink(it, '+ Kalendarz Google', 'cal-link') : null));
      }
      return h('tr', null,
        h('td', { class: 'lp', 'data-label': 'Lp.', title: 'Numer porządkowy na liście' }, String(n)),
        td('Nr', h('span', { class: 'lp-inline', title: 'Numer porządkowy na liście' }, n + '.'), h('a', { href: '#/inquiries/' + it.id }, it.number),
          it.received_at ? h('div', { class: 'nr-date', title: 'Data zapytania' }, fmtDayShort(it.received_at)) : null),
        td('Klient', it.client ? h('a', { class: 'client-link', href: clientHref(it.client), title: 'Pokaż wszystkie zapytania tego klienta' }, it.client) : ''),
        td('Kraj', it.country + (it.cc ? ' (' + it.cc + ')' : '')),
        td('Opis', desc),
        td('Następny krok', next),
        dateCell,
        td(archive ? 'Przywróć do' : 'Grupa', moveSel));
    }

    function section(title, rows, key) {
      const heads = ['Lp.', 'Nr', 'Klient', 'Kraj', 'Opis', 'Następny krok', archive ? 'Zarchiwizowano' : 'Termin', archive ? 'Przywróć do' : 'Grupa / przenieś do'];
      return h('section', { class: 'card st st-' + key },
        h('h2', null, title, h('span', { class: 'count' }, String(rows.length))),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'stack inq' + (archive ? ' arch' : '') },
            h('thead', null, h('tr', null, heads.map((t) => h('th', null, t)))),
            h('tbody', null, rows.map((it) => inquiryRow(it, ++seq)))))
          : h('p', { class: 'muted' }, archive ? 'Brak zapytań w archiwum spełniających te warunki.' : 'Brak pozycji.'));
    }

    // Pasek „Dzisiaj”: liczby z całej listy aktualnych zapytań (bez filtrów okresu i szukania); kliknięcie zawęża listę do jednej grupy
    const strip = h('div', { class: 'today-strip' });
    function drawStrip() {
      const counts = { late: 0, today: 0, stale: 0 };
      scoped().forEach((i) => { const f = focusOf(i); if (f) counts[f] += 1; });
      if (prefs.focus && !counts[prefs.focus]) prefs.focus = '';   // ostatnie zapytanie z grupy załatwione: wracamy do pełnej listy
      strip.replaceChildren(
        h('strong', { class: 'ts-title' }, 'Dzisiaj'),
        ...Object.entries(FOCUS_LABEL).map(([k, label]) => h('button', {
          type: 'button', class: 'chip chip-' + k + (prefs.focus === k ? ' on' : ''), disabled: !counts[k],
          'aria-pressed': prefs.focus === k ? 'true' : 'false',
          title: k === 'stale' ? 'Zapytania bez terminu, w których od ' + STALE_DAYS + ' dni nic się nie zmieniło (ani zapytanie, ani notatki)' : '',
          onclick: () => { prefs.focus = prefs.focus === k ? '' : k; draw(); }
        }, label, h('span', { class: 'chip-n' }, String(counts[k])))),
        ...(counts.late + counts.today + counts.stale ? [] : [h('span', { class: 'muted' }, 'Brak zaległości.')]));
    }

    // Przycisk „Co nowego” z liczbą zapytań, w których od ostatniego zamknięcia okienka coś się zmieniło; kliknięcie otwiera okienko
    const newsBtn = h('button', {
      type: 'button', class: 'news-btn',
      title: 'Krótkie podsumowanie: co się zmieniło w zapytaniach od Twojej ostatniej wizyty (do odświeżenia strony)',
      onclick: () => showNewsPopup(news, items)
    }, 'Co nowego');
    function updateNewsBtn() {
      const r = newsRows(news, items);
      const n = r.rows.length + r.deleted.length;
      newsBtn.replaceChildren('Co nowego', ...(n ? [h('span', { class: 'news-n' }, String(n))] : []));
    }
    let seq = 0;   // licznik numeracji porządkowej (Lp.), zerowany przy każdym rysowaniu listy
    function draw() {
      seq = 0;
      if (!archive) { drawStrip(); updateNewsBtn(); }
      const list = visible();
      const total = scoped().length;
      summary.textContent = 'Wyświetlono ' + list.length + ' z ' + total + (archive ? ' zapytań w archiwum' : ' aktualnych zapytań');
      resetBtn.style.display = (prefs.q || prefs.period !== 'all' || (!archive && prefs.focus)) ? '' : 'none';
      drawOtherHint();
      if (archive) {
        out.replaceChildren(section('Archiwum', list, 'done'));
      } else {
        // na górze: zapytania z terminem na dziś lub po terminie
        const overdue = list.filter((i) => dueState(i)).sort((a, b) => a.due_date.localeCompare(b.due_date));
        const dueCard = overdue.length
          ? h('section', { class: 'card due-card' },
            h('h2', null, 'Termin dziś lub po terminie (' + overdue.length + ')'),
            h('ul', { class: 'due-list' }, overdue.map((i) => h('li', null,
              h('input', { type: 'checkbox', class: 'tick', 'aria-label': 'Zrobione: ' + i.number, title: 'Odhacz jako zrobione (zdejmuje termin)', onchange: () => tickDone(i) }),
              h('span', { class: 'badge ' + dueState(i) }, DUE_LABEL[dueState(i)]), ' ',
              h('strong', null, fmtDay(i.due_date)), ' · ',
              h('a', { href: '#/inquiries/' + i.id }, i.number), ' ',
              h('span', { class: 'due-note' }, i.client + (i.next_step ? ' — ' + i.next_step : ''))))))
          : null;
        out.replaceChildren(
          ...(dueCard ? [dueCard] : []),
          ...Object.entries(STATUS).map(([k, label]) => section(label, list.filter((i) => i.status === k), k)));
      }
      // wysokość liczymy dopiero, gdy wiersze są już w dokumencie i kolumny mają ostateczną szerokość
      out.querySelectorAll('textarea.next-step').forEach(fitTextarea);
    }

    const backupHolder = h('div');
    const toolbar = h('div', { class: 'toolbar filters' },
      search,
      h('label', { class: 'inline' }, 'Okres', periodSel), range,
      h('label', { class: 'inline' }, 'Sortuj', sortSel),
      basisSel ? h('label', { class: 'inline' }, 'Filtruj wg', basisSel) : null,
      summary, resetBtn);
    shell(navKey,
      pageHead(archive ? 'Archiwum zapytań' : 'Zapytania', archive ? [] : [
        newsBtn,
        h('button', {
          onclick: (e) => exportWeekPlan(visible(), e.currentTarget, { ordered: true, total: scoped().length, filterNote: filterNote() }),
          title: 'Pobiera tabelę tak, jak wygląda lista na ekranie (te same grupy, kolejność i filtry)'
        }, 'Plan tygodnia (PDF)'),
        h('button', { class: 'primary', onclick: () => inquiryForm(null, (id) => { location.hash = '#/inquiries/' + id; }) }, 'Dodaj zapytanie')
      ]),
      archive ? h('p', { class: 'muted archive-note' }, 'Tu trafiają zapytania przeniesione do archiwum. W każdej chwili możesz przywrócić zapytanie do wybranej grupy.') : backupHolder,
      archive ? null : strip,
      toolbar,
      otherHint,
      out);
    root.classList.add('wide');   // lista zajmuje prawie całą szerokość strony
    showRange();
    draw();
    if (!archive) backupBanner(backupHolder, token);
    // odświeżanie na żywo: zmiany innych osób pojawiają się bez przeładowania strony
    watch(() => tableSig('inquiries'), async () => {
      const fresh = await fetchAll('inquiries');
      if (!archive) await Promise.all([loadActivity(), loadNews()]);
      if (token !== routeToken) return;
      items.length = 0;
      items.push(...fresh);
      watchExpect(sigOfRows(items));
      toast('Lista odświeżona: dane zostały zmienione przez inną osobę.');
      draw();
    }, sigOfRows(items));
  }

  async function viewInquiry(id, token) {
    if (!UUID.test(id)) return notFound('inquiries', 'Zapytanie');
    loading('inquiries');
    const [it, notes, history] = await Promise.all([
      q(sb.from('inquiries').select('*').eq('id', id).maybeSingle()),
      q(sb.from('notes').select('*').eq('inquiry_id', id).order('created_at', { ascending: false })),
      loadHistory('inquiries', id)
    ]);
    if (token !== routeToken) return;
    if (!it) return notFound('inquiries', 'Zapytanie');
    const company = it.company_id ? await q(sb.from('companies').select('id,name').eq('id', it.company_id).maybeSingle()) : null;
    if (token !== routeToken) return;

    const archived = isArchived(it);
    const state = dueState(it);
    const moveSel = h('select', {
      'aria-label': archived ? 'Przywróć do' : 'Przenieś do',
      onchange: async () => {
        if (!moveSel.value) return;
        try { await moveInquiry(it, moveSel.value); route(); } catch (ex) { toast(errMsg(ex), true); moveSel.value = ''; }
      }
    },
    h('option', { value: '' }, archived ? 'Przywróć do…' : 'Przenieś do…'),
    (archived ? Object.entries(STATUS) : Object.entries(MOVE_TARGETS).filter(([v]) => v !== it.status)).map(([v, l]) => h('option', { value: v }, l)));

    const actions = [
      h('button', { onclick: () => inquiryForm(it, () => route()) }, 'Edytuj'),
      it.due_date && !archived ? calendarLink(it, 'Dodaj do Kalendarza Google', 'btn') : null,
      moveSel,
      // zapytań nie usuwamy (numery są unikalne, usunięcie zostawiłoby dziury w historii): zamiast tego archiwum, gdzie zapytanie zostaje
      archived ? null : h('button', {
        title: 'Zapytanie zostaje w archiwum na stałe (można je stamtąd przywrócić do wybranej grupy)',
        onclick: async () => {
          try { await moveInquiry(it, 'archive'); location.hash = '#/inquiries'; } catch (ex) { toast(errMsg(ex), true); }
        }
      }, 'Przenieś do archiwum')
    ];

    shell(archived ? 'archive' : 'inquiries',
      pageHead('Zapytanie ' + it.number + (it.client ? ' — ' + it.client : ''), actions,
        archived ? h('a', { href: '#/archive' }, '← Archiwum') : h('a', { href: '#/inquiries' }, '← Zapytania')),
      h('section', { class: 'card' }, details([
        ['Grupa', archived ? 'Archiwum' + (archiveDate(it) ? ' (od ' + fmtDayShort(archiveDate(it)) + ')' : '') + ', ostatnia grupa: ' + STATUS[it.status] : STATUS[it.status]],
        ['Data zapytania', it.received_at ? fmtDay(it.received_at) : ''],
        ['Klient', it.client ? h('a', { href: clientHref(it.client) }, it.client) : ''], ['Kraj', it.country], ['Kod kraju', it.cc],
        ['Opis', it.description], ['Następny krok', it.next_step],
        ['Termin', it.due_date ? h('span', null, fmtDay(it.due_date), state ? ' ' : '', state ? h('span', { class: 'badge ' + state }, DUE_LABEL[state]) : null,
          state ? [' ', h('button', { type: 'button', class: 'link tick-btn', title: 'Odhacz jako zrobione (zdejmuje termin)',
            onclick: () => markDone(it, () => route()).catch((ex) => toast(errMsg(ex), true)) }, '✓ Zrobione')] : null) : ''],
        ['Firma', company ? h('a', { href: '#/companies/' + company.id }, company.name) : ''],
        ['Dodano', fmtDate(it.created_at) + (it.author ? ' · ' + it.author : '')],
        ['Zmieniono', fmtDate(it.updated_at) + (it.updated_by ? ' · ' + it.updated_by : '')]
      ])),
      notesPanel({ inquiryId: id, notes }),
      historyPanel('inquiries', history));
    watch(async () => (await tableSig('inquiries', 'id', id)) + '#' + (await tableSig('notes', 'inquiry_id', id)), reloadView,
      sigOfRows([it]) + '#' + sigOfRows(notes));
  }

  // Strona klienta: ile zapytań ma teraz i ile w archiwum, z listą jednych i drugich
  async function viewClient(raw, token) {
    let name;
    try { name = decodeURIComponent(raw); } catch (_e) { return notFound('inquiries', 'Klient'); }
    loading('inquiries');
    const all = await fetchAll('inquiries');
    if (token !== routeToken) return;
    const key = clientKey(name);
    const mine = all.filter((i) => i.client && clientKey(i.client) === key);
    if (!mine.length) return notFound('inquiries', 'Klient');

    const current = mine.filter((i) => !isArchived(i)).sort(byNumber);
    const archived = mine.filter(isArchived).sort((a, b) => archiveDate(b).localeCompare(archiveDate(a)) || byNumber(b, a));
    const dates = mine.map(inquiryDate).filter(Boolean).sort();
    const companyIds = [...new Set(mine.map((i) => i.company_id).filter(Boolean))];
    const company = companyIds.length === 1 ? await q(sb.from('companies').select('id,name').eq('id', companyIds[0]).maybeSingle()) : null;
    if (token !== routeToken) return;
    const latest = mine.slice().sort(byNumber).pop();
    const shownName = mine[0].client;

    const stat = (n, label, cls) => h('div', { class: 'stat ' + cls }, h('div', { class: 'stat-n' }, String(n)), h('div', { class: 'stat-l' }, label));
    const tableOf = (rows, heads, cells, empty) => (rows.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, heads.map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((i) => h('tr', null, ...cells(i))))))
      : h('p', { class: 'muted' }, empty));

    shell('inquiries',
      pageHead(shownName, [
        h('button', {
          class: 'primary',
          onclick: () => inquiryForm(null, (id) => { location.hash = '#/inquiries/' + id; },
            { client: shownName, country: latest.country, cc: latest.cc, company_id: companyIds.length === 1 ? companyIds[0] : '' })
        }, 'Nowe zapytanie tego klienta')
      ], h('a', { href: '#/inquiries' }, '← Zapytania')),
      h('section', { class: 'card' },
        h('div', { class: 'stats' }, stat(current.length, 'Obecnie', 'cur'), stat(archived.length, 'Archiwalnie', 'arch'), stat(mine.length, 'Razem', 'all')),
        details([
          ['Pierwsze zapytanie', dates.length ? fmtDay(dates[0]) : ''],
          ['Ostatnie zapytanie', dates.length ? fmtDay(dates[dates.length - 1]) : ''],
          ['Kraj', latest.country + (latest.cc ? ' (' + latest.cc + ')' : '')],
          ['Firma w CRM', company ? h('a', { href: '#/companies/' + company.id }, company.name) : '']
        ])),
      h('section', { class: 'card st st-action' }, h('h2', null, 'Aktualne zapytania', h('span', { class: 'count' }, String(current.length))),
        tableOf(current, ['Nr', 'Opis', 'Następny krok', 'Grupa', 'Termin', 'Data zapytania'],
          (i) => [td('Nr', h('a', { href: '#/inquiries/' + i.id }, i.number)), td('Opis', i.description), td('Następny krok', i.next_step),
            td('Grupa', STATUS[i.status]), td('Termin', i.due_date ? fmtDay(i.due_date) : ''), td('Data zapytania', fmtDayShort(inquiryDate(i)))],
          'Brak aktualnych zapytań.')),
      h('section', { class: 'card st st-done' }, h('h2', null, 'Archiwalne zapytania', h('span', { class: 'count' }, String(archived.length))),
        tableOf(archived, ['Nr', 'Opis', 'Data zapytania', 'Zarchiwizowano', 'Ostatnia grupa'],
          (i) => [td('Nr', h('a', { href: '#/inquiries/' + i.id }, i.number)), td('Opis', i.description), td('Data zapytania', fmtDayShort(inquiryDate(i))),
            td('Zarchiwizowano', fmtDayShort(archiveDate(i))), td('Ostatnia grupa', STATUS[i.status])],
          'Brak zapytań w archiwum.')));
    watch(() => tableSig('inquiries'), reloadView, sigOfRows(all));
  }


  // ---------------------------------------------------------------- firmy

  const COMPANY_FIELDS = [
    { name: 'name', label: 'Nazwa firmy', required: true, wide: true },
    { name: 'nip', label: 'NIP', max: 30 }, { name: 'phone', label: 'Telefon', type: 'tel', max: 40 },
    { name: 'email', label: 'E-mail', type: 'email' }, { name: 'website', label: 'Strona WWW' },
    { name: 'address', label: 'Adres' }, { name: 'city', label: 'Miasto' },
    { name: 'description', label: 'Opis', type: 'textarea', wide: true }
  ];

  async function viewCompanies(token) {
    loading('companies');
    const [companies, contacts] = await Promise.all([fetchAll('companies'), fetchAll('contacts')]);
    if (token !== routeToken) return;
    companies.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const counts = {};
    contacts.forEach((c) => { if (c.company_id) counts[c.company_id] = (counts[c.company_id] || 0) + 1; });

    const search = h('input', { type: 'search', placeholder: 'Szukaj firmy (nazwa, NIP, miasto, e-mail, telefon)…', oninput: draw });
    const tbody = h('tbody');
    const empty = h('p', { class: 'empty' });

    function draw() {
      const t = norm(search.value);
      const rows = companies.filter((c) => !t || norm([c.name, c.nip, c.city, c.email, c.phone].join(' ')).includes(t));
      tbody.replaceChildren(...rows.map((c) => h('tr', null,
        td('Nazwa', h('a', { href: '#/companies/' + c.id }, c.name)),
        td('Miasto', c.city), td('Telefon', telLink(c.phone)), td('E-mail', mailLink(c.email)),
        td('Kontakty', String(counts[c.id] || 0)))));
      empty.textContent = rows.length ? '' : (companies.length ? 'Brak wyników wyszukiwania.' : 'Brak firm. Dodaj pierwszą.');
    }

    shell('companies',
      pageHead('Firmy', h('button', {
        class: 'primary',
        onclick: async () => formModal({
          title: 'Nowa firma', fields: withSuggest(COMPANY_FIELDS, { name: (await loadSuggestions()).clients, city: (await loadSuggestions()).cities }),
          onSave: async (d) => { d.updated_by = getAuthor(); const row = await q(sb.from('companies').insert(d).select().single()); location.hash = '#/companies/' + row.id; }
        })
      }, 'Dodaj firmę')),
      h('div', { class: 'toolbar' }, search),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Nazwa', 'Miasto', 'Telefon', 'E-mail', 'Kontakty'].map((t) => h('th', null, t)))), tbody), empty));
    draw();
    watch(async () => (await tableSig('companies')) + '#' + (await tableSig('contacts')), reloadView, sigOfRows(companies) + '#' + sigOfRows(contacts));
  }

  async function viewCompany(id, token) {
    if (!UUID.test(id)) return notFound('companies', 'Firma');
    loading('companies');
    const [company, contacts, inquiries, notes, history] = await Promise.all([
      q(sb.from('companies').select('*').eq('id', id).maybeSingle()),
      q(sb.from('contacts').select('*').eq('company_id', id).order('last_name')),
      q(sb.from('inquiries').select('*').eq('company_id', id)),
      q(sb.from('notes').select('*').eq('company_id', id).order('created_at', { ascending: false })),
      loadHistory('companies', id)
    ]);
    if (token !== routeToken) return;
    if (!company) return notFound('companies', 'Firma');
    const contactsById = Object.fromEntries(contacts.map((c) => [c.id, c]));
    inquiries.sort(byNumber);

    const actions = [
      h('button', {
        onclick: async () => formModal({
          title: 'Edytuj firmę', fields: withSuggest(COMPANY_FIELDS, { city: (await loadSuggestions()).cities }), values: company,
          onSave: async (d) => { await patchResolving('companies', company, d); route(); }
        })
      }, 'Edytuj'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Usunąć firmę „' + company.name + '" wraz z jej historią? Kontakty i zapytania zostaną, ale stracą powiązanie z firmą.')) return;
          try { await q(sb.from('companies').delete().eq('id', id)); location.hash = '#/companies'; } catch (ex) { toast(errMsg(ex), true); }
        }
      }, 'Usuń')
    ];

    shell('companies',
      pageHead(company.name, actions, h('a', { href: '#/companies' }, '← Firmy')),
      h('section', { class: 'card' }, details([
        ['NIP', company.nip], ['Telefon', telLink(company.phone)], ['E-mail', mailLink(company.email)],
        ['WWW', webLink(company.website)], ['Adres', company.address], ['Miasto', company.city], ['Opis', company.description]
      ])),
      h('div', { class: 'grid2' },
        h('section', { class: 'card' },
          h('div', { class: 'page-head' }, h('h2', null, 'Kontakty'),
            h('button', { onclick: () => contactForm(null, { company_id: id }, () => route()) }, 'Dodaj kontakt')),
          contacts.length ? h('ul', { class: 'steps' }, contacts.map((c) => h('li', null,
            h('a', { href: '#/contacts/' + c.id }, personName(c)), c.position ? ' — ' + c.position : ''))) : h('p', { class: 'muted' }, 'Brak kontaktów.')),
        h('section', { class: 'card' }, h('h2', null, 'Zapytania'),
          inquiries.length ? h('p', { class: 'muted' }, 'Obecnie: ' + inquiries.filter((i) => !i.done).length + ' · Archiwalnie: ' + inquiries.filter((i) => i.done).length + ' · Razem: ' + inquiries.length) : null,
          inquiries.length ? h('ul', { class: 'steps' }, inquiries.map((i) => h('li', null,
            h('a', { href: '#/inquiries/' + i.id }, i.number), ' — ' + (i.description || i.client || '').slice(0, 60) + (i.done ? ' (archiwum)' : '')))) : h('p', { class: 'muted' }, 'Brak zapytań.'))),
      notesPanel({ companyId: id, contacts, contactsById, notes }),
      historyPanel('companies', history));
    watch(async () => [await tableSig('companies', 'id', id), await tableSig('contacts', 'company_id', id),
      await tableSig('inquiries', 'company_id', id), await tableSig('notes', 'company_id', id)].join('#'), reloadView,
    [sigOfRows([company]), sigOfRows(contacts), sigOfRows(inquiries), sigOfRows(notes)].join('#'));
  }

  // ---------------------------------------------------------------- kontakty

  async function contactForm(existing, preset, onDone) {
    const companies = (await q(sb.from('companies').select('id,name').order('name'))) || [];
    companies.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    const base = existing || preset || {};
    const sug = await loadSuggestions();
    formModal({
      title: existing ? 'Edytuj kontakt' : 'Nowy kontakt',
      values: base,
      fields: withSuggest([
        { name: 'first_name', label: 'Imię' }, { name: 'last_name', label: 'Nazwisko' },
        { name: 'position', label: 'Stanowisko' },
        { name: 'company_id', label: 'Firma', type: 'select',
          options: [{ value: '', label: '— brak firmy —' }].concat(companies.map((c) => ({ value: c.id, label: c.name }))) },
        { name: 'email', label: 'E-mail', type: 'email' }, { name: 'phone', label: 'Telefon', type: 'tel', max: 40 },
        { name: 'description', label: 'Opis', type: 'textarea', wide: true }
      ], { first_name: sug.firstNames, last_name: sug.lastNames, position: sug.positions }),
      onSave: async (d) => {
        if (!d.first_name && !d.last_name) throw new Error('Podaj imię lub nazwisko.');
        d.company_id = d.company_id || null;
        if (existing) { await patchResolving('contacts', existing, d); onDone(existing.id); }
        else { d.updated_by = getAuthor(); const row = await q(sb.from('contacts').insert(d).select().single()); onDone(row.id); }
      }
    });
  }

  async function viewContacts(token) {
    loading('contacts');
    const [contacts, companies] = await Promise.all([fetchAll('contacts'), fetchAll('companies')]);
    if (token !== routeToken) return;
    const cName = Object.fromEntries(companies.map((c) => [c.id, c.name]));
    contacts.sort((a, b) => personName(a).localeCompare(personName(b), 'pl'));

    const search = h('input', { type: 'search', placeholder: 'Szukaj kontaktu (imię, firma, e-mail, telefon)…', oninput: draw });
    const tbody = h('tbody');
    const empty = h('p', { class: 'empty' });

    function draw() {
      const t = norm(search.value);
      const rows = contacts.filter((c) => !t || norm([personName(c), cName[c.company_id], c.email, c.phone, c.position].join(' ')).includes(t));
      tbody.replaceChildren(...rows.map((c) => h('tr', null,
        td('Imię i nazwisko', h('a', { href: '#/contacts/' + c.id }, personName(c))),
        td('Firma', c.company_id ? h('a', { href: '#/companies/' + c.company_id }, cName[c.company_id] || '') : ''),
        td('Stanowisko', c.position), td('E-mail', mailLink(c.email)), td('Telefon', telLink(c.phone)))));
      empty.textContent = rows.length ? '' : (contacts.length ? 'Brak wyników wyszukiwania.' : 'Brak kontaktów. Dodaj pierwszy.');
    }

    shell('contacts',
      pageHead('Kontakty', h('button', { class: 'primary', onclick: () => contactForm(null, null, (id) => { location.hash = '#/contacts/' + id; }) }, 'Dodaj kontakt')),
      h('div', { class: 'toolbar' }, search),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'stack' },
        h('thead', null, h('tr', null, ['Imię i nazwisko', 'Firma', 'Stanowisko', 'E-mail', 'Telefon'].map((t) => h('th', null, t)))), tbody), empty));
    draw();
    watch(async () => (await tableSig('contacts')) + '#' + (await tableSig('companies')), reloadView, sigOfRows(contacts) + '#' + sigOfRows(companies));
  }

  async function viewContact(id, token) {
    if (!UUID.test(id)) return notFound('contacts', 'Kontakt');
    loading('contacts');
    const [contact, notes, history] = await Promise.all([
      q(sb.from('contacts').select('*').eq('id', id).maybeSingle()),
      q(sb.from('notes').select('*').eq('contact_id', id).order('created_at', { ascending: false })),
      loadHistory('contacts', id)
    ]);
    if (token !== routeToken) return;
    if (!contact) return notFound('contacts', 'Kontakt');
    const company = contact.company_id ? await q(sb.from('companies').select('id,name').eq('id', contact.company_id).maybeSingle()) : null;
    if (token !== routeToken) return;

    const actions = [
      h('button', { onclick: () => contactForm(contact, null, () => route()) }, 'Edytuj'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Usunąć kontakt ' + personName(contact) + ' wraz z jego wpisami w historii?')) return;
          try { await q(sb.from('contacts').delete().eq('id', id)); location.hash = '#/contacts'; } catch (ex) { toast(errMsg(ex), true); }
        }
      }, 'Usuń')
    ];

    shell('contacts',
      pageHead(personName(contact), actions, h('a', { href: '#/contacts' }, '← Kontakty')),
      h('section', { class: 'card' }, details([
        ['Firma', company ? h('a', { href: '#/companies/' + company.id }, company.name) : ''],
        ['Stanowisko', contact.position], ['E-mail', mailLink(contact.email)], ['Telefon', telLink(contact.phone)],
        ['Opis', contact.description]
      ])),
      notesPanel({ companyId: contact.company_id, contactId: id, notes }),
      historyPanel('contacts', history));
    watch(async () => (await tableSig('contacts', 'id', id)) + '#' + (await tableSig('notes', 'contact_id', id)), reloadView,
      sigOfRows([contact]) + '#' + sigOfRows(notes));
  }

  // ---------------------------------------------------------------- eksport (kopia zapasowa)

  function csvCell(v) {
    let s = String(v == null ? '' : v);
    // ochrona przed wstrzyknięciem formuł w Excelu (numery telefonów zostają bez zmian)
    if (/^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s()\-]+$/.test(s)) s = "'" + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadFile(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCsv(name, headers, rows) {
    const text = '﻿' + [headers].concat(rows).map((r) => r.map(csvCell).join(';')).join('\r\n');
    downloadFile(name + '-' + new Date().toISOString().slice(0, 10) + '.csv', text, 'text/csv;charset=utf-8');
  }

  // ---- pełna kopia zapasowa (JSON); data ostatniej kopii jest zapisana w bazie, więc widzą ją wszyscy użytkownicy
  const BACKUP_DAYS = 30;
  const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);

  // zwraca wiersz z datą ostatniej kopii, null (nigdy nie robiono) albo undefined (nie udało się sprawdzić)
  async function loadBackupInfo() {
    try { return (await q(sb.from('app_state').select('*').eq('key', 'last_backup_at').maybeSingle())) || null; } catch (_e) { return undefined; }
  }

  async function makeBackup() {
    const tables = {};
    for (const t of ['inquiries', 'companies', 'contacts', 'notes']) tables[t] = await fetchAll(t);
    const now = new Date().toISOString();
    const payload = { format: 'crm-backup', version: 1, created_at: now, created_by: getAuthor(), app: appName, company, tables };
    downloadFile('crm-kopia-zapasowa-' + now.slice(0, 10) + '.json', JSON.stringify(payload, null, 1), 'application/json');
    await q(sb.from('app_state').upsert({ key: 'last_backup_at', value: now, updated_at: now, updated_by: getAuthor() }));
    return now;
  }

  const backupSnoozed = () => { try { return Number(localStorage.getItem('crm_backup_snooze') || 0) > Date.now(); } catch (_e) { return false; } };

  // Baner na liście zapytań: gdy kopii nie robiono nigdy albo ostatnia jest starsza niż BACKUP_DAYS dni
  async function backupBanner(holder, token) {
    if (backupSnoozed()) return;
    const info = await loadBackupInfo();
    if (info === undefined || token !== routeToken) return;
    const days = info ? daysSince(info.value) : null;
    if (info && days < BACKUP_DAYS) return;
    const btn = h('button', {
      class: 'primary',
      onclick: async () => {
        btn.disabled = true;
        try { await makeBackup(); holder.replaceChildren(); toast('Kopia zapasowa pobrana. Zapisz plik w bezpiecznym miejscu.'); } catch (ex) { toast(errMsg(ex), true); btn.disabled = false; }
      }
    }, 'Pobierz kopię teraz');
    const later = h('button', {
      class: 'link',
      onclick: () => {
        try { localStorage.setItem('crm_backup_snooze', String(Date.now() + 7 * 864e5)); } catch (_e) { /* tryb prywatny */ }
        holder.replaceChildren();
      }
    }, 'Przypomnij za tydzień');
    holder.replaceChildren(h('div', { class: 'card banner warn', role: 'status' },
      h('span', null, (info ? 'Ostatnia pełna kopia zapasowa: ' + days + ' dni temu (' + fmtDate(info.value) + (info.updated_by ? ', ' + info.updated_by : '') + '). ' : 'Nie wykonano jeszcze pełnej kopii zapasowej. '),
        // dłuższe wyjaśnienie znika na telefonie (klasa banner-extra), żeby baner zajmował mniej miejsca
        h('span', { class: 'banner-extra' }, 'Darmowa baza nie robi jej sama: pobierz plik i zapisz go w bezpiecznym miejscu.')),
      btn, later));
  }

  const EXPORTS = {
    inquiries: ['Zapytania', async () => {
      const [rows, companies] = await Promise.all([fetchAll('inquiries'), fetchAll('companies')]);
      const cName = Object.fromEntries(companies.map((c) => [c.id, c.name]));
      return [['Numer', 'Data zapytania', 'Klient', 'Kraj', 'Kod kraju', 'Opis', 'Następny krok', 'Termin', 'Grupa', 'Archiwum', 'Data archiwizacji', 'Firma', 'Dodał(a)', 'Dodano', 'Zmieniono'],
        rows.sort(byNumber).map((i) => [i.number, inquiryDate(i), i.client, i.country, i.cc, i.description, i.next_step, i.due_date, STATUS[i.status], isArchived(i) ? 'tak' : 'nie', archiveDate(i), cName[i.company_id], i.author, fmtDate(i.created_at), fmtDate(i.updated_at)])];
    }],
    companies: ['Firmy', async () => {
      const rows = await fetchAll('companies');
      return [['Nazwa', 'NIP', 'Telefon', 'E-mail', 'WWW', 'Adres', 'Miasto', 'Opis', 'Dodano'],
        rows.map((c) => [c.name, c.nip, c.phone, c.email, c.website, c.address, c.city, c.description, fmtDate(c.created_at)])];
    }],
    contacts: ['Kontakty', async () => {
      const [rows, companies] = await Promise.all([fetchAll('contacts'), fetchAll('companies')]);
      const cName = Object.fromEntries(companies.map((c) => [c.id, c.name]));
      return [['Imię', 'Nazwisko', 'Stanowisko', 'Firma', 'E-mail', 'Telefon', 'Opis', 'Dodano'],
        rows.map((c) => [c.first_name, c.last_name, c.position, cName[c.company_id], c.email, c.phone, c.description, fmtDate(c.created_at)])];
    }],
    notes: ['Historia', async () => {
      const [rows, inquiries, companies, contacts] = await Promise.all([
        fetchAll('notes'), fetchAll('inquiries'), fetchAll('companies'), fetchAll('contacts')]);
      const iNum = Object.fromEntries(inquiries.map((i) => [i.id, i.number]));
      const cName = Object.fromEntries(companies.map((c) => [c.id, c.name]));
      const kName = Object.fromEntries(contacts.map((c) => [c.id, personName(c)]));
      return [['Data', 'Typ', 'Autor', 'Zapytanie', 'Firma', 'Kontakt', 'Treść'],
        rows.map((n) => [fmtDate(n.created_at), NOTE_KINDS[n.kind], n.author, iNum[n.inquiry_id], cName[n.company_id], kName[n.contact_id], n.body])];
    }]
  };

  function viewExport() {
    const buttons = Object.entries(EXPORTS).map(([key, [label, load]]) => {
      const b = h('button', {
        onclick: async () => {
          b.disabled = true;
          try { const [headers, data] = await load(); downloadCsv('crm-' + key, headers, data); } catch (ex) { toast(errMsg(ex), true); }
          b.disabled = false;
        }
      }, label);
      return b;
    });
    const planBtn = h('button', {
      class: 'primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        try { exportWeekPlan(await fetchAll('inquiries'), btn); } catch (ex) { toast(errMsg(ex), true); }
      }
    }, 'Pobierz plan tygodnia (PDF)');
    const lastBackup = h('p', { class: 'backup-last' });
    const backupBtn = h('button', {
      class: 'primary',
      onclick: async () => {
        backupBtn.disabled = true;
        try {
          const at = await makeBackup();
          lastBackup.textContent = 'Ostatnia kopia: ' + fmtDate(at) + ' (' + (getAuthor() || 'ty') + '), przed chwilą.';
          toast('Kopia zapasowa pobrana. Zapisz plik w bezpiecznym miejscu.');
        } catch (ex) { toast(errMsg(ex), true); }
        backupBtn.disabled = false;
      }
    }, 'Pobierz pełną kopię (JSON)');
    shell('export',
      pageHead('Eksport danych'),
      h('section', { class: 'card' }, h('h2', null, 'Plan tygodnia (PDF)'),
        h('p', { class: 'muted' }, 'Tabela wszystkich otwartych zapytań z aktualnymi etapami, pogrupowana wg etapu (wymaga działania, do przypomnienia, czekamy). Numer tygodnia i data są ustawiane automatycznie.'),
        h('div', { class: 'actions' }, planBtn)),
      h('section', { class: 'card' }, h('h2', null, 'Pełna kopia zapasowa (JSON)'),
        h('p', { class: 'muted' }, 'Darmowy plan Supabase nie tworzy kopii zapasowych. Jeden plik zawiera wszystkie zapytania, firmy, kontakty i notatki. Zalecane co najmniej raz w miesiącu; zapisz plik w bezpiecznym miejscu (nie tylko na tym komputerze).'),
        lastBackup,
        h('div', { class: 'actions' }, backupBtn)),
      h('section', { class: 'card' }, h('h2', null, 'Tabele do Excela (CSV)'),
        h('p', { class: 'muted' }, 'Wygodne do przeglądania i filtrowania w Excelu. To nie jest pełna kopia zapasowa (nie zawiera wszystkich pól).'),
        h('div', { class: 'actions' }, buttons)));
    loadBackupInfo().then((info) => {
      if (info === undefined) return;
      lastBackup.textContent = info
        ? 'Ostatnia kopia: ' + fmtDate(info.value) + (info.updated_by ? ' (' + info.updated_by + ')' : '') + ', ' + daysSince(info.value) + ' dni temu.'
        : 'Nie wykonano jeszcze żadnej pełnej kopii zapasowej.';
    });
  }

  // ---------------------------------------------------------------- routing

  async function route() {
    const token = ++routeToken;
    watcher = null;          // odświeżanie na żywo dotyczy tylko aktualnie oglądanego widoku
    pendingChange = false;
    try {
      if (!sb) return;
      if (!session) return renderAccess();

      const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
      if (a === 'note') {   // skrót „Dodaj notatkę” z ikony aplikacji na Androidzie: lista zapytań + okno notatki
        history.replaceState(null, '', location.pathname + location.search + '#/inquiries');
        await viewInquiries(token, false);
        if (token === routeToken) openVoiceNote();
      } else if (a === 'moje') {   // adres .../#/moje: okno prywatnych zadań (przy pierwszym razie z prośbą o drugi kod)
        history.replaceState(null, '', location.pathname + location.search + '#/inquiries');
        await viewInquiries(token, false);
        if (token === routeToken) openTasks();
      } else if (a === 'companies') await (b ? viewCompany(b, token) : viewCompanies(token));
      else if (a === 'contacts') await (b ? viewContact(b, token) : viewContacts(token));
      else if (a === 'export') viewExport();
      else if (a === 'archive') await viewInquiries(token, true);
      else if (a === 'client' && b) await viewClient(b, token);
      else await (a === 'inquiries' && b ? viewInquiry(b, token) : viewInquiries(token, false));

      // Przy pierwszym wejściu poproś o imię (do podpisywania wpisów)
      if (token === routeToken && !getAuthor() && !nameAsked) {
        nameAsked = true;
        nameModal();
      }
    } catch (ex) {
      if (token === routeToken) renderError(ex);
    }
  }

  async function boot() {
    document.title = (company ? company + ' ' : '') + appName;
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || !cfg.ACCESS_EMAIL || !window.supabase) return renderSetup();

    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

    // oznaczamy zapisy (insert/update/delete), żeby q() mógł pokazać wskaźnik zapisu
    const rawFrom = sb.from.bind(sb);
    sb.from = (table) => {
      const b = rawFrom(table);
      ['insert', 'update', 'delete', 'upsert'].forEach((m) => {
        const fn = b[m];
        if (typeof fn === 'function') {
          b[m] = function () {
            const r = fn.apply(b, arguments);
            if (r && typeof r === 'object') r.__write = true;
            return r;
          };
        }
      });
      return b;
    };

    // Prywatne zadania: osobny klient z osobną sesją (inny klucz w pamięci przeglądarki), tylko gdy w config.js jest PRIVATE_EMAIL
    if (cfg.PRIVATE_EMAIL) {
      psb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { storageKey: 'crm-private-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
      const pd = await psb.auth.getSession();
      privateSession = pd.data.session;
      psb.auth.onAuthStateChange((ev, s) => { privateSession = s; });
      if (privateSession) refreshTaskCount();
      setInterval(refreshTaskCount, 300000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTaskCount(); });
    }

    // Link z kodem: https://adres-aplikacji/#k=KOD  (kod w części po #, więc nie trafia do serwera ani w nagłówek Referer)
    const m = location.hash.match(/[#&]k=([^&]+)/);
    if (m) {
      const { error } = await sb.auth.signInWithPassword({ email: cfg.ACCESS_EMAIL, password: decodeURIComponent(m[1]) });
      if (error) accessError = errMsg(error);
      history.replaceState(null, '', location.pathname + location.search + '#/inquiries');
    }

    const { data } = await sb.auth.getSession();
    session = data.session;
    lastUserId = session ? session.user.id : null;

    sb.auth.onAuthStateChange((event, s) => {
      session = s;
      const uid = s ? s.user.id : null;
      // przeładowuj widok tylko przy faktycznej zmianie stanu dostępu (nie przy odświeżaniu tokenu)
      if (uid !== lastUserId) {
        lastUserId = uid;
        setTimeout(route, 0);
      }
    });

    window.addEventListener('hashchange', route);

    // Chrome na Androidzie zgłasza, że aplikację można zainstalować: zatrzymujemy jego małe okienko i pokazujemy własny, wyraźny baner
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; paintInstall(); });
    window.addEventListener('appinstalled', () => { installEvent = null; hideInstall(3650); });

    // odświeżanie na żywo: cyklicznie oraz po powrocie do karty lub odzyskaniu połączenia
    setInterval(pollTick, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollTick(); });
    window.addEventListener('focus', pollTick);
    window.addEventListener('online', pollTick);
    document.addEventListener('focusout', () => setTimeout(() => {
      if (pendingChange && !userIsEditing()) pollTick();
      // pole zmienione i cofnięte nie zapisuje się, więc zdejmujemy ostrzeżenie o niezapisanej zmianie
      const el = document.getElementById('savestate');
      if (dirtyEdit && !pendingWrites) { dirtyEdit = false; if (el) el.className = ''; }
    }, 400));

    // niezapisana zmiana w polu listy (zapis następuje po kliknięciu poza polem)
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('.table-wrap') && /^(TEXTAREA|INPUT)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'date') saveState('dirty');
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirtyEdit) { e.preventDefault(); e.returnValue = ''; }
    });

    // po zmianie szerokości okna kolumny się zmieniają, więc dopasuj wysokość pól ponownie
    window.addEventListener('resize', () => document.querySelectorAll('textarea.next-step').forEach(fitTextarea));
    route();
  }

  boot();
})();
