import { deleteSetting, getSetting, journal, nowIso, parseJson, setSetting } from "./db";
import type { Env } from "./env";
import { readFiche } from "./fiche";
import { getMission, storeBriefFile } from "./mission";
import { eraseCandidate, findCandidate } from "./rgpd";
import { derivedSecret, newId, safeEqual } from "./security";
import { usageToday } from "./usage";
import { answerCallback, type Bot, type Button, downloadFile, send } from "./telegram";
import { answerValidation, applyRejection, getValidation } from "./validations";
import type { MissionEvent } from "./workflow";

/** Interface du recruteur : fiche brute, validations, évolutions, décisions client, effacement. */

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
}

interface TgUpdate {
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
}

const AWAIT_KEY = "telegram_awaiting";

interface Awaiting {
  kind: "v1" | "v3" | "evolution";
  missionId: string;
  validationId?: string;
}

export async function sendMissionEvent(env: Env, missionId: string, type: string, payload: MissionEvent): Promise<void> {
  const m = await env.DB.prepare("SELECT workflow_id FROM missions WHERE id = ?").bind(missionId).first<{ workflow_id: string | null }>();
  if (!m?.workflow_id) throw new Error("Workflow de la mission introuvable");
  const inst = await env.MISSION.get(m.workflow_id);
  await inst.sendEvent({ type, payload });
}

/** Une fiche brute devient une mission : enregistrement, puis lancement de son Workflow. */
export async function createMission(env: Env, raw: string, file?: { bytes: Uint8Array; mime: string }): Promise<string> {
  const id = newId("m_").slice(0, 14);
  await env.DB.prepare("INSERT INTO missions (id, title, raw_text, status) VALUES (?, ?, ?, 'analyse')").bind(id, raw.split("\n")[0].slice(0, 80) || "Nouvelle mission", raw).run();
  if (file) await storeBriefFile(env, id, file.bytes, file.mime);
  const inst = await env.MISSION.create({ id, params: { missionId: id } });
  await env.DB.prepare("UPDATE missions SET workflow_id = ? WHERE id = ?").bind(inst.id, id).run();
  await journal(env, "recruteur", "fiche_recue", { caracteres: raw.length, fichier: !!file }, { mission: id });
  return id;
}

const HELP = `🤖 Agent X — mode d'emploi
1. Colle ici une fiche de poste brute (texte), ou envoie-la en PDF ou en capture.
2. Je la transforme en fiche modèle et te demande de la valider (n°1).
3. Je source (CV-thèque puis web public), contacte et relance aux bons créneaux, et fais remplir le questionnaire.
4. Je te propose les rejets (n°2), puis la shortlist de 4 avec les CV anonymisés (n°3 et 4).
5. Tu m'indiques la décision du client : placé ou non retenu.

Commandes : /missions · /linkedin · /etat · /effacer email-ou-url`;

async function listMissions(env: Env, b: Bot): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.title, m.status, m.deadline_at,
       (SELECT COUNT(*) FROM applications a WHERE a.mission_id = m.id AND a.state IN ('a_contacter','contacte')) AS contact,
       (SELECT COUNT(*) FROM applications a WHERE a.mission_id = m.id AND a.state IN ('qualifie','cv_formate','presente')) AS qualif
     FROM missions m WHERE m.status NOT IN ('abandonnee','terminee') ORDER BY m.created_at DESC LIMIT 8`,
  ).all<{ id: string; title: string; status: string; deadline_at: string | null; contact: number; qualif: number }>();
  if (!results?.length) {
    await send(env, b, "Aucune mission en cours. Colle une fiche de poste pour en lancer une.");
    return;
  }
  for (const m of results) {
    const rows: Button[][] = m.status === "en_cours" ? [[{ text: "🔄 Faire évoluer", data: `ev:${m.id}` }, { text: "🏁 Clôturer", data: `cl:${m.id}` }]] : [[{ text: "🏁 Clôturer", data: `cl:${m.id}` }]];
    await send(
      env,
      b,
      `📁 ${m.title}\nStatut : ${m.status}${m.deadline_at ? ` · échéance ${new Date(m.deadline_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}\nEn contact : ${m.contact} · Qualifiés : ${m.qualif}`,
      rows,
    );
  }
}

