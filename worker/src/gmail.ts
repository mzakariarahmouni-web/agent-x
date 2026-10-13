import { getSetting, secrets, setSetting } from "./db";
import type { Env } from "./env";
import { fetchJson } from "./outbound";
import { toBase64Url } from "./security";

/**
 * Email depuis la boîte Gmail du recruteur (API Gmail, autorisation OAuth une seule fois).
 * Envoi un par un ; lecture des réponses des candidats contactés.
 */

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const k = await secrets(env);
  const r = await fetchJson<{ refresh_token?: string; access_token: string }>(env, "google", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: k.google_client_id ?? "", client_secret: k.google_client_secret ?? "", redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  if (!r.refresh_token) throw new Error("Google n'a pas renvoyé de jeton durable : retirez l'accès d'Agent X dans votre compte Google puis recommencez.");
  await setSetting(env, "google_refresh_token", r.refresh_token, true);
  const me = await fetchJson<{ emailAddress: string }>(env, "gmail", "https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${r.access_token}` } });
  await setSetting(env, "gmail_address", me.emailAddress);
  return me.emailAddress;
}

async function accessToken(env: Env): Promise<string | null> {
  const k = await secrets(env);
  if (!k.google_refresh_token || !k.google_client_id || !k.google_client_secret) return null;
  const r = await fetchJson<{ access_token: string }>(env, "google", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: k.google_refresh_token, client_id: k.google_client_id, client_secret: k.google_client_secret, grant_type: "refresh_token" }),
  });
  return r.access_token;
}

export async function gmailReady(env: Env): Promise<boolean> {
  return !!(await getSetting(env, "gmail_address")) && !!(await secrets(env)).google_refresh_token;
}

/** Encodage d'un en-tête non ASCII (RFC 2047). */
function mimeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${toBase64Url(new TextEncoder().encode(s)).replace(/-/g, "+").replace(/_/g, "/")}?=`;
}

export function buildRawEmail(from: { name: string; email: string }, to: string, subject: string, body: string): string {
  const lines = [
    `From: ${mimeHeader(from.name)} <${from.email}>`,
    `To: ${to}`,
    `Subject: ${mimeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];
  return toBase64Url(new TextEncoder().encode(lines.join("\r\n")));
}

export async function sendEmail(env: Env, fromName: string, to: string, subject: string, body: string): Promise<string> {
  const token = await accessToken(env);
  const address = await getSetting(env, "gmail_address");
  if (!token || !address) throw new Error("Gmail non connecté");
  const r = await fetchJson<{ id: string }>(env, "gmail", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: buildRawEmail({ name: fromName, email: address }, to, subject, body) }),
  });
  return r.id;
}

/** Adresses (parmi `emails`) qui ont écrit au recruteur depuis `sinceDays` jours. */
export async function repliesFrom(env: Env, emails: string[], sinceDays = 7): Promise<Set<string>> {
  const out = new Set<string>();
  if (!emails.length) return out;
  const token = await accessToken(env);
  if (!token) return out;
  for (let i = 0; i < emails.length; i += 20) {
    const chunk = emails.slice(i, i + 20);
    const q = `in:inbox newer_than:${sinceDays}d {${chunk.map((e) => `from:${e}`).join(" ")}}`;
    const list = await fetchJson<{ messages?: { id: string }[] }>(env, "gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(q)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    for (const m of list.messages ?? []) {
      const msg = await fetchJson<{ payload?: { headers?: { name: string; value: string }[] } }>(
        env,
        "gmail",
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const from = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
      const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
      if (chunk.some((e) => e.toLowerCase() === addr)) out.add(addr);
    }
  }
  return out;
}
