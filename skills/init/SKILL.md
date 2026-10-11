---
name: init
description: Préparer un projet pour l'orchestration par agents — examiner la stack et rédiger le profil `.claude/orchestration/profile.json` (installation d'un worktree, vérifications, serveurs, motifs, ressources partagées) et `rules.md` (règles et pièges du projet), vérifier le `.gitignore`. À utiliser quand l'utilisateur demande d'initialiser l'orchestration dans un projet, ou quand le skill `orchestration` ne trouve pas de profil.
---

# Profil d'orchestration d'un projet

Le profil dit aux agents et aux scripts comment travailler dans ce projet. Il
est versionné avec le projet, dans `.claude/orchestration/`.

## 1. Examiner le projet

Lire les manifestes présents (`package.json`, `pyproject.toml`, `Cargo.toml`,
`go.mod`, `pom.xml`, `Makefile`, `docker-compose.yml`…), la configuration du
lint et des tests, le `CLAUDE.md` du projet, les skills et agents de
`.claude/`, et un `README`. En tirer :

- ce qu'un worktree neuf doit lancer pour être utilisable (installation des
  dépendances, génération de code) ;
- les vérifications d'une branche : typage, tests, lint, build ; et celles qui
  ne valent que si certains dossiers changent ;
- les serveurs qu'un agent peut démarrer (serveur de développement, serveur
  d'aperçu) ;
- les ressources qu'une seule tâche à la fois peut toucher (schéma de base,
  base locale, fichier de configuration partagé) ;
- les règles et pièges propres au projet.

## 2. Rédiger `profile.json`

```json
{
  "setup": ["npm ci"],
  "checks": [
    { "name": "typecheck", "run": "npm run typecheck" },
    { "name": "tests", "run": "npm test" },
    { "name": "build", "run": "npm run build", "paths": ["src/", "app/"] }
  ],
  "servers": ["/next/"],
  "diffPatterns": [{ "pattern": "console\\.log\\(", "why": "trace de débogage oubliée" }],
  "shared": ["schéma de la base (numéro de migration réservé dans CLAUDE.local.md)"]
}
```

- `setup` : commandes lancées dans l'ordre par le `meeseeks` dans un
  worktree neuf.
- `checks` : lancées par `agent-check` dans le worktree de l'agent, et par
  l'agent avant son rapport. `paths` (facultatif) : préfixes de chemin ; la
  vérification ne tourne que si le diff touche l'un d'eux.
- `servers` : sous-chaînes de ligne de commande d'un serveur (séparateurs `/`
  ou `\` indifférents) ; le hook `SubagentStop` arrête les processus d'un
  agent terminé qui en contiennent une. Rester précis : un motif trop large
  arrêterait des tests encore en cours.
- `diffPatterns` : expressions régulières (JavaScript) cherchées dans les
  lignes ajoutées par `agent-check`, avec la raison. Le double encodage UTF-8
  est déjà cherché.
- `shared` : texte libre lu par l'orchestrateur avant de lancer deux agents.

## 3. Rédiger `rules.md`

Court, en impératifs, lu en premier par chaque agent : conventions de la stack
(versions à vérifier, style imposé, langue du code et de l'interface), ce
qu'un agent ne doit jamais faire (production, ports réservés, conteneurs),
comment vérifier une interface ou une étape de traitement, les skills du
projet à suivre pour tel type de changement. Pas de procédure générique : elle
est déjà dans la définition des agents.

## 4. Faire valider, puis écrire

Montrer les deux fichiers à l'utilisateur, intégrer ses corrections, puis les
écrire. Vérifier aussi :

- `.gitignore` contient `CLAUDE.local.md`, `NOTES.local.md` et
  `.claude/worktrees/` ; proposer d'ajouter ce qui manque ;
- proposer un `.worktreeinclude` pour les fichiers non versionnés dont un
  worktree a besoin (`.env`…) ;
- lancer une fois chaque commande de `checks` sur la branche courante, pour
  vérifier qu'elle passe avant d'en faire un critère.
