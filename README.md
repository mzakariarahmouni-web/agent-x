# Agent X

Agent IA de sourcing et de recrutement de consultants pour recruteurs indépendants. Il reçoit une fiche de poste sur Telegram, source les profils (CV-thèque puis web public), contacte et relance aux bons créneaux, fait remplir un questionnaire de qualification, et livre une shortlist de 4 candidats avec des CV anonymisés, compatibles ATS, en 48 h ouvrées. Le recruteur n'intervient qu'à 4 validations, sur Telegram.

Tout tourne dans l'offre gratuite de Cloudflare, avec un combo d'IA gratuites (Gemini, Workers AI, Groq) qui bascule seul d'un fournisseur à l'autre.

## Ce que fait Agent X

| Étape | Ce que fait l'agent | Validation du recruteur |
| --- | --- | --- |
| F1 Fiche modèle | Transforme la fiche brute (texte, PDF ou capture) en fiche structurée : critères éliminatoires et pondérés, mots-clés, périmètre élargi, niveau exigeant, questionnaire | n°1 : fiche, questionnaire, nom d'expéditeur |
| F2 Évolutions | Applique une évolution du besoin, re-score le vivier, apprend les exigences récurrentes du client | — |
| F3 Sourcing | CV-thèque d'abord, puis profils publics (LinkedIn en recherche web, Malt, GitHub) ; scoring par la matrice | — |
| F4 Contact | Email automatique depuis Gmail ; LinkedIn pré-rempli par l'extension (un clic « Envoyer ») ; 3 relances aux créneaux ouvrés | — |
| F5 Qualification | Questionnaire court noté sur une grille commune ; rejet proposé, jamais automatique | n°2 : rejet définitif |
| F6 CV | Dossier de compétences anonymisé, .docx compatible ATS, adéquation au descriptif mesurée, aucune compétence inventée | n°3 et 4 : shortlist et envoi |
| F7 Suivi | Décision du client (placé, non retenu) en un clic | — |

## Installation (environ 20 minutes, une seule fois)

### 1. Déployer sur Cloudflare (gratuit)

