import { ai, AllProvidersDown } from "./ai/router";
import type { ChatFile } from "./ai/providers";
import { getSetting, parseJson } from "./db";
import { type Block, buildDocx, plainText } from "./docx";
import type { Env } from "./env";
import type { Fiche } from "./fiche";
import { keywordCoverage } from "./matching";
import type { SourcedProfile } from "./sourcing";

/** F6 — Dossier de compétences anonymisé, compatible ATS, aligné sur la terminologie de la fiche (jamais inventé). */

export interface CvContent {
  titre: string;
  annees_experience: number | null;
  disponibilite: string;
  synthese: string;
  adequation: { critere: string; preuve: string }[];
  competences: { techniques: string[]; fonctionnelles: string[]; outils: string[]; methodes: string[] };
  experiences: { client_ou_secteur: string; dates: string; role: string; contexte: string; realisations: string[]; environnement: string }[];
  formations: string[];
  certifications: string[];
  langues: string[];
  ecarts: string[];
}

export interface CvResult {
  bytes: Uint8Array;
  filename: string;
  coverage: number;
  missing: string[];
  ecarts: string[];
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts.map((p) => `${p[0].toUpperCase()}.`).join(" ") : "Consultant(e)";
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(?:\+33\s?|0)[1-9](?:[\s.-]?\d{2}){4}/g;
const URL_RE = /https?:\/\/\S+|linkedin\.com\/\S+/gi;

/** Anonymisation : retire nom complet, prénom, email, téléphone et liens de tout le texte. */
export function anonymize(text: string, fullName: string | null | undefined): string {
  let out = text.replace(EMAIL, "[email masqué]").replace(PHONE, "[téléphone masqué]").replace(URL_RE, "");
  for (const part of (fullName ?? "").split(/\s+/).filter((p) => p.length > 2)) {
    out = out.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
  }
  // Les mentions de contact masquées disparaissent avec leur tournure (« joignable à … ou … »).
  out = out.replace(/\s*,?\s*(?:joignable|contactable|contact|t[ée]l(?:[ée]phone)?\.?|e-?mail|mail)?\s*(?:à|au|:)?\s*\[(?:email|téléphone) masqué\](?:\s*(?:ou|et|\/|,)\s*\[(?:email|téléphone) masqué\])*/gi, "");
  out = out.replace(/\s{2,}/g, " ").replace(/^[\s,;:—–-]+/, "").trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}

/** Applique l'anonymisation à toutes les chaînes d'un objet. */
export function anonymizeDeep<T>(value: T, fullName: string | null | undefined): T {
  if (typeof value === "string") return anonymize(value, fullName) as T;
  if (Array.isArray(value)) return value.map((v) => anonymizeDeep(v, fullName)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymizeDeep(v, fullName)])) as T;
  return value;
}

export function cvBlocks(c: CvContent, f: Fiche, who: string, withTjm: string | null): Block[] {
  const b: Block[] = [];
  b.push({ kind: "title", text: `${who} — ${c.titre || f.intitule}` });
  b.push({ kind: "subtitle", text: [c.annees_experience ? `${c.annees_experience} ans d'expérience` : "", c.disponibilite ? `Disponibilité : ${c.disponibilite}` : "", withTjm ? `TJM : ${withTjm}` : ""].filter(Boolean).join(" · ") });
  if (c.synthese) b.push({ kind: "h1", text: "Synthèse" }, { kind: "p", text: c.synthese });
  if (c.adequation.length) {
    b.push({ kind: "h1", text: `Adéquation à la mission : ${f.intitule}` });
    for (const a of c.adequation) b.push({ kind: "bullet", text: `${a.critere} : ${a.preuve}` });
  }
  const comp = c.competences;
  const groups: [string, string[]][] = [
    ["Techniques", comp.techniques],
    ["Fonctionnelles", comp.fonctionnelles],
    ["Outils", comp.outils],
    ["Méthodes", comp.methodes],
  ];
  if (groups.some(([, v]) => v.length)) {
    b.push({ kind: "h1", text: "Compétences clés" });
    for (const [label, v] of groups) if (v.length) b.push({ kind: "p", text: `${label} : ${v.join(", ")}` });
  }
  if (c.experiences.length) {
    b.push({ kind: "h1", text: "Expériences professionnelles" });
    for (const e of c.experiences) {
      b.push({ kind: "h2", text: [e.role, e.client_ou_secteur, e.dates].filter(Boolean).join(" — ") });
      if (e.contexte) b.push({ kind: "p", text: `Contexte : ${e.contexte}` });
      for (const r of e.realisations) b.push({ kind: "bullet", text: r });
      if (e.environnement) b.push({ kind: "p", text: `Environnement : ${e.environnement}`, italic: true });
    }
  }
  if (c.formations.length || c.certifications.length) {
    b.push({ kind: "h1", text: "Formation et certifications" });
    for (const x of [...c.formations, ...c.certifications]) b.push({ kind: "bullet", text: x });
  }
  if (c.langues.length) b.push({ kind: "h1", text: "Langues" }, { kind: "p", text: c.langues.join(" · ") });
  return b;
}

const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

