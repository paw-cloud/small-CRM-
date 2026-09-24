<#
  Kontrola bezpieczeństwa własnego CRM.
  Sprawdza z zewnątrz (tak, jak zrobiłaby to obca osoba), czy:
    - rejestracja nowych użytkowników jest wyłączona,
    - logowanie anonimowe jest wyłączone,
    - dane (zapytania, firmy, kontakty, notatki) są niedostępne bez logowania,
    - opcjonalnie: strona jest opublikowana i pokazuje tylko ekran z prośbą o kod.
  Uruchom dwuklikiem na SPRAWDZ.bat po wykonaniu kroków z instrukcji.
#>
param(
  [string]$Folder,   # folder do-publikacji z gotowym config.js (domyślnie GOTOWE\do-publikacji obok skryptu)
  [string]$Adres     # opcjonalnie: adres opublikowanej strony (https://...)
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Folder) { $Folder = Join-Path $root 'GOTOWE\do-publikacji' }
$cfgFile = Join-Path $Folder 'config.js'
if (-not (Test-Path $cfgFile)) { Write-Host "Nie znaleziono $cfgFile. Najpierw uruchom URUCHOM.bat." -ForegroundColor Red; exit 1 }

$cfg = [IO.File]::ReadAllText($cfgFile, (New-Object System.Text.UTF8Encoding($false)))
function Cfg($name) { $m = [regex]::Match($cfg, "$name\s*:\s*'([^']*)'"); if ($m.Success) { $m.Groups[1].Value } else { '' } }
$url = Cfg 'SUPABASE_URL'; $key = Cfg 'SUPABASE_ANON_KEY'
if (-not $url -or -not $key) { Write-Host 'W config.js brakuje adresu lub klucza Supabase.' -ForegroundColor Red; exit 1 }

$bad = 0
function Ok($msg)   { Write-Host "  [OK]    $msg" -ForegroundColor Green }
function Err($msg)  { Write-Host "  [BŁĄD]  $msg" -ForegroundColor Red; $script:bad++ }
function Info($msg) { Write-Host "  [INFO]  $msg" -ForegroundColor DarkGray }

function Get-Status($uri, $headers) {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers $headers -TimeoutSec 30; return @{ Code = [int]$r.StatusCode; Body = $r.Content } }
  catch {
    $resp = $_.Exception.Response
    if ($resp) { return @{ Code = [int]$resp.StatusCode; Body = '' } }
    return @{ Code = 0; Body = $_.Exception.Message }
  }
}

Write-Host ''
Write-Host "=== Kontrola bezpieczeństwa: $url ===" -ForegroundColor Cyan
$h = @{ apikey = $key }

Write-Host ''
Write-Host 'Ustawienia logowania:'
try {
  $s = Invoke-RestMethod -Uri "$url/auth/v1/settings" -Headers $h -TimeoutSec 30
  if ($s.disable_signup -eq $true) { Ok 'Rejestracja nowych użytkowników jest wyłączona.' }
  else { Err 'Rejestracja jest WŁĄCZONA. Wyłącz „Allow new users to sign up” w Supabase (Authentication → Sign In / Providers) i kliknij Save.' }
  if ($s.external.anonymous_users -eq $false) { Ok 'Logowanie anonimowe jest wyłączone.' }
  else { Err 'Logowanie anonimowe jest WŁĄCZONE. Wyłącz „Allow anonymous sign-ins”.' }
  if ($s.external.email -eq $true) { Ok 'Logowanie e-mailem i hasłem działa (potrzebne do wejścia z linku).' }
  else { Err 'Logowanie e-mailem jest wyłączone. Włącz dostawcę „Email”.' }
} catch { Err "Nie udało się odczytać ustawień (sprawdź adres i klucz w config.js): $($_.Exception.Message)" }

