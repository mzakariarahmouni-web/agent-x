// Agent X — script de page LinkedIn.
// Sur un profil de la file : ouvre la messagerie et pré-remplit le message. Le recruteur clique « Envoyer » (jamais l'extension).
// Dans la messagerie : signale à Agent X quand un candidat suivi a répondu.

(() => {
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false })));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  async function waitFor(fn, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  function panel(html) {
    let p = document.getElementById("agentx-panel");
    if (!p) {
      p = document.createElement("div");
      p.id = "agentx-panel";
      p.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;background:#fff;color:#1b2130;border:1px solid #d6dbe4;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);padding:14px;font:14px/1.45 system-ui,sans-serif";
      document.body.appendChild(p);
    }
    p.innerHTML = html;
    return p;
  }

  const btn = (id, label, primary) =>
    `<button id="${id}" style="margin:8px 6px 0 0;padding:8px 12px;border-radius:8px;border:${primary ? "0" : "1px solid #d6dbe4"};background:${primary ? "#2f5bd3" : "#fff"};color:${primary ? "#fff" : "#2f5bd3"};font-weight:600;cursor:pointer">${label}</button>`;

  /** Insère le texte comme une saisie (LinkedIn écoute les événements d'entrée). */
  function typeInto(el, text) {
    el.focus();
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
  }

  function messageButton() {
    const main = $("main") || document;
    return [...main.querySelectorAll("button, a")].find((b) => /^(message|envoyer un message)$/i.test((b.innerText || b.getAttribute("aria-label") || "").trim()));
  }

  async function onProfile() {
    const r = await send({ type: "current", url: location.href });
    if (!r.ok || !r.item) return;
    const item = r.item;
    const short = item.message.split(/\n\n(?:Questionnaire|Pour me répondre)/)[0].slice(0, 190);
    panel(
      `<b>Agent X</b> · ${r.position + 1}/${r.total}<br><span style="color:#5f6878">${item.title || ""}</span>
       <div style="margin-top:8px;white-space:pre-wrap;max-height:160px;overflow:auto;border:1px solid #eef0f4;border-radius:8px;padding:8px">${item.message.replace(/</g, "&lt;")}</div>
       ${btn("ax-fill", "Remplir le message", true)}${btn("ax-copy", "Copier (note d'invitation)")}${btn("ax-skip", "Passer")}
       <div id="ax-info" style="margin-top:6px;color:#5f6878;font-size:12px">Vous cliquez ensuite sur « Envoyer ».</div>`,
    );
    document.getElementById("ax-skip").onclick = () => send({ type: "skip" });
    document.getElementById("ax-copy").onclick = async () => {
      await navigator.clipboard.writeText(short);
      document.getElementById("ax-info").textContent = "Note courte copiée (190 caractères) : « Se connecter » → « Ajouter une note » → coller → Envoyer, puis touchez « Envoyé ».";
      document.getElementById("ax-skip").textContent = "Envoyé";
      document.getElementById("ax-skip").onclick = () => send({ type: "sent" });
    };
    document.getElementById("ax-fill").onclick = async () => {
      const mb = messageButton();
      if (!mb) {
        document.getElementById("ax-info").textContent = "Pas de bouton « Message » (profil non connecté) : utilisez « Copier » pour une invitation avec note.";
        return;
      }
      mb.click();
      const box = await waitFor(() => $(".msg-form__contenteditable[contenteditable='true']") || $("div[role='textbox'][contenteditable='true']"));
      if (!box) {
        document.getElementById("ax-info").textContent = "Fenêtre de message introuvable : copiez le message et collez-le.";
        await navigator.clipboard.writeText(item.message);
        return;
      }
      typeInto(box, item.message);
      document.getElementById("ax-info").textContent = "Message rempli. Relisez puis cliquez sur « Envoyer » dans LinkedIn.";
      const form = box.closest("form") || document;
      const watch = (e) => {
        const t = e.target.closest && e.target.closest("button");
        if (t && (/send|envoyer/i.test(t.className + " " + (t.innerText || "") + " " + (t.getAttribute("aria-label") || "")))) {
          document.removeEventListener("click", watch, true);
          document.getElementById("ax-info").textContent = "Envoyé ✓ · profil suivant…";
          send({ type: "sent" });
        }
      };
      document.addEventListener("click", watch, true);
      form.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) watch({ target: $(".msg-form__send-button") || form });
      });
    };
  }

  const reported = new Set();
  async function onMessaging() {
    // Fil ouvert : si le dernier message vient de l'interlocuteur, on le signale (une fois).
    const header = $(".msg-thread__link-to-profile, a.msg-thread__link-to-profile, .msg-entity-lockup a[href*='/in/']");
    const href = header && header.href;
    if (!href || reported.has(href)) return;
    const events = document.querySelectorAll(".msg-s-message-list__event");
    const last = events[events.length - 1];
    if (!last) return;
    // LinkedIn marque les messages reçus avec la classe « --other ».
    if (!last.querySelector(".msg-s-event-listitem--other")) return;
    reported.add(href);
    await send({ type: "reply", url: href });
  }

  let lastUrl = "";
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById("agentx-panel")?.remove();
      if (/linkedin\.com\/in\//.test(location.href)) setTimeout(onProfile, 1500);
    }
    if (/linkedin\.com\/messaging\//.test(location.href)) onMessaging();
  }, 1500);
})();
