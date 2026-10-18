import { ai } from "./ai/router";
import { journal, parseJson } from "./db";
import type { Env } from "./env";
import { cleanTerm, type Fiche } from "./fiche";
import { evaluate, isLanguage, type MatchResult, type Profile, type SubScores } from "./matching";
import { recentNogo } from "./review";
import { isOptedOut } from "./rgpd";
import { readPublicPages, type SearchHit, type SearchQuery, webSearch } from "./search";
import { newId } from "./security";

/** F3 — Sourcing : CV-thèque d'abord, puis profils publics (recherche web), extraction structurée et scoring. */

export interface SourcedProfile extends Profile {
  source: string;
  source_url?: string;
}

/** Forme unique d'une URL de profil LinkedIn (sous-domaine pays, paramètres et barre finale retirés). */
export function canonLinkedin(u: string): string {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(u);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}` : u;
}

const quote = (s: string) => `"${s.replace(/"/g, "").trim()}"`;
const orGroup = (terms: string[]) => {
  const t = [...new Set(terms.map((x) => x.trim()).filter(Boolean))];
  return t.length > 1 ? `(${t.map(quote).join(" OR ")})` : t.length ? quote(t[0]) : "";
};

/** Exclusions : pages d'offres d'emploi et de cabinets, pas des personnes. */
export const EXCLUSIONS = '-"offre d\'emploi" -recrute -recrutement -"we are hiring" -jobs';

const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

/** Intitulés recherchés : l'intitulé découpé (« A / B »), puis les intitulés proches, nettoyés et dédoublonnés. */
const FR_MARKET = /france|paris|[iî]le-de-france|idf|lyon|marseille|lille|toulouse|nantes|bordeaux|rennes|strasbourg|nice|montpellier|grenoble|t[ée]l[ée]travail|remote/i;

export function titlesOf(f: Fiche): string[] {
  return uniq([...f.intitule.split(/\s*[/|]\s*/), ...f.niveau_elargi.intitules_proches].map(cleanTerm)).slice(0, 4);
}

/** Compétences obligatoires utilisables dans une recherche : sans langue, sans précision, les plus courtes d'abord. */
export function mustSkills(f: Fiche): string[] {
  return uniq(f.competences_obligatoires.map(cleanTerm))
    .filter((s) => !isLanguage(s))
    .sort((a, b) => a.split(" ").length - b.split(" ").length)
    .slice(0, 3);
}

/** Seules les pages de personnes sont gardées (pas les pages de recherche, de tags ou d'offres). */
export function isProfileUrl(url: string, domain?: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (/linkedin\.com$/.test(u.hostname) || /linkedin\.com/.test(domain ?? "")) return /\/in\/[^/]+/.test(u.pathname);
  if (/malt\.(fr|com)$/.test(u.hostname)) return /^\/profile\/[^/]+/.test(u.pathname);
  if (/github\.com$/.test(u.hostname)) return /^\/[^/]+\/?$/.test(u.pathname) && !/^\/(topics|search|orgs|features|about|pricing|login)\b/.test(u.pathname);
  return true;
}

export interface BooleanPlan {
  round: SourcingRound;
  queries: SearchQuery[];
}

/**
 * Chaînes booléennes de la mission, de la plus précise à la plus large.
 * Tour 1 : strict, moyen, freelance, Malt, GitHub. Tour 2 (si le vivier est maigre) : périmètre élargi.
 */
export type SourcingRound = 1 | 2 | 3;

