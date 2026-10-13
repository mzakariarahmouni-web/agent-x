import { getConfig, journal } from "./db";
import type { Env } from "./env";
import { sha256Hex } from "./security";

/** RGPD : liste d'opposition (hachée), effacement complet, purge des candidats inactifs. */

const keyOf = (v: string) => v.trim().toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "");

export async function isOptedOut(env: Env, email: string | null | undefined, url: string | null | undefined): Promise<boolean> {
  const hashes = await Promise.all([email, url].filter((v): v is string => !!v).map((v) => sha256Hex(keyOf(v))));
  if (!hashes.length) return false;
  const row = await env.DB.prepare(`SELECT 1 FROM optouts WHERE hash IN (${hashes.map(() => "?").join(",")}) LIMIT 1`).bind(...hashes).first();
  return !!row;
}

/** Supprime toutes les données d'un candidat (base, index, fichiers) ; garde seulement l'empreinte d'opposition. */
export async function eraseCandidate(env: Env, candidateId: string, reason: string, optOut = true): Promise<boolean> {
  const c = await env.DB.prepare("SELECT email, linkedin_url FROM candidates WHERE id = ?").bind(candidateId).first<{ email: string | null; linkedin_url: string | null }>();
  if (!c) return false;
  const files = await env.DB.prepare("SELECT cv_key FROM applications WHERE candidate_id = ? AND cv_key IS NOT NULL").bind(candidateId).all<{ cv_key: string }>();
  for (const f of files.results ?? []) await env.FILES.delete(f.cv_key);
  await env.FILES.delete(`upload:${candidateId}`);
  const stmts = [
    env.DB.prepare("DELETE FROM candidates_fts WHERE candidate_id = ?").bind(candidateId),
    env.DB.prepare("DELETE FROM linkedin_queue WHERE application_id IN (SELECT id FROM applications WHERE candidate_id = ?)").bind(candidateId),
    env.DB.prepare("DELETE FROM applications WHERE candidate_id = ?").bind(candidateId),
    env.DB.prepare("DELETE FROM candidates WHERE id = ?").bind(candidateId),
    env.DB.prepare("UPDATE journal SET detail = NULL WHERE candidate_id = ?").bind(candidateId),
  ];
  if (optOut) {
    for (const v of [c.email, c.linkedin_url].filter((x): x is string => !!x)) {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO optouts (hash) VALUES (?)").bind(await sha256Hex(keyOf(v))));
    }
  }
  await env.DB.batch(stmts);
  await journal(env, "rgpd", "effacement", reason, { candidate: candidateId });
  return true;
}

/** Retrouve un candidat par email ou URL de profil (commande Telegram /effacer). */
export async function findCandidate(env: Env, emailOrUrl: string): Promise<string | null> {
  const v = emailOrUrl.trim();
  const r = await env.DB.prepare("SELECT id FROM candidates WHERE lower(email) = lower(?) OR linkedin_url = ? OR linkedin_url = ? LIMIT 1")
    .bind(v, v, v.replace(/\/+$/, ""))
    .first<{ id: string }>();
  return r?.id ?? null;
}

/** Purge quotidienne : candidats sans contact depuis la durée de conservation (2 ans par défaut). */
export async function purgeInactive(env: Env): Promise<number> {
  const cfg = await getConfig(env);
  const { results } = await env.DB.prepare(
    `SELECT id FROM candidates WHERE COALESCE(last_contact_at, created_at) < datetime('now', ?) LIMIT 200`,
  )
    .bind(`-${cfg.rgpd.retention_days} days`)
    .all<{ id: string }>();
  for (const r of results ?? []) await eraseCandidate(env, r.id, "durée de conservation dépassée", false);
  return results?.length ?? 0;
}