export function normalizeCv(d: Partial<CvContent>): CvContent {
  const comp = (d.competences ?? {}) as Partial<CvContent["competences"]>;
  return {
    titre: String(d.titre ?? ""),
    annees_experience: typeof d.annees_experience === "number" ? d.annees_experience : null,
    disponibilite: String(d.disponibilite ?? ""),
    synthese: String(d.synthese ?? ""),
    adequation: Array.isArray(d.adequation) ? d.adequation.filter((a) => a?.critere && a?.preuve).map((a) => ({ critere: String(a.critere), preuve: String(a.preuve) })) : [],
    competences: { techniques: arr(comp.techniques), fonctionnelles: arr(comp.fonctionnelles), outils: arr(comp.outils), methodes: arr(comp.methodes) },
    experiences: Array.isArray(d.experiences)
      ? d.experiences.map((e) => ({
          client_ou_secteur: String(e?.client_ou_secteur ?? ""),
          dates: String(e?.dates ?? ""),
          role: String(e?.role ?? ""),
          contexte: String(e?.contexte ?? ""),
          realisations: arr(e?.realisations),
          environnement: String(e?.environnement ?? ""),
        }))
      : [],
    formations: arr(d.formations),
    certifications: arr(d.certifications),
    langues: arr(d.langues),
    ecarts: arr(d.ecarts),
  };
}

const SYSTEM = `Tu rédiges des dossiers de compétences de consultants pour des clients (ESN, grands comptes), en français.
RÈGLE ABSOLUE D'INTÉGRITÉ : tu n'ajoutes jamais une compétence, une expérience, un diplôme, une date ou un chiffre absent des sources fournies (CV du candidat, profil, réponses au questionnaire).
Tu reformules avec la terminologie exacte de la fiche de poste quand le parcours le justifie.
Chaque mot-clé de la fiche sans preuve dans les sources va dans « ecarts », jamais dans le CV.
Pas de nom, d'email, de téléphone ni de lien : le CV est anonymisé.
Expériences en ordre chronologique inverse ; réalisations chiffrées si (et seulement si) les chiffres sont dans les sources.
Réponds uniquement en JSON : { "titre": "", "annees_experience": null, "disponibilite": "", "synthese": "", "adequation": [{ "critere": "", "preuve": "" }],
"competences": { "techniques": [""], "fonctionnelles": [""], "outils": [""], "methodes": [""] },
"experiences": [{ "client_ou_secteur": "", "dates": "", "role": "", "contexte": "", "realisations": [""], "environnement": "" }],
"formations": [""], "certifications": [""], "langues": [""], "ecarts": [""] }`;

export async function generateCv(
  env: Env,
  f: Fiche,
  p: SourcedProfile & { full_name?: string | null },
  answers: Record<string, string>,
  synthesis: string,
  cvFile?: ChatFile,
  missionId?: string,
): Promise<CvResult> {
  const prompt = `Fiche de poste (mots-clés à reprendre si prouvés) : ${JSON.stringify({ intitule: f.intitule, missions: f.missions, competences_obligatoires: f.competences_obligatoires, competences_souhaitees: f.competences_souhaitees, mots_cles: f.mots_cles })}

Profil connu : ${JSON.stringify({ intitule: p.intitule, competences: p.competences, annees_experience: p.annees_experience, secteurs: p.secteurs, langues: p.langues, resume: p.resume })}

Réponses au questionnaire : ${JSON.stringify(answers).slice(0, 8000)}

Synthèse de qualification : ${synthesis}
${cvFile ? "\nLe CV du candidat est joint : c'est la source principale." : ""}`;
  const call = (file?: ChatFile) =>
    ai<Partial<CvContent>>(env, {
      family: "cv",
      label: "rédaction CV",
      missionId,
      system: SYSTEM,
      prompt,
      json: true,
      file,
      maxTokens: 6000,
      validate: (d) => (d && typeof d === "object" && Array.isArray(d.experiences) ? null : "expériences absentes"),
    });
  let res;
  try {
    res = await call(cvFile);
  } catch (e) {
    if (!(e instanceof AllProvidersDown) || !cvFile) throw e;
    res = await call(undefined); // aucun modèle ne lit le fichier : on rédige depuis le profil et les réponses
  }
  const content = normalizeCv(res.data);
  // Anonymisation de tous les champs texte, même si le modèle a laissé passer un nom.
  const clean = anonymizeDeep(content, p.full_name ?? p.nom);
  const brand = parseJson<{ font?: string; color?: string; show_tjm?: boolean }>(await getSetting(env, "cv_brand"), {});
  const who = initials(p.full_name ?? p.nom);
  const blocks = cvBlocks(clean, f, who, brand.show_tjm && p.tjm ? `${p.tjm} €` : null);
  const cov = keywordCoverage(f.mots_cles, plainText(blocks));
  const bytes = buildDocx(blocks, { font: brand.font || "Calibri", color: (brand.color || "1F3864").replace("#", "") }, `${who} — ${f.intitule}`);
  const safe = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "_").slice(0, 40);
  return { bytes, filename: `CV_${safe(who.replace(/\./g, ""))}_${safe(f.intitule)}.docx`, coverage: Math.round(cov.ratio * 100), missing: cov.missing, ecarts: clean.ecarts };
}
