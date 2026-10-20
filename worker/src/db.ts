import defaults from "../../config/defaults.json";
import type { Env } from "./env";
import { decryptSecret, encryptSecret } from "./security";

export type Config = typeof defaults;

/** Clés API saisies dans la page de configuration (chiffrées en base). */
export const SECRET_KEYS = [
  "telegram_bot_token",
  "gemini_api_key",
  "groq_api_key",
  "tavily_api_key",
  "brave_api_key",
  "exa_api_key",
  "serper_api_key",
  "serpapi_api_key",
  "hunter_api_key",
  "anthropic_api_key",
  "google_client_id",
  "google_client_secret",
  "google_refresh_token",
  "microsoft_client_id",
  "microsoft_client_secret",
  "microsoft_refresh_token",
  "cloudflare_api_token",
  "cloudflare_account_id",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export const nowIso = (d = new Date()) => d.toISOString();

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value, secret FROM settings WHERE key = ?").bind(key).first<{ value: string; secret: number }>();
  if (!row) return null;
  if (!row.secret) return row.value;
  if (!env.ADMIN_TOKEN) return null;
  try {
    return await decryptSecret(env.ADMIN_TOKEN, row.value);
  } catch {
    return null;
  }
}

/**
 * Petit cache par base (30 s) pour la configuration et les clés : chaque appel d'IA les relisait, ce qui faisait
 * dépasser la limite d'appels à la base par exécution de l'offre gratuite. Toute écriture de réglage le vide.
 */
const CACHE_MS = 30_000;
const cache = new WeakMap<object, { config?: { at: number; v: Config }; secrets?: { at: number; v: Partial<Record<SecretKey, string>> } }>();
const cacheOf = (env: Env) => {
  let c = cache.get(env.DB);
  if (!c) cache.set(env.DB, (c = {}));
  return c;
};

export async function setSetting(env: Env, key: string, value: string, secret = false): Promise<void> {
  cache.delete(env.DB);
  if (secret && !env.ADMIN_TOKEN) throw new Error("ADMIN_TOKEN manquant : impossible de chiffrer la clé");
  const stored = secret ? await encryptSecret(env.ADMIN_TOKEN!, value) : value;
  await env.DB.prepare(
    "INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at",
  )
    .bind(key, stored, secret ? 1 : 0)
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  cache.delete(env.DB);
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

/** Lit plusieurs secrets d'un coup (absents = undefined). */
export async function secrets(env: Env): Promise<Partial<Record<SecretKey, string>>> {
  const c = cacheOf(env);
  if (c.secrets && Date.now() - c.secrets.at < CACHE_MS) return c.secrets.v;
  const out: Partial<Record<SecretKey, string>> = {};
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE secret = 1`).all<{ key: SecretKey; value: string }>();
  if (!env.ADMIN_TOKEN) return out;
  for (const r of results ?? []) {
    try {
      out[r.key] = await decryptSecret(env.ADMIN_TOKEN, r.value);
    } catch {
      /* clé chiffrée avec un ancien mot de passe : ignorée */
    }
  }
  if (env.ADMIN_TOKEN) c.secrets = { at: Date.now(), v: out };
  return out;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/** Configuration effective : valeurs par défaut + réglages enregistrés dans la page de configuration. */
export async function getConfig(env: Env): Promise<Config> {
  const c = cacheOf(env);
  if (c.config && Date.now() - c.config.at < CACHE_MS) return c.config.v;
  const raw = await getSetting(env, "config");
  let v: Config = defaults;
  try {
    if (raw) v = deepMerge(defaults, JSON.parse(raw));
  } catch {
    v = defaults;
  }
  c.config = { at: Date.now(), v };
  return v;
}

export async function journal(env: Env, actor: string, action: string, detail?: unknown, ids: { mission?: string; candidate?: string } = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO journal (mission_id, candidate_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(ids.mission ?? null, ids.candidate ?? null, actor, action, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4000))
    .run();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
