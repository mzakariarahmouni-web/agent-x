import { ai } from "./ai/router";
import { getConfig, getSetting, journal, parseJson, SECRET_KEYS, type SecretKey, secrets, setSetting, deleteSetting } from "./db";
import type { Env } from "./env";
import { authUrl, exchangeCode } from "./gmail";
import { activeMailbox } from "./mail";
import { outlookAuthUrl, outlookExchangeCode } from "./outlook";
import { zipStore } from "./docx";
import { EXTENSION_FILES } from "./generated/extension";
import page from "./pages/config.html";
import { webSearch } from "./search";
import { derivedSecret, safeEqual } from "./security";
import { setupBot } from "./telegram";
import { usageToday } from "./usage";

/** Page de configuration (protégée par ADMIN_TOKEN) et son API. */

const COOKIE = "ax_session";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function sessionValue(env: Env): Promise<string> {
  return derivedSecret(env.ADMIN_TOKEN!, "session");
}

export async function isAdmin(env: Env, req: Request): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const v = new RegExp(`${COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? "";
  return !!v && safeEqual(v, await sessionValue(env));
}

export function configPage(env: Env): Response {
  if (!env.ADMIN_TOKEN)
    return new Response(
      "Agent X : définissez d'abord le secret ADMIN_TOKEN dans Cloudflare (Workers → agent-x → Paramètres → Variables et secrets), puis rechargez cette page.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

async function login(env: Env, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  if (!env.ADMIN_TOKEN || !body.token || !safeEqual(body.token, env.ADMIN_TOKEN)) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ ok: false, error: "Mot de passe incorrect." }, 401);
  }
  const origin = new URL(req.url).origin;
  if (!(await getSetting(env, "public_url"))) await setSetting(env, "public_url", origin);
  const res = json({ ok: true });
  res.headers.append("set-cookie", `${COOKIE}=${await sessionValue(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86_400}`);
  return res;
}

async function status(env: Env): Promise<Response> {
  const k = await secrets(env);
  const configured = Object.fromEntries(SECRET_KEYS.map((key) => [key, !!k[key]]));
  const prefs = {
    sender_default: (await getSetting(env, "sender_default")) ?? "",
    premium_cv: (await getSetting(env, "premium_cv")) === "1",
    cv_brand: parseJson(await getSetting(env, "cv_brand"), { font: "Calibri", color: "#1F3864", show_tjm: false }),
    config: parseJson(await getSetting(env, "config"), {}),
  };
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM missions WHERE status = 'en_cours') AS missions, (SELECT COUNT(*) FROM candidates) AS candidats, (SELECT COUNT(*) FROM linkedin_queue WHERE status = 'a_envoyer') AS linkedin",
  ).first<{ missions: number; candidats: number; linkedin: number }>();
  return json({
    ok: true,
    configured,
    telegram: await telegramStatus(env),
    gmail: await getSetting(env, "gmail_address"),
    outlook: await getSetting(env, "outlook_address"),
    mailbox: await activeMailbox(env),
    public_url: await getSetting(env, "public_url"),
    workers_ai: !!env.AI,
    usage: await usageToday(env),
    counts,
    prefs,
    defaults: await getConfig(env),
  });
}

async function saveSecrets(env: Env, req: Request): Promise<Response> {
  const body = (await req.json()) as Record<string, string>;
  const saved: string[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!(SECRET_KEYS as readonly string[]).includes(key)) continue;
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (value === "-") await deleteSetting(env, key);
    else await setSetting(env, key as SecretKey, value, true);
    saved.push(key);
  }
  await journal(env, "admin", "cles_mises_a_jour", saved);
  return json({ ok: true, saved });
}

async function savePrefs(env: Env, req: Request): Promise<Response> {
  const b = (await req.json()) as { sender_default?: string; premium_cv?: boolean; cv_brand?: unknown; config?: unknown; mail_provider?: string };
  if (b.mail_provider === "gmail" || b.mail_provider === "outlook") await setSetting(env, "mail_provider", b.mail_provider);
  if (typeof b.sender_default === "string") await setSetting(env, "sender_default", b.sender_default.trim().slice(0, 80));
  if (typeof b.premium_cv === "boolean") await setSetting(env, "premium_cv", b.premium_cv ? "1" : "0");
  if (b.cv_brand && typeof b.cv_brand === "object") await setSetting(env, "cv_brand", JSON.stringify(b.cv_brand));
  if (b.config && typeof b.config === "object") await setSetting(env, "config", JSON.stringify(b.config));
  return json({ ok: true });
}

async function telegramStatus(env: Env): Promise<{ linked: boolean; username: string | null; link: string | null; code: string | null }> {
  const linked = !!(await getSetting(env, "telegram_chat_id"));
  const username = await getSetting(env, "telegram_username");
  const code = !linked && username ? (await derivedSecret(env.ADMIN_TOKEN!, "telegram-link")).slice(0, 16) : null;
  return { linked, username, link: code ? `https://t.me/${username}?start=${code}` : null, code };
}

async function linkTelegram(env: Env, req: Request): Promise<Response> {
  const token = await getSetting(env, "telegram_bot_token");
  if (!token) return json({ ok: false, error: "Enregistrez d'abord le jeton du bot Telegram." }, 400);
  const origin = (await getSetting(env, "public_url")) || new URL(req.url).origin;
  const { username } = await setupBot(env, token, `${origin}/telegram/webhook`, await derivedSecret(env.ADMIN_TOKEN!, "telegram"));
  await setSetting(env, "telegram_username", username);
  const code = (await derivedSecret(env.ADMIN_TOKEN!, "telegram-link")).slice(0, 16);
  return json({ ok: true, username, code, link: `https://t.me/${username}?start=${code}` });
}

/** Petit appel réel pour vérifier une clé (IA ou recherche). */
async function testProvider(env: Env, name: string): Promise<Response> {
  try {
    if (name === "search") {
      const r = await webSearch(env, "site:linkedin.com/in chef de projet AMOA Paris");
      return json({ ok: true, detail: `${r.engine} : ${r.hits.length} résultat(s)` });
    }
    const family = name === "volume" ? "volume" : "jugement";
    const r = await ai<{ ok: boolean }>(env, { family, label: "test", system: "Réponds uniquement en JSON.", prompt: 'Renvoie {"ok": true}', json: true, maxTokens: 50 });
    return json({ ok: true, detail: `réponse de ${r.provider}` });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message.slice(0, 400) });
  }
}

