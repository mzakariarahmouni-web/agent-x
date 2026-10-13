-- Agent X : schéma initial (D1 / SQLite).

-- Réglages et clés (les clés sont chiffrées en AES-GCM avec une clé dérivée de ADMIN_TOKEN).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Clients finaux : exigences récurrentes apprises (F2).
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  learned TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX clients_name ON clients(lower(name));

-- Missions : fiche modèle versionnée, statut, échéance de 48 h ouvrées.
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  fiche TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  sender_name TEXT,
  status TEXT NOT NULL DEFAULT 'brouillon',
  workflow_id TEXT,
  deadline_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX missions_status ON missions(status);

CREATE TABLE mission_versions (
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  fiche TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (mission_id, version)
);

-- Candidats : la CV-thèque.
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  full_name TEXT,
  headline TEXT,
  location TEXT,
  email TEXT,
  linkedin_url TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  profile TEXT NOT NULL DEFAULT '{}',
  skills TEXT NOT NULL DEFAULT '',
  qualified_at TEXT,
  consent_at TEXT,
  last_contact_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX candidates_linkedin ON candidates(linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE UNIQUE INDEX candidates_email ON candidates(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX candidates_last_contact ON candidates(last_contact_at);

-- Recherche plein texte dans la CV-thèque (compétences, titre, profil).
CREATE VIRTUAL TABLE candidates_fts USING fts5(candidate_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');

-- Lien candidat ↔ mission : score, état, relances, réponses.
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'identifie',
  score INTEGER,
  score_detail TEXT NOT NULL DEFAULT '{}',
  eliminated_reason TEXT,
  channel TEXT,
  contact_step INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT,
  answers TEXT,
  answer_score INTEGER,
  synthesis TEXT,
  token TEXT,
  cv_key TEXT,
  client_decision TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mission_id, candidate_id)
);
CREATE INDEX applications_next ON applications(next_action_at) WHERE next_action_at IS NOT NULL;
CREATE INDEX applications_mission_state ON applications(mission_id, state);
CREATE UNIQUE INDEX applications_token ON applications(token) WHERE token IS NOT NULL;

-- File d'envoi LinkedIn (extension Chrome) : message pré-rempli, envoi par le recruteur.
CREATE TABLE linkedin_queue (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  profile_url TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'a_envoyer',
  due_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX linkedin_queue_status ON linkedin_queue(status, due_at);

-- Les 4 validations Telegram.
CREATE TABLE validations (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
  application_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'en_attente',
  answer TEXT,
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX validations_status ON validations(status);

-- Liste d'opposition : jamais recontacter (email ou URL haché).
CREATE TABLE optouts (
  hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Journal d'audit : chaque action de l'agent.
CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  mission_id TEXT,
  candidate_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX journal_mission ON journal(mission_id);

-- Compteurs de quotas par fournisseur et par jour (UTC), coupe-circuit.
CREATE TABLE usage (
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  open_until TEXT,
  PRIMARY KEY (provider, day)
);
