import type { Fiche } from "./fiche";
import { careerYears, stabilityOf } from "./talent";

/**
 * Matrice de matching : critères éliminatoires vérifiés par le code (jamais par l'IA seule),
 * puis score pondéré de 0 à 100. Une donnée inconnue n'élimine pas : elle est vérifiée au questionnaire.
 */

export interface Profile {
  nom?: string;
  intitule?: string;
  entreprise?: string;
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
  /** Page d'origine (le sous-domaine LinkedIn indique le pays : in.linkedin.com = Inde). */
  source_url?: string;
  /** Fiche candidat, niveau 1 (profil public). */
  en_poste?: boolean | null;
  anciennete_entreprise_annees?: number | null;
  experiences?: { poste?: string | null; entreprise?: string | null; debut?: string | null; fin?: string | null }[];
  diplome?: string | null;
}

/** Statut contractuel reconnu, sinon null (un intitulé de poste comme « Senior » n'est pas un statut). */
export function normStatut(s?: string | null): "freelance" | "salarie" | "portage" | null {
  const n = norm(s ?? "");
  if (!n) return null;
  if (/portage/.test(n)) return "portage";
  if (/freelance|independant|indep|auto entrepreneur|micro entrepreneur|contractor|self employed/.test(n)) return "freelance";
  if (/salarie|employe|employee|cdi|permanent|full time/.test(n)) return "salarie";
  return null;
}

const FR = /france|paris|ile de france|idf|lyon|marseille|lille|toulouse|nantes|bordeaux|rennes|strasbourg|nice|montpellier|grenoble|rouen|orleans|tours|dijon|reims|metz|nancy|clermont|caen|angers|le mans|brest|limoges|amiens|besancon|perpignan|toulon|la defense|courbevoie|puteaux|nanterre|boulogne|issy|saint denis|versailles|massy|hauts de seine|yvelines|essonne|val de marne|seine saint denis|val d oise|auvergne|rhone|occitanie|bretagne|normandie|nouvelle aquitaine|grand est|hauts de france|pays de la loire|centre val de loire|bourgogne|provence|cote d azur/;
const ABROAD = /india|united states|usa|canada|united kingdom|england|london|china|germany|deutschland|spain|espana|italy|italia|portugal|netherlands|belgium|belgique|switzerland|suisse|morocco|maroc|tunisia|tunisie|algeria|algerie|senegal|cote d ivoire|cameroon|cameroun|brazil|mexico|australia|singapore|philippines|pakistan|bangladesh|egypt|nigeria|poland|romania|ukraine|russia|turkey|dubai|united arab emirates|qatar|saudi|japan|korea|vietnam|indonesia|malaysia|ireland|luxembourg|uttar pradesh|maharashtra|karnataka|tamil nadu|telangana|ontario|quebec|florida|california|texas|new york/;

/**
 * Pays déduit de l'adresse du profil : sous-domaine LinkedIn (fr., in., uk., cn.…) ou extension Malt (malt.fr, malt.es…).
 * « fr » pour la France, un autre code pour l'étranger, null si l'adresse ne dit rien (www.linkedin.com).
 */
export function countryFromUrl(url?: string | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const li = /^([a-z]{2})\.linkedin\.com$/.exec(host);
  if (li) return li[1] === "uk" ? "gb" : li[1];
  const malt = /(?:^|\.)malt\.([a-z]{2})$/.exec(host);
  if (malt) return malt[1];
  return null;
}

/** Le profil est-il clairement basé hors de France alors que la mission est en France (ou sans lieu précisé) ? */
export function abroadLocation(profileLoc?: string | null, missionLoc?: string | null, profileUrl?: string | null): boolean {
  const m = norm(missionLoc ?? "");
  if (m && !FR.test(m) && !/remote|teletravail|full remote/.test(m)) return false;
  const p = norm(profileLoc ?? "");
  if (p && FR.test(p)) return false;
  if (p && ABROAD.test(p)) return true;
  // Lieu absent ou ambigu : l'adresse du profil tranche (in.linkedin.com, cn.linkedin.com…).
  const c = countryFromUrl(profileUrl);
  return !!c && c !== "fr";
}

/** Lieu affiché sur une carte : lieu du profil, sinon pays déduit de l'adresse, sinon « inconnu ». */
export function displayLocation(profileLoc?: string | null, profileUrl?: string | null): string {
  if (profileLoc?.trim()) return profileLoc.trim();
  const c = countryFromUrl(profileUrl);
  return c === "fr" ? "France (profil LinkedIn français)" : c ? `étranger (${c.toUpperCase()})` : "inconnu, à vérifier";
}

