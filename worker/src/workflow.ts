import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AllProvidersDown } from "./ai/router";
import { getConfig, journal } from "./db";
import type { Env } from "./env";
import {
  analyzeMission,
  applyEvolution,
  applyFicheChange,
  buildShortlist,
  enrichTopProfiles,
  getMission,
  markPresented,
  poolStats,
  progress,
  setMissionSender,
  qualifyPending,
  reportSourcing,
  sendFicheValidation,
  sendShortlistValidation,
  sourceFromCvtheque,
  sourceFromWeb,
  startMission,
} from "./mission";
import { applyMessage, type ChannelMode, closeReview, draftModel, type MessageModel, remindReview, sendMessageValidation, sendReviewCards } from "./review";
import { parseSender, readFiche } from "./fiche";
import { getSetting } from "./db";
import { ensureSchema } from "./migrate";
import { reevaluatePool } from "./pool";
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
  /** Canal choisi à la validation du message de premier contact. */
  mode?: ChannelMode;
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

  /** Modèle de premier contact : rédaction, validation (2 exemples), modifications, puis choix du canal et planification. */
  private async messagePhase(step: WorkflowStep, id: string, tag: string, reminderHours: number): Promise<void> {
    const env = this.env;
    let model = await this.resilient(step, `message:${tag}:redaction`, async () => {
      const m = await getMission(env, id);
      const sender = m.sender_name || (await getSetting(env, "sender_default")) || "Le recruteur";
      return draftModel(env, readFiche(m.fiche), sender, undefined, undefined, id);
    });
    for (let round = 0; ; round++) {
      const current: MessageModel = model;
      await step.do(`message:${tag}:envoi#${round}`, async () => {
        await sendMessageValidation(env, id, current);
        return true;
      });
      const d = await this.waitDecision(step, `vmsg:${tag}#${round}`, "vmsg", (n) => sendMessageValidation(env, id, current, n), reminderHours);
      // Signature (« expéditeur : … », guillemets acceptés) : enregistrée, jamais insérée dans le texte du message.
      const { sender, rest } = d.action === "mod" ? parseSender(d.text ?? "") : { sender: null, rest: "" };
      if (sender) {
        await step.do(`message:${tag}:expediteur#${round}`, async () => {
          await setMissionSender(env, id, sender);
          return true;
        });
      }
      if (d.action === "mod" && rest.length >= 3) {
        model = await this.resilient(step, `message:${tag}:modif#${round}`, async () => {
          const m = await getMission(env, id);
          return draftModel(env, readFiche(m.fiche), m.sender_name || "Le recruteur", rest, current, id);
        });
        continue;
      }
      if (d.action === "mod") continue;
      await step.do(`message:${tag}:valide`, async () => {
        const out = await applyMessage(env, id, current, d.mode ?? "auto");
        await notify(
          env,
          `🚀 Premier contact lancé · ${out.planned} profil(s) planifié(s) au prochain créneau (email : ${out.email} · LinkedIn : ${out.linkedin})${out.none ? `\n${out.none} profil(s) sans canal joignable : gardés en CV-thèque.` : ""}\nJe continue de sourcer en parallèle ; les nouveaux profils arrivent en cartes.`,
        );
        return true;
      });
      return;
    }
  }

  async run(event: WorkflowEvent<MissionParams>, step: WorkflowStep): Promise<string> {
    const id = event.payload.missionId;
    const env = this.env;
    const cfg = await step.do("config", async () => {
      await ensureSchema(env);
      const c = await getConfig(env);
      return {
        reminderHours: c.mission.validation_reminder_hours,
        shortlist: c.mission.shortlist_size,
        poolTarget: c.mission.pool_target,
        sourceEvery: Math.max(1, Math.round((c.mission.continuous_sourcing_every_hours ?? 6) / 2)),
      };
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

    // F3 : CV-thèque, puis web public (booléen), tour élargi si besoin, lecture des pages publiques.
    const fromCv = await this.resilient(step, "sourcing:cvtheque", () => sourceFromCvtheque(env, id));
    const fromWeb = await this.resilient(step, "sourcing:web", () => sourceFromWeb(env, id, 1));
    // Vivier trop maigre : tour élargi (synonymes, intitulés voisins, compétences adjacentes).
    const widened = await this.resilient(step, "sourcing:web-elargi", () => sourceFromWeb(env, id, 2));
    // Lecture des pages publiques des meilleurs profils, sans connexion (robots de Tavily ou d'Exa).
    const enriched = await this.resilient(step, "sourcing:lecture", () => enrichTopProfiles(env, id));
    await step.do("sourcing:rapport", async () => {
      await reevaluatePool(env, id);
      const pool = await poolStats(env, id);
      await reportSourcing(env, id, { cvtheque: fromCv, web: fromWeb + widened, widened, enriched, toReview: pool.toReview, eliminated: pool.eliminated });
      return true;
    });

    // Revue : une carte par profil, Go / No go (motif). Rien n'est envoyé sans Go.
    let cards = await step.do("revue:cartes", () => sendReviewCards(env, id));
    if (cards === 0) {
      // Rien d'assez pertinent : tour de variantes immédiat (sans attendre le sourcing continu).
      await this.resilient(step, "sourcing:variantes", () => sourceFromWeb(env, id, 3));
      await this.resilient(step, "sourcing:variantes-lecture", () => enrichTopProfiles(env, id, 5));
      cards = await step.do("revue:cartes-variantes", () => sendReviewCards(env, id));
      if (cards === 0) {
        await step.do("revue:aucune", async () => {
          await notify(env, "🔎 Toujours aucun profil assez proche de la fiche. Je continue de chercher toutes les 6 h. Si le besoin le permet, élargis la fiche avec /missions → « Faire évoluer » (ex. « accepte aussi les profils support EDI sans gestion de projet »).");
          return true;
        });
      }
    }
    let messageDone = false;
    if (cards > 0) {
      await this.waitDecision(step, "revue", "revue", (n) => remindReview(env, id, n), cfg.reminderHours);
      const r = await step.do("revue:cloture", () => closeReview(env, id));
      // Message de premier contact validé une fois pour la mission (les Go suivants sont planifiés directement).
      if (r.go > 0) {
        await this.messagePhase(step, id, "1", cfg.reminderHours);
        messageDone = true;
      }
    }

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
      // Sourcing continu, en parallèle des contacts : tant que le vivier actif est sous la cible et qu'aucune revue n'est en attente.
      if (tick % cfg.sourceEvery === cfg.sourceEvery - 1) {
        const pool = await step.do(`continu#${tick}:vivier`, () => poolStats(env, id));
        if (pool.active < cfg.poolTarget && pool.pending === 0) {
          await this.resilient(step, `continu#${tick}:recherche`, () => sourceFromWeb(env, id, 3));
          await this.resilient(step, `continu#${tick}:lecture`, () => enrichTopProfiles(env, id, 5));
          await step.do(`continu#${tick}:cartes`, () => sendReviewCards(env, id));
        }
      }
      // Premiers Go arrivés après la revue initiale : le message de contact est validé à ce moment-là.
      if (!messageDone) {
        const go = await step.do(`message#${tick}:go`, async () => {
          const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'go'").bind(id).first<{ n: number }>();
          return r?.n ?? 0;
        });
        if (go > 0) {
          await this.messagePhase(step, id, `t${tick}`, cfg.reminderHours);
          messageDone = true;
        }
      }
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
