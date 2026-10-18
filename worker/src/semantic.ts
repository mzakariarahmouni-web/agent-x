import { parseJson } from "./db";
import type { Env } from "./env";
import type { Fiche } from "./fiche";
import { isOptedOut } from "./rgpd";
import { fromBase64, toBase64 } from "./security";
import type { SourcedProfile } from "./sourcing";

/**
 * Recherche par le sens dans la CV-thèque : chaque profil a une empreinte vectorielle (modèle multilingue bge-m3 de
 * Workers AI, inclus dans l'offre Cloudflare). Une fiche « Chef de projet SIRH » retrouve ainsi un « Consultant HRIS
 * Workday » que la recherche par mots exacts manquait. Empreintes quantifiées en int8 (1 Ko par profil).
 */

const MODEL = "@cf/baai/bge-m3";
const BATCH = 24;

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI || !texts.length) return [];
  const out = (await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<{ data?: number[][] }> }).run(MODEL, { text: texts })) ?? {};
  return out.data ?? [];
}

export function quantize(v: number[]): string {
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / norm) * 127)));
  return toBase64(new Uint8Array(q.buffer));
}

export function similarity(a: Int8Array, b: Int8Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s / (127 * 127);
}

const decode = (b64: string) => new Int8Array(fromBase64(b64).buffer);

export function profileText(p: SourcedProfile): string {
  return [p.intitule, (p.competences ?? []).slice(0, 15).join(", "), (p.secteurs ?? []).join(", "), p.resume].filter(Boolean).join(" · ").slice(0, 800);
}

export function ficheText(f: Fiche): string {
  return [f.intitule, ...f.synonymes.slice(0, 4), f.competences_obligatoires.join(", "), f.competences_souhaitees.join(", "), f.secteur, f.missions.slice(0, 3).join(" ; ")].filter(Boolean).join(" · ").slice(0, 900);
}

/** Calcule les empreintes manquantes (les profils les plus récents d'abord), par lots. */
export async function embedMissing(env: Env, max = BATCH * 2): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, profile FROM candidates WHERE embedding IS NULL ORDER BY created_at DESC LIMIT ?").bind(max).all<{ id: string; profile: string }>();
  const rows = results ?? [];
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embed(env, batch.map((r) => profileText(parseJson<SourcedProfile>(r.profile, { source: "inconnu" })) || "profil"));
    if (vecs.length !== batch.length) break;
    await env.DB.batch(batch.map((r, j) => env.DB.prepare("UPDATE candidates SET embedding = ? WHERE id = ?").bind(quantize(vecs[j]), r.id)));
    n += batch.length;
  }
  return n;
}

/** Profils de la CV-thèque les plus proches de la fiche par le sens (hors liste d'opposition). */
export async function semanticCvtheque(env: Env, f: Fiche, limit = 20, minSimilarity = 0.5): Promise<{ id: string; profile: SourcedProfile; similarity: number }[]> {
  if (!env.AI) return [];
  await embedMissing(env);
  const [qv] = await embed(env, [ficheText(f)]);
  if (!qv) return [];
  const query = decode(quantize(qv));
  const { results } = await env.DB.prepare("SELECT id, embedding FROM candidates WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT 800").all<{ id: string; embedding: string }>();
  const top = (results ?? [])
    .map((r) => ({ id: r.id, sim: similarity(query, decode(r.embedding)) }))
    .filter((x) => x.sim >= minSimilarity)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
  const out: { id: string; profile: SourcedProfile; similarity: number }[] = [];
  for (const t of top) {
    const c = await env.DB.prepare("SELECT profile, email, linkedin_url FROM candidates WHERE id = ?").bind(t.id).first<{ profile: string; email: string | null; linkedin_url: string | null }>();
    if (!c || (await isOptedOut(env, c.email, c.linkedin_url))) continue;
    out.push({ id: t.id, profile: { ...parseJson<SourcedProfile>(c.profile, { source: "cvtheque" }), source: "cvtheque" }, similarity: Math.round(t.sim * 100) / 100 });
  }
  return out;
}
