# Le brief d'un meeseeks

L'agent part sans contexte. Ce qui vaut pour toutes les tâches (installation
du worktree, conventions, pièges génériques, vérifications, format du rapport)
est dans sa définition ; ce qui vaut pour toutes les tâches du projet est dans
`.claude/orchestration/rules.md` et `profile.json`, qu'il lit en premier. Ne
pas le recopier : n'écrire que ce qui est propre à la tâche.

1. **Branche** (`<type>/<sujet>`) et **ressources partagées** : « tu possèdes
   le schéma, migration `00NN` » ou rien (l'agent n'y touche pas).
2. **But** : la question de l'utilisateur que la tâche sert, en une phrase.
3. **Zone** : dossiers et fichiers que l'agent possède ; ce qu'il lit d'abord,
   avec les fonctions ou les lignes.
4. **Règles décidées**, à appliquer telles quelles : définitions, seuils,
   ordres de priorité, signes, cas exclus. Dire ce qui n'est **pas** dans le
   périmètre.
5. **Stockage** et **interface** : tables et colonnes, écrans, libellés,
   pagination, filtres.
6. **En passant** : petites corrections voisines attendues.
7. **Pièges propres à la tâche**, en plus de ceux de la définition et de
   `rules.md`.
8. **Tests attendus** : la liste des cas, dont les cas croisés (deux côtés
   différents) et les cas négatifs.
9. **Vérification sur données réelles** : comment relancer l'étape, repères
   chiffrés attendus, questions précises auxquelles le rapport doit répondre.

Un brief qui laisse une règle métier ouverte n'est pas prêt : la trancher
d'abord, ou la noter pour une conversation de conception.
