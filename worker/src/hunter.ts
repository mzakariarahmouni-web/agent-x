import { getConfig, journal, parseJson, secrets } from "./db";
import type { Env } from "./env";
import { fetchJson, HttpError } from "./outbound";
import { isOptedOut } from "./rgpd";
import type { SourcedProfile } from "./sourcing";
import { monthRequests, recordFailure, recordSuccess } from "./usage";

/**
 * Recherche d'email professionnel (Hunter) pour les profils retenus (Go) sans adresse connue.
 * Uniquement après ton Go, pour ne pas gaspiller le quota gratuit (25 recherches par mois).
 */

const MIN_CONFIDENCE = 70;

export async function findEmail(env: Env, key: string, fullName: string, company: string): Promise<string | null> {
  const p = new URLSearchParams({ full_name: fullName, company, api_key: key });
  const r = await fetchJson<{ data?: { email?: string | null; score?: number | null } }>(env, "hunter", `https://api.hunter.io/v2/email-finder?${p}`, {});
  const email = r.data?.email;
  return email && (r.data?.score ?? 0) >= MIN_CONFIDENCE ? email : null;
}

/** Cherche les emails manquants des candidatures données ; renvoie le nombre trouvé. */
export async function findMissingEmails(env: Env, missionId: string, applicationIds: string[]): Promise<number> {
  const k = await secrets(env);
  if (!k.hunter_api_key || !applicationIds.length) return 0;
  const cfg = await getConfig(env);
  const limit = (cfg.search.monthly_limits as Record<string, number>).hunter ?? 25;
  let found = 0;
  for (const appId of applicationIds) {
    if ((await monthRequests(env, "search:hunter")) >= limit) break;
    const c = await env.DB.prepare("SELECT c.id, c.full_name, c.email, c.profile FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?")
      .bind(appId)
      .first<{ id: string; full_name: string | null; email: string | null; profile: string }>();
    if (!c || c.email || !c.full_name) continue;
    const p = parseJson<SourcedProfile>(c.profile, { source: "web" });
    const company = p.entreprise?.trim();
    if (!company || c.full_name.split(/\s+/).length < 2) continue;
    try {
      const email = await findEmail(env, k.hunter_api_key, c.full_name, company);
      await recordSuccess(env, "search:hunter");
      if (email && !(await isOptedOut(env, email, null))) {
        await env.DB.prepare("UPDATE candidates SET email = ? WHERE id = ? AND email IS NULL").bind(email, c.id).run();
        found++;
      }
    } catch (e) {
      // Doublon d'email (déjà en base sur un autre candidat) ou erreur Hunter : on continue sans email.
      if (e instanceof HttpError) {
        await recordFailure(env, "search:hunter", e.message, { breakerErrors: 2, openMinutes: 60, untilMidnight: e.status === 401 || e.status === 429 });
        if (e.status === 401 || e.status === 429) break;
      }
    }
  }
  await journal(env, "contact", "recherche_emails", { demandes: applicationIds.length, trouves: found }, { mission: missionId });
  return found;
}
