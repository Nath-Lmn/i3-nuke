# ~ Never forget to I3 lock again ~



![Funny picture :D](image%20github.png)



# prank.sh — blagues de session i3 (tradition d'école)

Si quelqu'un oublie de verrouiller sa session (`$mod+Escape` + `i3lock`), la tradition
autorise les blagues. Règles : **on ne touche jamais au travail/code/git**, tout est
annulable en quelques secondes, et on **assume son coup**.

>  Chaque modification de config est consignée dans **`~/prank_journal.txt`** avec
> son antidote — la victime peut donc tout annuler elle-même. C'est le fair-play.

## Installation

```bash
chmod +x prank.sh
./prank.sh                # menu interactif
./prank.sh list           # liste des blagues
./prank.sh rotate         # direct en CLI
./prank.sh undo rotate    # annule une blague
./prank.sh undo-all       # annule tout

⚠️ Lance le script dans un terminal **de la session graphique de la victime**.
Les blagues marquées `[rc]` ne s'arment que dans les **nouveaux** terminaux :
utiliser `./prank.sh new-terminal` pour en ouvrir un immédiatement.

## Les commandes

| # | Nom | Effet | Antidote |
|---|---|---|---|
| 1 | `swap-commands` | Intervertit les commandes : `ls` fait un `cd`, `cd` liste, `cat` lit à l'envers (`tac`) | `undo swap-commands` |
| 2 | `swap-apps` | Intervertit les logiciels : `vim` lance firefox et inversement. Paires : `SWAP_APPS="vim:firefox nano:gedit" ./prank.sh swap-apps` | `undo swap-apps` |
| 3 | `dvorak` | Passe le clavier en DVORAK | `undo dvorak` |
| 4 | `vim-red` | Met tout le texte des vim **ouverts** en rouge | `undo vim-red` |
| 5 | `vim-mirror` | Inverse l'affichage de vim (droite → gauche) | `undo vim-mirror` |
| 6 | `rotate` | Retourne l'écran à 180° | `undo rotate` |
| 7 | `cursor-image` | Remplace le curseur par l'image passée en argument : `./prank.sh cursor-image chat.png` | `undo cursor-image` |
| 8 | `cursor-big` | Curseur immense (taille 96) | `undo cursor-big` |
| 9 | `lock-shot` | Screenshot du bureau puis `i3lock` dessus — à lancer **en dernier** | mot de passe de la victime |
| 10 | `mouse-slow` | Souris au ralenti (15% de vitesse) | `undo mouse-slow` |
| 11 | `mouse-invert` | Inverse les axes de la souris (180°) | `undo mouse-invert` |
| 12 | `opacity` | Toutes les fenêtres à 20% d'opacité | `undo opacity` |
| 13 | `shutup` | `shutdown` répond « shutup 😏 » | `undo shutup` |
| 14 | `vim-light` | Passe vim en thème clair | `undo vim-light` |
| 15 | `oneko` | Un chat poursuit le curseur 🐱 | `undo oneko` |
| 16 | `terminal-shutdown` | **Faux** shutdown à l'ouverture du 1er terminal (compte à rebours 5s puis révélation) | `undo terminal-shutdown` |
| — | `new-terminal` | Outil : ouvre un terminal qui hérite des pièges du rc | — |

## Dépendances (par blague)

| Blague | Paquets |
|---|---|
| lock-shot | `i3lock` + `maim` ou ImageMagick |
| rotate, mouse-*, dvorak | `xorg.xrandr`, `xorg.xinput`, `xorg.setxkbmap` |
| cursor-image | `xcursorgen` + ImageMagick (`convert`) |
| vim-* | vim compilé avec `+clientserver`, lancé avec `--servername` |
| opacity | `xorg.xprop`, `xorg.xwininfo` + compositeur (`picom`/`compton`) actif |
| oneko | `oneko` |

## Notes importantes

- **terminal-shutdown est volontairement FAUX** : un vrai shutdown détruirait le
  travail non sauvegardé (interdit par la tradition) et serait irréversible.
  Le piège ne se déclenche qu'au premier terminal (flag dans `~/.cache/`).
- **shutup** : `sudo shutdown` continue de fonctionner (`secure_path` ignore le
  PATH utilisateur) — seul le `shutdown` "simple" est piégé.
- **swap-commands / swap-apps** : les fonctions ne sont pas exportées → les
  scripts et Makefiles de la victime restent intacts. Le swap utilise
  `builtin`/`command` pour éviter toute récursion infinie.
- **cursor-image / cursor-big** n'affectent que les applications lancées *après*
  la blague. Si tu combines les deux, annule dans l'ordre inverse de l'installation.
- **NixOS** : si `~/.bashrc`, `~/.zshrc` ou `~/.config/i3/config` sont des symlinks
  read-only vers `/nix/store`, les blagues `[rc]` échouent proprement avec un message.
- **Wayland** non supporté (xrandr/xinput/i3lock sont X11).
- **La victime qui cherche** trouvera tout avec : `type -a ls`, `declare -f ls`,
  `command ls`, et le journal `~/prank_journal.txt`. C'est voulu 😏
