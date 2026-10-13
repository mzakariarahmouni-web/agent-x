// Agent X — service worker : dialogue avec le Worker (file d'envoi, envois confirmés, réponses détectées).

// Réglages préremplis par la page de configuration (fichier config.js inclus dans le téléchargement).
try {
  importScripts("config.js");
} catch (_) {
  /* extension chargée sans config.js : réglages saisis dans la fenêtre de l'extension */
}
const DEFAULTS = self.AGENT_X_DEFAULTS || {};

const get = async (k) => {
  const v = await chrome.storage.local.get(k);
  for (const key of [].concat(k)) if (v[key] == null && DEFAULTS[key] != null) v[key] = DEFAULTS[key];
  return v;
};
const set = (o) => chrome.storage.local.set(o);

async function call(path, body) {
  const { url, token } = await get(["url", "token"]);
  if (!url || !token) throw new Error("Configurez l'adresse et le jeton dans l'extension.");
  const r = await fetch(url.replace(/\/+$/, "") + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-agent-x-token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({ ok: false, error: "réponse illisible" }));
  if (!d.ok) throw new Error(d.error || "erreur " + r.status);
  return d;
}

const canon = (u) => {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(u || "");
  return m ? "https://www.linkedin.com/in/" + decodeURIComponent(m[1]).toLowerCase() : u;
};

async function openItem(index) {
  const { queue = [] } = await get("queue");
  const item = queue[index];
  if (!item) {
    await set({ current: null });
    return { done: true };
  }
  await set({ current: index });
  const { tabId } = await get("tabId");
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab) await chrome.tabs.update(tab.id, { url: item.profile_url, active: true });
  else {
    tab = await chrome.tabs.create({ url: item.profile_url });
    await set({ tabId: tab.id });
  }
  return { done: false, item };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "load") {
        const d = await call("/api/linkedin/queue");
        await set({ queue: d.items, current: null });
        return reply({ ok: true, count: d.items.length });
      }
      if (msg.type === "start") return reply({ ok: true, ...(await openItem(0)) });
      if (msg.type === "current") {
        // Le script de page demande s'il y a un message prêt pour le profil affiché.
        const { queue = [], current } = await get(["queue", "current"]);
        const item = current != null ? queue[current] : null;
        return reply({ ok: true, item: item && canon(item.profile_url) === canon(msg.url) ? item : null, position: current, total: queue.length });
      }
      if (msg.type === "sent" || msg.type === "skip") {
        const { queue = [], current } = await get(["queue", "current"]);
        const item = queue[current];
        if (item && msg.type === "sent") await call("/api/linkedin/sent", { id: item.id });
        setTimeout(() => openItem((current ?? -1) + 1), msg.type === "sent" ? 2500 : 300);
        return reply({ ok: true });
      }
      if (msg.type === "reply") {
        const d = await call("/api/linkedin/reply", { profile_url: canon(msg.url) });
        return reply({ ok: true, matched: d.matched });
      }
      reply({ ok: false, error: "message inconnu" });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  })();
  return true;
});
