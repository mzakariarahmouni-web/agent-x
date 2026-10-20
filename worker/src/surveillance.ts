import { journal } from "./db";
import type { Env } from "./env";
import { notify } from "./telegram";

/**
 * Surveillance des missions (à chaque passage du planificateur) : un Workflow de mission arrêté par une erreur,
 * ou bloqué sans aucune activité depuis des heures, est relancé là où la mission en est (sans redemander la
 * validation de la fiche). L'erreur est journalisée et tu es prévenu sur Telegram.
 */

const DEAD = ["errored", "terminated"];
const STUCK_HOURS = 4;
const MAX_RESUMES_PER_DAY = 3;

export interface WatchResult {
  missionId: string;
  status: string;
  action: "reprise" | "aucune" | "limite";
}

const sqlTime = (s: string) => Date.parse(`${s.replace(" ", "T")}Z`);

export async function watchMissions(env: Env, now = new Date()): Promise<WatchResult[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, workflow_id FROM missions WHERE status = 'en_cours' AND workflow_id IS NOT NULL ORDER BY created_at DESC LIMIT 10",
  ).all<{ id: string; title: string; workflow_id: string }>();
  const out: WatchResult[] = [];
  for (const m of results ?? []) {
    let status = "unknown";
    let error = "";
    try {
      const st = (await (await env.MISSION.get(m.workflow_id)).status()) as { status: string; error?: { name?: string; message?: string } | string };
      status = st.status;
      error = typeof st.error === "string" ? st.error : [st.error?.name, st.error?.message].filter(Boolean).join(" : ");
    } catch (e) {
      // Instance introuvable : considérée comme arrêtée.
      status = /not.?found|introuvable/i.test((e as Error).message) ? "terminated" : "unknown";
      error = (e as Error).message;
    }
    let dead = DEAD.includes(status);
    if (!dead && status === "running") {
      // « running » sans aucune trace depuis des heures (une attente normale s'affiche « waiting ») : bloqué.
      const last = await env.DB.prepare("SELECT MAX(at) AS at FROM journal WHERE mission_id = ?").bind(m.id).first<{ at: string | null }>();
      if (last?.at && now.getTime() - sqlTime(last.at) > STUCK_HOURS * 3_600_000) {
        dead = true;
        error = error || `aucune activité depuis ${last.at} UTC`;
        try {
          await (await env.MISSION.get(m.workflow_id)).terminate();
        } catch {
          /* déjà arrêtée */
        }
      }
    }
    if (!dead) {
      out.push({ missionId: m.id, status, action: "aucune" });
      continue;
    }
    const resumes = await env.DB.prepare("SELECT COUNT(*) AS n FROM journal WHERE mission_id = ? AND action = 'reprise' AND at >= datetime('now', '-1 day')").bind(m.id).first<{ n: number }>();
    if ((resumes?.n ?? 0) >= MAX_RESUMES_PER_DAY) {
      if ((resumes?.n ?? 0) === MAX_RESUMES_PER_DAY) {
        await journal(env, "surveillance", "reprise", { statut: status, erreur: error.slice(0, 300), abandon: true }, { mission: m.id });
        await notify(env, `⚠️ Mission « ${m.title} » : elle s'est arrêtée ${MAX_RESUMES_PER_DAY} fois en 24 h (${error.slice(0, 200) || status}). Je ne la relance plus automatiquement aujourd'hui ; je regarde la cause.`);
      }
      out.push({ missionId: m.id, status, action: "limite" });
      continue;
    }
    const inst = await env.MISSION.create({ id: `${m.id}-r${now.getTime().toString(36)}`, params: { missionId: m.id, resume: true } });
    await env.DB.prepare("UPDATE missions SET workflow_id = ?, updated_at = datetime('now') WHERE id = ?").bind(inst.id, m.id).run();
    await journal(env, "surveillance", "reprise", { statut: status, erreur: error.slice(0, 300), ancien: m.workflow_id, nouveau: inst.id }, { mission: m.id });
    await notify(env, `🔧 Mission « ${m.title} » : le traitement s'était arrêté (${error.slice(0, 160) || status}). Je l'ai relancé là où il en était : sourcing puis cartes Go / No go. Rien n'est perdu, la fiche reste validée.`);
    out.push({ missionId: m.id, status, action: "reprise" });
  }
  return out;
}
