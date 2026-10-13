import { getConfig, journal, secrets } from "./db";
import type { Env } from "./env";
import { fetchJson, HttpError } from "./outbound";
import { dayUsage, isOpen, monthRequests, recordFailure, recordSuccess } from "./usage";

/**
 * Recherche web de profils publics (relais Tavily → Brave → Exa, quotas mensuels) et lecture des pages
 * publiques sans connexion, par les robots de ces services : Agent X n'appelle jamais LinkedIn lui-même.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Requête booléenne (guillemets, OR, -exclusion) limitée à un site, adaptée ensuite à chaque moteur. */
export interface SearchQuery {
  boolean: string;
  domain?: string;
  label?: string;
}

export class SearchUnavailable extends Error {
  constructor(readonly retryAt: Date) {
    super("Aucun moteur de recherche disponible");
  }
}

type Engine = "tavily" | "brave" | "exa";

/** Ancienne forme « site:domaine requête » → requête structurée. */
export function toQuery(q: string | SearchQuery): SearchQuery {
  if (typeof q !== "string") return q;
  const m = /^\s*site:(\S+)\s+([\s\S]*)$/.exec(q);
  return m ? { boolean: m[2].trim(), domain: m[1] } : { boolean: q.trim() };
}

/** Texte exact envoyé à chaque moteur (exporté pour les tests). */
export function engineQuery(engine: Engine, q: SearchQuery): string {
  if (engine === "brave") return q.domain ? `site:${q.domain} ${q.boolean}` : q.boolean;
  // Tavily et Exa ne sont pas des moteurs booléens : la même recherche en mots-clés simples
  // (exclusions retirées, groupes OR réduits aux deux premières variantes), le site étant filtré par paramètre.
  return naturalQuery(q.boolean);
}

