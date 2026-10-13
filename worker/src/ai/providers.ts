import type { Env } from "../env";
import { fetchJson, HttpError } from "../outbound";

/** Un appel à un modèle : instructions système + demande, réponse texte. */
export interface ChatRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Demande une réponse JSON quand le fournisseur sait la garantir. */
  json?: boolean;
  /** Pièce jointe (PDF ou image) : seuls Gemini et Claude savent la lire. */
  file?: ChatFile;
}

export interface ChatFile {
  mime: string;
  base64: string;
}

/** Fournisseurs capables de lire un PDF ou une image. */
export function supportsFiles(provider: ProviderName): boolean {
  return provider === "gemini" || provider === "claude";
}

export interface ChatResult {
  text: string;
  /** Unités consommées (jetons de sortie), pour le suivi. */
  units: number;
}

export type ProviderName = "gemini" | "groq" | "workersai" | "claude";

export interface ProviderKeys {
  gemini_api_key?: string;
  groq_api_key?: string;
  anthropic_api_key?: string;
}

export function providerAvailable(env: Env, keys: ProviderKeys, provider: ProviderName): boolean {
  switch (provider) {
    case "gemini":
      return !!keys.gemini_api_key;
    case "groq":
      return !!keys.groq_api_key;
    case "claude":
      return !!keys.anthropic_api_key;
    case "workersai":
      return !!env.AI;
  }
}

/**
 * Les modèles récents « réfléchissent » avant de répondre et ces jetons comptent dans la limite de sortie :
 * une limite trop basse donne une réponse vide. On garde donc une marge minimale et un niveau de réflexion bas.
 */
export const MIN_OUTPUT_TOKENS = 2048;
const outTokens = (req: ChatRequest) => Math.max(req.maxTokens ?? 4096, MIN_OUTPUT_TOKENS);

async function gemini(env: Env, key: string, model: string, req: ChatRequest, timeoutMs: number, thinking = true): Promise<ChatResult> {
  type R = { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: { candidatesTokenCount?: number } };
  let data: R;
  try {
    data = await fetchJson<R>(
    env,
    "gemini",
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [...(req.file ? [{ inlineData: { mimeType: req.file.mime, data: req.file.base64 } }] : []), { text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.3,
          maxOutputTokens: outTokens(req),
          ...(thinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
          ...(req.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
    timeoutMs,
  );
  } catch (e) {
    // Modèle sans réglage de réflexion : on réessaie sans ce paramètre.
    if (thinking && e instanceof HttpError && e.status === 400 && /thinking/i.test(e.message)) return gemini(env, key, model, req, timeoutMs, false);
    throw e;
  }
  const text = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new HttpError(502, "gemini", `réponse vide (${data.candidates?.[0]?.finishReason ?? "?"})`);
  return { text, units: data.usageMetadata?.candidatesTokenCount ?? 0 };
}

async function groq(env: Env, key: string, model: string, req: ChatRequest, timeoutMs: number, jsonMode = true): Promise<ChatResult> {
  type R = { choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number } };
  let data: R;
  try {
    data = await fetchJson<R>(
    env,
    "groq",
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: req.temperature ?? 0.3,
        max_tokens: outTokens(req),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}),
        ...(req.json && jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    },
    timeoutMs,
  );
  } catch (e) {
    // Mode JSON strict refusé par Groq : on réessaie en texte libre, le JSON est extrait ensuite.
    if (jsonMode && req.json && e instanceof HttpError && e.status === 400 && /json/i.test(e.message)) return groq(env, key, model, req, timeoutMs, false);
    throw e;
  }
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new HttpError(502, "groq", "réponse vide");
  return { text, units: data.usage?.completion_tokens ?? 0 };
}

async function claude(env: Env, key: string, model: string, req: ChatRequest, timeoutMs: number): Promise<ChatResult> {
  type R = { content?: { type: string; text?: string }[]; usage?: { output_tokens?: number } };
  const data = await fetchJson<R>(
    env,
    "claude",
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: outTokens(req),
        temperature: req.temperature ?? 0.3,
        system: req.system,
        messages: [
          {
            role: "user",
            content: req.file
              ? [
                  req.file.mime === "application/pdf"
                    ? { type: "document", source: { type: "base64", media_type: req.file.mime, data: req.file.base64 } }
                    : { type: "image", source: { type: "base64", media_type: req.file.mime, data: req.file.base64 } },
                  { type: "text", text: req.prompt },
                ]
              : req.prompt,
          },
        ],
      }),
    },
    timeoutMs,
  );
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text) throw new HttpError(502, "claude", "réponse vide");
  return { text, units: data.usage?.output_tokens ?? 0 };
}

async function workersai(env: Env, model: string, req: ChatRequest): Promise<ChatResult> {
  if (!env.AI) throw new HttpError(503, "workersai", "liaison AI absente");
  let out: unknown;
  try {
    out = await (env.AI as unknown as { run: (m: string, i: unknown) => Promise<unknown> }).run(model, {
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      max_tokens: outTokens(req),
      temperature: req.temperature ?? 0.3,
      // Nemotron : réflexion courte et réponse jamais vide.
      ...(/nemotron/.test(model) ? { chat_template_kwargs: { enable_thinking: true, low_effort: true, force_nonempty_content: true } } : {}),
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // 3036/3040 : quota ou capacité ; 5035 : modèle réservé à l'offre payante.
    const status = /3036|3040|capacity|limit|quota/i.test(msg) ? 429 : /5035|paid/i.test(msg) ? 403 : 502;
    throw new HttpError(status, "workersai", msg);
  }
  const o = out as { response?: unknown; choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number } };
  const text =
    typeof o.response === "string" ? o.response : o.response && typeof o.response === "object" ? JSON.stringify(o.response) : o.choices?.[0]?.message?.content ?? "";
  if (!text) throw new HttpError(502, "workersai", "réponse vide");
  return { text, units: o.usage?.completion_tokens ?? 0 };
}

export async function callProvider(env: Env, keys: ProviderKeys, provider: ProviderName, model: string, req: ChatRequest, timeoutMs: number): Promise<ChatResult> {
  switch (provider) {
    case "gemini":
      return gemini(env, keys.gemini_api_key!, model, req, timeoutMs);
    case "groq":
      return groq(env, keys.groq_api_key!, model, req, timeoutMs);
    case "claude":
      return claude(env, keys.anthropic_api_key!, model, req, timeoutMs);
    case "workersai":
      return workersai(env, model, req);
  }
}
