# claude-mods

Des mods pour Claude Code qui améliorent l'interface.

| Mod | Ce qu'il fait |
| --- | --- |
| [agent-viewer](agent-viewer/) | Montre en direct quel agent fait quelle tâche : un panneau « Agents » à côté du chat, et une vue interactive façon Obsidian (2D ou 3D) avec zoom, déplacement, bulles de détail et couleurs par type d'action. |
| [turn-stats](turn-stats/) | Un bandeau au-dessus du prompt avec la durée, les outils et les tokens du dernier tour (et de ses sous-agents). |

## Installation

Dans une session Claude Code lancée dans un terminal, tape (une ligne par mod) :

```
/plugin install agent-viewer --marketplace mblcfw/claude-mods
```

```
/plugin install turn-stats --marketplace mblcfw/claude-mods
```

Réponds `y` pour ajouter le catalogue `github:mblcfw/claude-mods`, puis choisis la portée (Entrée pour « user »).

Depuis un shell :

```bash
claude plugin install agent-viewer --marketplace mblcfw/claude-mods
```

```bash
claude plugin install turn-stats --marketplace mblcfw/claude-mods
```

Dans l'app desktop, où `/plugin` ne fonctionne pas : clique sur + à côté de la zone de saisie, puis Plugins,
Add marketplace avec `mblcfw/claude-mods`, puis Add plugin.

## Prérequis

- **agent-viewer** : la vue interactive tourne sur un petit serveur local lancé par le mod, il faut donc
  `node` dans le PATH. La vue 3D télécharge ses bibliothèques (three.js, 3d-force-graph) depuis
  cdn.jsdelivr.net au premier passage en 3D ; la 2D fonctionne hors ligne.
- **turn-stats** : rien de particulier.
