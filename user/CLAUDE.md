# Rédaction : README, commentaires, messages de commit

Ne raconter aucune histoire : ni celle de l'utilisateur, ni la mienne, ni celle
du projet. S'en tenir aux usages des projets open source.

- **README** : ce que fait le projet, prérequis, installation, configuration,
  usage, déploiement, architecture en bref. Pas de journal de décisions, pas
  d'anecdotes, pas de chiffres mesurés sur les données de l'utilisateur.
- **Commentaires** : le *pourquoi* technique non évident, en quelques lignes.
  Pas d'historique (« avant », « la première version », « ça a coûté »), pas de
  date de constat, pas de mesure sur des données réelles, pas de « nous ».
- **Messages de commit** : Conventional Commits, un sujet court et un corps bref
  qui dit ce qui change et pourquoi. Pas de récit de l'enquête, pas de chiffres
  tirés des données personnelles.
- **Données personnelles** : jamais d'adresse de wallet, de montant, de nom ou
  d'identifiant réel de l'utilisateur dans le code, les tests ou la doc ; des
  valeurs synthétiques à la place.

Tout le reste va hors du dépôt, dans deux fichiers à la racine du projet, tous
deux ajoutés au `.gitignore`, ou dans la mémoire locale :

- **`CLAUDE.local.md`** : le contexte courant et les chantiers en cours, et rien
  d'autre. Il est chargé dans chaque conversation, donc il reste court.
- **`NOTES.local.md`** : l'historique des décisions, les incidents et les
  chiffres mesurés sur les données de l'utilisateur. Lu à la demande, quand une
  question porte sur un chiffre, une source de données ou un incident.
