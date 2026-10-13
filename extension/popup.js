const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: "pas de réponse" })));

const DEFAULTS = window.AGENT_X_DEFAULTS || {};
chrome.storage.local.get(["url", "token"]).then(({ url, token }) => {
  url = url || DEFAULTS.url;
  token = token || DEFAULTS.token;
  $("#url").value = url || "";
  $("#token").value = token || "";
  if (!url || !token) $("#cfg").open = true;
});

$("#save").onclick = async () => {
  const url = $("#url").value.trim().replace(/\/+$/, "");
  const token = $("#token").value.trim();
  if (url && !/\.workers\.dev$/.test(new URL(url).host)) {
    const granted = await chrome.permissions.request({ origins: [new URL(url).origin + "/*"] });
    if (!granted) return ($("#out").textContent = "Autorisation refusée pour cette adresse.");
  }
  await chrome.storage.local.set({ url, token });
  $("#out").textContent = "Réglages enregistrés.";
};

$("#load").onclick = async () => {
  $("#out").textContent = "Chargement…";
  const r = await send({ type: "load" });
  if (!r.ok) return ($("#out").textContent = r.error);
  if (!r.count) return ($("#out").textContent = "Aucun message en attente. 👍");
  $("#out").textContent = `${r.count} message(s) à envoyer. Ouverture du premier profil…`;
  await send({ type: "start" });
  window.close();
};
