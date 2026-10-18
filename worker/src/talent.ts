import { ai } from "./ai/router";
import { parseJson } from "./db";
import type { Block } from "./docx";
import type { Env } from "./env";
import type { Fiche } from "./fiche";
import type { Profile } from "./matching";

/**
 * Fiche candidat (dossier de compétences) : chaque rubrique est remplie au niveau du processus où l'information
 * devient fiable — 1 Sourcing (profil public), 2 Pré-qualification (formulaire + précisions demandées par l'IA),
 * 3 Entretien (compte rendu du recruteur, assisté par l'IA), 4 Présentation (fiche + CV formaté envoyés au client).
 */

export type Niveau = 1 | 2 | 3 | 4;
export const NIVEAUX: Record<Niveau, string> = { 1: "Sourcing", 2: "Pré-qualification", 3: "Entretien", 4: "Présentation" };

export interface Talent {
  en_poste?: "oui" | "non" | null;
  dernier_poste?: string | null;
  derniere_entreprise?: string | null;
  anciennete_entreprise_annees?: number | null;
  annees_experience?: number | null;
  notes_situation?: string | null;
  remuneration_type?: "salaire" | "tjm" | null;
  remuneration_montant?: number | null;
  package?: string | null;
  preavis?: string | null;
  disponible_le?: string | null;
  diplome?: string | null;
  points_forts?: string[];
  experience_resume?: string | null;
  personnalite?: string | null;
  competences?: string[];
  precisions?: string | null;
}

export interface TalentField {
  key: string;
  label: string;
  niveau: Niveau;
  value: (t: Talent) => string | null;
}

const fmtNum = (n: number) => n.toLocaleString("fr-FR").replace(/ /g, " ");
const years = (n: number | null | undefined) => (n == null ? null : `${n % 1 ? n.toFixed(1).replace(".", ",") : n} an${n >= 2 ? "s" : ""}`);
const list = (v?: string[]) => (v?.length ? v.join(", ") : null);

/** Rémunération annuelle : le salaire, ou le TJM ramené à l'année (218 jours, estimation indiquée). */
export function annualPay(t: Talent): string | null {
  if (!t.remuneration_montant) return null;
  if (t.remuneration_type === "tjm") return `≈ ${fmtNum(Math.round((t.remuneration_montant * 218) / 1000) * 1000)} € (estimation : TJM × 218 jours)`;
  return `${fmtNum(t.remuneration_montant)} € brut / an`;
}

/** Les rubriques de la fiche, dans l'ordre demandé, avec le niveau à partir duquel elles ont une réponse. */
export const TALENT_FIELDS: TalentField[] = [
  { key: "en_poste", label: "Actuellement en poste", niveau: 1, value: (t) => t.en_poste ?? null },
  { key: "dernier_poste", label: "Dernier poste occupé · entreprise", niveau: 1, value: (t) => [t.dernier_poste, t.derniere_entreprise].filter(Boolean).join(" · ") || null },
  {
    key: "anciennete",
    label: "Années dans cette entreprise · expérience globale",
    niveau: 1,
    value: (t) => (t.anciennete_entreprise_annees == null && t.annees_experience == null ? null : `${years(t.anciennete_entreprise_annees) ?? "?"} · ${years(t.annees_experience) ?? "?"} au total`),
  },
  { key: "notes_situation", label: "Notes et précisions sur sa situation", niveau: 3, value: (t) => t.notes_situation ?? null },
  { key: "remuneration_annuelle", label: "Rémunération annuelle", niveau: 2, value: annualPay },
  {
    key: "remuneration",
    label: "Salaire brut annuel ou TJM",
    niveau: 2,
    value: (t) => (t.remuneration_montant ? (t.remuneration_type === "tjm" ? `TJM : ${fmtNum(t.remuneration_montant)} € / jour` : `Salaire brut annuel : ${fmtNum(t.remuneration_montant)} €`) : null),
  },
  { key: "package", label: "Package actuel (variable, avantages)", niveau: 2, value: (t) => t.package ?? null },
  { key: "preavis", label: "Préavis", niveau: 2, value: (t) => t.preavis ?? null },
  { key: "disponible_le", label: "Disponible dès le", niveau: 2, value: (t) => (t.disponible_le ? frDay(t.disponible_le) : null) },
  { key: "diplome", label: "Niveau d'étude · diplôme", niveau: 2, value: (t) => t.diplome ?? null },
  { key: "points_forts", label: "Points forts", niveau: 3, value: (t) => list(t.points_forts) },
  { key: "experience_resume", label: "Expérience", niveau: 3, value: (t) => t.experience_resume ?? null },
  { key: "personnalite", label: "Personnalité et soft skills", niveau: 3, value: (t) => t.personnalite ?? null },
  { key: "competences", label: "Compétences", niveau: 2, value: (t) => list(t.competences) },
];

function frDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });
}

// ───────────── Niveau 1 : sourcing (profil public) et stabilité ─────────────

export interface Experience {
  poste?: string | null;
  entreprise?: string | null;
  debut?: string | null;
  fin?: string | null;
}

const ym = (s?: string | null): number | null => {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec(s ?? "");
  return m ? Number(m[1]) + (m[2] ? (Number(m[2]) - 1) / 12 : 0) : null;
};

export interface Stability {
  /** Années dans le poste actuel (ou le dernier). */
  current: number | null;
  /** Durée moyenne par employeur. */
  average: number | null;
  /** Ajustement de score : stable = bonus, enchaînement de missions très courtes = malus. */
  bonus: number;
  label: string | null;
}

/**
 * Règle de recrutement : un profil stable dans ses entreprises, et surtout dans la dernière, est plutôt un bon profil.
 * Calculée depuis les expériences datées (page publique) ou, à défaut, l'ancienneté dans l'entreprise actuelle.
 * Les freelances enchaînent des missions par nature : on ne les pénalise pas sur la durée moyenne.
 */
export function stabilityOf(p: Profile & { experiences?: Experience[]; anciennete_entreprise_annees?: number | null }, now = new Date()): Stability {
  const nowY = now.getUTCFullYear() + now.getUTCMonth() / 12;
  const exps = (p.experiences ?? [])
    .map((e, i) => ({ start: ym(e.debut), end: e.fin ? ym(e.fin) : nowY, entreprise: (e.entreprise ?? "").trim().toLowerCase() || `#${i}` }))
    .filter((e): e is { start: number; end: number; entreprise: string } => e.start != null && e.end != null && e.end >= e.start);
  // Durée par employeur (plusieurs postes successifs chez le même employeur comptent ensemble).
  const byCompany = new Map<string, number>();
  for (const e of exps) byCompany.set(e.entreprise, (byCompany.get(e.entreprise) ?? 0) + (e.end - e.start));
  const latest = exps.sort((a, b) => b.start - a.start)[0];
  const current = p.anciennete_entreprise_annees ?? (latest ? (byCompany.get(latest.entreprise) ?? latest.end - latest.start) : null);
  const tenures = [...byCompany.values()];
  const average = tenures.length >= 2 ? tenures.reduce((a, b) => a + b, 0) / tenures.length : null;
  const freelance = /freelance|ind[ée]pendant/i.test(`${p.statut ?? ""} ${p.intitule ?? ""}`);
  let bonus = 0;
  if (current != null && current >= 3) bonus += 6;
  else if (current != null && current >= 2) bonus += 3;
  if (average != null && average >= 3) bonus += 4;
  if (!freelance && average != null && average < 1.2 && tenures.length >= 3) bonus -= 8;
  const round = (n: number) => Math.round(n * 10) / 10;
  const label =
    current == null && average == null
      ? null
      : [current != null ? `${years(round(current))} dans le poste actuel` : "", average != null ? `${years(round(average))} en moyenne par employeur` : ""].filter(Boolean).join(" · ") +
        (bonus > 0 ? " (stable)" : bonus < 0 ? " (changements fréquents)" : "");
  return { current: current == null ? null : round(current), average: average == null ? null : round(average), bonus, label };
}

/** Rubriques du niveau 1, lues dans le profil public. */
export function talentFromProfile(p: Profile & { experiences?: Experience[]; en_poste?: boolean | null; anciennete_entreprise_annees?: number | null; diplome?: string | null }): Talent {
  const exps = (p.experiences ?? []).filter((e) => e.poste || e.entreprise);
  const latest = [...exps].sort((a, b) => (ym(b.debut) ?? 0) - (ym(a.debut) ?? 0))[0];
  const st = stabilityOf(p);
  const enPoste = p.en_poste ?? (latest ? !latest.fin : null);
  return {
    en_poste: enPoste == null ? null : enPoste ? "oui" : "non",
    dernier_poste: latest?.poste ?? p.intitule ?? null,
    derniere_entreprise: latest?.entreprise ?? p.entreprise ?? null,
    anciennete_entreprise_annees: st.current,
    annees_experience: p.annees_experience ?? null,
    diplome: p.diplome ?? null,
    competences: (p.competences ?? []).slice(0, 15),
  };
}

/** Fusion : une valeur connue n'est jamais effacée par une valeur vide ; les niveaux supérieurs l'emportent. */
export function mergeTalent(...layers: Talent[]): Talent {
  const out: Record<string, unknown> = {};
  for (const layer of layers)
    for (const [k, v] of Object.entries(layer)) {
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      out[k] = v;
    }
  return out as Talent;
}