const DIRECTION = /\b(directeur|directrice|director|head of|vp|vice pr[ée]sident|chief|cto|cio|dsi|cdo|coo|ceo|partner|associe|associee|country manager|general manager)\b/;

/** Intitulé de direction (ex. « Directeur de projet », « Head of HRIS »), quand la mission n'en est pas un. */
export function directionTitle(missionTitle: string, profileTitle?: string | null): boolean {
  return !!profileTitle && DIRECTION.test(norm(profileTitle)) && !DIRECTION.test(norm(missionTitle));
}

/** Motif « surdimensionné », ou null. Tolérance d'un an sur un maximum explicite, deux sur le maximum par défaut (minimum + 5). */
export function oversized(f: Fiche, p: Profile): string | null {
  const explicit = f.seniorite_max_annees;
  const max = explicit ?? (f.seniorite_min_annees != null ? f.seniorite_min_annees + 5 : null);
  const years = careerYears(p);
  if (max != null && years != null && years > max + (explicit != null ? 1 : 2)) return `surdimensionné : ${years} ans d'expérience (maximum ${max})`;
  if (directionTitle(f.intitule, p.intitule)) return `surdimensionné : poste de direction (${p.intitule})`;
  return null;
}

/** Preuves et signaux rendus par la pré-notation (un fait observable par critère). */
export interface Evidence {
  preuves?: Record<string, string>;
  vigilance?: string;
  ouverture?: string;
}

/**
 * Classe de préqualification (méthode du sourceur) : A = éliminatoires OK et score ≥ 75 (contact prioritaire),
 * B = éliminatoires OK, score plus bas ou informations manquantes, C = un éliminatoire KO (pas de contact).
 */
export function preClass(score: number | null | undefined, eliminated: boolean, toVerify: string[] = []): "A" | "B" | "C" {
  if (eliminated) return "C";
  return (score ?? 0) >= 75 && toVerify.filter((t) => !/TJM/.test(t)).length === 0 ? "A" : "B";
}

/** Preuves gardées avec le score (relues par la revue, la shortlist et le tableau de bord). */
export function evidenceOf(s: (Partial<SubScores> & Evidence) | undefined): Evidence {
  if (!s) return {};
  const preuves = s.preuves && typeof s.preuves === "object" ? Object.fromEntries(Object.entries(s.preuves).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v).slice(0, 160)])) : undefined;
  return { ...(preuves && Object.keys(preuves).length ? { preuves } : {}), ...(s.vigilance ? { vigilance: String(s.vigilance).slice(0, 160) } : {}), ...(s.ouverture ? { ouverture: String(s.ouverture).slice(0, 120) } : {}) };
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

const STOP = new Set(["de", "du", "des", "la", "le", "les", "et", "en", "a", "au", "aux", "d", "l", "un", "une", "pour", "sur", "avec", "of", "and", "the"]);
const word = (hay: string, w: string) => (w.length <= 3 ? new RegExp(`(^|[^a-z0-9])${w.replace(/[.+#]/g, (c) => `\\${c}`)}([^a-z0-9]|$)`).test(hay) : hay.includes(w));

/** Le profil mentionne-t-il la compétence (ou un de ses synonymes) ? Expression longue : tous ses mots significatifs présents. */
export function hasSkill(profileTerms: string[], skill: string, synonyms: string[] = []): boolean {
  const hay = ` ${profileTerms.map(norm).join(" | ")} `;
  return [skill, ...synonyms].some((t) => {
    const n = norm(t.replace(/\([^)]*\)/g, " "));
    if (!n) return false;
    if (word(hay, n)) return true;
    const words = n.split(" ").filter((w) => w && !STOP.has(w));
    return words.length >= 2 && words.every((w) => word(hay, w));
  });
}

const LANGS = /^(anglais|english|francais|french|allemand|german|espagnol|spanish|italien|italian|portugais|neerlandais|dutch|arabe|chinois|mandarin|japonais|russe|polonais)\b/;
/** Une « compétence » qui est en fait une langue (vérifiée par le questionnaire, pas par le profil). */
export function isLanguage(skill: string): boolean {
  return LANGS.test(norm(skill));
}

