import { journal, parseJson } from "./db";
import type { Env } from "./env";
import { newId } from "./security";
import { bot, type Button, send } from "./telegram";

/** Les 4 validations Telegram : 1 fiche, 2 rejet définitif, 3+4 shortlist et envoi au client. */

export type ValidationKind = "fiche" | "rejet" | "shortlist";

export interface Validation {
  id: string;
  mission_id: string | null;
  application_id: string | null;
  kind: ValidationKind;
  payload: string;
  status: string;
}

export async function createValidation(env: Env, kind: ValidationKind, missionId: string | null, applicationId: string | null, payload: unknown = {}): Promise<string> {
  const id = newId("v_").slice(0, 18);
  await env.DB.prepare("INSERT INTO validations (id, mission_id, application_id, kind, payload) VALUES (?, ?, ?, ?, ?)")
    .bind(id, missionId, applicationId, kind, JSON.stringify(payload))
    .run();
  return id;
}

export async function getValidation(env: Env, id: string): Promise<Validation | null> {
  return env.DB.prepare("SELECT id, mission_id, application_id, kind, payload, status FROM validations WHERE id = ?").bind(id).first<Validation>();
}

export async function answerValidation(env: Env, id: string, status: "validee" | "modifiee" | "refusee", answer?: string): Promise<void> {
  await env.DB.prepare("UPDATE validations SET status = ?, answer = ?, answered_at = datetime('now') WHERE id = ?").bind(status, answer ?? null, id).run();
  const v = await getValidation(env, id);
  await journal(env, "recruteur", `validation_${v?.kind ?? "?"}`, { statut: status, reponse: answer }, { mission: v?.mission_id ?? undefined });
}

export function validationButtons(id: string, labels: { ok: string; mod?: string; no?: string }): Button[][] {
  const row: Button[] = [{ text: labels.ok, data: `v:${id}:ok` }];
  if (labels.mod) row.push({ text: labels.mod, data: `v:${id}:mod` });
  const rows: Button[][] = [row];
  if (labels.no) rows.push([{ text: labels.no, data: `v:${id}:no` }]);
  return rows;
}

/** Validation n°2 : l'agent propose un rejet ; sans réponse, le candidat reste « en attente », jamais rejeté. */
export async function proposeRejection(env: Env, missionId: string, applicationId: string, who: string, reasons: string[]): Promise<void> {
  const id = await createValidation(env, "rejet", missionId, applicationId, { reasons });
  await env.DB.prepare("UPDATE applications SET state = 'en_attente', updated_at = datetime('now') WHERE id = ?").bind(applicationId).run();
  const b = await bot(env);
  if (!b) return;
  await send(env, b, `⚖️ Validation n°2 · rejet proposé\n${who}\nMotifs : ${reasons.join(" ; ")}\n\nSans réponse, le candidat reste en attente (jamais rejeté automatiquement).`, [
    [
      { text: "✅ Rejeter", data: `v:${id}:ok` },
      { text: "↩️ Garder", data: `v:${id}:no` },
    ],
  ]);
}

/** Applique une réponse à une validation n°2 (pas de Workflow : décision immédiate). */
export async function applyRejection(env: Env, v: Validation, accept: boolean): Promise<string> {
  if (!v.application_id) return "Candidature introuvable.";
  await answerValidation(env, v.id, accept ? "validee" : "refusee");
  await env.DB.prepare("UPDATE applications SET state = ?, updated_at = datetime('now') WHERE id = ?").bind(accept ? "rejete" : "qualifie", v.application_id).run();
  const reasons = parseJson<{ reasons?: string[] }>(v.payload, {}).reasons ?? [];
  return accept ? `Rejet confirmé (${reasons[0] ?? "motif enregistré"}). Le candidat reste dans la CV-thèque.` : "Candidat gardé : il repasse en « qualifié ».";
}
