<#
  Przygotowanie własnego CRM.
  Zamienia wzorcowe pliki w komplet gotowy do wgrania (nazwa firmy, adres bazy, ikony, skrypt SQL).
  Uruchom dwuklikiem na URUCHOM.bat (albo: powershell -ExecutionPolicy Bypass -File przygotuj.ps1).
  Skrypt niczego nie wysyła do internetu i niczego nie instaluje. Wynik trafia do folderu GOTOWE obok skryptu.
#>
param(
  [string]$NazwaFirmy,
  [string]$EmailDostepowy,
  [string]$EmailPrywatny,   # opcjonalnie: adres konta prywatnego (prywatne zadania właściciela); puste = bez tej funkcji
  [string]$SupabaseUrl,
  [string]$SupabaseKlucz,
  [string]$Wyjscie,      # opcjonalnie: inny folder wynikowy (domyślnie GOTOWE obok skryptu)
  [switch]$Cicho         # bez pytań i bez otwierania Eksploratora (do testów)
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail($msg) { Write-Host ''; Write-Host "BŁĄD: $msg" -ForegroundColor Red; Write-Host ''; exit 1 }

function Ask($label, $current, $hint) {
  if ($current) { return $current.Trim() }
  if ($Cicho) { Fail "Brak wartości: $label" }
  if ($hint) { Write-Host "   ($hint)" -ForegroundColor DarkGray }
  return (Read-Host $label).Trim()
}

function JsEscape($s)   { return $s.Replace('\', '\\').Replace("'", "\'") }
function JsonEscape($s) { return $s.Replace('\', '\\').Replace('"', '\"') }
function HtmlEscape($s) { return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;') }

function Decode-JwtPayload($jwt) {
  $p = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
  switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
}

function New-Icon($size, $letter, $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#111111'))
  $font = New-Object System.Drawing.Font('Segoe UI', [single]($size * 0.52), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $g.DrawString($letter, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Write-Host ''
Write-Host '=== Przygotowanie własnego CRM ===' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------- dane wejściowe
$firma = Ask 'Nazwa Twojej firmy' $NazwaFirmy 'np. Kowalski Meble; pojawi się w nagłówku, w PDF i w wydarzeniach kalendarza'
if (-not $firma) { Fail 'Nazwa firmy nie może być pusta.' }
if ($firma.Length -gt 40) { Fail 'Nazwa firmy jest za długa (maks. 40 znaków).' }

$email = Ask 'Adres e-mail wspólnego konta dostępowego' $EmailDostepowy 'może być nieistniejący, np. dostep@example.com; ten sam wpiszesz w Supabase'
if (-not $email) { $email = 'dostep@example.com' }
if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail "To nie wygląda na adres e-mail: $email" }
# konto prywatne właściciela (przycisk "Moje zadania"): w tej paczce domyślnie WŁĄCZONE; wpisz - (myślnik), żeby wyłączyć
$domyslnyPryw = 'prywatne@example.com'
$emailPryw = ''
if ($EmailPrywatny) { $emailPryw = $EmailPrywatny.Trim() }
elseif ($Cicho) { $emailPryw = $domyslnyPryw }
else {
  Write-Host '   (osobne konto z własnym kodem na prywatne zadania właściciela; Enter = prywatne@example.com, wpisz - żeby wyłączyć tę funkcję)' -ForegroundColor DarkGray
  $emailPryw = (Read-Host 'Adres e-mail konta prywatnego').Trim()
  if (-not $emailPryw) { $emailPryw = $domyslnyPryw }
}
if ($emailPryw -in '-', 'brak', 'nie') { $emailPryw = '' }   # myślnik wpisany w pytaniu (parametr z wiersza poleceń: brak)
if ($emailPryw) {
  if ($emailPryw -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Fail "To nie wygląda na adres e-mail: $emailPryw" }
  if ($emailPryw -ieq $email) { Fail 'Adres konta prywatnego musi być inny niż adres wspólnego konta dostępowego.' }
}

$url = Ask 'Project URL z Supabase' $SupabaseUrl 'wygląda tak: https://abcdefgh.supabase.co'
$url = $url.TrimEnd('/')
if ($url -notmatch '^https://[a-z0-9-]+\.supabase\.co$') { Fail "Adres projektu powinien mieć postać https://XXXX.supabase.co, a wpisano: $url" }

$klucz = Ask 'Klucz publishable (lub anon) z Supabase' $SupabaseKlucz 'Project Settings → API Keys; NIGDY nie wpisuj klucza secret ani service_role'
if ($klucz -match '^sb_secret_') { Fail 'To jest klucz SECRET (tajny). Nie wolno go używać w aplikacji. Wybierz klucz „Publishable”.' }
if ($klucz -match '^eyJ') {
  try { $role = (Decode-JwtPayload $klucz).role } catch { Fail 'Nie udało się odczytać klucza. Skopiuj go ponownie w całości.' }
  if ($role -eq 'service_role') { Fail 'To jest klucz SERVICE_ROLE (tajny). Nie wolno go używać w aplikacji. Wybierz klucz „anon” lub „Publishable”.' }
} elseif ($klucz -notmatch '^sb_publishable_[A-Za-z0-9_\-]+$') {
  Fail 'Klucz powinien zaczynać się od sb_publishable_ (albo eyJ dla starszego klucza anon).'
}

# ---------------------------------------------------------------- budowa wyniku
$out = if ($Wyjscie) { $Wyjscie } else { Join-Path $root 'GOTOWE' }
$site = Join-Path $out 'do-publikacji'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $site -Force | Out-Null

Copy-Item -Path (Join-Path $root 'strona\*') -Destination $site -Recurse

function Patch($file, $map) {
  $t = [IO.File]::ReadAllText($file, $utf8)
  foreach ($k in $map.Keys) { $t = $t.Replace($k, $map[$k]) }
  [IO.File]::WriteAllText($file, $t, $utf8)
}
Patch (Join-Path $site 'config.js') @{
  '__NAZWA_FIRMY__' = (JsEscape $firma); '__SUPABASE_URL__' = $url; '__SUPABASE_KLUCZ__' = $klucz; '__EMAIL_DOSTEPOWY__' = (JsEscape $email); '__EMAIL_PRYWATNY__' = (JsEscape $emailPryw)
}
Patch (Join-Path $site 'index.html')            @{ '__NAZWA_FIRMY__' = (HtmlEscape $firma) }
Patch (Join-Path $site 'manifest.webmanifest')  @{ '__NAZWA_FIRMY__' = (JsonEscape $firma) }

# ikony aplikacji: pierwsza litera nazwy firmy na czarnym tle
$letter = ($firma.ToCharArray() | Where-Object { [char]::IsLetterOrDigit($_) } | Select-Object -First 1)
if (-not $letter) { $letter = 'C' }
$letter = ([string]$letter).ToUpper()
New-Icon 192 $letter (Join-Path $site 'icon-192.png')
New-Icon 512 $letter (Join-Path $site 'icon-512.png')
New-Icon 180 $letter (Join-Path $site 'apple-touch-icon.png')

# skrypt SQL do wklejenia w Supabase (z adresem konta dostępowego)
$schema = [IO.File]::ReadAllText((Join-Path $root 'supabase\schema.sql'), $utf8).Replace('__EMAIL_DOSTEPOWY__', $email)
if ($emailPryw) {
  $schema = $schema.TrimEnd() + "`r`n`r`n" + [IO.File]::ReadAllText((Join-Path $root 'supabase\moje_zadania.sql'), $utf8).Replace('__EMAIL_PRYWATNY__', $emailPryw)
}
[IO.File]::WriteAllText((Join-Path $out '1_schema_do_wklejenia.sql'), $schema, $utf8)
$przyklad = [IO.File]::ReadAllText((Join-Path $root 'supabase\dane_przykladowe.sql'), $utf8)
if ($emailPryw) { $przyklad = $przyklad.TrimEnd() + "`r`n`r`n" + [IO.File]::ReadAllText((Join-Path $root 'supabase\zadania_przykladowe.sql'), $utf8) }
[IO.File]::WriteAllText((Join-Path $out '2_dane_przykladowe_OPCJONALNIE.sql'), $przyklad, $utf8)

# kontrola: w wyniku nie może zostać żaden niewypełniony znacznik
$left = Get-ChildItem $out -Recurse -File | Where-Object { $_.Extension -in '.js', '.html', '.webmanifest', '.sql' } |
  Where-Object { [IO.File]::ReadAllText($_.FullName, $utf8) -match '__[A-Z_]{4,}__' }
if ($left) { Fail ('Nie wszystkie znaczniki zostały uzupełnione w: ' + (($left | ForEach-Object { $_.Name }) -join ', ')) }

# ---------------------------------------------------------------- podsumowanie
Write-Host ''
Write-Host 'GOTOWE. Wynik jest w folderze:' -ForegroundColor Green
Write-Host "   $out"
Write-Host ''
Write-Host 'Co dalej (szczegóły w START-TUTAJ.html, kroki 4 i dalej):' -ForegroundColor Cyan
Write-Host '   1. W Supabase (SQL Editor) wklej i uruchom plik 1_schema_do_wklejenia.sql'
Write-Host '   2. Wyłącz w Supabase rejestrację nowych użytkowników i zapisz zmianę'
Write-Host "   3. Utwórz w Supabase użytkownika o adresie: $email (hasło = Twój kod dostępu)"
Write-Host '   4. Wgraj zawartość folderu do-publikacji do Cloudflare'
Write-Host '   5. Uruchom SPRAWDZ.bat, żeby upewnić się, że dane są zabezpieczone'
if ($emailPryw) {
  Write-Host ''
  Write-Host 'Prywatne zadania (włączone):' -ForegroundColor Cyan
  Write-Host "   Dodatkowo utwórz w Supabase drugiego użytkownika o adresie: $emailPryw (hasło = Twój prywatny kod, zaznacz Auto Confirm User)"
  Write-Host '   Po wgraniu strony otwórz jej adres z dopiskiem #/moje i wpisz prywatny kod'
}
Write-Host ''
if (-not $Cicho) { Start-Process explorer.exe $out }
