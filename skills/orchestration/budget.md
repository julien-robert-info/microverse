# Rythme de consommation

À lire avant de lancer un agent ou d'en reprendre un.

## Les compteurs

`orch-quota` lit le dernier relevé de l'extension VS Code « Claude Code Usage »
(growthjack) pour les deux compteurs, `five-hour` et `seven-day`. Si l'extension
n'est pas installée, ou si le relevé a plus de deux heures, demander à
l'utilisateur ses deux compteurs (`5h x% | wk y%`) à la prochaine occasion,
sans bloquer, et appliquer les mêmes règles à la main.

## Les périodes

La fenêtre hebdomadaire commence `resetAt` − 7 jours (en fin de semaine). Elle
se coupe en deux périodes :

- **week-end** : du début de la fenêtre au dimanche 24 h, heure locale ; la
  consommation peut monter jusqu'à C − R %, C étant la cible de fin de semaine
  (`week_target`) et R la réserve des jours de semaine (`weekday_reserve`) ;
- **semaine** : du lundi 0 h à la remise à zéro ; les soirs de semaine se
  partagent les R points restants jusqu'à C. Ce qui dépasse C reste pour les
  questions de fin de semaine.

Dans chaque période, la ligne de rythme va de la consommation au début de la
période à sa cible, linéairement dans le temps. `orch-quota` compare le
compteur hebdomadaire à cette ligne.

## Le conseil

Dans l'ordre, le premier qui s'applique :

| Situation | Conseil |
|---|---|
| hebdo ≥ C | **arrêt** : plus de reprise d'agent ; mettre l'état à jour, garder le reste pour les questions |
| hebdo ≥ C − 3 | **aucun nouvel agent** : finir, relire et merger ceux en cours (un agent lancé coûte encore quelques points) |
| 5h ≥ `five_hour_limit` + 5 | plus de reprise jusqu'à la remise à zéro du compteur 5h |
| 5h ≥ `five_hour_limit` | aucun nouvel agent jusqu'à la remise à zéro du compteur 5h |
| au-dessus de la ligne de plus de 5 points, ou cible atteinte | **lisser** : aucun nouvel agent tant que le compteur ne repasse pas sous la ligne |
| en dessous de la ligne de plus de 10 points | **accélérer** : deux `meeseeks` sur des zones distinctes, un seul sur une ressource partagée |
| sinon | **normal** : un `meeseeks` à la fois |

Les `morty` ne comptent pas. Un `rick` (Opus) compte comme un agent :
le réserver aux diffs à risque.

## Le coût, pour décider

- Le gros du coût est le contexte de la conversation principale, relu à chaque
  requête : changer de conversation vers 150K tokens coûte moins cher que de
  continuer.
- Une pause de plus d'une heure (attente d'un agent, nuit) fait expirer le
  cache : la requête suivante réécrit tout le contexte, au double du prix
  d'entrée.
- `orch-usage [--since <date>]` donne les tokens et le coût en équivalent API
  par modèle, conversations et agents séparés ; rapprocher les tokens d'un
  chantier de la variation du compteur hebdomadaire pendant ce chantier.
