import { ai } from "./ai/router";
import type { ChatFile } from "./ai/providers";
import { parseJson } from "./db";
import type { Env } from "./env";

/** F1 — Fiche de poste modèle (structure stable, utilisée par le matching, les messages, le questionnaire et le CV). */

export type CritereType = "competence" | "disponibilite" | "localisation" | "langue" | "statut" | "tjm" | "seniorite" | "autre";

export interface Fiche {
  intitule: string;
  client: string;
  secteur: string;
  contexte: string;
  missions: string[];
  localisation: string;
  teletravail: string;
  date_debut: string;
  duree: string;
  statuts_acceptes: string[];
  budget: { tjm_min: number | null; tjm_max: number | null; salaire_min: number | null; salaire_max: number | null };
  seniorite_min_annees: number | null;
  competences_obligatoires: string[];
  competences_souhaitees: string[];
  langues: string[];
  soft_skills: string[];
  /** Exigences incluses : ce que le profil doit avoir ou accepter (hors compétences : habilitation, déplacements, astreintes…). */
  exigences: string[];
  /** Profils exclus : ce que le client ne veut pas (junior, profil 100 % technique, sortie d'ESN concurrente…). */
  profils_exclus: string[];
  eliminatoires: { critere: string; type: CritereType; valeur: string }[];
  mots_cles: string[];
  synonymes: string[];
  niveau_elargi: { intitules_proches: string[]; competences_adjacentes: string[]; seniorite_min_annees: number | null };
  niveau_exigeant: { criteres_durcis: string[] };
  questions_clarification: string[];
  hypotheses: string[];
  questionnaire: Question[];
}

export interface Question {
  id: string;
  bloc: 1 | 2 | 3 | 4;
  texte: string;
  type: "oui_non" | "texte" | "choix";
  choix?: string[];
  /** Bloc 1 : réponse attendue (« oui » ou « non ») ; une autre réponse est signalée au recruteur. */
  attendu?: string;
  /** Bloc 2 : ce qui fait une réponse notée 5/5. */
  ancrage?: string;
}

const SYSTEM = `Tu es un chargé de recrutement expert des consultants IT et métier en France (ESN, freelances).
Tu transformes une fiche de poste brute en fiche modèle structurée, exacte et exploitable par un agent automatique.
Règles :
- N'invente rien qui ne soit pas dans la fiche ou dans les exigences connues du client ; quand tu supposes, écris-le dans « hypotheses ».
- « competences_obligatoires » : seulement les exigences explicites et non négociables (3 à 6), en termes courts tels qu'ils figurent sur un CV (ex. « EDIFACT », pas « EDIFACT (messages EDI) ») ; les langues vont dans « langues », pas ici.
- « intitule » : un seul intitulé court (ex. « Consultant EDI ») ; les variantes vont dans « synonymes ».
- « eliminatoires » : uniquement des critères binaires vérifiables (disponibilité, statut, localisation, langue, TJM, compétence clé).
- « niveau_elargi » : synonymes, intitulés voisins, compétences adjacentes pour ne rater aucun profil.
- « niveau_exigeant » : les critères qu'un client exigeant durcira probablement (anticipation).
- « questions_clarification » : 3 au maximum, seulement si une information manque vraiment (TJM, date, télétravail…).
- « mots_cles » : termes exacts de la fiche, utiles à un ATS (10 à 25).
- « budget » : TJM (freelance) et/ou salaire brut annuel en euros (salarié), tels qu'écrits ; null si absent.
- « exigences » : exigences incluses hors compétences (habilitation, déplacements, astreintes, secteur imposé…).
- « profils_exclus » : profils que le client ne veut pas, explicites ou évidents d'après la fiche (ex. « profil junior », « profil uniquement développeur »).
- « localisation » : ville ou région du poste ; « langues » : avec le niveau si indiqué (ex. « Anglais B2 »).
- Si TJM et salaire sont absents, ou la localisation absente, ou l'expérience absente : pose la question correspondante dans « questions_clarification ».
- Montants en euros, nombres sans unité ; null si inconnu.
Réponds uniquement en JSON.`;

