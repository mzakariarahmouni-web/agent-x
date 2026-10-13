import { ai } from "./ai/router";
import { journal, parseJson } from "./db";
import type { Env } from "./env";
import type { Fiche } from "./fiche";
import { evaluate, type MatchResult, type Profile, type SubScores } from "./matching";
import { isOptedOut } from "./rgpd";
import { webSearch, type SearchHit } from "./search";
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

const quote = (s: string) => `"${s.replace(/"/g, "")}"`;

/** Requêtes de recherche : LinkedIn public (X-ray), puis plateformes freelance et GitHub, du plus précis au plus large. */
export function buildQueries(f: Fiche, max: number): string[] {
  const title = f.intitule;
  const near = f.niveau_elargi.intitules_proches.slice(0, 3);
  const must = f.competences_obligatoires.slice(0, 3);
  const loc = f.localisation ? f.localisation.split(/[,(]/)[0].trim() : "";
  const q: string[] = [];
  q.push(`site:linkedin.com/in ${quote(title)} ${must.slice(0, 2).map(quote).join(" ")} ${loc}`.trim());
  q.push(`site:linkedin.com/in ${quote(title)} ${must.slice(0, 1).map(quote).join(" ")} freelance ${loc}`.trim());
  for (const n of near) q.push(`site:linkedin.com/in ${quote(n)} ${must.slice(0, 2).map(quote).join(" ")} ${loc}`.trim());
  q.push(`site:malt.fr ${title} ${must.slice(0, 2).join(" ")}`);
  if (must.length >= 2) q.push(`site:linkedin.com/in ${must.map(quote).join(" ")} ${loc}`.trim());
  if (/dev|développeur|developer|engineer|ingénieur|data|devops|cloud/i.test(title)) q.push(`site:github.com ${must.slice(0, 2).join(" ")} ${loc} France`);
  for (const s of f.synonymes.slice(0, 3)) q.push(`site:linkedin.com/in ${quote(s)} ${loc}`.trim());
  return [...new Set(q.map((x) => x.replace(/\s+/g, " ")))].slice(0, max);
}

/** Candidats de la CV-thèque proches de la fiche (recherche plein texte), hors liste d'opposition. */
export async function searchCvtheque(env: Env, f: Fiche, limit = 30): Promise<{ id: string; profile: SourcedProfile }[]> {
  const terms = [...f.competences_obligatoires, ...f.mots_cles.slice(0, 10), f.intitule]
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
Réponds uniquement en JSON : { "profils": [{ "index": 0, "nom": "", "intitule": "", "localisation": "", "competences": [""], "annees_experience": null, "secteurs": [""], "langues": [""], "statut": null, "linkedin_url": null, "resume": "" }] }`;

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
export async function subScores(env: Env, f: Fiche, profiles: Profile[], missionId?: string): Promise<Partial<SubScores>[]> {
  if (!profiles.length) return [];
  const brief = {
    intitule: f.intitule,
    competences_souhaitees: f.competences_souhaitees,
    seniorite_min_annees: f.seniorite_min_annees,
    secteur: f.secteur,
    langues: f.langues,
    soft_skills: f.soft_skills,
  };
  const { data } = await ai<{ scores: (Partial<SubScores> & { index: number })[] }>(env, {
    family: "volume",
    label: "scoring",
    missionId,
    system: `Tu notes l'adéquation de profils à une mission, de 0 à 100 par critère, sans complaisance.
Une information absente du profil vaut 50 (inconnu), pas 0.
Réponds uniquement en JSON : { "scores": [{ "index": 0, "competences_souhaitees": 0, "seniorite": 0, "secteur": 0, "langues": 0, "soft_skills": 0 }] }`,
    prompt: `Mission : ${JSON.stringify(brief)}\n\nProfils :\n${profiles
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
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    const subs = await subScores(env, f, batch.map((b) => b.profile), missionId);
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

/** Recherche web complète pour une mission : requêtes, extraction, dédoublonnage, CV-thèque. */
export async function sourcePublic(env: Env, missionId: string, f: Fiche, maxQueries: number): Promise<{ candidateId: string; profile: SourcedProfile }[]> {
  const seen = new Set<string>();
  const found: { candidateId: string; profile: SourcedProfile }[] = [];
  for (const q of buildQueries(f, maxQueries)) {
    const { engine, hits } = await webSearch(env, q, missionId);
    const fresh = hits.filter((h) => !seen.has(h.url.split("?")[0]));
    fresh.forEach((h) => seen.add(h.url.split("?")[0]));
    const profiles = await extractProfiles(env, fresh, missionId);
    for (const p of profiles) {
      if (await isOptedOut(env, p.email ?? null, p.linkedin_url ?? null)) continue;
      const id = await upsertCandidate(env, p);
      if (!found.some((x) => x.candidateId === id)) found.push({ candidateId: id, profile: p });
    }
    await journal(env, "sourcing", "recherche", { requete: q, moteur: engine, resultats: hits.length, profils: profiles.length }, { mission: missionId });
  }
  return found;
}