async function googleStart(env: Env, req: Request): Promise<Response> {
  const k = await secrets(env);
  if (!k.google_client_id || !k.google_client_secret) return new Response("Renseignez d'abord l'identifiant et le secret OAuth Google.", { status: 400 });
  const origin = (await getSetting(env, "public_url")) || new URL(req.url).origin;
  const state = await derivedSecret(env.ADMIN_TOKEN!, "google-oauth");
  return Response.redirect(authUrl(k.google_client_id, `${origin}/oauth/google/callback`, state), 302);
}

/** Extension Edge/Chrome prête à installer : archive .zip avec l'adresse et le jeton déjà renseignés. */
export async function extensionZip(env: Env, origin: string): Promise<Uint8Array> {
  const url = (await getSetting(env, "public_url")) || origin;
  const token = await derivedSecret(env.ADMIN_TOKEN!, "extension");
  const enc = new TextEncoder();
  const files = Object.entries(EXTENSION_FILES).map(([name, text]) => ({ name: `agent-x-linkedin/${name}`, data: enc.encode(text) }));
  files.push({ name: "agent-x-linkedin/config.js", data: enc.encode(`// Réglages d'Agent X (préremplis). Ne partagez pas ce fichier : il contient votre jeton.\nself.AGENT_X_DEFAULTS = ${JSON.stringify({ url, token })};\n`) });
  return zipStore(files);
}

