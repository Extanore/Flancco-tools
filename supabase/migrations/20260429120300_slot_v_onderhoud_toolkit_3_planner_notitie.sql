-- Slot V Toolkit-3: planner_notitie op clients voor klant-preferences
ALTER TABLE clients ADD COLUMN IF NOT EXISTS planner_notitie TEXT NULL;
COMMENT ON COLUMN clients.planner_notitie IS
  'Slot V Toolkit-3: vrije tekst voor klant-preferences (voorkeuren, taal, contact-stijl). Geen GDPR-gevoelige content (medisch/financieel) — gebruik aparte velden indien nodig.';