const SHAPE = `{
 "intitule": "", "client": "", "secteur": "", "contexte": "", "missions": [""], "localisation": "", "teletravail": "",
 "date_debut": "", "duree": "", "statuts_acceptes": ["freelance" | "salarie" | "portage"],
 "budget": { "tjm_min": null, "tjm_max": null, "salaire_min": null, "salaire_max": null },
 "seniorite_min_annees": null, "competences_obligatoires": [""], "competences_souhaitees": [""], "langues": [""], "soft_skills": [""],
 "exigences": [""], "profils_exclus": [""],
 "eliminatoires": [{ "critere": "", "type": "competence|disponibilite|localisation|langue|statut|tjm|seniorite|autre", "valeur": "" }],
 "mots_cles": [""], "synonymes": [""],
 "niveau_elargi": { "intitules_proches": [""], "competences_adjacentes": [""], "seniorite_min_annees": null },
 "niveau_exigeant": { "criteres_durcis": [""] },
 "questions_clarification": [""], "hypotheses": [""]
}`;

/** Terme court et exploitable : sans précision entre parenthèses ni ponctuation finale. */
export function cleanTerm(s: string): string {
  return s.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").replace(/[\s.;:,]+$/, "").trim();
}

export function validateFiche(f: Partial<Fiche>): string | null {
  if (!f || typeof f !== "object") return "pas un objet";
  if (!f.intitule || typeof f.intitule !== "string") return "intitulé manquant";
  if (!Array.isArray(f.competences_obligatoires)) return "compétences obligatoires manquantes";
  if (!Array.isArray(f.mots_cles) || f.mots_cles.length < 3) return "mots-clés insuffisants";
  if (!Array.isArray(f.eliminatoires)) return "critères éliminatoires manquants";
  return null;
}

/** Les rubriques indispensables absentes donnent toujours lieu à une question au recruteur. */
function requiredQuestions(raw: Partial<Fiche>, asked: string[]): string[] {
  const b = (raw.budget ?? {}) as Partial<Fiche["budget"]>;
  const has = (re: RegExp) => asked.some((q) => re.test(q));
  const out = [...asked];
  if (!b.tjm_max && !b.tjm_min && !b.salaire_max && !b.salaire_min && !has(/tjm|salaire|budget|r[ée]mun[ée]ration/i)) out.unshift("Quel est le TJM ou le salaire brut annuel proposé ?");
  if (!String(raw.localisation ?? "").trim() && !has(/lieu|localisation|ville|r[ée]gion/i)) out.unshift("Où se situe le poste (ville ou région) ?");
  if (raw.seniorite_min_annees == null && !has(/exp[ée]rience|ann[ée]es/i)) out.push("Combien d'années d'expérience minimum ?");
  return [...new Set(out)];
}

/** Complète les champs absents pour que le reste du code n'ait jamais de « undefined ». */
export function normalizeFiche(raw: Partial<Fiche>, maxQuestions = 3): Fiche {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim()) : []);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !isNaN(+v) ? +v : null);
  const b = (raw.budget ?? {}) as Partial<Fiche["budget"]>;
  const el = (raw.niveau_elargi ?? {}) as Partial<Fiche["niveau_elargi"]>;
  return {
    intitule: String(raw.intitule ?? "").trim(),
    client: String(raw.client ?? "").trim(),
    secteur: String(raw.secteur ?? "").trim(),
    contexte: String(raw.contexte ?? "").trim(),
    missions: arr(raw.missions),
    localisation: String(raw.localisation ?? "").trim(),
    teletravail: String(raw.teletravail ?? "").trim(),
    date_debut: String(raw.date_debut ?? "").trim(),
    duree: String(raw.duree ?? "").trim(),
    statuts_acceptes: arr(raw.statuts_acceptes).map((s) => s.toLowerCase()),
    budget: { tjm_min: num(b.tjm_min), tjm_max: num(b.tjm_max), salaire_min: num(b.salaire_min), salaire_max: num(b.salaire_max) },
    seniorite_min_annees: num(raw.seniorite_min_annees),
    competences_obligatoires: arr(raw.competences_obligatoires).map(cleanTerm).filter(Boolean),
    competences_souhaitees: arr(raw.competences_souhaitees).map(cleanTerm).filter(Boolean),
    langues: arr(raw.langues),
    soft_skills: arr(raw.soft_skills),
    exigences: arr(raw.exigences),
    profils_exclus: arr(raw.profils_exclus),
    eliminatoires: Array.isArray(raw.eliminatoires)
      ? raw.eliminatoires.filter((e) => e && e.critere).map((e) => ({ critere: String(e.critere), type: (e.type ?? "autre") as CritereType, valeur: String(e.valeur ?? "") }))
      : [],
    mots_cles: [...new Set(arr(raw.mots_cles))],
    synonymes: arr(raw.synonymes),
    niveau_elargi: { intitules_proches: arr(el.intitules_proches), competences_adjacentes: arr(el.competences_adjacentes), seniorite_min_annees: num(el.seniorite_min_annees) },
    niveau_exigeant: { criteres_durcis: arr(raw.niveau_exigeant?.criteres_durcis) },
    questions_clarification: requiredQuestions(raw, arr(raw.questions_clarification)).slice(0, maxQuestions + 1),
    hypotheses: arr(raw.hypotheses),
    questionnaire: Array.isArray(raw.questionnaire) ? raw.questionnaire : [],
  };
}