async function microsoftStart(env: Env, req: Request): Promise<Response> {
  const k = await secrets(env);
  if (!k.microsoft_client_id || !k.microsoft_client_secret) return new Response("Renseignez d'abord l'identifiant et le secret de l'application Microsoft.", { status: 400 });
  const origin = (await getSetting(env, "public_url")) || new URL(req.url).origin;
  return Response.redirect(outlookAuthUrl(k.microsoft_client_id, `${origin}/oauth/microsoft/callback`, await derivedSecret(env.ADMIN_TOKEN!, "microsoft-oauth")), 302);
}

async function microsoftCallback(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get("state") ?? "", await derivedSecret(env.ADMIN_TOKEN!, "microsoft-oauth"))) return new Response("Requête invalide.", { status: 400 });
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(`${url.origin}/config?outlook=refus`, 302);
  try {
    const origin = (await getSetting(env, "public_url")) || url.origin;
    const address = await outlookExchangeCode(env, code, `${origin}/oauth/microsoft/callback`);
    if (!(await getSetting(env, "mail_provider"))) await setSetting(env, "mail_provider", "outlook");
    await journal(env, "admin", "outlook_connecte", address);
    return Response.redirect(`${url.origin}/config?outlook=ok`, 302);
  } catch (e) {
    return new Response(`Connexion Outlook impossible : ${(e as Error).message}`, { status: 400 });
  }
}

async function googleCallback(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  if (!safeEqual(state, await derivedSecret(env.ADMIN_TOKEN!, "google-oauth"))) return new Response("Requête invalide.", { status: 400 });
  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(`${url.origin}/config?gmail=refus`, 302);
  try {
    const origin = (await getSetting(env, "public_url")) || url.origin;
    const address = await exchangeCode(env, code, `${origin}/oauth/google/callback`);
    await journal(env, "admin", "gmail_connecte", address);
    return Response.redirect(`${url.origin}/config?gmail=ok`, 302);
  } catch (e) {
    return new Response(`Connexion Gmail impossible : ${(e as Error).message}`, { status: 400 });
  }
}

export async function handleAdmin(env: Env, req: Request, path: string): Promise<Response> {
  try {
    return await routeAdmin(env, req, path);
  } catch (e) {
    // Toujours une réponse lisible par la page : le message d'erreur réel, jamais une page d'erreur brute.
    console.error("admin", e);
    return json({ ok: false, error: (e as Error).message.slice(0, 400) || "Erreur inconnue" }, 500);
  }
}

async function routeAdmin(env: Env, req: Request, path: string): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "ADMIN_TOKEN manquant dans Cloudflare." }, 503);
  if (path === "/api/admin/login" && req.method === "POST") return login(env, req);
  if (!(await isAdmin(env, req))) return path.startsWith("/oauth/") ? Response.redirect(`${new URL(req.url).origin}/config`, 302) : json({ ok: false, error: "Session expirée." }, 401);
  if (path === "/api/admin/status") return status(env);
  if (path === "/api/admin/secrets" && req.method === "POST") return saveSecrets(env, req);
  if (path === "/api/admin/prefs" && req.method === "POST") return savePrefs(env, req);
  if (path === "/api/admin/telegram" && req.method === "POST") return linkTelegram(env, req);
  if (path.startsWith("/api/admin/test/")) return testProvider(env, path.split("/").pop()!);
  if (path === "/api/admin/extension") return json({ ok: true, token: await derivedSecret(env.ADMIN_TOKEN, "extension"), url: (await getSetting(env, "public_url")) || new URL(req.url).origin });
  if (path === "/api/admin/extension.zip")
    return new Response(await extensionZip(env, new URL(req.url).origin), {
      headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="agent-x-linkedin.zip"', "cache-control": "no-store" },
    });
  if (path === "/oauth/google/start") return googleStart(env, req);
  if (path === "/oauth/google/callback") return googleCallback(env, req);
  if (path === "/oauth/microsoft/start") return microsoftStart(env, req);
  if (path === "/oauth/microsoft/callback") return microsoftCallback(env, req);
  return json({ ok: false, error: "introuvable" }, 404);
}