export function naturalQuery(boolean: string): string {
  const withoutExcl = boolean.replace(/(^|\s)-("[^"]*"|\S+)/g, " ");
  const groups = withoutExcl.replace(/\(([^()]*)\)/g, (_, inner: string) =>
    inner
      .split(/\s+OR\s+/)
      .slice(0, 2)
      .map((x) => x.replace(/"/g, "").trim())
      .join(" or "),
  );
  return groups.replace(/"/g, "").replace(/\s+/g, " ").trim();
}

const baseDomain = (d?: string) => (d ? d.replace(/\/.*$/, "") : undefined);

async function tavily(env: Env, key: string, q: SearchQuery, n: number): Promise<SearchHit[]> {
  const r = await fetchJson<{ results?: { title?: string; url: string; content?: string }[] }>(env, "tavily", "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: engineQuery("tavily", q), max_results: n, search_depth: "basic", ...(q.domain ? { include_domains: [baseDomain(q.domain)] } : {}) }),
  });
  return (r.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: x.content ?? "" }));
}

async function brave(env: Env, key: string, q: SearchQuery, n: number): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(engineQuery("brave", q))}&count=${Math.min(n, 20)}&country=FR&search_lang=fr`;
  const r = await fetchJson<{ web?: { results?: { title?: string; url: string; description?: string }[] } }>(env, "brave", url, {
    headers: { accept: "application/json", "x-subscription-token": key },
  });
  return (r.web?.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: (x.description ?? "").replace(/<[^>]+>/g, "") }));
}

async function exa(env: Env, key: string, q: SearchQuery, n: number): Promise<SearchHit[]> {
  const r = await fetchJson<{ results?: { title?: string; url: string; text?: string }[] }>(env, "exa", "https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      query: engineQuery("exa", q),
      numResults: n,
      type: "auto",
      ...(q.domain ? { includeDomains: [baseDomain(q.domain)] } : {}),
      contents: { text: { maxCharacters: 1200 } },
    }),
  });
  return (r.results ?? []).map((x) => ({ title: x.title ?? "", url: x.url, snippet: x.text ?? "" }));
}

interface EngineChoice {
  engine: Engine;
  key: string;
}

/** Moteurs utilisables maintenant (clé présente, pas en pause, quota du mois non atteint), dans l'ordre de la chaîne. */
async function usableEngines(env: Env, kind: "search" | "extract"): Promise<{ list: EngineChoice[]; soonest: number }> {
  const cfg = await getConfig(env);
  const keys = await secrets(env);
  const keyOf: Record<Engine, string | undefined> = { tavily: keys.tavily_api_key, brave: keys.brave_api_key, exa: keys.exa_api_key };
  const limits = cfg.search.monthly_limits as Record<string, number>;
  const list: EngineChoice[] = [];
  let soonest = Infinity;
  for (const engine of cfg.search.chain as Engine[]) {
    if (kind === "extract" && engine === "brave") continue; // Brave ne lit pas les pages.
    const key = keyOf[engine];
    if (!key) continue;
    const st = await dayUsage(env, `search:${engine}`);
    if (isOpen(st)) {
      soonest = Math.min(soonest, Date.parse(st.openUntil!));
      continue;
    }
    if ((await monthRequests(env, `search:${engine}`)) >= (limits[engine] ?? Infinity)) continue;
    list.push({ engine, key });
  }
  return { list, soonest };
}

async function failure(env: Env, engine: Engine, e: unknown, missionId?: string): Promise<void> {
  const status = e instanceof HttpError ? e.status : 0;
  await recordFailure(env, `search:${engine}`, (e as Error).message, { breakerErrors: 2, openMinutes: 30, untilMidnight: status === 401 || status === 403 || status === 432 });
  await journal(env, "recherche", "relais", { moteur: engine, erreur: (e as Error).message.slice(0, 200) }, { mission: missionId });
}

/**
 * Recherche sur tous les moteurs disponibles en parallèle (Tavily, Brave, Exa), résultats fusionnés et dédoublonnés :
 * chaque moteur a son propre index, on trouve donc plus de profils. Un moteur en panne ne bloque pas les autres ;
 * si tous échouent, SearchUnavailable (l'étape attend et reprend).
 */
export async function webSearch(env: Env, query: string | SearchQuery, missionId?: string): Promise<{ engine: string; hits: SearchHit[] }> {
  const cfg = await getConfig(env);
  if ((cfg.search as { mode?: string }).mode === "relais") return webSearchChain(env, query, missionId);
  const q = toQuery(query);
  const { list, soonest: s0 } = await usableEngines(env, "search");
  const n = cfg.search.results_per_query;
  const outcomes = await Promise.all(
    list.map(async ({ engine, key }) => {
      try {
        const hits = engine === "tavily" ? await tavily(env, key, q, n) : engine === "brave" ? await brave(env, key, q, n) : await exa(env, key, q, n);
        await recordSuccess(env, `search:${engine}`);
        return { engine, hits };
      } catch (e) {
        await failure(env, engine, e, missionId);
        return null;
      }
    }),
  );
  const ok = outcomes.filter((o): o is { engine: Engine; hits: SearchHit[] } => !!o);
  if (!ok.length) throw new SearchUnavailable(new Date(list.length ? Date.now() + 30 * 60_000 : Number.isFinite(s0) ? s0 : Date.now() + 6 * 3_600_000));
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const o of ok)
    for (const h of o.hits) {
      const k = h.url.split(/[?#]/)[0].replace(/\/$/, "").replace(/^https?:\/\/[a-z]{2}\.linkedin\.com/i, "https://www.linkedin.com").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push(h);
    }
  return { engine: ok.map((o) => o.engine).join("+"), hits };
}

/** Ancien mode : un seul moteur à la fois, les suivants en relais (réglage search.mode = "relais"). */
export async function webSearchChain(env: Env, query: string | SearchQuery, missionId?: string): Promise<{ engine: string; hits: SearchHit[] }> {
  const cfg = await getConfig(env);
  const q = toQuery(query);
  const { list, soonest: s0 } = await usableEngines(env, "search");
  let soonest = s0;
  for (const { engine, key } of list) {
    try {
      const n = cfg.search.results_per_query;
      const hits = engine === "tavily" ? await tavily(env, key, q, n) : engine === "brave" ? await brave(env, key, q, n) : await exa(env, key, q, n);
      await recordSuccess(env, `search:${engine}`);
      return { engine, hits };
    } catch (e) {
      await failure(env, engine, e, missionId);
      soonest = Math.min(soonest, Date.now() + 30 * 60_000);
    }
  }
  throw new SearchUnavailable(new Date(Number.isFinite(soonest) ? soonest : Date.now() + 6 * 3_600_000));
}

export interface PageText {
  url: string;
  text: string;
}

/**
 * Lit le texte de pages publiques (profils LinkedIn publics, Malt, GitHub) sans aucune connexion :
 * ce sont les robots de Tavily (Extract) ou d'Exa (Contents) qui lisent les pages, jamais Agent X ni ton compte.
 * Par lots de 5 adresses ; une page illisible est simplement absente du résultat.
 */
export async function readPublicPages(env: Env, urls: string[], missionId?: string): Promise<{ engine: string | null; pages: PageText[] }> {
  if (!urls.length) return { engine: null, pages: [] };
  const { list } = await usableEngines(env, "extract");
  for (const { engine, key } of list) {
    try {
      const pages: PageText[] = [];
      for (let i = 0; i < urls.length; i += 5) {
        const batch = urls.slice(i, i + 5);
        if (engine === "tavily") {
          const r = await fetchJson<{ results?: { url: string; raw_content?: string }[] }>(env, "tavily", "https://api.tavily.com/extract", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ urls: batch, extract_depth: "basic" }),
          });
          for (const x of r.results ?? []) if (x.raw_content) pages.push({ url: x.url, text: x.raw_content.slice(0, 6000) });
        } else {
          const r = await fetchJson<{ results?: { url: string; text?: string }[] }>(env, "exa", "https://api.exa.ai/contents", {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": key },
            body: JSON.stringify({ urls: batch, text: { maxCharacters: 6000 } }),
          });
          for (const x of r.results ?? []) if (x.text) pages.push({ url: x.url, text: x.text });
        }
        await recordSuccess(env, `search:${engine}`);
      }
      return { engine, pages };
    } catch (e) {
      await failure(env, engine as Engine, e, missionId);
    }
  }
  // Lecture impossible : le sourcing continue avec les extraits de recherche.
  return { engine: null, pages: [] };
}