/** Vue complète : niveau 1 depuis le profil, puis ce qui a été recueilli aux niveaux 2 et 3. */
export function talentView(profile: Profile, stored: string | null | undefined): Talent {
  return mergeTalent(talentFromProfile(profile), parseJson<Talent>(stored, {}));
}

// ───────────── Niveau 2 : formulaire de pré-qualification ─────────────

/** Rubriques du formulaire « Votre situation » (page du questionnaire). */
export function talentFromForm(form: { get(name: string): unknown }): Talent {
  const s = (k: string) => String(form.get(k) ?? "").trim().slice(0, 600);
  const amount = Number(s("t_rem_montant").replace(/[^\d,.]/g, "").replace(",", "."));
  const preavis = s("t_preavis");
  const preavisAutre = s("t_preavis_autre");
  const date = s("t_dispo");
  return {
    en_poste: s("t_en_poste") === "oui" ? "oui" : s("t_en_poste") === "non" ? "non" : null,
    dernier_poste: s("t_poste") || null,
    remuneration_type: s("t_rem_type") === "tjm" ? "tjm" : s("t_rem_type") === "salaire" ? "salaire" : null,
    remuneration_montant: Number.isFinite(amount) && amount > 0 ? (amount < 1000 && s("t_rem_type") === "salaire" ? amount * 1000 : amount) : null,
    package: s("t_package") || null,
    preavis: preavis === "autre" ? preavisAutre || "à préciser" : preavis === "aucun" ? "Pas de préavis" : preavis ? `Préavis de ${preavis}` : null,
    disponible_le: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    diplome: s("t_diplome") || null,
    competences: s("t_competences")
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 25),
  };
}

/** « Entretien de pré-qualification » écrit : jusqu'à 3 questions de précision générées par l'IA d'après les réponses. */
export async function followUpQuestions(env: Env, f: Fiche, answers: Record<string, string>, talent: Talent, missionId?: string): Promise<string[]> {
  try {
    const { data } = await ai<{ questions: string[] }>(env, {
      family: "jugement",
      label: "questions de précision",
      missionId,
      system: `Tu mènes un court entretien de pré-qualification écrit avec un candidat consultant, en français, vouvoiement.
D'après ses réponses, pose au plus 3 questions de précision utiles au recruteur : réponse vague ou sans fait concret, incohérence, information manquante (préavis, disponibilité, rémunération, motivation).
Questions courtes et polies, liées au poste uniquement ; jamais d'âge, de situation familiale, de santé, d'origine ou d'opinions.
Si tout est clair, renvoie une liste vide. Réponds uniquement en JSON : { "questions": [""] }`,
      prompt: `Poste : ${f.intitule} (${f.competences_obligatoires.join(", ")})\nSituation déclarée : ${JSON.stringify(talent)}\nRéponses : ${JSON.stringify(answers).slice(0, 6000)}`,
      json: true,
      maxTokens: 800,
      validate: (d) => (Array.isArray(d?.questions) ? null : "liste absente"),
    });
    return data.questions.map((q) => String(q).trim()).filter((q) => q.length > 8).slice(0, 3);
  } catch {
    return [];
  }
}

// ───────────── Niveau 3 : compte rendu d'entretien (texte ou vocal) ─────────────

