import { getConfig, journal } from "./db";
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

export async function runCron(env: Env, cron: string): Promise<void> {
  // Dernier passage du planificateur (visible dans /etat) : prouve que les créneaux d'envoi tournent.
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('cron_last', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')").run();
  if (cron === "0 2 * * *") {
    const n = await purgeInactive(env);
    await env.DB.prepare("DELETE FROM usage WHERE day < date('now', '-62 days')").run();
    await env.DB.prepare("DELETE FROM journal WHERE at < datetime('now', '-400 days')").run();
    if (n) await journal(env, "rgpd", "purge", `${n} candidat(s) effacé(s)`);
    return;
  }
  const tasks: [string, () => Promise<unknown>][] = [
    ["contacts", () => processDueContacts(env)],
    ["réponses Gmail", () => checkEmailReplies(env)],
    ["rappels", () => remindValidations(env)],
  ];
  for (const [name, fn] of tasks) {
    try {
      await fn();
    } catch (e) {
      console.error(name, e);
      await journal(env, "cron", "erreur", { tache: name, erreur: (e as Error).message.slice(0, 300) });
    }
  }
}
