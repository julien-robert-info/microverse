---
name: orchestration
description: Conduire un projet par chantiers délégués à des agents en arrière-plan, une tâche = une branche = un worktree — concevoir, écrire le brief, lancer l'agent, relire son diff, merger, nettoyer, tenir le tableau des chantiers, rédiger le rapport de série. À utiliser dès que l'utilisateur dit « démarre X », « lance », « chantier suivant », « enchaîne », « on passe à … », quand le rapport d'un agent arrive, avant de merger une branche d'agent, quand il faut savoir si un nouvel agent peut partir (quota), quand l'utilisateur demande où on en est ou un rapport, ou quand la conversation orchestratrice s'alourdit.
---

# Orchestration de chantiers par agents

L'orchestrateur est le seul interlocuteur de l'utilisateur. Il conçoit, délègue,
relit et merge ; le travail lourd vit dans le contexte des agents, et lui ne
garde que les décisions. L'état vit dans des fichiers, pour qu'une nouvelle
conversation reprenne sans perte :

- **fichier d'état** (`CLAUDE.local.md`, non versionné, chargé à chaque
  conversation) : tableau « Chantiers en cours », ressources partagées
  réservées (numéro de migration…), ce qui est déployé, dernier rapport,
  questions qui attendent l'utilisateur (§ 6) ;
- **notes** (`NOTES.local.md`, lu à la demande) : conception de chaque
  chantier, mesures sur les données réelles, décisions passées ;
- **profil du projet** (`.claude/orchestration/profile.json` et `rules.md`,
  versionnés) : installation d'un worktree, vérifications, serveurs, motifs à
  surveiller, ressources partagées, règles de la stack. Absent : lancer
  `/microverse:init` avant le premier chantier.

## Rôles et modèles

| Qui | Modèle | Fait |
|---|---|---|
| conversation de conception | Opus | enquête, règles, brief |
| conversation d'exécution | Sonnet | lancer, relire un diff mécanique, merger, nettoyer, état, rapport |
| `microverse:meeseeks` | Sonnet | implémente un brief dans son worktree |
| `microverse:morty` | Haiku | lit et résume : une question, des faits avec leur preuve |
| `microverse:rick` | Opus | relit un diff à risque, ne corrige rien |

- Le modèle de la conversation se choisit à son ouverture et ne change pas :
  le cache est propre à chaque modèle, un changement réécrit tout le contexte.
- Une conversation en Sonnet ne conçoit pas : une question de conception est
  notée dans le fichier d'état pour la prochaine conversation en Opus.
- Passer le modèle **explicitement** à chaque lancement (`model:` de l'outil
  Agent) : la définition de l'agent ne suffit pas toujours.
- Ce qui est mécanique passe par un script (zéro token de modèle) ; une sortie
  brute volumineuse (journaux, résultats SQL, gros fichiers) passe par un
  `morty`, pour rester hors du contexte de l'orchestrateur.

## 1. Avant de lancer

- **Budget** : `orch-quota --target ${user_config.week_target} --reserve ${user_config.weekday_reserve} --five-hour ${user_config.five_hour_limit} --file "${user_config.quota_file}"`.
  Suivre son conseil (accélérer, normal, lisser, aucun nouvel agent, arrêt) ;
  détail et cas sans fichier dans `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/budget.md`.
- **Parallélisme** : deux `meeseeks` à la fois seulement sur le conseil
  « accélérer », sur des zones de code distinctes, et jamais deux sur une même
  ressource du `shared` du profil (schéma, base locale…). La tâche qui prend
  une ressource partagée la réserve dans le fichier d'état.
- **Concevoir d'abord** (en Opus) : mesurer sur les données réelles ce que la
  tâche va rencontrer, trancher les règles, les écrire dans les notes. Un
  implémenteur qui doit décider seul une règle métier la décidera mal.

## 2. Lancer

```
Agent(subagent_type: "microverse:meeseeks", model: "sonnet",
      isolation: "worktree", run_in_background: true,
      description: "<3-5 mots>", prompt: <brief>)
Agent(subagent_type: "microverse:morty", model: "haiku",
      description: "<3-5 mots>", prompt: <une question>)
```

- Le brief suit `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/brief.md`.
- Lancer depuis la racine du dépôt principal : le worktree part du `HEAD` du
  répertoire courant. Sous Windows, une lettre de lecteur en minuscule (`d:`)
  fait refuser la création du worktree : `cd "D:/…"`.
