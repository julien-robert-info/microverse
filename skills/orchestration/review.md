# Relire le diff d'un agent

Après `agent-check` (qui couvre commits, worktree propre, vérifications du
profil et motifs mécaniques), lire `git diff main...<branche>` contre le brief.
Le rapport de l'agent dit ce qu'il croit avoir fait ; le diff dit ce qu'il a
fait.

## Ce qui a déjà échappé à des relectures

- **Le travail existe** : un agent a déjà relancé un autre agent au lieu de
  coder, puis rendu un rapport « délégué, en cours ».
- **Clés qui collisionnent** : une clé de stockage ou de dédoublonnage non
  unique sur les données réelles perd des lignes sans un mot.
- **Repli silencieux** : une source en échec ou une valeur manquante qui
  devient zéro, une valeur par défaut ou un cache, au lieu d'un `null`, d'un
  indicateur d'incomplétude ou d'une erreur.
- **Décision prise à la place de l'utilisateur** : une valeur proposée par
  défaut (étiquette, catégorie) là où l'utilisateur doit choisir.
- **Test aveugle** : un test qui donne le même cas aux deux côtés d'une
  comparaison ne voit pas le défaut qu'il doit attraper (mêmes symboles, mêmes
  unités, mêmes montants des deux côtés).
- **Commentaires** : un commentaire utile perdu dans un déplacement ; un
  commentaire qui raconte l'historique, la démarche ou une mesure.
- **Calcul au mauvais endroit** : un écran qui recalcule au rendu ce qu'une
  étape amont a stocké.
- **Hors zone** : fichiers modifiés hors de la zone du brief, ressource
  partagée touchée sans réservation.
- **Données personnelles** : identifiant, adresse ou montant réel dans le code,
  les tests ou les commits.
- **Périmètre** : règle du brief appliquée à moitié, cas exclu traité quand
  même, cas attendu sans test.

## Quand passer la main à rick

Arithmétique sur montants ou unités, clés de dédoublonnage ou de stockage,
migrations, suppression ou réécriture de données, concurrence : le diff part à
`rick` (Opus) avec la branche, le brief et les zones à risque. Il rend
des défauts classés avec fichier:ligne et le scénario qui casse ; trancher
chacun (corriger par l'agent, accepter, noter) avant de merger.
