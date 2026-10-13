import { getSetting } from "./db";
import type { Env } from "./env";
import { apiFetch } from "./outbound";

const API = "https://api.telegram.org";

/** Bouton : action (callback), lien, ou copie du texte en un toucher. */
export type Button = { text: string; data: string } | { text: string; url: string } | { text: string; copy: string };

function markup(rows: Button[][]): unknown {
  return {
    inline_keyboard: rows.map((r) =>
      r.map((b) => ("data" in b ? { text: b.text, callback_data: b.data.slice(0, 64) } : "url" in b ? { text: b.text, url: b.url } : { text: b.text, copy_text: { text: b.copy.slice(0, 256) } })),
    ),
  };
}

export async function tg(env: Env, token: string, method: string, body: unknown, form = false): Promise<unknown> {
  const res = await apiFetch(env, `${API}/bot${token}/${method}`, {
    method: "POST",
    headers: form ? undefined : { "content-type": "application/json" },
    body: form ? (body as FormData) : JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
  return data.result;
}

export interface Bot {
  token: string;
  chatId: string;
}

/** Bot et conversation du recruteur, ou null si la liaison n'est pas faite. */
export async function bot(env: Env): Promise<Bot | null> {
  const token = await getSetting(env, "telegram_bot_token");
  const chatId = await getSetting(env, "telegram_chat_id");
  return token && chatId ? { token, chatId } : null;
}

function split(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 3800) {
    const cut = rest.lastIndexOf("\n", 3800) > 1000 ? rest.lastIndexOf("\n", 3800) : 3800;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/** Envoie un message (découpé si long), boutons sous la dernière partie. Renvoie l'identifiant du dernier message. */
export async function send(env: Env, b: Bot, text: string, rows: Button[][] = []): Promise<number> {
  let id = 0;
  const parts = split(text);
  for (let i = 0; i < parts.length; i++) {
    const body: Record<string, unknown> = { chat_id: b.chatId, text: parts[i], link_preview_options: { is_disabled: true } };
    if (i === parts.length - 1 && rows.length) body.reply_markup = markup(rows);
    const r = (await tg(env, b.token, "sendMessage", body)) as { message_id?: number };
    id = r?.message_id ?? 0;
  }
  return id;
}

/** Notification au recruteur si le bot est relié ; silencieuse sinon (jamais bloquante). */
export async function notify(env: Env, text: string, rows: Button[][] = []): Promise<void> {
  const b = await bot(env);
  if (!b) return;
  try {
    await send(env, b, text, rows);
  } catch (e) {
    console.error("notification Telegram", (e as Error).message);
  }
}

export async function sendDocument(env: Env, b: Bot, bytes: Uint8Array, filename: string, mime: string, caption: string, rows: Button[][] = []): Promise<void> {
  const form = new FormData();
  form.set("chat_id", b.chatId);
  form.set("caption", caption.slice(0, 1024));
  if (rows.length) form.set("reply_markup", JSON.stringify(markup(rows)));
  form.set("document", new Blob([bytes], { type: mime }), filename);
  await tg(env, b.token, "sendDocument", form, true);
}

export async function editButtons(env: Env, b: Bot, messageId: number, text: string): Promise<void> {
  try {
    await tg(env, b.token, "editMessageText", { chat_id: b.chatId, message_id: messageId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } });
  } catch (e) {
    if (!/not modified|can't be edited|not found/i.test((e as Error).message)) throw e;
  }
}

export async function answerCallback(env: Env, token: string, callbackId: string, text: string): Promise<void> {
  await tg(env, token, "answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 190) }).catch(() => undefined);
}

/** Télécharge un fichier envoyé au bot (fiche PDF, capture). */
export async function downloadFile(env: Env, token: string, fileId: string): Promise<Uint8Array> {
  const f = (await tg(env, token, "getFile", { file_id: fileId })) as { file_path: string };
  const res = await apiFetch(env, `${API}/file/bot${token}/${f.file_path}`);
  if (!res.ok) throw new Error(`Téléchargement Telegram ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export const COMMANDS = [
  { command: "missions", description: "Missions en cours et leur avancement" },
  { command: "linkedin", description: "File des messages LinkedIn à envoyer" },
  { command: "etat", description: "État des IA, quotas et recherches du jour" },
  { command: "effacer", description: "Effacer un candidat (email ou URL de profil)" },
  { command: "aide", description: "Comment utiliser Agent X" },
];

export async function setupBot(env: Env, token: string, webhookUrl: string, secret: string): Promise<{ username: string }> {
  const me = (await tg(env, token, "getMe", {})) as { username: string };
  // Garde-fou : un bot déjà branché sur un autre projet (ex. la boutique) n'est jamais détourné.
  const info = (await tg(env, token, "getWebhookInfo", {})) as { url?: string };
  if (info?.url && info.url !== webhookUrl) {
    throw new Error(`Le bot @${me.username} est déjà utilisé par un autre projet (${new URL(info.url).host}). Créez un bot dédié à Agent X avec @BotFather (/newbot).`);
  }
  // Déjà branché ici : on ne refait pas l'appel (Telegram limite les appels répétés à setWebhook).
  if (info?.url !== webhookUrl) {
    await tg(env, token, "setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    await tg(env, token, "setMyCommands", { commands: COMMANDS });
  }
  return { username: me.username };
}
