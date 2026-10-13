import type { Fiche } from "./fiche";

/**
 * Matrice de matching : critères éliminatoires vérifiés par le code (jamais par l'IA seule),
 * puis score pondéré de 0 à 100. Une donnée inconnue n'élimine pas : elle est vérifiée au questionnaire.
 */

export interface Profile {
  nom?: string;
  intitule?: string;
  localisation?: string;
  competences?: string[];
  annees_experience?: number | null;
  secteurs?: string[];
  langues?: string[];
  statut?: string;
  tjm?: number | null;
  disponibilite?: string;
  email?: string;
  linkedin_url?: string;
  resume?: string;
}

export interface SubScores {
  competences_souhaitees: number;
  seniorite: number;
  secteur: number;
  langues: number;
  soft_skills: number;
}

export interface MatchResult {
  eliminated: boolean;
  reasons: string[];
  toVerify: string[];
  mandatoryCoverage: number;
  score: number;
  detail: Record<string, number>;
}

/** Forme normalisée d'un terme (casse, accents, ponctuation) pour comparer des compétences. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();
}

/** Le profil mentionne-t-il la compétence (ou un de ses synonymes) ? */
export function hasSkill(profileTerms: string[], skill: string, synonyms: string[] = []): boolean {
  const hay = ` ${profileTerms.map(norm).join(" | ")} `;
  return [skill, ...synonyms].some((t) => {
    const n = norm(t);
    if (!n) return false;
    if (n.length <= 3) return new RegExp(`(^|[^a-z0-9])${n.replace(/[.+#]/g, (c) => `\\${c}`)}([^a-z0-9]|$)`).test(hay);
    return hay.includes(n);
  });
}

function profileTerms(p: Profile): string[] {
  return [...(p.competences ?? []), p.intitule ?? "", p.resume ?? ""].filter(Boolean);
}

export function evaluate(f: Fiche, p: Profile, sub: Partial<SubScores>, weights: Record<string, number>, tjmTolerance = 0.1): MatchResult {
  const reasons: string[] = [];
  const toVerify: string[] = [];
  const terms = profileTerms(p);

  // Compétences obligatoires : on mesure la couverture ; une absence n'élimine que si le profil est riche (≥ 5 compétences listées).
  const mandatory = f.competences_obligatoires;
  const found = mandatory.filter((s) => hasSkill(terms, s, f.synonymes.filter((x) => norm(x).includes(norm(s)))));
  const coverage = mandatory.length ? found.length / mandatory.length : 1;
  const richProfile = (p.competences?.length ?? 0) >= 5;
  const missing = mandatory.filter((s) => !found.includes(s));
  if (missing.length) {
    if (richProfile && coverage < 0.5) reasons.push(`compétences obligatoires absentes : ${missing.join(", ")}`);
    else toVerify.push(`à vérifier : ${missing.join(", ")}`);
  }

  // TJM : éliminatoire seulement s'il est connu et hors tolérance.
  const max = f.budget.tjm_max;
  if (max && typeof p.tjm === "number" && p.tjm > max * (1 + tjmTolerance)) reasons.push(`TJM ${p.tjm} € au-dessus du budget (${max} €)`);
  else if (max && p.tjm == null) toVerify.push("TJM à vérifier");

  // Statut : éliminatoire si connu et non accepté.
  const statut = norm(p.statut ?? "");
  if (statut && f.statuts_acceptes.length && !f.statuts_acceptes.some((s) => statut.includes(norm(s)))) reasons.push(`statut ${p.statut} non accepté`);

  // Séniorité : éliminatoire sous le niveau élargi (marge de 2 ans), sinon pondérée.
  const minYears = f.niveau_elargi.seniorite_min_annees ?? (f.seniorite_min_annees != null ? Math.max(0, f.seniorite_min_annees - 2) : null);
  if (minYears != null && typeof p.annees_experience === "number" && p.annees_experience < minYears) reasons.push(`${p.annees_experience} ans d'expérience (minimum ${minYears})`);

  // Score pondéré : sous-scores de l'IA bornés, couverture des obligatoires calculée par le code.
  const clamp = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50);
  const detail: Record<string, number> = {
    competences_souhaitees: clamp(sub.competences_souhaitees),
    seniorite: clamp(sub.seniorite),
    secteur: clamp(sub.secteur),
    langues: clamp(sub.langues),
    soft_skills: clamp(sub.soft_skills),
  };
  const totalW = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const weighted = Object.entries(weights).reduce((acc, [k, w]) => acc + (detail[k] ?? 50) * w, 0) / totalW;
  // La couverture des obligatoires pèse sur tout le score (0,6 à 1).
  const score = Math.round(weighted * (0.6 + 0.4 * coverage));
  return { eliminated: reasons.length > 0, reasons, toVerify, mandatoryCoverage: Math.round(coverage * 100), score, detail };
}

/** Part des mots-clés de la fiche présents dans un texte (mesure des 90 % d'adéquation du CV). */
export function keywordCoverage(keywords: string[], text: string): { ratio: number; missing: string[] } {
  const terms = [text];
  const missing = keywords.filter((k) => !hasSkill(terms, k));
  return { ratio: keywords.length ? (keywords.length - missing.length) / keywords.length : 1, missing };
}