/** Analyse la fiche brute (texte, ou PDF / image lus par un modèle qui sait les lire). */
export async function buildFiche(
  env: Env,
  input: { raw: string; file?: ChatFile; clientLearned?: string; instruction?: string; previous?: Fiche; missionId?: string },
): Promise<Fiche> {
  const parts = [
    input.previous
      ? `Fiche modèle actuelle :\n${JSON.stringify(input.previous)}\n\nModification demandée par le recruteur : « ${input.instruction} »\nApplique la modification et renvoie la fiche complète.`
      : `Fiche de poste brute :\n"""\n${input.raw.slice(0, 20_000)}\n"""`,
    input.clientLearned ? `Exigences récurrentes déjà observées chez ce client (à appliquer d'emblée) :\n${input.clientLearned}` : "",
    `Format attendu :\n${SHAPE}`,
  ];
  const { data } = await ai<Partial<Fiche>>(env, {
    family: "jugement",
    label: "fiche modèle",
    missionId: input.missionId,
    system: SYSTEM,
    prompt: parts.filter(Boolean).join("\n\n"),
    json: true,
    file: input.file,
    maxTokens: 6000,
    validate: validateFiche,
  });
  return normalizeFiche({ ...data, questionnaire: input.previous?.questionnaire ?? [] });
}

/** F5 — Questionnaire de la mission : blocs 1 et 4 communs, blocs 2 et 3 générés depuis la fiche. */
export function commonQuestions(f: Fiche): Question[] {
  const q: Question[] = [];
  const dispo = f.date_debut ? `Êtes-vous disponible pour démarrer ${/^\d/.test(f.date_debut) ? "le " : ""}${f.date_debut} ?` : "Êtes-vous disponible sous un mois ?";
  q.push({ id: "b1_dispo", bloc: 1, texte: dispo, type: "oui_non", attendu: "oui" });
  if (f.statuts_acceptes.length) q.push({ id: "b1_statut", bloc: 1, texte: `La mission est ouverte aux statuts : ${f.statuts_acceptes.join(", ")}. Cela vous convient-il ?`, type: "oui_non", attendu: "oui" });
  if (f.budget.tjm_max) q.push({ id: "b1_tjm", bloc: 1, texte: `Le budget est de ${f.budget.tjm_min ? `${f.budget.tjm_min} à ` : "jusqu'à "}${f.budget.tjm_max} € par jour. Est-ce compatible avec vos attentes ?`, type: "oui_non", attendu: "oui" });
  else if (f.localisation) q.push({ id: "b1_lieu", bloc: 1, texte: `La mission se déroule à ${f.localisation}${f.teletravail ? ` (${f.teletravail})` : ""}. Est-ce compatible pour vous ?`, type: "oui_non", attendu: "oui" });
  q.push({ id: "b4_accord", bloc: 4, texte: "Acceptez-vous que votre profil (anonymisé) soit présenté au client pour cette mission ?", type: "oui_non", attendu: "oui" });
  return q.slice(0, 4);
}

export async function buildQuestionnaire(env: Env, f: Fiche, missionId?: string): Promise<Question[]> {
  const { data } = await ai<{ questions: Question[] }>(env, {
    family: "jugement",
    label: "questionnaire",
    missionId,
    system: `Tu conçois des questionnaires de pré-qualification de consultants, courts et justes.
Règles : questions liées au poste uniquement ; jamais d'âge, de situation familiale, de santé, d'origine ou d'opinions.
Bloc 2 (3 ou 4 questions) : demander des preuves concrètes (« Décrivez une mission où… : contexte, rôle, résultat »), chacune avec un « ancrage » décrivant une réponse à 5/5.
Bloc 3 (2 questions) : motivation pour cette mission, processus en cours ou préavis.
Réponds uniquement en JSON : { "questions": [{ "id": "b2_1", "bloc": 2, "texte": "", "type": "texte", "ancrage": "" }] }`,
    prompt: `Fiche modèle :\n${JSON.stringify({ intitule: f.intitule, missions: f.missions, competences_obligatoires: f.competences_obligatoires, competences_souhaitees: f.competences_souhaitees, secteur: f.secteur, soft_skills: f.soft_skills })}`,
    json: true,
    maxTokens: 2500,
    validate: (d) => (Array.isArray(d?.questions) && d.questions.some((q) => q.bloc === 2) ? null : "questions du bloc 2 absentes"),
  });
  const generated = data.questions
    .filter((q) => (q.bloc === 2 || q.bloc === 3) && q.texte)
    .map((q, i) => ({ id: q.id || `b${q.bloc}_${i + 1}`, bloc: q.bloc, texte: String(q.texte), type: "texte" as const, ancrage: q.ancrage ? String(q.ancrage) : undefined }));
  const common = commonQuestions(f);
  const ordered = [...common.filter((q) => q.bloc === 1), ...generated.filter((q) => q.bloc === 2).slice(0, 4), ...generated.filter((q) => q.bloc === 3).slice(0, 2), ...common.filter((q) => q.bloc === 4)];
  return ordered.slice(0, 10);
}

