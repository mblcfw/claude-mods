# agent-viewer

**Français** · [English](#english)

Mod pour Claude Code qui montre en direct, sous forme d'organigramme, quel agent fait quoi : l'agent
principal, chaque sous-agent qu'il lance, ce qu'ils font, sur quelle partie du projet, et où ils en sont.

## Ce que tu vois

- **Un organigramme** : ta demande en haut, l'agent principal, ses sous-agents, puis la réponse finale.
- **La couleur de chaque bulle suit l'état de l'agent** : vert = terminé, ivoire = en cours (avec un arc
  animé autour de la bulle), violet = en attente, rouge = échec, orange = alerte (il attend ton
  autorisation ou te pose une question).
- **Un clic sur une bulle** l'ouvre : ce que fait l'agent, l'action en cours, la partie du projet et
  ses tâches (faite / en cours / à faire).
- **Des barres de progression fiables** : le % d'un agent = tâches faites ÷ total de sa liste de tâches.
  Sans liste, ou si la liste n'a jamais été mise à jour, la barre affiche « — » plutôt qu'un chiffre
  inventé. La barre du projet suit le plan de l'agent principal.
- **Un chat** en bas : écris à l'agent sélectionné, sa réponse s'affiche dans son fil.
- **Toutes tes sessions** Claude Code qui ont le mod, avec un sélecteur en haut à gauche.
- Molette pour zoomer, glisser le fond pour se déplacer, glisser une bulle pour la déplacer (sa place est
  retenue ; « Remettre en place » rend la disposition d'origine), poignée en haut du chat pour l'agrandir.
- **Réglages ⚙** à côté du chat : disposition (organigramme, arbre horizontal, tableau), thème sombre ou
  clair, langue français ou anglais.
- Dans le panneau « Agents » à côté du chat de Claude Code : un résumé (progression du projet, une ligne
  par agent) et l'adresse de la vue complète. `/voir-agents` rouvre le panneau, `/graphe-agents` donne
  l'adresse.

## Bon à savoir

- **Listes de tâches** : le mod fournit aux agents un outil `progress` et ajoute à la consigne de chaque
  sous-agent une phrase qui lui demande de tenir sa liste de tâches avec cet outil. C'est ce qui rend les %
  réels ; cela ajoute quelques appels d'outil légers.
- **Chat** : ton message passe par l'agent principal, comme si tu l'avais tapé dans la session (il
  commence par « [Chat agent-viewer] » quand il est destiné à un sous-agent). L'agent principal le
  transmet lui-même avec `SendMessage`, sous tes règles d'autorisation habituelles : le mod n'en contourne
  aucune.
- **Hub local** : la vue complète est servie par `server/server.mjs` (Node.js, sans dépendance), partagé
  par toutes tes sessions. Il n'écoute que sur 127.0.0.1 (ports 47321 à 47340), refuse les autres noms
  d'hôte et toute requête venue d'une page web étrangère, et s'arrête seul après 15 minutes sans session ni
  page ouverte. Il faut `node` dans le PATH.
- **Hors ligne** : la page ne charge rien depuis Internet.

## Installation

```
/plugin install agent-viewer --marketplace mblcfw/claude-mods
```

Depuis un shell : `claude plugin install agent-viewer --marketplace mblcfw/claude-mods`.
Dans l'app desktop : + à côté de la zone de saisie, Plugins, Add marketplace avec `mblcfw/claude-mods`, puis Add plugin.

---

## English

A Claude Code mod that shows, live and as an org chart, which agent is doing what: the main agent, every
subagent it launches, what each one is doing, on which part of the project, and how far along it is.

### What you see

- **An org chart**: your request at the top, the main agent, its subagents, then the final answer.
- **Each bubble's color follows the agent's state**: green = done, ivory = running (with an animated arc
  around the bubble), purple = waiting, red = failed, orange = alert (it is waiting for your permission or
  asking you a question).
- **Click a bubble** to open it: what the agent does, its current action, its part of the project and its
  tasks (done / running / to do).
- **Reliable progress bars**: an agent's % = tasks done ÷ tasks in its task list. With no list, or a list
  that was never updated, the bar shows "—" instead of a made-up number. The project bar follows the main
  agent's plan.
- **A chat** at the bottom: write to the selected agent; its answer shows up in its thread.
- **All your Claude Code sessions** that have the mod, with a picker at the top left.
- Mouse wheel to zoom, drag the background to pan, drag a bubble to move it (its position is remembered;
  "Reset layout" restores the default), drag the handle above the chat to make it taller.
- **Settings ⚙** next to the chat: layout (org chart, horizontal tree, table), dark or light theme, French
  or English.
- In the "Agents" pane next to the Claude Code chat: a summary (project progress, one line per agent) and
  the address of the full view. `/voir-agents` reopens the pane, `/graphe-agents` gives the address.

### Good to know

- **Task lists**: the mod gives agents a `progress` tool and adds a sentence to each subagent's prompt
  asking it to keep its task list with that tool. This is what makes the percentages real; it adds a few
  lightweight tool calls.
- **Chat**: your message goes through the main agent, as if you had typed it in the session (it starts
  with "[Chat agent-viewer]" when it is meant for a subagent). The main agent forwards it itself with
  `SendMessage`, under your usual permission rules: the mod bypasses none of them.
- **Local hub**: the full view is served by `server/server.mjs` (Node.js, no dependencies), shared by all
  your sessions. It only listens on 127.0.0.1 (ports 47321 to 47340), rejects other host names and any
  request coming from a foreign web page, and stops on its own after 15 minutes with no session and no open
  page. `node` must be on the PATH.
- **Offline**: the page loads nothing from the Internet.

### Install

```
/plugin install agent-viewer --marketplace mblcfw/claude-mods
```

From a shell: `claude plugin install agent-viewer --marketplace mblcfw/claude-mods`.
In the desktop app: + next to the prompt box, Plugins, Add marketplace with `mblcfw/claude-mods`, then Add plugin.
