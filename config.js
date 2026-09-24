// Konfiguracja aplikacji. Wartości w podwójnych podkreślnikach uzupełnia skrypt przygotuj.ps1 (URUCHOM.bat).
// Klucz "publishable" jest publiczny z założenia: dostępu do danych pilnują reguły bazy oraz kod dostępu z linku.
// NIGDY nie wklejaj tu klucza "secret" ani "service_role".
window.CRM_CONFIG = {
  APP_NAME: 'CRM',
  COMPANY_NAME: '__NAZWA_FIRMY__',
  SUPABASE_URL: '__SUPABASE_URL__',
  SUPABASE_ANON_KEY: '__SUPABASE_KLUCZ__',
  ACCESS_EMAIL: '__EMAIL_DOSTEPOWY__',
  // Prywatne zadania właściciela (przycisk "Moje zadania"): adres osobnego konta z własnym kodem. Puste = funkcja wyłączona i niewidoczna.
  PRIVATE_EMAIL: '__EMAIL_PRYWATNY__'
};