/** Rémunération lisible : TJM et/ou salaire, « à préciser » si rien. */
export function remuneration(f: Fiche): string {
  const b = f.budget;
  const range = (min: number | null, max: number | null, unit: string) => (min && max ? `${min} à ${max} ${unit}` : max ? `jusqu'à ${max} ${unit}` : min ? `à partir de ${min} ${unit}` : "");
  const tjm = range(b.tjm_min, b.tjm_max, "€ / jour");
  const sal = range(b.salaire_min, b.salaire_max, "€ brut / an");
  return [tjm && `TJM ${tjm}`, sal && `salaire ${sal}`].filter(Boolean).join(" · ") || "⚠️ à préciser";
}

export function ficheSummary(f: Fiche): string {
  const todo = "⚠️ à préciser";
  const lines = [
    `📋 ${f.intitule}${f.client ? ` — ${f.client}` : ""}`,
    `💶 Rémunération : ${remuneration(f)}`,
    `📍 Localisation : ${f.localisation ? `${f.localisation}${f.teletravail ? ` · ${f.teletravail}` : ""}` : todo}`,
    `🎯 Expérience : ${f.seniorite_min_annees != null ? `${f.seniorite_min_annees} ans minimum` : todo}`,
    `🗣 Langues : ${f.langues.join(", ") || "—"}`,
    `✅ Exigences incluses : ${[...f.competences_obligatoires, ...f.exigences].join(", ") || "—"}`,
    `⛔ Profils exclus : ${f.profils_exclus.join(" ; ") || "—"}`,
    f.date_debut || f.duree ? `🗓 ${[f.date_debut && `début ${f.date_debut}`, f.duree].filter(Boolean).join(" · ")}` : "",
    "",
    `Obligatoire : ${f.competences_obligatoires.join(", ") || "—"}`,
    `Souhaité : ${f.competences_souhaitees.join(", ") || "—"}`,
    `Éliminatoire : ${f.eliminatoires.map((e) => e.critere).join(" ; ") || "—"}`,
    `Périmètre élargi : ${[...f.niveau_elargi.intitules_proches, ...f.niveau_elargi.competences_adjacentes].slice(0, 8).join(", ") || "—"}`,
    f.niveau_exigeant.criteres_durcis.length ? `Anticipation client exigeant : ${f.niveau_exigeant.criteres_durcis.join(" ; ")}` : "",
    f.hypotheses.length ? `\nHypothèses : ${f.hypotheses.join(" ; ")}` : "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Repère une signature « expéditeur : Prénom Nom, Cabinet » n'importe où dans une consigne du recruteur
 * (guillemets « » " ' acceptés, mots « signature » ou « signé » aussi) ; renvoie la signature et le reste de la consigne.
 */
export function parseSender(text: string): { sender: string | null; rest: string } {
  const re = /[«"“']?\s*(?:exp[ée]diteur|signature|sign[ée](?:\s+par)?)\s*[:=]\s*([^«»"“”\n;]+?)\s*[»"”']?\s*(?:[;\n]|$)/i;
  const m = re.exec(text);
  if (!m) return { sender: null, rest: text.trim() };
  const sender = m[1].replace(/\s+,/g, ",").replace(/\s{2,}/g, " ").trim().slice(0, 80);
  const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/^[\s«»"“”',.;:-]+|[\s«»"“”',;:-]+$/g, "").trim();
  return { sender: sender || null, rest };
}

export const readFiche = (json: string | null | undefined) => normalizeFiche(parseJson<Partial<Fiche>>(json, {}));