export function buildBooleanQueries(f: Fiche, round: SourcingRound, max: number): SearchQuery[] {
  const titles = titlesOf(f);
  const must = mustSkills(f);
  // Sans lieu précisé, le marché par défaut est la France.
  const loc = f.localisation ? f.localisation.split(/[,(]/)[0].trim() : "France";
  const locPart = loc ? quote(loc) : "";
  // Mission en France : profils LinkedIn français (fr.linkedin.com), pour ne pas remonter des profils du monde entier.
  const LI = !f.localisation || FR_MARKET.test(f.localisation) ? "fr.linkedin.com/in" : "linkedin.com/in";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const q: SearchQuery[] = [];
  if (round === 1) {
    q.push({ label: "strict", domain: LI, boolean: join(orGroup(titles), ...must.map(quote), locPart, EXCLUSIONS) });
    if (must.length > 2) q.push({ label: "moyen", domain: LI, boolean: join(orGroup(titles), ...must.slice(0, 2).map(quote), locPart, EXCLUSIONS) });
    q.push({ label: "freelance", domain: LI, boolean: join(orGroup(titles), must[0] ? quote(must[0]) : "", '(freelance OR "consultant indépendant" OR indépendant)', locPart, EXCLUSIONS) });
    q.push({ label: "compétences", domain: LI, boolean: join(...must.map(quote), orGroup([...f.competences_souhaitees.slice(0, 3)]), locPart, EXCLUSIONS) });
    q.push({ label: "malt", domain: "malt.fr/profile", boolean: join(orGroup(titles.slice(0, 2)), ...must.slice(0, 2).map(quote)) });
    if (/dev|développeur|developer|engineer|ingénieur|data|devops|cloud|architecte/i.test(f.intitule)) q.push({ label: "github", domain: "github.com", boolean: join(...must.slice(0, 2).map(quote), loc || "France") });
  } else if (round === 3) {
    // Sourcing continu : rotation de variantes (un intitulé à la fois, synonymes, compétence par compétence, autres sites).
    const wide = uniq([...titles, ...f.synonymes.slice(0, 6).map(cleanTerm)]);
    for (const t of wide) q.push({ label: `variante ${t}`, domain: LI, boolean: join(quote(t), ...must.slice(0, 2).map(quote), locPart, EXCLUSIONS) });
    for (const s of [...must, ...f.competences_souhaitees.slice(0, 3)]) q.push({ label: `compétence ${s}`, domain: LI, boolean: join(orGroup(titles), quote(s), locPart || '(France OR remote)', EXCLUSIONS) });
    for (const t of wide.slice(0, 3)) q.push({ label: `malt ${t}`, domain: "malt.fr/profile", boolean: join(quote(t), must[0] ? quote(must[0]) : "", loc) });
  } else {
    const wideTitles = uniq([...titles, ...f.synonymes.slice(0, 4).map(cleanTerm)]);
    const adj = f.niveau_elargi.competences_adjacentes.slice(0, 4);
    q.push({ label: "élargi", domain: LI, boolean: join(orGroup(wideTitles), must[0] ? orGroup([must[0], ...adj.slice(0, 2)]) : "", locPart, EXCLUSIONS) });
    q.push({ label: "élargi sans lieu", domain: LI, boolean: join(orGroup(wideTitles), ...must.slice(0, 2).map(quote), '(France OR "Île-de-France" OR remote OR télétravail)', EXCLUSIONS) });
    if (adj.length) q.push({ label: "adjacent", domain: LI, boolean: join(orGroup(titles), orGroup(adj), locPart, EXCLUSIONS) });
    q.push({ label: "malt élargi", domain: "malt.fr/profile", boolean: join(orGroup(wideTitles), must[0] ? quote(must[0]) : "") });
  }
  const seen = new Set<string>();
  return q.filter((x) => x.boolean && !seen.has(x.domain + x.boolean) && seen.add(x.domain + x.boolean)).slice(0, max);
}

/** Ancienne interface (requêtes texte « site:… »), conservée pour les appels existants. */
export function buildQueries(f: Fiche, max: number): string[] {
  return buildBooleanQueries(f, 1, max).map((x) => (x.domain ? `site:${x.domain} ${x.boolean}` : x.boolean));
}

/** Candidats de la CV-thèque proches de la fiche (recherche plein texte), hors liste d'opposition. */
export async function searchCvtheque(env: Env, f: Fiche, limit = 30): Promise<{ id: string; profile: SourcedProfile }[]> {
  const terms = [...mustSkills(f), ...f.mots_cles.slice(0, 10), ...titlesOf(f)]
    .map((t) => t.replace(/["*():^-]/g, " ").trim())
    .filter((t) => t.length > 1);
  if (!terms.length) return [];
  const match = [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.profile, c.linkedin_url, c.email FROM candidates_fts f JOIN candidates c ON c.id = f.candidate_id
     WHERE candidates_fts MATCH ? ORDER BY rank LIMIT ?`,
  )
    .bind(match, limit)
    .all<{ id: string; profile: string; linkedin_url: string | null; email: string | null }>();
  const out: { id: string; profile: SourcedProfile }[] = [];
  for (const r of results ?? []) {
    if (await isOptedOut(env, r.email, r.linkedin_url)) continue;
    out.push({ id: r.id, profile: { ...parseJson<SourcedProfile>(r.profile, { source: "cvtheque" }), source: "cvtheque" } });
  }
  return out;
}

const EXTRACT_SYSTEM = `Tu extrais des profils de personnes à partir de résultats de recherche web publics.
Ignore les offres d'emploi, les entreprises, les articles et les pages qui ne décrivent pas une personne précise.
N'invente aucune information : un champ inconnu vaut null ou [].
Réponds uniquement en JSON : { "profils": [{ "index": 0, "nom": "", "intitule": "", "entreprise": null, "localisation": "", "competences": [""], "annees_experience": null, "secteurs": [""], "langues": [""], "statut": null, "linkedin_url": null, "resume": "" }] }
« statut » : uniquement "freelance", "salarie" ou "portage" si c'est écrit, sinon null (jamais un niveau ou un intitulé).`;

export async function extractProfiles(env: Env, hits: SearchHit[], missionId?: string): Promise<SourcedProfile[]> {
  if (!hits.length) return [];
  const listing = hits.map((h, i) => `[${i}] ${h.title}\n${h.url}\n${h.snippet.slice(0, 600)}`).join("\n\n");
  const { data } = await ai<{ profils: (Profile & { index: number })[] }>(env, {
    family: "volume",
    label: "extraction de profils",
    missionId,
    system: EXTRACT_SYSTEM,
    prompt: listing,
    json: true,
    maxTokens: 4000,
    validate: (d) => (Array.isArray(d?.profils) ? null : "liste « profils » absente"),
  });
  return data.profils
    .filter((p) => p && typeof p.index === "number" && hits[p.index] && (p.nom || p.intitule))
    .map((p) => {
      const hit = hits[p.index];
      const isLinkedin = /linkedin\.com\/in\//i.test(hit.url);
      return {
        ...p,
        competences: Array.isArray(p.competences) ? p.competences : [],
        linkedin_url: isLinkedin ? canonLinkedin(hit.url) : p.linkedin_url ? canonLinkedin(p.linkedin_url) : undefined,
        source: new URL(hit.url).hostname.replace(/^www\./, ""),
        source_url: hit.url,
      };
    });
}

/** Sous-scores de l'IA (modèle économique) pour un lot de profils ; le code calcule ensuite le score final. */
export async function subScores(env: Env, f: Fiche, profiles: Profile[], missionId?: string, learned = ""): Promise<Partial<SubScores>[]> {
  if (!profiles.length) return [];
  const brief = {
    intitule: f.intitule,
    competences_souhaitees: f.competences_souhaitees,
    seniorite_min_annees: f.seniorite_min_annees,
    secteur: f.secteur,
    langues: f.langues,
    soft_skills: f.soft_skills,
    profils_exclus: f.profils_exclus,
  };
  const { data } = await ai<{ scores: (Partial<SubScores> & { index: number })[] }>(env, {
    family: "volume",
    label: "scoring",
    missionId,
    system: `Tu notes l'adéquation de profils à une mission, de 0 à 100 par critère, sans complaisance.
Une information absente du profil vaut 50 (inconnu), pas 0.
Un profil qui correspond à un des « profils_exclus » de la mission : toutes ses notes à 15 au plus.
Réponds uniquement en JSON : { "scores": [{ "index": 0, "competences_souhaitees": 0, "seniorite": 0, "secteur": 0, "langues": 0, "soft_skills": 0 }] }`,
    prompt: `Mission : ${JSON.stringify(brief)}${learned ? `\n\nProfils déjà écartés par le recruteur sur cette mission (note plus bas les profils semblables, pour le même motif) :\n${learned}` : ""}\n\nProfils :\n${profiles
      .map((p, i) => `[${i}] ${JSON.stringify({ intitule: p.intitule, competences: p.competences, annees_experience: p.annees_experience, secteurs: p.secteurs, langues: p.langues, resume: p.resume?.slice(0, 400) })}`)
      .join("\n")}`,
    json: true,
    maxTokens: 2500,
    validate: (d) => (Array.isArray(d?.scores) ? null : "liste « scores » absente"),
  });
  return profiles.map((_, i) => data.scores.find((s) => s.index === i) ?? {});
}

/** Enregistre ou met à jour un candidat dans la CV-thèque (dédoublonné par URL LinkedIn ou email). */
export async function upsertCandidate(env: Env, p: SourcedProfile): Promise<string> {
  const existing = await env.DB.prepare("SELECT id, profile FROM candidates WHERE (linkedin_url IS NOT NULL AND linkedin_url = ?) OR (email IS NOT NULL AND lower(email) = lower(?)) LIMIT 1")
    .bind(p.linkedin_url ?? null, p.email ?? null)
    .first<{ id: string; profile: string }>();
  const skills = (p.competences ?? []).join(", ");
  const text = [p.intitule, skills, p.secteurs?.join(", "), p.resume, p.localisation].filter(Boolean).join(" · ");
  if (existing) {
    const merged = { ...parseJson<SourcedProfile>(existing.profile, { source: p.source }), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))) };
    await env.DB.batch([
      env.DB.prepare("UPDATE candidates SET profile = ?, skills = ?, headline = COALESCE(?, headline), location = COALESCE(?, location) WHERE id = ?").bind(
        JSON.stringify(merged),
        (merged.competences ?? []).join(", "),
        p.intitule ?? null,
        p.localisation ?? null,
        existing.id,
      ),
      env.DB.prepare("DELETE FROM candidates_fts WHERE candidate_id = ?").bind(existing.id),
      env.DB.prepare("INSERT INTO candidates_fts (candidate_id, text) VALUES (?, ?)").bind(existing.id, text),
    ]);
    return existing.id;
  }
  const id = newId("c_");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO candidates (id, full_name, headline, location, email, linkedin_url, source, source_url, profile, skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, p.nom ?? null, p.intitule ?? null, p.localisation ?? null, p.email ?? null, p.linkedin_url ?? null, p.source, p.source_url ?? null, JSON.stringify(p), skills),
    env.DB.prepare("INSERT INTO candidates_fts (candidate_id, text) VALUES (?, ?)").bind(id, text),
  ]);
  return id;
}

export interface ScoredCandidate {
  candidateId: string;
  profile: SourcedProfile;
  match: MatchResult;
}

/** Score et enregistre les candidats d'une mission (application « scoré » ou « écarté »). */
export async function scoreAndStore(
  env: Env,
  missionId: string,
  f: Fiche,
  items: { candidateId: string; profile: SourcedProfile }[],
  weights: Record<string, number>,
  tjmTolerance: number,
): Promise<ScoredCandidate[]> {
  const out: ScoredCandidate[] = [];
  // Apprentissage : les No go du recruteur (avec motif) orientent la notation des profils suivants.
  const learned = items.length ? await recentNogo(env, missionId) : "";
  // Lots de 5 : requêtes courtes, compatibles avec les limites « par minute » des offres gratuites.
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const subs = await subScores(env, f, batch.map((b) => b.profile), missionId, learned);
    const stmts: D1PreparedStatement[] = [];
    batch.forEach((b, j) => {
      const match = evaluate(f, b.profile, subs[j] ?? {}, weights, tjmTolerance);
      out.push({ ...b, match });
      stmts.push(
        env.DB.prepare(
          `INSERT INTO applications (id, mission_id, candidate_id, state, score, score_detail, eliminated_reason) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(mission_id, candidate_id) DO UPDATE SET score = excluded.score, score_detail = excluded.score_detail,
             eliminated_reason = excluded.eliminated_reason, updated_at = datetime('now'),
             state = CASE WHEN applications.state IN ('identifie', 'score', 'ecarte') THEN excluded.state ELSE applications.state END`,
        ).bind(
          newId("a_"),
          missionId,
          b.candidateId,
          match.eliminated ? "ecarte" : "score",
          match.score,
          JSON.stringify({ ...match.detail, couverture_obligatoires: match.mandatoryCoverage, a_verifier: match.toVerify }),
          match.reasons.join(" ; ") || null,
        ),
      );
    });
    if (stmts.length) await env.DB.batch(stmts);
  }
  return out;
}

