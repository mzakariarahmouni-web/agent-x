import { getSetting, secrets, setSetting } from "./db";
import type { Env } from "./env";
import { apiFetch, fetchJson } from "./outbound";

/**
 * Email depuis la boîte Outlook du recruteur (Microsoft Graph, autorisation OAuth une seule fois).
 * Fonctionne avec les comptes personnels (outlook.com, hotmail) et professionnels (Microsoft 365).
 */

export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.Send", "Mail.Read"];
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";

export function outlookAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: OUTLOOK_SCOPES.join(" "), state, prompt: "select_account" });
  return `${AUTH}/authorize?${p}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
}

async function token(env: Env, body: Record<string, string>): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(env, "microsoft", `${AUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

export async function outlookExchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const k = await secrets(env);
  const r = await token(env, {
    client_id: k.microsoft_client_id ?? "",
    client_secret: k.microsoft_client_secret ?? "",
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    scope: OUTLOOK_SCOPES.join(" "),
  });
  if (!r.refresh_token) throw new Error("Microsoft n'a pas renvoyé de jeton durable : vérifiez la permission « offline_access ».");
  await setSetting(env, "microsoft_refresh_token", r.refresh_token, true);
  const me = await fetchJson<{ mail?: string | null; userPrincipalName?: string }>(env, "outlook", `${GRAPH}/me?$select=mail,userPrincipalName`, {
    headers: { authorization: `Bearer ${r.access_token}` },
  });
  const address = me.mail || me.userPrincipalName || "";
  await setSetting(env, "outlook_address", address);
  return address;
}

/** Jeton d'accès ; Microsoft renouvelle aussi le jeton durable à chaque fois : on garde le plus récent. */
async function accessToken(env: Env): Promise<string | null> {
  const k = await secrets(env);
  if (!k.microsoft_refresh_token || !k.microsoft_client_id || !k.microsoft_client_secret) return null;
  const r = await token(env, {
    client_id: k.microsoft_client_id,
    client_secret: k.microsoft_client_secret,
    refresh_token: k.microsoft_refresh_token,
    grant_type: "refresh_token",
    scope: OUTLOOK_SCOPES.join(" "),
  });
  if (r.refresh_token && r.refresh_token !== k.microsoft_refresh_token) await setSetting(env, "microsoft_refresh_token", r.refresh_token, true);
  return r.access_token;
}

export async function outlookReady(env: Env): Promise<boolean> {
  return !!(await getSetting(env, "outlook_address")) && !!(await secrets(env)).microsoft_refresh_token;
}

export async function outlookSend(env: Env, fromName: string, to: string, subject: string, body: string): Promise<void> {
  const t = await accessToken(env);
  if (!t) throw new Error("Outlook non connecté");
  // Le nom affiché est celui du compte Microsoft ; on le rappelle en signature (corps du message).
  void fromName;
  const res = await apiFetch(env, `${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
  // Graph répond 202 sans corps en cas de succès.
  if (!res.ok) throw new Error(`Outlook ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Adresses (parmi `emails`) qui ont écrit dans la boîte de réception depuis `sinceDays` jours. */
export async function outlookRepliesFrom(env: Env, emails: string[], sinceDays = 7): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length) return out;
  const t = await accessToken(env);
  if (!t) return out;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const url = `${GRAPH}/me/mailFolders/inbox/messages?$select=from,receivedDateTime&$top=100&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
  const r = await fetchJson<{ value?: { from?: { emailAddress?: { address?: string } } }[] }>(env, "outlook", url, { headers: { authorization: `Bearer ${t}` } });
  for (const m of r.value ?? []) {
    const a = (m.from?.emailAddress?.address ?? "").toLowerCase();
    if (wanted.has(a)) out.add(a);
  }
  return out;
}