export async function talentFromInterview(env: Env, f: Fiche, current: Talent, notes: string, missionId?: string): Promise<Talent> {
  const { data } = await ai<Talent>(env, {
    family: "jugement",
    label: "compte rendu d'entretien",
    missionId,
    system: `Tu structures le compte rendu d'entretien d'un recruteur avec un candidat, en français, de façon fidèle : n'invente rien, ne reprends que ce que dit le compte rendu.
« experience_resume » : 3 à 5 phrases concises et bien formulées sur l'expérience du candidat, utiles au client.
« personnalite » : personnalité et soft skills observés, 2 à 3 phrases.
« points_forts » : 3 à 5 points forts courts.
« notes_situation » : situation du candidat (processus en cours, motivations, contraintes).
Remplis aussi les rubriques de situation si elles sont mentionnées (en_poste "oui"/"non", remuneration_type "salaire"/"tjm", remuneration_montant en euros, package, preavis, disponible_le au format AAAA-MM-JJ, diplome, competences) ; sinon null.
Réponds uniquement en JSON : { "notes_situation": null, "points_forts": [], "experience_resume": null, "personnalite": null, "en_poste": null, "remuneration_type": null, "remuneration_montant": null, "package": null, "preavis": null, "disponible_le": null, "diplome": null, "competences": [] }`,
    prompt: `Poste : ${f.intitule}\nCe que l'on sait déjà : ${JSON.stringify(current)}\n\nCompte rendu du recruteur :\n"""${notes.slice(0, 8000)}"""`,
    json: true,
    maxTokens: 2000,
    validate: (d) => (d && typeof d === "object" && (d.experience_resume || d.points_forts?.length || d.notes_situation) ? null : "compte rendu non structuré"),
  });
  const clean: Talent = {
    notes_situation: data.notes_situation ?? null,
    points_forts: Array.isArray(data.points_forts) ? data.points_forts.map(String).slice(0, 6) : [],
    experience_resume: data.experience_resume ?? null,
    personnalite: data.personnalite ?? null,
    en_poste: data.en_poste === "oui" || data.en_poste === "non" ? data.en_poste : null,
    remuneration_type: data.remuneration_type === "tjm" || data.remuneration_type === "salaire" ? data.remuneration_type : null,
    remuneration_montant: typeof data.remuneration_montant === "number" && data.remuneration_montant > 0 ? data.remuneration_montant : null,
    package: data.package ?? null,
    preavis: data.preavis ?? null,
    disponible_le: typeof data.disponible_le === "string" && /^\d{4}-\d{2}-\d{2}/.test(data.disponible_le) ? data.disponible_le.slice(0, 10) : null,
    diplome: data.diplome ?? null,
    competences: Array.isArray(data.competences) ? data.competences.map(String).slice(0, 25) : [],
  };
  return clean;
}

/** Transcription d'un vocal Telegram (Workers AI, Whisper). */
export async function transcribe(env: Env, audio: Uint8Array): Promise<string> {
  const out = (await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<{ text?: string }> }).run("@cf/openai/whisper", { audio: [...audio] })) ?? {};
  return (out.text ?? "").trim();
}

// ───────────── Affichage et niveau 4 : présentation ─────────────

/** Fiche lisible sur Telegram, avec ce qu'il reste à compléter et à quel niveau. */
export function talentText(t: Talent, who: string, title: string, stability?: string | null): string {
  const lines = [`🗂 Fiche candidat · ${who} · ${title}`];
  for (const n of [1, 2, 3] as Niveau[]) {
    lines.push("", `— ${n}. ${NIVEAUX[n]}`);
    for (const fld of TALENT_FIELDS.filter((x) => x.niveau === n)) lines.push(`• ${fld.label} : ${fld.value(t) ?? "⏳ à compléter"}`);
    if (n === 1 && stability) lines.push(`• Stabilité : ${stability}`);
  }
  if (t.precisions) lines.push("", `Précisions du candidat : ${t.precisions}`);
  return lines.join("\n");
}

export function missingAt(t: Talent, niveau: Niveau): string[] {
  return TALENT_FIELDS.filter((x) => x.niveau === niveau && !x.value(t)).map((x) => x.label);
}

/** Fiche candidat .docx jointe au CV formaté (présentation au client). */
export function talentBlocks(t: Talent, who: string, f: Fiche, stability?: string | null): Block[] {
  const b: Block[] = [
    { kind: "title", text: `Fiche candidat — ${who}` },
    { kind: "subtitle", text: `${f.intitule}${f.localisation ? ` · ${f.localisation}` : ""}` },
  ];
  const section = (title: string, keys: string[]) => {
    const rows = TALENT_FIELDS.filter((x) => keys.includes(x.key)).map((x) => ({ label: x.label, v: x.value(t) }));
    if (!rows.some((r) => r.v)) return;
    b.push({ kind: "h1", text: title });
    for (const r of rows) if (r.v) b.push({ kind: "p", text: `${r.label} : ${r.v}` });
  };
  section("Situation actuelle", ["en_poste", "dernier_poste", "anciennete", "notes_situation"]);
  if (stability) b.push({ kind: "p", text: `Stabilité : ${stability}` });
  section("Rémunération et disponibilité", ["remuneration_annuelle", "remuneration", "package", "preavis", "disponible_le"]);
  section("Formation", ["diplome"]);
  if (t.experience_resume) b.push({ kind: "h1", text: "Expérience" }, { kind: "p", text: t.experience_resume });
  if (t.points_forts?.length) {
    b.push({ kind: "h1", text: "Points forts" });
    for (const p of t.points_forts) b.push({ kind: "bullet", text: p });
  }
  if (t.personnalite) b.push({ kind: "h1", text: "Personnalité et soft skills" }, { kind: "p", text: t.personnalite });
  if (t.competences?.length) b.push({ kind: "h1", text: "Compétences" }, { kind: "p", text: t.competences.join(", ") });
  return b;
}
