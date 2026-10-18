import { getConfig, getSetting, journal, secrets } from "../db";
import type { Env } from "../env";
import { BudgetExhausted, HttpError, isBudgetError } from "../outbound";
import { dayUsage, isOpen, recordFailure, recordSuccess } from "../usage";
import { callProvider, type ChatRequest, type ProviderName, providerAvailable, supportsFiles } from "./providers";

export type Family = "jugement" | "volume" | "cv";

/** Tous les fournisseurs sont indisponibles : l'étape doit attendre `retryAt` puis reprendre. */
export class AllProvidersDown extends Error {
  constructor(
    readonly family: string,
    readonly retryAt: Date,
    readonly attempts: string[],
  ) {
    super(`Aucun fournisseur IA disponible pour « ${family} » (${attempts.join(" ; ") || "aucun configuré"})`);
  }
}

export interface AiCall<T> extends ChatRequest {
  family: Family;
  /** Vérifie la réponse (JSON déjà décodé) ; renvoie un message d'erreur pour passer au relais suivant. */
  validate?: (data: T) => string | null;
  /** Pour le journal. */
  label?: string;
  missionId?: string;
}

export interface AiResult<T> {
  data: T;
  text: string;
  provider: string;
}

/** Extrait l'objet JSON d'une réponse de modèle (blocs ```json, texte autour). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body) as T;
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1)) as T;
    throw new Error("JSON introuvable dans la réponse");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Limite journalière (et non à la minute) atteinte ? */
export function isDailyLimit(message: string): boolean {
  return /per day|\b(TPD|RPD)\b|daily|quota exceeded for quota metric.*per_day/i.test(message) && !/per minute|\b(TPM|RPM)\b/i.test(message);
}

/** Délai d'attente conseillé pour une erreur passagère (limite à la minute, surcharge), sinon null. */
export function shortRetryDelay(e: unknown): number | null {
  if (!(e instanceof HttpError)) return null;
  if (e.status === 429 && !isDailyLimit(e.message)) {
    const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(e.message);
    if (!m) return null;
    const s = Number(m[1] ?? 0) * 60 + Number(m[2]);
    return s <= 25 ? Math.ceil(s * 1000) + 500 : null;
  }
  if (e.status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(e.message)) return 8_000;
  return null;
}

/** Un nouvel essai sur le même fournisseur après une erreur passagère, avant de passer au relais suivant. */
async function callWithShortRetry<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (e) {
    const wait = shortRetryDelay(e);
    if (wait == null) throw e;
    await sleep(wait);
    return fn();
  }
}

function parseLink(link: string): { provider: ProviderName; model: string } {
  const i = link.indexOf(":");
  return { provider: link.slice(0, i) as ProviderName, model: link.slice(i + 1) };
}

/**
 * Appelle la meilleure IA disponible pour une famille de tâches, avec relais automatiques :
 * quota proche (90 %), coupe-circuit ouvert, clé absente → fournisseur suivant ; erreur ou réponse invalide → suivant.
 * Si tout est indisponible : AllProvidersDown (l'étape du Workflow attend et reprend seule).
 */
export async function ai<T = unknown>(env: Env, call: AiCall<T>): Promise<AiResult<T>> {
  const cfg = await getConfig(env);
  const keys = await secrets(env);
  const fam = cfg.ai.families[call.family];
  const premium = call.family === "cv" && (await getSetting(env, "premium_cv")) === "1";
  const chain = premium && "premium_chain" in fam ? (fam as { premium_chain: string[] }).premium_chain : fam.chain;
  const limits = cfg.ai.daily_limits as Record<string, number>;
  const attempts: string[] = [];
  let soonest = Infinity;
  const now = new Date();

  for (const link of chain) {
    const { provider, model } = parseLink(link);
    if (!providerAvailable(env, keys, provider)) {
      attempts.push(`${link} : non configuré`);
      continue;
    }
    if (call.file && !supportsFiles(provider)) {
      attempts.push(`${link} : ne lit pas les fichiers`);
      continue;
    }
    const st = await dayUsage(env, link);
    if (isOpen(st, now)) {
      attempts.push(`${link} : en pause`);
      soonest = Math.min(soonest, Date.parse(st.openUntil!));
      continue;
    }
    const limit = limits[provider] ?? Infinity;
    if (st.requests >= Math.floor(limit * cfg.ai.switch_at_ratio)) {
      attempts.push(`${link} : quota du jour presque atteint`);
      const midnight = new Date(now);
      midnight.setUTCHours(24, 0, 0, 0);
      soonest = Math.min(soonest, midnight.getTime());
      continue;
    }
    try {
      const res = await callWithShortRetry(() => callProvider(env, keys, provider, model, call, cfg.ai.timeout_ms));
      let data: T;
      if (call.json) {
        data = extractJson<T>(res.text);
        const problem = call.validate?.(data) ?? null;
        if (problem) throw new Error(`réponse invalide : ${problem}`);
      } else {
        data = res.text as unknown as T;
      }
      await recordSuccess(env, link, res.units);
      return { data, text: res.text, provider: link };
    } catch (e) {
      if (isBudgetError(e)) throw new BudgetExhausted();
      const err = e as Error;
      const status = e instanceof HttpError ? e.status : 0;
      // Clé refusée ou modèle réservé : écarté jusqu'à minuit. Quota du jour épuisé (429 « per day ») : idem.
      // Limite à la minute ou surcharge passagère : simple coupe-circuit de quelques minutes.
      const untilMidnight = status === 401 || status === 403 || (status === 429 && isDailyLimit(err.message));
      await recordFailure(env, link, err.message, { breakerErrors: cfg.ai.breaker.errors, openMinutes: cfg.ai.breaker.open_minutes, untilMidnight });
      attempts.push(`${link} : ${err.message.slice(0, 120)}`);
      await journal(env, "ia", "relais", { famille: call.family, tache: call.label, fournisseur: link, erreur: err.message.slice(0, 200) }, { mission: call.missionId });
      soonest = Math.min(soonest, Date.now() + cfg.ai.breaker.open_minutes * 60_000);
    }
  }
  const retryAt = new Date(Number.isFinite(soonest) ? Math.max(soonest, Date.now() + 60_000) : Date.now() + 15 * 60_000);
  throw new AllProvidersDown(call.family, retryAt, attempts);
}