export function profileTerms(p: Profile): string[] {
  return [...(p.competences ?? []), p.intitule ?? "", p.resume ?? ""].filter(Boolean);
}

export function evaluate(f: Fiche, p: Profile, sub: Partial<SubScores>, weights: Record<string, number>, tjmTolerance = 0.1): MatchResult {
  const reasons: string[] = [];
  const toVerify: string[] = [];
  const terms = profileTerms(p);

  // Compétences obligatoires : on mesure la couverture. Une compétence absente d'un profil public n'est pas une preuve d'absence :
  // elle n'élimine que si AUCUNE obligatoire n'apparaît dans un profil riche (≥ 8 compétences listées).
  // Les langues sont vérifiées au questionnaire : elles ne pèsent pas sur la couverture des compétences.
  const mandatory = f.competences_obligatoires.filter((s) => !isLanguage(s));
  const found = mandatory.filter((s) => hasSkill(terms, s, f.synonymes.filter((x) => norm(x).includes(norm(s)))));
  const coverage = mandatory.length ? found.length / mandatory.length : 1;
  const richProfile = (p.competences?.length ?? 0) >= 8;
  const missing = mandatory.filter((s) => !found.includes(s));
  if (missing.length) {
    if (richProfile && coverage === 0) reasons.push(`compétences obligatoires absentes : ${missing.join(", ")}`);
    else toVerify.push(`à vérifier : ${missing.join(", ")}`);
  }

  // TJM : éliminatoire seulement s'il est connu et hors tolérance.
  const max = f.budget.tjm_max;
  if (max && typeof p.tjm === "number" && p.tjm > max * (1 + tjmTolerance)) reasons.push(`TJM ${p.tjm} € au-dessus du budget (${max} €)`);
  else if (max && p.tjm == null) toVerify.push("TJM à vérifier");

  // Statut : éliminatoire seulement s'il est reconnu (freelance, salarié, portage) et non accepté.
  const statut = normStatut(p.statut);
  if (statut && f.statuts_acceptes.length && !f.statuts_acceptes.map(normStatut).includes(statut)) reasons.push(`statut ${statut} non accepté`);

  // Lieu : un profil clairement basé hors de France est écarté quand la mission est en France (ou sans lieu précisé).
  const abroad = abroadLocation(p.localisation, f.localisation, p.source_url ?? p.linkedin_url);
  if (abroad) reasons.push(`basé hors de France (${displayLocation(p.localisation, p.source_url ?? p.linkedin_url)})`);

  // Séniorité : éliminatoire sous le niveau élargi (marge de 2 ans), sinon pondérée.
  const minYears = f.niveau_elargi.seniorite_min_annees ?? (f.seniorite_min_annees != null ? Math.max(0, f.seniorite_min_annees - 2) : null);
  const years = careerYears(p);
  if (minYears != null && years != null && years < minYears) reasons.push(`${years} ans d'expérience (minimum ${minYears})`);
  // Entreprise à ne pas solliciter (le client, un concurrent exclu par le brief).
  const ent = norm(p.entreprise ?? "");
  const excludedCo = ent ? (f.entreprises_exclues ?? []).find((e) => norm(e) && (ent.includes(norm(e)) || norm(e).includes(ent))) : undefined;
  if (excludedCo) reasons.push(`entreprise exclue (${p.entreprise})`);
  // Surdimensionné : trop d'expérience pour le poste, ou poste de direction pour une mission qui n'en est pas une.
  const over = oversized(f, p);
  if (over) reasons.push(over);

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
  // La couverture des obligatoires pèse sur tout le score (0,6 à 1) ; la stabilité ajuste (règle de recrutement).
  const stab = stabilityOf(p);
  detail.stabilite = stab.bonus;
  const score = Math.max(0, Math.min(100, Math.round(weighted * (0.6 + 0.4 * coverage)) + stab.bonus));
  return { eliminated: reasons.length > 0, reasons, toVerify, mandatoryCoverage: Math.round(coverage * 100), score, detail };
}

/** Part des mots-clés de la fiche présents dans un texte (mesure des 90 % d'adéquation du CV). */
export function keywordCoverage(keywords: string[], text: string): { ratio: number; missing: string[] } {
  const terms = [text];
  const missing = keywords.filter((k) => !hasSkill(terms, k));
  return { ratio: keywords.length ? (keywords.length - missing.length) / keywords.length : 1, missing };
}