/** Un tour de recherche booléenne : requêtes, extraction, dédoublonnage, CV-thèque. */
export async function sourceRound(env: Env, missionId: string, f: Fiche, round: SourcingRound, maxQueries: number): Promise<{ candidateId: string; profile: SourcedProfile }[]> {
  const seen = new Set<string>();
  const found: { candidateId: string; profile: SourcedProfile }[] = [];
  // Une requête déjà lancée pour la mission n'est jamais rejouée (le sourcing continu avance dans la liste).
  const { results: past } = await env.DB.prepare("SELECT detail FROM journal WHERE mission_id = ? AND action = 'recherche'").bind(missionId).all<{ detail: string | null }>();
  const used = new Set((past ?? []).map((r) => parseJson<{ requete?: string; site?: string }>(r.detail, {})).map((d) => `${d.site ?? ""}|${d.requete ?? ""}`));
  const queries = buildBooleanQueries(f, round, 50).filter((q) => !used.has(`${q.domain}|${q.boolean}`)).slice(0, maxQueries);
  for (const q of queries) {
    const { engine, hits } = await webSearch(env, q, missionId);
    const fresh = hits.filter((h) => isProfileUrl(h.url, q.domain) && !seen.has(h.url.split("?")[0]));
    fresh.forEach((h) => seen.add(h.url.split("?")[0]));
    const profiles = await extractProfiles(env, fresh, missionId);
    for (const p of profiles) {
      if (await isOptedOut(env, p.email ?? null, p.linkedin_url ?? null)) continue;
      const id = await upsertCandidate(env, p);
      if (!found.some((x) => x.candidateId === id)) found.push({ candidateId: id, profile: p });
    }
    await journal(env, "sourcing", "recherche", { tour: round, type: q.label, requete: q.boolean, site: q.domain, moteur: engine, resultats: hits.length, pages_profil: fresh.length, profils: profiles.length }, { mission: missionId });
  }
  return found;
}

