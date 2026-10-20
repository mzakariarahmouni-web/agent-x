import { dailyBilan } from "./pilotage";
import { watchMissions } from "./surveillance";
import { getConfig, getSetting, journal, setSetting } from "./db";
import type { Env } from "./env";
import { checkEmailReplies, processDueContacts } from "./outreach";
import { purgeInactive } from "./rgpd";
import { notify } from "./telegram";

/** Tâches planifiées : contacts et relances aux créneaux, réponses Gmail, rappels ; purge RGPD la nuit. */

async function remindValidations(env: Env): Promise<void> {
  const cfg = await getConfig(env);
  // Les validations n°1 et n°3 sont rappelées par leur Workflow ; ici, les rejets proposés (n°2) restés sans réponse.
  const { results } = await env.DB.prepare(
    `SELECT v.id, c.full_name FROM validations v JOIN applications a ON a.id = v.application_id JOIN candidates c ON c.id = a.candidate_id
     WHERE v.kind = 'rejet' AND v.status = 'en_attente' AND COALESCE(v.reminded_at, v.created_at) < datetime('now', ?) LIMIT 5`,
  )
    .bind(`-${cfg.mission.validation_reminder_hours * 6} hours`)
    .all<{ id: string; full_name: string | null }>();
  for (const r of results ?? []) {
    await notify(env, `⏰ Rejet proposé en attente : ${r.full_name ?? "candidat"}. Il reste « en attente » tant que tu n'as pas tranché.`, [
      [
        { text: "✅ Rejeter", data: `v:${r.id}:ok` },
        { text: "↩️ Garder", data: `v:${r.id}:no` },
      ],
    ]);
    await env.DB.prepare("UPDATE validations SET reminded_at = datetime('now') WHERE id = ?").bind(r.id).run();
  }
}

/**
 * Passage du planificateur (Workflow toutes les 15 min, ou cron de secours). Un verrou en base évite deux passages
 * à moins de 10 minutes d'intervalle : un contact n'est jamais envoyé deux fois.
 */
export async function runCron(env: Env, _cron = "*/15 * * * *"): Promise<boolean> {
  const lock = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('cron_last', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now') WHERE settings.value < datetime('now', '-10 minutes')`,
  ).run();
  if (!lock.meta?.changes) return false;
  // Purge RGPD une fois par nuit (entre 2 h et 3 h UTC).
  if (new Date().getUTCHours() === 2 && (await getSetting(env, "purge_last")) !== new Date().toISOString().slice(0, 10)) {
    await setSetting(env, "purge_last", new Date().toISOString().slice(0, 10));
    const n = await purgeInactive(env);
    await env.DB.prepare("DELETE FROM usage WHERE day < date('now', '-62 days')").run();
    await env.DB.prepare("DELETE FROM journal WHERE at < datetime('now', '-400 days')").run();
    if (n) await journal(env, "rgpd", "purge", `${n} candidat(s) effacé(s)`);
  }
  const tasks: [string, () => Promise<unknown>][] = [
    ["contacts", () => processDueContacts(env)],
    ["réponses Gmail", () => checkEmailReplies(env)],
    ["rappels", () => remindValidations(env)],
    ["surveillance des missions", () => watchMissions(env)],
    ["bilan du matin", () => dailyBilan(env)],
  ];
  for (const [name, fn] of tasks) {
    try {
      await fn();
    } catch (e) {
      console.error(name, e);
      await journal(env, "cron", "erreur", { tache: name, erreur: (e as Error).message.slice(0, 300) });
    }
  }
  return true;
}

let schedulerChecked = false;

/** Démarre le Workflow planificateur s'il ne tourne pas (vérifié une fois par instance du Worker). */
export async function ensureScheduler(env: Env): Promise<void> {
  if (schedulerChecked || !env.PLANIFICATEUR) return;
  schedulerChecked = true;
  const id = await getSetting(env, "planificateur_id");
  if (id) {
    try {
      const st = await (await env.PLANIFICATEUR.get(id)).status();
      if (["queued", "running", "waiting", "paused", "waitingForPause"].includes(st.status)) return;
    } catch {
      /* instance inconnue : on en crée une */
    }
  }
  const inst = await env.PLANIFICATEUR.create({ id: `planif-${Date.now()}`, params: {} });
  await setSetting(env, "planificateur_id", inst.id);
}
