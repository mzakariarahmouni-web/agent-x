import { getSetting } from "./db";
import type { Env } from "./env";
import { gmailReady, repliesFrom as gmailReplies, sendEmail as gmailSend } from "./gmail";
import { outlookReady, outlookRepliesFrom, outlookSend } from "./outlook";

/** Boîte d'envoi du recruteur : Gmail ou Outlook, au choix dans la page de configuration. */

export type MailProvider = "gmail" | "outlook";

/** Boîte choisie ; à défaut, la seule connectée (Gmail en priorité si les deux le sont). */
export async function activeMailbox(env: Env): Promise<MailProvider | null> {
  const chosen = (await getSetting(env, "mail_provider")) as MailProvider | null;
  const ready = { gmail: await gmailReady(env), outlook: await outlookReady(env) };
  if (chosen && ready[chosen]) return chosen;
  return ready.gmail ? "gmail" : ready.outlook ? "outlook" : null;
}

export async function mailReady(env: Env): Promise<boolean> {
  return (await activeMailbox(env)) !== null;
}

export async function sendMail(env: Env, fromName: string, to: string, subject: string, body: string): Promise<MailProvider> {
  const box = await activeMailbox(env);
  if (!box) throw new Error("Aucune boîte email connectée");
  if (box === "gmail") await gmailSend(env, fromName, to, subject, body);
  else await outlookSend(env, fromName, to, subject, body);
  return box;
}

export async function mailRepliesFrom(env: Env, emails: string[], sinceDays = 7): Promise<Set<string>> {
  const box = await activeMailbox(env);
  if (box === "gmail") return gmailReplies(env, emails, sinceDays);
  if (box === "outlook") return outlookRepliesFrom(env, emails, sinceDays);
  return new Set();
}