1. Créez un compte gratuit sur [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers et Pages → Créer → Importer un dépôt** : connectez GitHub, choisissez `agent-x`, puis **Déployer**. La base de données et le stockage se créent seuls.
3. Dans le Worker `agent-x` → **Paramètres → Variables et secrets → Ajouter** : un secret nommé `ADMIN_TOKEN`, avec un mot de passe long que vous choisissez. Il protège la page de configuration et chiffre vos clés.

Chaque `git push` sur `main` redéploie ensuite automatiquement.

Variante : déploiement par GitHub Actions. Ajoutez les secrets `CLOUDFLARE_API_TOKEN` (modèle « Modifier les Workers ») et `CLOUDFLARE_ACCOUNT_ID` dans GitHub → Settings → Secrets and variables → Actions. Les tests tournent à chaque push ; le déploiement est ignoré tant que ces secrets sont absents.

### 2. Configurer (page web)

Ouvrez `https://agent-x.<votre-sous-domaine>.workers.dev/config`, entrez votre `ADMIN_TOKEN`, puis suivez les sections de la page :

| Clé | Gratuit ? | Où l'obtenir |
| --- | --- | --- |
| Gemini | Oui | [aistudio.google.com](https://aistudio.google.com/app/apikey) → Get API key |
| Groq (relais) | Oui | [console.groq.com/keys](https://console.groq.com/keys) |
| Tavily (recherche) | Oui, 1 000 recherches par mois | [app.tavily.com](https://app.tavily.com) |
| Brave, Exa (relais de recherche) | Crédit mensuel gratuit | [Brave](https://api-dashboard.search.brave.com), [Exa](https://dashboard.exa.ai/api-keys) |
| Bot Telegram | Oui | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Claude (option CV premium) | Non, environ 0,40 $ par mission | [platform.claude.com](https://platform.claude.com/settings/keys) |

Workers AI est déjà inclus dans votre compte Cloudflare : aucune clé à saisir.

### 3. Relier Telegram

Dans la page de configuration, section Telegram : **Relier mon Telegram**, puis ouvrez le lien affiché et touchez **Démarrer**. Le bot ne répond qu'à vous.

### 4. Connecter Gmail (emails automatiques)

1. [console.cloud.google.com](https://console.cloud.google.com) → nouveau projet « Agent X ».
2. **API et services → Bibliothèque** : activez **Gmail API**.
3. **Écran de consentement OAuth** : type « Externe », ajoutez votre adresse, puis **Publier l'application** (statut « En production »). Sans publication, Google coupe l'accès au bout de 7 jours. L'avertissement « application non vérifiée » est normal pour un usage personnel : « Paramètres avancés → Continuer ».
4. **Identifiants → Créer → ID client OAuth → Application Web**, avec l'URI de redirection affichée dans la page de configuration (`…/oauth/google/callback`).
5. Collez l'identifiant et le secret dans la page de configuration, puis **Connecter Gmail**.

Outlook : prévu en version 0.2.

### 5. Installer l'extension LinkedIn (Chrome)

1. Téléchargez le dossier `extension/` du dépôt.
2. `chrome://extensions` → **Mode développeur** → **Charger l'extension non empaquetée** → dossier `extension`.
3. Dans la page de configuration, section Extension : copiez l'adresse et le jeton dans les réglages de l'extension.

Chaque jour : icône Agent X → **Ouvrir la file du jour**. L'extension ouvre chaque profil et remplit le message ; vous relisez et cliquez sur **Envoyer**. Elle ne clique jamais à votre place : c'est ce qui protège votre compte LinkedIn.

## Utilisation au quotidien

1. Collez une fiche de poste dans Telegram (ou envoyez le PDF).
2. Validez la fiche modèle (n°1), ou touchez **Modifier** et écrivez la correction.
3. Laissez l'agent travailler. Commandes : `/missions` (avancement, évolution, clôture), `/linkedin` (file sur mobile), `/etat` (IA et quotas), `/effacer email-ou-url`.
4. Tranchez les rejets proposés (n°2) et validez la shortlist (n°3 et 4) : les CV arrivent en pièces jointes, prêts à transmettre.
5. Indiquez la décision du client : **Placé** ou **Non retenu**.

## Continuité de service

Chaque famille de tâches a un fournisseur principal et deux relais (voir `config/defaults.json`). L'agent bascule avant la limite des quotas (90 %), écarte 15 minutes un fournisseur qui enchaîne 3 erreurs, et, si tout est saturé, met l'étape en pause et la reprend seule, avec une alerte Telegram. Une mission ne s'arrête jamais en cours de route.

## RGPD

- Information du candidat et lien de désinscription dans chaque message.
- Désinscription ou `/effacer` : suppression complète (base, index, fichiers) et liste d'opposition hachée, pour ne jamais recontacter la personne.
- Purge automatique des candidats sans contact depuis 2 ans.
- Aucun rejet définitif sans validation humaine ; journal d'audit de chaque action.
- Clés API chiffrées en base (AES-GCM).
- Sourcing sur données publiques : décision du porteur de projet. Les conditions d'utilisation de LinkedIn interdisent le scraping automatisé ; l'agent passe par des moteurs de recherche et n'automatise jamais l'envoi de messages.

## Développement

```bash
npm install
npm test        # types + 35 tests (calendrier, matching, relais IA, .docx, parcours complet avec API simulées)
npx wrangler dev
```

| Dossier | Contenu |
| --- | --- |
| `worker/src/` | Worker Cloudflare : bot, Workflow de mission, IA, sourcing, contacts, questionnaire, CV, pages |
| `migrations/` | Schéma de la base, appliqué automatiquement au premier appel |
| `config/defaults.json` | Chaînes d'IA, quotas, créneaux, relances, matrice, durées RGPD |
| `extension/` | Extension Chrome LinkedIn |
| `scripts/` | Tests |

## Limites connues (v0.1)

- Outlook non pris en charge (Gmail uniquement).
- Recherche dans la CV-thèque en plein texte ; la recherche sémantique (Vectorize) viendra ensuite.
- L'extension dépend de la mise en page de LinkedIn, qui change souvent : en cas d'échec, elle bascule sur « Copier le message ».
- Sur un profil non connecté, LinkedIn n'autorise qu'une invitation avec une note courte : l'extension propose alors une version de 190 caractères.
- Pour un usage commercial en Europe, Google impose une clé Gemini payante, fournie par chaque client. Un système de tri de candidats relève aussi du « haut risque » de l'AI Act : conformité à compléter avant la commercialisation.