async function listLinkedin(env: Env, b: Bot): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT q.id, q.profile_url, q.message, c.full_name FROM linkedin_queue q JOIN applications a ON a.id = q.application_id JOIN candidates c ON c.id = a.candidate_id
     WHERE q.status = 'a_envoyer' ORDER BY q.due_at LIMIT 5`,
  ).all<{ id: string; profile_url: string; message: string; full_name: string | null }>();
  if (!results?.length) {
    await send(env, b, "La file LinkedIn est vide.");
    return;
  }
  for (const r of results) {
    await send(env, b, `💼 ${r.full_name ?? "Profil"}\n\n${r.message}`, [
      [
        { text: "📋 Copier le message", copy: r.message },
        { text: "🔗 Ouvrir le profil", url: r.profile_url },
      ],
      [{ text: "✅ Envoyé", data: `ls:${r.id}` }],
    ]);
  }
}

async function status(env: Env, b: Bot): Promise<void> {
  const rows = await usageToday(env);
  const lines = rows.length
    ? rows.map((r) => `${r.open_until && Date.parse(r.open_until) > Date.now() ? "⏸" : "✅"} ${r.provider} : ${r.requests} appel(s)${r.errors ? ` · ${r.errors} erreur(s)` : ""}${r.last_error && r.errors ? `\n   ${r.last_error.slice(0, 90)}` : ""}`)
    : ["Aucun appel aujourd'hui."];
  await send(env, b, `📊 Fournisseurs du jour (UTC)\n${lines.join("\n")}`);
}

async function handleText(env: Env, b: Bot, msg: TgMessage, ctx: ExecutionContext): Promise<void> {
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (/^\/(start|aide|help)\b/.test(text)) return void (await send(env, b, HELP));
  if (/^\/missions\b/.test(text)) return listMissions(env, b);
  if (/^\/linkedin\b/.test(text)) return listLinkedin(env, b);
  if (/^\/etat\b/.test(text)) return status(env, b);
  const erase = /^\/effacer\s+(\S+)/.exec(text);
  if (erase) {
    const id = await findCandidate(env, erase[1]);
    if (!id) return void (await send(env, b, "Aucun candidat trouvé pour cet email ou cette URL."));
    await eraseCandidate(env, id, "demande transmise au recruteur");
    return void (await send(env, b, "🗑 Candidat effacé (base, index, fichiers) et ajouté à la liste d'opposition."));
  }
  if (/^\//.test(text)) return void (await send(env, b, "Commande inconnue. /aide pour la liste."));

  // Réponse attendue (modification d'une validation, évolution de mission).
  const awaiting = parseJson<Awaiting | null>(await getSetting(env, AWAIT_KEY), null);
  if (awaiting && text) {
    await deleteSetting(env, AWAIT_KEY);
    if (awaiting.kind === "evolution") {
      await sendMissionEvent(env, awaiting.missionId, "point", { kind: "evolution", text });
      return void (await send(env, b, "🔄 Évolution reçue : je mets à jour la fiche et je re-score le vivier."));
    }
    if (awaiting.validationId) await answerValidation(env, awaiting.validationId, "modifiee", text);
    await sendMissionEvent(env, awaiting.missionId, awaiting.kind, { action: "mod", text });
    return void (await send(env, b, "✏️ Modification reçue, je m'en occupe."));
  }

  // Fichier joint (PDF ou image) : nouvelle mission.
  const doc = msg.document;
  const photo = msg.photo?.at(-1);
  if (doc || photo) {
    const mime = doc?.mime_type ?? "image/jpeg";
    if (!/pdf|image\//.test(mime)) return void (await send(env, b, "Envoie la fiche en texte, en PDF ou en image."));
    if ((doc?.file_size ?? photo?.file_size ?? 0) > 8_000_000) return void (await send(env, b, "Fichier trop lourd (8 Mo maximum)."));
    const bytes = await downloadFile(env, b.token, (doc ?? photo)!.file_id);
    const id = await createMission(env, text || doc?.file_name || "Fiche jointe", { bytes, mime });
    return void (await send(env, b, `📥 Fiche reçue (${doc?.file_name ?? "image"}). Analyse en cours… (mission ${id})`));
  }

  if (text.length >= 120) {
    const id = await createMission(env, text);
    return void (await send(env, b, `📥 Fiche reçue. Analyse en cours… (mission ${id})`));
  }
  await send(env, b, "Pour lancer une mission, colle la fiche de poste complète (ou envoie-la en PDF). /aide pour le mode d'emploi.");
  void ctx;
}

async function handleCallback(env: Env, b: Bot, cb: NonNullable<TgUpdate["callback_query"]>): Promise<void> {
  const data = cb.data ?? "";
  const [kind, id, action] = data.split(":");
  const reply = (t: string) => answerCallback(env, b.token, cb.id, t);

  if (kind === "v") {
    const v = await getValidation(env, id);
    if (!v || v.status !== "en_attente") return reply("Déjà traité.");
    if (v.kind === "rejet") {
      const msg = await applyRejection(env, v, action === "ok");
      await reply("C'est noté.");
      return void (await send(env, b, msg));
    }
    const type = v.kind === "fiche" ? "v1" : "v3";
    if (action === "mod") {
      await setSetting(env, AWAIT_KEY, JSON.stringify({ kind: type, missionId: v.mission_id ?? "", validationId: v.id } satisfies Awaiting));
      await reply("Écris ta modification.");
      return void (await send(env, b, type === "v1" ? "✏️ Écris la modification (une ou plusieurs lignes) :" : "✏️ Quels numéros retirer ? (ex. « retire 2 »)"));
    }
    await answerValidation(env, v.id, action === "ok" ? "validee" : "refusee");
    await sendMissionEvent(env, v.mission_id!, type, { action: action === "ok" ? "ok" : "no" });
    await reply(action === "ok" ? "Validé ✅" : "C'est noté.");
    if (action === "ok") await send(env, b, type === "v1" ? "🚀 Mission lancée : sourcing en cours." : "📤 Shortlist validée : les CV sont prêts à transmettre au client.");
    return;
  }
  if (kind === "ev") {
    await setSetting(env, AWAIT_KEY, JSON.stringify({ kind: "evolution", missionId: id } satisfies Awaiting));
    await reply("Écris l'évolution.");
    return void (await send(env, b, "🔄 Qu'est-ce qui change ? (ex. « le client veut maintenant 8 ans d'expérience et l'anglais courant »)"));
  }
  if (kind === "cl") {
    await env.DB.prepare("UPDATE missions SET status = 'terminee', updated_at = datetime('now') WHERE id = ?").bind(id).run();
    await env.DB.prepare("UPDATE applications SET next_action_at = NULL WHERE mission_id = ? AND state IN ('a_contacter','contacte')").bind(id).run();
    const m = await getMission(env, id);
    await journal(env, "recruteur", "mission_cloturee", null, { mission: id });
    await reply("Mission clôturée.");
    return void (await send(env, b, `🏁 ${m.title} clôturée. Les candidats restent dans la CV-thèque.`));
  }
  if (kind === "dc") {
    const placed = action === "place";
    await env.DB.prepare("UPDATE applications SET client_decision = ?, state = ?, updated_at = datetime('now') WHERE id = ?").bind(placed ? "place" : "non_retenu", placed ? "place" : "non_retenu", id).run();
    await journal(env, "recruteur", "decision_client", { candidature: id, decision: placed ? "placé" : "non retenu" });
    return reply(placed ? "Bravo, placement enregistré 🏆" : "Décision enregistrée.");
  }
  if (kind === "ls") {
    const q = await env.DB.prepare("UPDATE linkedin_queue SET status = 'envoye', sent_at = ? WHERE id = ? AND status = 'a_envoyer' RETURNING application_id").bind(nowIso(), id).first<{ application_id: string }>();
    return reply(q ? "Envoi noté." : "Déjà noté.");
  }
  if (kind === "li") {
    await reply("File LinkedIn");
    return listLinkedin(env, b);
  }
  if (kind === "call") {
    const r = await env.DB.prepare("SELECT a.synthesis, a.mission_id, c.full_name, c.email FROM applications a JOIN candidates c ON c.id = a.candidate_id WHERE a.id = ?")
      .bind(id)
      .first<{ synthesis: string | null; mission_id: string; full_name: string | null; email: string | null }>();
    if (!r) return reply("Introuvable.");
    const syn = parseJson<{ doutes?: string[]; points_forts?: string[] }>(r.synthesis, {});
    const f = readFiche((await getMission(env, r.mission_id)).fiche);
    await reply("Fiche d'appel");
    return void (await send(
      env,
      b,
      `📞 Appel de qualification · ${r.full_name ?? "?"}${r.email ? ` (${r.email})` : ""}\nMission : ${f.intitule}\n\nÀ creuser :\n${(syn.doutes ?? []).map((d) => `• ${d}`).join("\n") || "• Posture client, communication"}\n\nPoints forts à confirmer :\n${(syn.points_forts ?? []).map((d) => `• ${d}`).join("\n") || "—"}\n\nÀ la fin : TJM confirmé, date de démarrage, accord de présentation.`,
    ));
  }
  await reply("Action inconnue.");
}

/** Webhook Telegram : seul le recruteur relié est écouté ; la liaison se fait par /start <code>. */
export async function handleTelegram(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  if (!env.ADMIN_TOKEN) return new Response("ADMIN_TOKEN manquant", { status: 503 });
  const secret = await derivedSecret(env.ADMIN_TOKEN, "telegram");
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return new Response("interdit", { status: 403 });
  const token = await getSetting(env, "telegram_bot_token");
  if (!token) return new Response("ok");
  const update = (await req.json()) as TgUpdate;
  const msg = update.message ?? update.callback_query?.message;
  if (!msg) return new Response("ok");
  const chatId = String(msg.chat.id);
  const linked = await getSetting(env, "telegram_chat_id");

  // Liaison : /start <code> avec le code affiché dans la page de configuration.
  const start = /^\/start\s+(\S+)/.exec(update.message?.text ?? "");
  if (start) {
    const code = (await derivedSecret(env.ADMIN_TOKEN, "telegram-link")).slice(0, 16);
    if (safeEqual(start[1], code)) {
      await setSetting(env, "telegram_chat_id", chatId);
      await send(env, { token, chatId }, `✅ Agent X est relié à cette conversation.\n\n${HELP}`);
      return new Response("ok");
    }
  }
  if (!linked || linked !== chatId) {
    if (update.message) await send(env, { token, chatId }, "Ce bot est privé. Reliez-le depuis la page de configuration d'Agent X.").catch(() => undefined);
    return new Response("ok");
  }
  const b: Bot = { token, chatId };
  try {
    if (update.callback_query) await handleCallback(env, b, update.callback_query);
    else if (update.message) await handleText(env, b, update.message, ctx);
  } catch (e) {
    console.error("Telegram", e);
    await send(env, b, `⚠️ Erreur : ${(e as Error).message.slice(0, 300)}`).catch(() => undefined);
  }
  return new Response("ok");
}

