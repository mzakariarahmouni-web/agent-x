const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sha256Hex(data: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparaison en temps constant. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Secret dérivé de ADMIN_TOKEN pour un usage donné (webhook Telegram, liens, extension). */
export async function derivedSecret(adminToken: string, purpose: string): Promise<string> {
  return toBase64Url(await hmac(adminToken, `agent-x:${purpose}`)).slice(0, 40);
}

/** Identifiant aléatoire court, lisible dans une URL. */
export function newId(prefix = ""): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return prefix + toBase64Url(b);
}

async function aesKey(adminToken: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`agent-x:secrets:${adminToken}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Chiffre une clé API avant de la ranger en base (AES-GCM, clé dérivée de ADMIN_TOKEN). */
export async function encryptSecret(adminToken: string, plain: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(adminToken), enc.encode(plain)));
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function decryptSecret(adminToken: string, sealed: string): Promise<string> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("secret illisible");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await aesKey(adminToken), fromBase64(ct));
  return dec.decode(pt);
}
