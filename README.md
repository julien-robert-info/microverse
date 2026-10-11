# microverse

Plugin Claude Code pour conduire un projet par chantiers délégués à des agents
en arrière-plan : une tâche, une branche, un worktree. Une conversation
orchestratrice conçoit, écrit le brief, lance l'agent, relit son diff, merge et
nettoie ; le rythme de lancement suit le quota d'utilisation.

## Contenu

| Composant | Rôle |
|---|---|
| skill `orchestration` | procédure : rôles et modèles, budget, brief, réception, rapport de série, changement de conversation |
| skill `init` | rédige le profil d'orchestration d'un projet |
| agent `meeseeks` (Sonnet) | implémente un brief dans son worktree |
| agent `morty` (Haiku, lecture seule) | répond à une question avec des faits et leurs preuves |
| agent `rick` (Opus, lecture seule) | relit un diff à risque, rend des défauts classés |
| `orch-quota` | lit les compteurs de quota et conseille le rythme de lancement |
| `orch-usage` | tokens et coût en équivalent API par modèle, taille du contexte d'une session |
| `agent-check <branche>` | commits, worktree propre, vérifications du profil, motifs suspects dans le diff |
| `agent-cleanup <branche>` | supprime le worktree et la branche mergée d'un agent |
| hook `SubagentStop` | arrête les serveurs laissés allumés par un agent terminé (Windows) |
| `user/CLAUDE.md` | règles de rédaction (README, commentaires, commits), à importer dans `~/.claude/CLAUDE.md` |

## Prérequis

- Claude Code 2.1.293 ou plus récent (alias de modèle `haiku` pour Claude Haiku 5.5).
- Node.js 20 ou plus récent, pour les scripts de `bin/`.
- Git.
- Facultatif : l'extension VS Code « Claude Code Usage » (growthjack), dont
  `orch-quota` lit les relevés. Sans elle, l'orchestrateur demande les
  compteurs à l'utilisateur.
- Le hook `SubagentStop` ne fonctionne que sous Windows (PowerShell).

## Installation

Le dépôt est son propre catalogue de plugins.

```bash
claude plugin marketplace add <chemin du clone ou owner/repo>
claude plugin install microverse@microverse
```

Un catalogue ajouté depuis un chemin local charge le plugin en place : une
modification prend effet à la conversation suivante ou après `/reload-plugins`.

Règles de rédaction, dans `~/.claude/CLAUDE.md` :

```markdown
@<chemin du clone>/user/CLAUDE.md
```

## Configuration

Réglages du plugin (`/config`) :

| Clé | Défaut | Sens |
|---|---|---|
| `week_target` | 98 | consommation visée en fin de semaine ; au-delà plus de reprise d'agent, 3 points avant plus de nouvel agent (%) |
| `weekday_reserve` | 30 | points gardés pour les jours de semaine ; le week-end monte jusqu'à `week_target` moins cette valeur |
| `five_hour_limit` | 90 | au-delà, aucun nouvel agent jusqu'à la remise à zéro du compteur 5h ; 5 points plus haut, plus de reprise (%) |
| `quota_file` | — | fichier des relevés, si l'extension n'est pas à son emplacement par défaut |

Par projet, le profil `.claude/orchestration/` (versionné), rédigé par
`/microverse:init` :

- `profile.json` : `setup` (commandes d'un worktree neuf), `checks` (`name`,
  `run`, `paths` facultatif), `servers` (motifs de ligne de commande),
  `diffPatterns` (`pattern`, `why`), `shared` (ressources exclusives) ;
- `rules.md` : règles et pièges du projet, lus en premier par les agents.

Le projet ignore `CLAUDE.local.md`, `NOTES.local.md` et `.claude/worktrees/`.

## Usage

Dans une conversation ouverte à la racine du projet : « démarre <chantier> »,
« chantier suivant », « où en est-on ? », « rapport ». Le skill `orchestration`
se charge sur ces demandes ; `/microverse:orchestration` le force.

Les scripts se lancent aussi à la main depuis la racine du dépôt :

```bash
orch-quota --target 98 --reserve 30
orch-usage --since 2026-01-01
orch-usage --context
agent-check feat/sujet
agent-cleanup feat/sujet
```

## Architecture

```
.claude-plugin/   plugin.json (manifeste, réglages), marketplace.json (catalogue)
skills/           orchestration (SKILL.md, budget.md, brief.md, review.md), init
agents/           meeseeks, morty, rick
bin/              scripts Node sans dépendance, ajoutés au PATH de l'outil Bash ;
                  les .cmd les rendent appelables depuis PowerShell
scripts/          orch-lib.js (partagé par bin/), hook SubagentStop
hooks/hooks.json  déclaration du hook
user/CLAUDE.md    règles globales de rédaction
```
