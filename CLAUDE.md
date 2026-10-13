# Agent X — notes pour les sessions de développement

- Langue : tout en français (messages, commentaires, interface). Le recruteur s'appelle Zacharie.
- Cible : recruteur indépendant (ESN en v2). Specs : fiche besoin, specs fonctionnelles F1–F7 et architecture dans le Projet claude.ai « Agent X ».
- Stack : Cloudflare Worker (TypeScript) + Workflows + D1 + KV + Workers AI ; bot Telegram ; Gmail API ; extension Chrome MV3.
- Règles métier à ne jamais casser :
  - aucun rejet définitif sans validation n°2 ; aucun envoi au client sans validation n°4 ;
  - l'extension ne clique jamais « Envoyer » sur LinkedIn ;
  - un CV n'invente aucune compétence : les mots-clés sans preuve vont dans « ecarts » ;
  - CV anonymisés (initiales, pas de coordonnées) ;
  - délai = 48 h ouvrées (jours fériés français calculés), envois seulement dans les créneaux.
- IA : toujours passer par `ai()` (worker/src/ai/router.ts), jamais appeler un fournisseur directement ; une sortie JSON a toujours un `validate`.
- Tests : `npm test` doit rester vert avant tout push (CI GitHub Actions).
- Isolation stricte avec les autres projets de Zacharie (dont la boutique « atelier-ecrin ») : ressources Cloudflare propres à agent-x, bot Telegram dédié ; ne jamais réutiliser ni toucher les ressources ou le bot d'un autre projet.