Write-Host ''
Write-Host 'Dostęp do danych bez logowania (powinien być zablokowany):'
foreach ($t in 'inquiries', 'companies', 'contacts', 'notes', 'audit_log', 'app_state') {
  $r = Get-Status "$url/rest/v1/$t`?select=id&limit=1" $h
  if ($r.Code -in 401, 403) { Ok "Tabela ${t}: dostęp zablokowany." }
  elseif ($r.Code -eq 404) { Err "Tabela $t nie istnieje. Uruchom w Supabase plik 1_schema_do_wklejenia.sql." }
  elseif ($r.Code -eq 200 -and $r.Body.Trim() -eq '[]') { Info "Tabela ${t}: brak danych i odczyt dozwolony. Sprawdź, czy skrypt SQL został uruchomiony w całości." ; $bad++ }
  elseif ($r.Code -eq 200) { Err "Tabela $t jest ODCZYTYWALNA BEZ LOGOWANIA. Uruchom ponownie plik 1_schema_do_wklejenia.sql." }
  else { Info "Tabela ${t}: nieoczekiwany wynik (kod $($r.Code))." }
}

if (Cfg 'PRIVATE_EMAIL') {
  $r = Get-Status "$url/rest/v1/my_tasks`?select=id&limit=1" $h
  if ($r.Code -in 401, 403) { Ok 'Tabela my_tasks (prywatne zadania): dostęp zablokowany.' }
  elseif ($r.Code -eq 404) { Err 'Tabela my_tasks nie istnieje. Uruchom w Supabase plik 1_schema_do_wklejenia.sql (albo usuń PRIVATE_EMAIL z config.js).' }
  elseif ($r.Code -eq 200) { Err 'Tabela my_tasks jest ODCZYTYWALNA BEZ LOGOWANIA. Uruchom ponownie plik 1_schema_do_wklejenia.sql.' }
  else { Info "Tabela my_tasks: nieoczekiwany wynik (kod $($r.Code))." }
}
Write-Host ''
Write-Host 'Funkcja ping() (do monitoringu i ochrony przed uśpieniem projektu):'
$p = Get-Status "$url/rest/v1/rpc/ping" $h
if ($p.Code -eq 200) { Ok 'ping() odpowiada. Możesz podpiąć darmowy monitoring (np. UptimeRobot) pod ten adres.' }
else { Err "ping() nie działa (kod $($p.Code)). Uruchom ponownie plik 1_schema_do_wklejenia.sql." }

if ($Adres) {
  Write-Host ''
  Write-Host "Strona: $Adres"
  $Adres = $Adres.TrimEnd('/')
  $r = Get-Status "$Adres/" @{}
  if ($r.Code -eq 200) { Ok 'Strona jest opublikowana.' } else { Err "Strona nie odpowiada poprawnie (kod $($r.Code))." }
  try {
    $hr = Invoke-WebRequest -UseBasicParsing -Uri "$Adres/" -TimeoutSec 30
    if ($hr.Headers['X-Content-Type-Options'] -eq 'nosniff') { Ok 'Nagłówki bezpieczeństwa są aktywne (plik _headers został wgrany).' }
    else { Info 'Brak nagłówków bezpieczeństwa: sprawdź, czy wgrano plik _headers. Strona działa, ale ma słabszą ochronę.' }
  } catch { }
  $c = Get-Status "$Adres/config.js" @{}
  # szukamy prawdziwych kluczy, a nie słów w komentarzach: klucza sb_secret_... albo tokenu JWT z rolą service_role
  $secret = [regex]::IsMatch($c.Body, 'sb_secret_[A-Za-z0-9_\-]{6,}')
  foreach ($m in [regex]::Matches($c.Body, 'eyJ[A-Za-z0-9_\-]{10,}\.([A-Za-z0-9_\-]{10,})\.[A-Za-z0-9_\-]*')) {
    try {
      $p = $m.Groups[1].Value.Replace('-', '+').Replace('_', '/')
      switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
      if (([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json).role -eq 'service_role') { $secret = $true }
    } catch { }
  }
  if ($secret) { Err 'W opublikowanym config.js jest klucz TAJNY. Usuń go i wgraj plik ponownie.' }
  elseif ($c.Code -eq 200) { Ok 'W opublikowanym pliku konfiguracji nie ma tajnych kluczy.' }
}

Write-Host ''
if ($bad -eq 0) { Write-Host 'WYNIK: wszystko w porządku.' -ForegroundColor Green }
else { Write-Host "WYNIK: znaleziono problemy ($bad). Popraw je i uruchom kontrolę ponownie." -ForegroundColor Yellow }
Write-Host ''
if ($bad -gt 0) { exit 1 }
