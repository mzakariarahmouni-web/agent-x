import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AllProvidersDown } from "./ai/router";
import { getConfig, journal } from "./db";
import type { Env } from "./env";
import {
  analyzeMission,
  applyScopeChange,
  startEvolution,
  evolutionReport,
  evolveFiche,
  planWebQueries,
  sourceQueryAndScore,
  applyFicheChange,
  buildShortlist,
  enrichBatch,
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
import { runCron } from "./cron";
import { ensureSchema } from "./migrate";
import { reevaluatePool } from "./pool";
import { BudgetExhausted } from "./outbound";
import { SearchUnavailable } from "./search";
import type { SourcingRound } from "./sourcing";
import { notify } from "./telegram";

export interface MissionParams {
  missionId: string;
  /** Reprise par la surveillance : fiche déjà validée, on repart du sourcing. */
  resume?: boolean;
}

/** Événement envoyé au Workflow par le bot ou les pages (validation, réponses, évolution). */
export interface MissionEvent {
  action?: "ok" | "mod" | "no";
  text?: string;
  kind?: "answers" | "evolution";
  /** Canal choisi à la validation du message de premier contact. */
  mode?: ChannelMode;
}

/** Missions créées avant le découpage du sourcing en étapes (leur historique de Workflow suit l'ancien enchaînement). */
const LEGACY_BEFORE = "2026-10-18T21:30:00Z";

async function goodPool(env: Env, id: string): Promise<number> {
  const cfg = await getConfig(env);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'score' AND score >= ?").bind(id, cfg.matching.contact_threshold).first<{ n: number }>();
  return r?.n ?? 0;
}

const RETRY = { retries: { limit: 3, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "15 minutes" as const };

type Outcome<T> = { ok: true; value: T } | { ok: false; retryAt: string; reason: string };

/**
 * Étape « jamais d'arrêt » : si toutes les IA ou tous les moteurs sont saturés, l'étape attend leur retour
 * (ou minuit UTC) puis reprend, avec une alerte Telegram.
 */
async function resilientStep<T>(env: Env, step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    const attempt = async (): Promise<Outcome<T>> => {
      try {
        return { ok: true, value: await fn() };
      } catch (e) {
        if (e instanceof AllProvidersDown || e instanceof SearchUnavailable || e instanceof BudgetExhausted) return { ok: false, retryAt: e.retryAt.toISOString(), reason: e.message };
        throw e;
      }
    };
    // Les valeurs renvoyées par les étapes sont des données simples (nombres, chaînes, objets JSON).
    const out = (await step.do(`${name}#${i}`, RETRY, attempt as never)) as Outcome<T>;
    if (out.ok) return out.value;
    // Limite d'appels de l'exécution : simple reprise, sans alerte.
    const silent = Date.parse(out.retryAt) - Date.now() < 60_000;
    if (i === 0 && !silent) {
      await step.do(`${name}#${i}:alerte`, async () => {
        await notify(env, `⏸ Pause automatique (${name}) : ${out.reason}\nReprise prévue vers ${new Date(out.retryAt).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}. Rien n'est perdu.`);
        return true;
      });
    }
    await step.sleepUntil(`${name}#${i}:attente`, new Date(out.retryAt));
  }
}

/**
 * Un tour de sourcing, une requête par étape avec une courte pause entre deux : chaque exécution reste sous la limite
 * de 50 appels sortants de l'offre gratuite (recherche + extraction + notation par requête).
 */
/** Lecture des pages publiques par lots de 3, une étape par lot (limite d'appels de l'offre gratuite). */
async function enrichSteps(env: Env, step: WorkflowStep, id: string, total: number, tag: string): Promise<number> {
  let enriched = 0;
  for (let k = 0; k * 3 < total; k++) {
    const r = await resilientStep(env, step, `${tag}:${k}`, () => enrichBatch(env, id, 3));
    enriched += r.enriched;
    if (r.attempted < 3) break;
    await step.sleep(`${tag}:${k}:pause`, "3 seconds");
  }
  return enriched;
}

async function sourceRoundSteps(env: Env, step: WorkflowStep, id: string, round: SourcingRound, tag: string, max?: number): Promise<number> {
  const plan = await step.do(`${tag}:plan`, () => planWebQueries(env, id, round, max));
  let n = 0;
  for (const [i, q] of plan.queries.entries()) {
    n += await resilientStep(env, step, `${tag}:q${i}`, () => sourceQueryAndScore(env, id, plan.round, q));
    await step.sleep(`${tag}:q${i}:pause`, "3 seconds");
  }
  return n;
}

/**
 * Une mission = un Workflow. Jamais d'arrêt : si toutes les IA ou tous les moteurs sont saturés,
 * l'étape attend leur retour (ou minuit UTC) puis reprend, avec une alerte Telegram.
 */
export class MissionWorkflow extends WorkflowEntrypoint<Env, MissionParams> {
  private resilient<T>(step: WorkflowStep, name: string, fn: () => Promise<T>): Promise<T> {
    return resilientStep(this.env, step, name, fn);
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

    // F1 + validation n°1 (boucle tant que le recruteur modifie). Une reprise repart directement du sourcing.
    const resume = !!event.payload.resume;
    if (!resume) await this.resilient(step, "fiche", () => analyzeMission(env, id).then(() => true));
    for (let round = 0; !resume; round++) {
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

    if (!resume) await step.do("lancement", () => startMission(env, id));

    // F3 : CV-thèque, puis web public (booléen), tour élargi si besoin, lecture des pages publiques.
    const fromCv = await this.resilient(step, "sourcing:cvtheque", () => sourceFromCvtheque(env, id));
    // Missions lancées avant le découpage en étapes : leur historique garde l'ancien enchaînement.
    const legacy = await step.do("mode", async () => {
      const r = await env.DB.prepare("SELECT created_at FROM missions WHERE id = ?").bind(id).first<{ created_at: string }>();
      return !!r && Date.parse(`${r.created_at.replace(" ", "T")}Z`) < Date.parse(LEGACY_BEFORE);
    });
    let fromWeb: number;
    let widened: number;
    if (legacy) {
      fromWeb = await this.resilient(step, "sourcing:web", () => sourceFromWeb(env, id, 1));
      widened = await this.resilient(step, "sourcing:web-elargi", () => sourceFromWeb(env, id, 2));
    } else {
      fromWeb = await sourceRoundSteps(env, step, id, 1, "sourcing:web");
      // Vivier trop maigre : tour élargi (synonymes, intitulés voisins, compétences adjacentes).
      const good = await step.do("sourcing:vivier", () => goodPool(env, id));
      widened = good < cfg.poolTarget ? await sourceRoundSteps(env, step, id, 2, "sourcing:elargi") : 0;
    }
    // Lecture des pages publiques des meilleurs profils, sans connexion (robots de Tavily ou d'Exa).
    const enriched = legacy ? await this.resilient(step, "sourcing:lecture", () => enrichTopProfiles(env, id)) : await enrichSteps(env, step, id, 15, "sourcing:lecture");
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
      if (legacy) await this.resilient(step, "sourcing:variantes", () => sourceFromWeb(env, id, 3));
      else await sourceRoundSteps(env, step, id, 3, "sourcing:variantes", 4);
      if (legacy) await this.resilient(step, "sourcing:variantes-lecture", () => enrichTopProfiles(env, id, 5));
      else await enrichSteps(env, step, id, 9, "sourcing:variantes-lecture");
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
    // Étapes regroupées : un Workflow de l'offre gratuite est limité à 1 024 étapes.
    for (let tick = 0; tick < 150; tick++) {
      let ev: MissionEvent = {};
      try {
        ev = (await step.waitForEvent<MissionEvent>(`point#${tick}`, { type: "point", timeout: "2 hours" })).payload ?? {};
      } catch {
        /* point régulier */
      }
      // Évolution envoyée par une ancienne version du bot : traitée par son propre Workflow (jamais deux fois).
      if (ev.kind === "evolution" && ev.text) {
        await step.do(`evolution#${tick}`, async () => {
          await startEvolution(env, id, ev.text!);
          return true;
        });
      }
      await this.resilient(step, `qualification#${tick}`, () => qualifyPending(env, id));
      // Sourcing continu, en parallèle des contacts : tant que le vivier actif est sous la cible et qu'aucune revue n'est en attente.
      if (tick % cfg.sourceEvery === cfg.sourceEvery - 1) {
        const pool = await step.do(`continu#${tick}:vivier`, () => poolStats(env, id));
        if (pool.active < cfg.poolTarget && pool.pending === 0) {
          await sourceRoundSteps(env, step, id, 3, `continu#${tick}`, 4);
          await enrichSteps(env, step, id, 9, `continu#${tick}:lecture`);
          await step.do(`continu#${tick}:cartes`, () => sendReviewCards(env, id));
        }
      }
      const st = await step.do(`avancement#${tick}`, async () => {
        const p = await progress(env, id);
        const m = await getMission(env, id);
        const go = await env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE mission_id = ? AND state = 'go'").bind(id).first<{ n: number }>();
        return { ...p, status: m.status, now: Date.now(), go: go?.n ?? 0 };
      });
      if (st.status !== "en_cours") return st.status;
      // Premiers Go arrivés après la revue initiale : le message de contact est validé à ce moment-là.
      if (!messageDone && st.go > 0) {
        await this.messagePhase(step, id, `t${tick}`, cfg.reminderHours);
        messageDone = true;
      }
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

/**
 * Planificateur : se réveille toutes les 15 minutes et lance les tâches (contacts aux créneaux, relances,
 * réponses email, rappels, purge RGPD). Passe la main à une nouvelle instance au bout d'environ 9 jours
 * (limite de pas d'un Workflow).
 */
export class SchedulerWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep): Promise<string> {
    const env = this.env;
    // 900 passages (≈ 9 jours) : sous la limite de 1 024 étapes par Workflow de l'offre gratuite.
    for (let i = 0; i < 900; i++) {
      await step.do(`passage#${i}`, { retries: { limit: 2, delay: "1 minute" as const, backoff: "constant" as const }, timeout: "10 minutes" as const }, async () => {
        await ensureSchema(env);
        return runCron(env);
      });
      await step.sleep(`pause#${i}`, "15 minutes");
    }
    await step.do("relais", async () => {
      const inst = await env.PLANIFICATEUR!.create({ id: `planif-${Date.now()}`, params: {} });
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('planificateur_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(inst.id).run();
      return inst.id;
    });
    return "relais passé";
  }
}

export interface EvolutionParams {
  missionId: string;
  text: string;
}

/**
 * Évolution du besoin, traitée à part de la mission (qui peut attendre une revue ou une validation) :
 * nouvelle fiche, vivier re-trié par les nouvelles règles (surdimensionnés, lieu, statut…), Go et contacts hors
 * périmètre retirés, nouveau sourcing ciblé, puis cartes des meilleurs nouveaux profils.
 */
export class EvolutionWorkflow extends WorkflowEntrypoint<Env, EvolutionParams> {
  async run(event: WorkflowEvent<EvolutionParams>, step: WorkflowStep): Promise<string> {
    const env = this.env;
    const { missionId: id, text } = event.payload;
    const open = await step.do("mission", async () => (await getMission(env, id)).status === "en_cours");
    if (!open) return "mission close : évolution ignorée";
    const summary = await resilientStep(env, step, "fiche", () => evolveFiche(env, id, text));
    const scope = await step.do("tri", () => applyScopeChange(env, id));
    await step.do("rapport", async () => {
      await notify(env, `${evolutionReport(summary, scope, 0)}\n\n🔎 Je relance un sourcing ciblé avec la nouvelle fiche ; les cartes arrivent dans quelques minutes.`);
      return true;
    });
    const found = await sourceRoundSteps(env, step, id, 1, "sourcing", 6);
    await enrichSteps(env, step, id, 12, "lecture");
    const cards = await step.do("cartes", async () => {
      await reevaluatePool(env, id);
      return sendReviewCards(env, id);
    });
    await step.do("fin", async () => {
      if (!cards) await notify(env, `🔎 Sourcing après évolution : ${found} profil(s) trouvé(s), aucun nouveau profil à revoir pour l'instant. Je continue toutes les 6 h.`);
      return true;
    });
    return `évolution appliquée, ${cards} carte(s)`;
  }
}