/** Compatibilité : premier tour seulement. */
export async function sourcePublic(env: Env, missionId: string, f: Fiche, maxQueries: number): Promise<{ candidateId: string; profile: SourcedProfile }[]> {
  return sourceRound(env, missionId, f, 1, maxQueries);
}

const PAGE_SYSTEM = `Tu lis la page publique d'un professionnel (profil LinkedIn public, Malt ou GitHub) et tu en extrais un profil fidèle.
N'invente rien ; un champ absent vaut null ou [].
« resume » : 3 à 6 lignes factuelles sur les expériences (postes, secteurs, durées, réalisations chiffrées s'il y en a).
Réponds uniquement en JSON : { "nom": "", "intitule": "", "entreprise": null, "localisation": "", "competences": [""], "annees_experience": null, "secteurs": [""], "langues": [""], "statut": null, "resume": "" }
« statut » : uniquement "freelance", "salarie" ou "portage" si c'est écrit, sinon null.`;

/**
 * Lecture des pages publiques des meilleurs profils, sans connexion (robots de Tavily ou d'Exa),
 * puis profil enrichi : compétences complètes, expérience, secteurs. Renvoie les profils mis à jour.
 */
export async function enrichFromPublicPages(env: Env, missionId: string, items: { candidateId: string; url: string }[]): Promise<{ candidateId: string; profile: SourcedProfile }[]> {
  if (!items.length) return [];
  const { engine, pages } = await readPublicPages(env, items.map((i) => i.url), missionId);
  const out: { candidateId: string; profile: SourcedProfile }[] = [];
  for (const page of pages) {
    const item = items.find((i) => canonLinkedin(i.url) === canonLinkedin(page.url) || i.url === page.url);
    if (!item || page.text.length < 200) continue;
    const { data } = await ai<Profile>(env, {
      family: "volume",
      label: "lecture de profil public",
      missionId,
      system: PAGE_SYSTEM,
      prompt: page.text.slice(0, 6000),
      json: true,
      maxTokens: 1500,
      validate: (d) => (d && typeof d === "object" && Array.isArray(d.competences) ? null : "compétences absentes"),
    });
    const row = await env.DB.prepare("SELECT profile FROM candidates WHERE id = ?").bind(item.candidateId).first<{ profile: string }>();
    const prev = parseJson<SourcedProfile>(row?.profile, { source: "web" });
    const merged: SourcedProfile = {
      ...prev,
      ...Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))),
      competences: [...new Set([...(prev.competences ?? []), ...(data.competences ?? [])])],
      nom: prev.nom || data.nom,
      linkedin_url: prev.linkedin_url,
      email: prev.email,
      source: prev.source,
      source_url: prev.source_url,
    };
    await upsertCandidate(env, merged);
    out.push({ candidateId: item.candidateId, profile: merged });
  }
  await journal(env, "sourcing", "lecture_pages_publiques", { moteur: engine, demandees: items.length, lues: pages.length, enrichies: out.length }, { mission: missionId });
  return out;
}
