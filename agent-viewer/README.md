# agent-viewer

Mod pour Claude Code qui montre en direct quel agent fait quelle tâche : l'agent principal et chaque
sous-agent lancé, avec chacune de leurs actions (appels d'outils), colorées par type
(lecture, recherche, écriture, commande, web, agents, MCP).

## Deux vues

- **Le panneau « Agents »** à côté du chat : un graphe de nœuds (survol = surbrillance, clic = bulle
  de détail), avec les boutons Figer, Masquer terminés, Effacer et la taille − / +.
  `/voir-agents` le rouvre. Dans le terminal, il affiche une liste en arbre.
- **La vue interactive**, façon vue graphe d'Obsidian, dans une page web locale :
  molette pour zoomer, glisser le fond pour se déplacer, glisser un nœud pour le tirer (la physique
  le ramène), clic pour ouvrir une bulle qu'on déplace en cliquant-glissant, recherche, filtres par
  type dans la légende, réglages des forces. `/graphe-agents` donne son adresse.
  Le bouton **2D / 3D** passe en vue 3D (three.js + 3d-force-graph) : glisser pour tourner, clic droit
  pour déplacer, molette pour zoomer, halos lumineux, particules sur les liens des agents actifs,
  rotation automatique en option. Les bibliothèques 3D (versions figées, vérifiées par empreinte
  d'intégrité) ne sont téléchargées depuis cdn.jsdelivr.net qu'au premier passage en 3D ; la 2D marche
  hors ligne.

## Serveur local

La vue interactive est servie par `server/server.mjs` (Node.js, sans dépendance), que le mod lance au
démarrage de la session. Il n'écoute que sur 127.0.0.1 (port 47321 à 47340), refuse les autres noms
d'hôte, n'accepte les données que du mod (jeton secret) et s'arrête quand le mod s'arrête, ou après
15 minutes sans nouvelles. Il faut `node` dans le PATH.

## Installation

```
/plugin install agent-viewer --marketplace mblcfw/claude-mods
```

Depuis un shell : `claude plugin install agent-viewer --marketplace mblcfw/claude-mods`.
Dans l'app desktop : + à côté de la zone de saisie, Plugins, Add marketplace avec `mblcfw/claude-mods`, puis Add plugin.
