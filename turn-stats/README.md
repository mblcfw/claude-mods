# turn-stats

Mod pour Claude Code qui affiche un bandeau au-dessus du prompt avec le bilan du dernier tour :
sa durée, le nombre d'outils appelés, les tokens d'entrée et de sortie (avec la part servie par
le cache), le modèle, et ce qu'ont consommé les sous-agents lancés pendant ce tour.
Pendant un tour, le bandeau montre les compteurs en direct.

- Bouton « Masquer » pour cacher le bandeau.
- `/stats-tour` l'affiche ou le masque.

## Installation

```
/plugin install turn-stats --marketplace mblcfw/claude-mods
```

Depuis un shell : `claude plugin install turn-stats --marketplace mblcfw/claude-mods`.
Dans l'app desktop : + à côté de la zone de saisie, Plugins, Add marketplace avec `mblcfw/claude-mods`, puis Add plugin.