- Un `morty` ne pose qu'une question ; plusieurs questions, plusieurs
  `morty`. Il ne compte pas dans le parallélisme.

## 3. À la réception du rapport

1. `agent-check <branche>` : commits présents, worktree propre, `checks` du
   profil, motifs du diff. Un échec de quelques lignes se renvoie à l'agent par
   `SendMessage` (contexte encore chaud) plutôt que corrigé soi-même.
2. **Relire le diff pour de vrai**, pas le rapport, avec
   `${CLAUDE_PLUGIN_ROOT}/skills/orchestration/review.md`.
3. **Diff à risque** (arithmétique sur montants ou unités, clés de
   dédoublonnage ou de stockage, migrations, suppression de données) :
   `Agent(subagent_type: "microverse:rick", model: "opus",
   prompt: <branche, brief, zones à risque>)`, puis trancher ses remarques.
4. **Merger** sans attendre l'utilisateur, qui relit a posteriori :
   `git merge --no-ff <branche>` avec le sujet `merge: …`. La vérification
   complète de la branche principale (build compris) se fait une fois, avant un
   déploiement.
5. `agent-cleanup <branche>` : refuse tant qu'un processus tourne dans le
   worktree ou que la branche n'est pas mergée.
6. **Fichier d'état** : ligne du chantier, commit mergé, réservation libérée,
   questions en attente.
7. **Enchaîner** : une tâche déjà planifiée se lance dès que la précédente est
   mergée, sans demander, après un nouvel `orch-quota`. Entre deux rapports,
   une ligne par événement (« D1 mergé (`abc1234`), D2 lancé »).

## 4. Rapport de série

Rédigé à chaque arrêt de l'enchaînement (plus de tâche planifiée, seuil de
quota, question bloquante, changement de conversation) et à chaque demande de
l'utilisateur. Il couvre tout depuis le précédent, dont le commit est noté dans
le fichier d'état (`git log --oneline <commit>..main`). Il se suffit à
lui-même, dans cet ordre :

1. **Mergé** : par tâche, ce qui change pour l'utilisateur, avec le commit.
2. **Décisions prises seul**, à confirmer : la règle, l'alternative écartée,
   pourquoi.
3. **Demandes à l'utilisateur** (§ 6) : ce qui a été vérifié depuis le rapport
   précédent, puis ce que lui seul peut faire.
4. **Points ouverts** : défauts trouvés et non corrigés, mesures surprenantes.
5. **Suite** : tâche en cours ou prochaine, ce qui attend une décision, et en
   **une seule question** : déployer et pousser ce qui est mergé depuis le
   dernier déploiement.
6. **Quota** : la sortie résumée d'`orch-quota`.
7. **Conversation** : contexte mesuré par `orch-usage --context`, et une
   recommandation nette : continuer, ou changer après tel merge ; avec le
   **modèle de la suivante** : Opus s'il reste à concevoir, Sonnet s'il ne
   reste qu'à exécuter des chantiers conçus.

Puis noter le nouveau « Dernier rapport » dans le fichier d'état.

## 5. Changer de conversation

Au-delà de ~150K tokens de contexte (`orch-usage --context`) : rapport de série,
fichier d'état à jour, puis le dire à l'utilisateur, à un moment où aucun agent
n'attend de relecture (le rapport d'un agent revient à la conversation qui l'a
lancé). Une fois le changement recommandé, ne plus lancer d'agent depuis cette
conversation : finir la relecture en cours, merger, mettre à jour l'état,
s'arrêter.

## 6. Ce qui reste à demander

Pousser, déployer, toute écriture sur une machine de production. Build et tests
ne prouvent pas qu'un écran s'affiche : après un déploiement qui touche
l'interface, demander à l'utilisateur d'ouvrir les écrans.

Le fichier d'état tient **une seule liste** de ce qui est demandé à
l'utilisateur :

- **vérifier soi-même d'abord** tout ce qui peut l'être (base, journaux, rendu
  local, `git`), au besoin par un `morty` ; ne demander que ce qui exige
  l'utilisateur : un écran, un geste dans l'application, une décision ;
- **une demande est tenue pour faite une fois posée** : elle sort de la liste
  au rapport rendu ; seules restent les questions qui attendent une réponse ;
- **vérifier ensuite l'effet** des gestes demandés quand on peut le lire, et le
  dire au rapport suivant ; un geste dont dépend un chantier se vérifie avant
  de le lancer.
