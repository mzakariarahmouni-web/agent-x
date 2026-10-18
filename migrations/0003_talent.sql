-- Fiche candidat (dossier de compétences) : rubriques recueillies en pré-qualification et en entretien.
ALTER TABLE applications ADD COLUMN talent TEXT;
-- Questions de précision posées par l'IA après le questionnaire, et réponses du candidat.
ALTER TABLE applications ADD COLUMN followups TEXT;
