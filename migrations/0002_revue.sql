-- Revue Go / No go des profils, message de premier contact validé par mission, canal choisi.
ALTER TABLE applications ADD COLUMN nogo_reason TEXT;
ALTER TABLE missions ADD COLUMN message_objet TEXT;
ALTER TABLE missions ADD COLUMN message_template TEXT;
ALTER TABLE missions ADD COLUMN channel_mode TEXT;
ALTER TABLE missions ADD COLUMN message_ok INTEGER NOT NULL DEFAULT 0;
CREATE INDEX applications_revue ON applications(mission_id, state, score);
