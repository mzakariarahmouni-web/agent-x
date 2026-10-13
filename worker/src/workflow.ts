import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AllProvidersDown } from "./ai/router";
import { getConfig, journal } from "./db";
import type { Env } from "./env";
import {
  analyzeMission,
  applyEvolution,
  applyFicheChange,
  buildShortlist,
  getMission,
  markPresented,
  planOutreach,
  progress,
  qualifyPending,
  reportSourcing,
  sendFicheValidation,
  sendShortlistValidation,
  sourceFromCvtheque,
  sourceFromWeb,
  startMission,
} from "./mission";
import { SearchUnavailable } from "./search";
import { notify } from "./telegram";

export interface MissionParams {
  missionId: string;
}

/** Événement envoyé au Workflow par le bot ou les pages (validation, réponses, évolution). */
export interface MissionEvent {
  action?: "ok" | "mod" | "no";
  text?: string;
  kind?: "answers" | "evolution";
}

const RETRY = { retries: { limit: 3, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "15 minutes" as const };

type Outcome<T> = { ok: true; value: T } | { ok: false; retryAt: string; reason: string };

/**
 * Une mission = un Workflow. Jamais d'arrêt : si toutes les IA ou tous les moteurs sont saturés,
 * l'étape attend leur retour (ou minuit UTC) puis reprend, avec une alerte Telegram.
 */
export class MissionWorkflow extends WorkflowEntrypoint<Env, MissionParams> {
  private async resilient<T>(step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      const attempt = async (): Promise<Outcome<T>> => {
        try {
          return { ok: true, value: await fn() };
        } catch (e) {
          if (e instanceof AllProvidersDown || e instanceof SearchUnavailable) return { ok: false, retryAt: e.retryAt.toISOString(), reason: e.message };
          throw e;
        }
      };
      // Les valeurs renvoyées par les étapes sont des données simples (nombres, chaînes, objets JSON).
      const out = (await step.do(`${name}#${i}`, RETRY, attempt as never)) as Outcome<T>;
      if (out.ok) return out.value;
      if (i === 0) {
        await step.do(`${name}#${i}:alerte`, async () => {
          await notify(this.env, `⏸ Pause automatique (${name}) : ${out.reason}\nReprise prévue vers ${new Date(out.retryAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}. Rien n'est perdu.`);
          return true;
        });
      }
      await step.sleepUntil(`${name}#${i}:attente`, new Date(out.retryAt));
    }
  }

  private async waitDecision(step: WorkflowStep, name: string, type: string, onTimeout: (n: number) => Promise<void>, hours: number): Promise<MissionEvent> {
    for (let n = 1; ; n++) {
      try {
        const ev = await step.waitForEvent<MissionEvent>(`${name}:attente#${n}`, { type, timeout: `${hours} hours` });
        return ev.payload ?? {};
      } catch {
        await step.do(`${name}:rappel#${n}`, async () => {
          await onTimeout(n);
          return true;
        });
      }
    }
  }

  async run(event: WorkflowEvent<MissionParams>, step: WorkflowStep): Promise<string> {
    const id = event.payload.missionId;
    const env = this.env;
    const cfg = await step.do("config", async () => {
      const c = await getConfig(env);
      return { reminderHours: c.mission.validation_reminder_hours, shortlist: c.mission.shortlist_size };
    });

    // F1 + validation n°1 (boucle tant que le recruteur modifie).
    await this.resilient(step, "fiche", () => analyzeMission(env, id).then(() => true));
    for (let round = 0; ; round++) {
      await step.do(`v1:envoi#${round}`, async () => {
        await sendFicheValidation(env, id);
        return true;
      });
      const d = await this.waitDecision(step, `v1#${round}`, "v1", (n) => sendFicheValidation(env, id, n), cfg.reminderHours);
      if (d.action === "ok") break;
      if (d.action === "no") {
        await step.do("abandon", async () => {
          await env.DB.prepare("UPDATE missions SET status = 'abandonnee' WHERE id = ?").bind(id).run();
          await journal(env, "recruteur", "mission_abandonnee", null, { mission: id });
          return true;
        });
        return "abandonnée";
      }
      await this.resilient(step, `v1:modif#${round}`, () => applyFicheChange(env, id, d.text ?? "").then(() => true));
    }

    await step.do("lancement", () => startMission(env, id));

    // F3 : CV-thèque, puis web public, puis planification des contacts (F4 est exécuté par le cron, aux créneaux).
    const fromCv = await this.resilient(step, "sourcing:cvtheque", () => sourceFromCvtheque(env, id));
    const fromWeb = await this.resilient(step, "sourcing:web", () => sourceFromWeb(env, id));
    const plan = await step.do("contacts:planification", () => planOutreach(env, id));
    await step.do("sourcing:rapport", async () => {
      await reportSourcing(env, id, { cvtheque: fromCv, web: fromWeb, planned: plan.planned, eliminated: plan.eliminated });
      return true;
    });

    // F5 : réveil à chaque questionnaire reçu (ou toutes les 2 h), jusqu'à la shortlist ou l'échéance.
    for (let tick = 0; tick < 200; tick++) {
      let ev: MissionEvent = {};
      try {
        ev = (await step.waitForEvent<MissionEvent>(`point#${tick}`, { type: "point", timeout: "2 hours" })).payload ?? {};
      } catch {
        /* point régulier */
      }
      if (ev.kind === "evolution" && ev.text) {
        const msg = await this.resilient(step, `evolution#${tick}`, () => applyEvolution(env, id, ev.text!));
        await step.do(`evolution#${tick}:notif`, async () => {
          await notify(env, msg);
          return true;
        });
      }
      await this.resilient(step, `qualification#${tick}`, () => qualifyPending(env, id));
      const st = await step.do(`avancement#${tick}`, async () => {
        const p = await progress(env, id);
        const m = await getMission(env, id);
        return { ...p, status: m.status, now: Date.now() };
      });
      if (st.status !== "en_cours") return st.status;
      const deadline = st.deadline ? Date.parse(st.deadline) : Infinity;
      const nearDeadline = st.now >= deadline - 6 * 3_600_000;
      if (st.qualified >= cfg.shortlist || (nearDeadline && st.qualified > 0)) break;
      if (st.now >= deadline && st.qualified === 0 && tick % 12 === 0) {
        await step.do(`echeance#${tick}`, async () => {
          await notify(env, `⚠️ Échéance des 48 h ouvrées dépassée, aucun candidat qualifié pour l'instant (${st.inProgress} en cours). Je continue ; tu peux élargir la fiche avec /missions → « Faire évoluer ».`);
          return true;
        });
      }
    }

    // F6 + validations n°3 et 4 (boucle si le recruteur retire des candidats).
    const excluded: string[] = [];
    for (let round = 0; ; round++) {
      const apps = await this.resilient(step, `shortlist#${round}`, () => buildShortlist(env, id, excluded));
      await step.do(`v3:envoi#${round}`, async () => {
        await sendShortlistValidation(env, id, apps);
        return true;
      });
      const d = await this.waitDecision(step, `v3#${round}`, "v3", (n) => sendShortlistValidation(env, id, apps, n), cfg.reminderHours);
      if (d.action === "ok") {
        await step.do("presentation", async () => {
          await markPresented(env, id, apps);
          await journal(env, "recruteur", "shortlist_envoyee", { candidatures: apps }, { mission: id });
          return true;
        });
        return "shortlist envoyée";
      }
      const nums = [...(d.text ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]) - 1).filter((n) => n >= 0 && n < apps.length);
      for (const n of nums) excluded.push(apps[n]);
      if (!nums.length) {
        await step.do(`v3:incompris#${round}`, async () => {
          await notify(env, "Je n'ai pas compris la modification : indique les numéros à retirer, par exemple « retire 2 et 4 ».");
          return true;
        });
      }
    }
  }
}
