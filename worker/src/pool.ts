import { getConfig, parseJson } from "./db";
import type { Env } from "./env";
import { readFiche } from "./fiche";
import { type Evidence, evaluate, evidenceOf, type SubScores } from "./matching";
import type { SourcedProfile } from "./sourcing";

/**
 * Re-évaluation du vivier sans IA : les sous-scores déjà calculés sont conservés, seules les règles du code
 * (éliminatoires, couverture, lieu, statut) sont rejouées. Utile après une correction des règles ou une évolution.
 */
export async function reevaluatePool(env: Env, missionId: string): Promise<{ restored: number; eliminated: number }> {
  const cfg = await getConfig(env);
  const m = await env.DB.prepare("SELECT fiche FROM missions WHERE id = ?").bind(missionId).first<{ fiche: string }>();
  if (!m) return { restored: 0, eliminated: 0 };
  const f = readFiche(m.fiche);
  const { results } = await env.DB.prepare(
    "SELECT a.id, a.state, a.score_detail, c.profile FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.mission_id = ? AND a.state IN ('score', 'ecarte')",
  )
    .bind(missionId)
    .all<{ id: string; state: string; score_detail: string; profile: string }>();
  const out = { restored: 0, eliminated: 0 };
  const stmts: D1PreparedStatement[] = [];
  for (const r of results ?? []) {
    const subs = parseJson<Partial<SubScores> & Evidence>(r.score_detail, {});
    const match = evaluate(f, parseJson<SourcedProfile>(r.profile, { source: "inconnu" }), subs, cfg.matching.weights, cfg.matching.tjm_tolerance);
    const state = match.eliminated ? "ecarte" : "score";
    if (state === "score" && r.state === "ecarte") out.restored++;
    if (state === "ecarte") out.eliminated++;
    stmts.push(
      env.DB.prepare("UPDATE applications SET state = ?, score = ?, score_detail = ?, eliminated_reason = ? WHERE id = ?").bind(
        state,
        match.score,
        JSON.stringify({ ...match.detail, couverture_obligatoires: match.mandatoryCoverage, a_verifier: match.toVerify, ...evidenceOf(subs) }),
        match.reasons.join(" ; ") || null,
        r.id,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return out;
}

/** Motifs d'exclusion regroupés, pour le rapport (« statut 3, hors de France 6, compétences 2 »). */
export async function eliminationSummary(env: Env, missionId: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT eliminated_reason AS r FROM applications WHERE mission_id = ? AND state = 'ecarte'").bind(missionId).all<{ r: string | null }>();
  const counts: Record<string, number> = {};
  for (const { r } of results ?? []) {
    const k = /hors de France/.test(r ?? "") ? "hors de France" : /TJM/.test(r ?? "") ? "TJM" : /statut/.test(r ?? "") ? "statut" : /expérience/.test(r ?? "") ? "expérience" : /compétences/.test(r ?? "") ? "aucune compétence clé" : "autre";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}
