#!/usr/bin/env bash
# ============================================================
#  prank.sh — blagues de session i3 (tradition d'école)
#
#  Règles : ne pas toucher au travail · tout annulable · assumer son coup
#  Toute modification de config est consignée dans ~/prank_journal.txt
#  avec son antidote (fair-play : la victime peut le lire).
#
#  Usage :
#   ./prank.sh                    menu interactif
#   ./prank.sh list               liste
#   ./prank.sh <blague> [arg]     applique          ex: ./prank.sh cursor-image chat.png
#   ./prank.sh undo <blague>      annule            ex: ./prank.sh undo rotate
#   ./prank.sh undo-all           tout annuler
# ============================================================

set -u

G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; B='\033[1;34m'; N='\033[0m'
say()  { printf "%b\n" "$*"; }
ok()   { say "${G}[ok]${N} $*"; }
warn() { say "${Y}[!]${N}  $*"; }
die()  { say "${R}[x]${N}  $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
STATE="$STATE_DIR/prank_state.env"
JOURNAL="$HOME/prank_journal.txt"
XRDB_BAK="$STATE_DIR/prank_xrdb.bak"

state_set() { mkdir -p "$STATE_DIR"; touch "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null
  printf '%s=%s\n' "$1" "$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
state_get() { [ -f "$STATE" ] && grep -m1 "^$1=" "$STATE" | cut -d= -f2-; }
state_del() { [ -f "$STATE" ] && { grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null; mv "$STATE.tmp" "$STATE"; }; return 0; }

detect_rc() { case "${SHELL:-/bin/bash}" in *zsh*) echo "$HOME/.zshrc";; *) echo "$HOME/.bashrc";; esac; }
rc_writable() { local rc; rc=$(detect_rc); [ -w "$rc" ] || { die "$rc non inscriptible (NixOS symlink ?)"; return 1; }; return 0; }

check_x() {
  [ -n "${WAYLAND_DISPLAY:-}" ] && { warn "Wayland détecté : xrandr/xinput/setxkbmap/i3lock ne marcheront pas."; return 1; }
  [ -z "${DISPLAY:-}" ] && { warn "Pas de DISPLAY : lance-moi DANS la session graphique de la victime."; return 1; }
  return 0
}

# ---------- journal : toute modification + antidote ----------
log_on() {  # $1 nom, $2 description
  [ -f "$JOURNAL" ] || printf '=== JOURNAL — blagues de session ===\n(APPLI = modification ; ANTIDOTE = annulation)\n\n' >> "$JOURNAL"
  printf '[%s] APPLI  %-18s %s\n    ANTIDOTE : ./prank.sh undo %s\n' "$(date '+%F %T')" "$1" "$2" "$1" >> "$JOURNAL"
}
log_off() { printf '[%s] ANNUL  %-18s antidote appliqué\n' "$(date '+%F %T')" "$1" >> "$JOURNAL"; }

primary_output() { xrandr --query 2>/dev/null | grep -m1 -w connected | cut -d' ' -f1; }
current_rotation() {
  local line; line=$(xrandr --query 2>/dev/null | awk -v o="$1" '$1==o && $2 ~ /^connected/' | head -n1)
  printf '%s\n' "${line%% (normal*}" | awk '{for(i=1;i<=NF;i++) if($i=="left"||$i=="right"||$i=="inverted"||$i=="normal") print $i}'
}
mouse_matrix() {
  xinput list-props "Virtual core pointer" 2>/dev/null \
    | awk '/Coordinate Transformation Matrix/ {gsub(/,/,""); print $5,$6,$7,$8,$9,$10,$11,$12,$13}'
}
i3_reload() { have i3-msg && i3-msg reload >/dev/null 2>&1 && ok "config i3 rechargée"; return 0; }

# ============================================================
#  1. SWAP-COMMANDS — ls<->cd (+ cat<->tac) dans le bashrc
# ============================================================
do_swap_commands() {
  rc_writable || return 1
  local rc; rc=$(detect_rc)
  grep -q 'BEGIN PRANK-SWAP-CMD' "$rc" && { warn "déjà installé"; return 0; }
  {
    printf '\n# --- BEGIN PRANK-SWAP-CMD ---\n'
    printf 'ls() { builtin cd "$@"; }\n'
    printf 'cd() { command ls "${1:-.}"; }\n'
    have tac && { printf 'cat() { command tac "$@"; }\n'; printf 'tac() { command cat "$@"; }\n'; }
    printf '# --- END PRANK-SWAP-CMD ---\n'
  } >> "$rc"
  ok "swap installé dans $rc — ouvrir un NOUVEAU terminal pour armer"
  log_on swap-commands "ls<->cd (+cat<->tac) via fonctions shell"
}
undo_swap_commands() {
  local rc; rc=$(detect_rc)
  sed -i '/^# --- BEGIN PRANK-SWAP-CMD ---$/,/^# --- END PRANK-SWAP-CMD ---$/d' "$rc" 2>/dev/null
  ok "swap retiré (shells ouverts : unset -f ls cd cat tac)"
  log_off swap-commands
}

# ============================================================
#  2. SWAP-APPS — vim lance firefox et inversement (fakes PATH)
#     Paires configurables : SWAP_APPS="vim:firefox nano:gedit" ./prank.sh swap-apps
# ============================================================
do_swap_apps() {
  rc_writable || return 1
  local rc; rc=$(detect_rc)
  mkdir -p "$HOME/.prankbin"
  local pairs="${SWAP_APPS:-vim:firefox}"
  local installed="" pair a b ra rb
  for pair in $pairs; do
    a=${pair%%:*}; b=${pair##*:}
    ra=$(command -v "$a" 2>/dev/null); rb=$(command -v "$b" 2>/dev/null)
    case "$ra" in "$HOME/.prankbin/"*) warn "$a déjà piégé, skip"; continue;; esac
    case "$rb" in "$HOME/.prankbin/"*) warn "$b déjà piégé, skip"; continue;; esac
    [ -z "$ra" ] && { warn "$a introuvable, skip"; continue; }
    [ -z "$rb" ] && { warn "$b introuvable, skip"; continue; }
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$rb" > "$HOME/.prankbin/$a"
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$ra" > "$HOME/.prankbin/$b"
    chmod +x "$HOME/.prankbin/$a" "$HOME/.prankbin/$b"
    installed="$installed $a $b"
  done
  [ -z "$installed" ] && { die "aucune paire installable"; return 1; }
  grep -q 'PRANK-PATH-APPS' "$rc" || printf '\nPATH="$HOME/.prankbin:$PATH"  # PRANK-PATH-APPS\n' >> "$rc"
  state_set APPS_INSTALLED "${installed# }"
  ok "apps interverties :$installed — nouveau terminal pour armer"
  log_on swap-apps "fakes PATH:$installed"
}
undo_swap_apps() {
  local rc; rc=$(detect_rc)
  local names; names=$(state_get APPS_INSTALLED); names=${names:-vim firefox}
  local n; for n in $names; do rm -f "$HOME/.prankbin/$n"; done
  sed -i '/PRANK-PATH-APPS/d' "$rc" 2>/dev/null
  rmdir "$HOME/.prankbin" 2>/dev/null
  state_del APPS_INSTALLED
  ok "fakes apps retirés (shells ouverts : hash -r)"
  log_off swap-apps
}

# ============================================================
#  3. DVORAK — clavier en dvorak
# ============================================================
do_dvorak() {
  check_x || return 1
  local lay opt
  lay=$(setxkbmap -query 2>/dev/null | awk '/^layout:/{print $2}')
  opt=$(setxkbmap -query 2>/dev/null | awk '/^options:/{print $2}')
  state_set KB_LAYOUT "${lay:-fr}"; state_set KB_OPT "$opt"
  setxkbmap dvorak && ok "clavier DVORAK (avant : ${lay:-?})"
  log_on dvorak "layout ${lay:-?} -> dvorak"
}
undo_dvorak() {
  check_x || return 1
  local lay opt; lay=$(state_get KB_LAYOUT); opt=$(state_get KB_OPT); lay=${lay:-fr}
  setxkbmap "$lay"
  if [ -n "$opt" ]; then setxkbmap -option "$opt"; else setxkbmap -option; fi
  ok "clavier restauré ($lay)"; log_off dvorak
}

# ============================================================
#  vim : helpers clientserver
# ============================================================
vim_servers() { have vim || return 0; vim --serverlist 2>/dev/null; }
vim_send() { # $1 touches, $2 label
  local s n=0
  for s in $(vim_servers); do
    vim --servername "$s" --remote-send "$1" 2>/dev/null && { ok "vim[$s] : $2"; n=1; }
  done
  [ "$n" = 1 ]
}
vim_capture_schemes() {
  local s sch
  for s in $(vim_servers); do
    sch=$(vim --servername "$s" --remote-expr 'exists("g:colors_name") ? g:colors_name : ""' 2>/dev/null | tr -d '\r\n')
    [ -n "$sch" ] && state_set "VIMSCH_$(printf '%s' "$s" | tr -c 'A-Za-z0-9' '_')" "$sch"
  done
}
vim_scheme_for() { state_get "VIMSCH_$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }

# ============================================================
#  4. VIM-RED — tout le texte des vim ouverts en rouge
# ============================================================
do_vim_red() {
  [ -n "$(vim_servers)" ] || { die "aucun vim en mode clientserver (lancé avec --servername)"; return 1; }
  vim_capture_schemes
  vim_send ':hi Normal ctermfg=Red guifg=Red<CR>' "texte passé en rouge" || { die "échec envoi"; return 1; }
  log_on vim-red "groupe de surbrillance Normal -> rouge"
}
undo_vim_red() {
  local s sch sent=0
  for s in $(vim_servers); do
    sch=$(vim_scheme_for "$s")
    if [ -n "$sch" ]; then vim --servername "$s" --remote-send ":colorscheme $sch<CR>" 2>/dev/null && sent=1
    else vim --servername "$s" --remote-send ':hi clear<CR>' 2>/dev/null && sent=1; fi
  done
  [ "$sent" = 1 ] && { ok "vim restauré"; log_off vim-red; } || warn "aucun vim à restaurer"
}

# ============================================================
#  5. VIM-MIRROR — affichage de vim inversé (droite->gauche)
# ============================================================
do_vim_mirror() {
  [ -n "$(vim_servers)" ] || { die "aucun vim en mode clientserver"; return 1; }
  vim_send ':set rightleft<CR>' "code en miroir" || { die "échec envoi"; return 1; }
  log_on vim-mirror "rightleft activé"
}
undo_vim_mirror() {
  vim_send ':set norightleft<CR>' "miroir annulé" && log_off vim-mirror
}

# ============================================================
#  6. ROTATE — écran à l'envers
# ============================================================
do_rotate() {
  check_x || return 1
  local out; out=$(primary_output)
  [ -z "$out" ] && { die "aucun écran trouvé"; return 1; }
  state_set ROT_OUT "$out"; state_set ROT_PREV "$(current_rotation "$out")"
  xrandr --output "$out" --rotate inverted && ok "Écran retourné ($out)"
  log_on rotate "$out -> inverted"
}
undo_rotate() {
  have xrandr || return 0
  local out rot; out=$(state_get ROT_OUT); rot=$(state_get ROT_PREV)
  out=${out:-$(primary_output)}; rot=${rot:-normal}
  xrandr --output "$out" --rotate "$rot" && ok "Rotation restaurée ($rot)" && log_off rotate
}

# ============================================================
#  7. CURSOR-IMAGE — curseur souris remplacé par une image
#     (affecte les applications lancées APRÈS la blague)
# ============================================================
do_cursor_image() {
  local img="${1:-}"
  [ -z "$img" ] && { warn "usage : prank.sh cursor-image <image>"; return 1; }
  have convert || { die "ImageMagick (convert) requis"; return 1; }
  have xcursorgen || { die "xcursorgen requis (paquet xorg.xcursorgen / x11-apps)"; return 1; }
  [ -f "$img" ] || { die "image introuvable : $img"; return 1; }
  mkdir -p "$HOME/.icons/prankcursor/cursors"
  convert "$img" -resize 48x48! /tmp/prank_cursor.png || { die "conversion échouée"; return 1; }
  printf '48 2 2 /tmp/prank_cursor.png\n' > /tmp/prank_cursor.in
  xcursorgen /tmp/prank_cursor.in "$HOME/.icons/prankcursor/cursors/left_ptr" || { die "xcursorgen échoué"; return 1; }
  cp "$HOME/.icons/prankcursor/cursors/left_ptr" "$HOME/.icons/prankcursor/cursors/default"
  # sauvegarde xrdb + thème GTK par défaut
  [ -f "$XRDB_BAK" ] || { xrdb -query > "$XRDB_BAK" 2>/dev/null; state_set XRDB_SAVED 1; }
  printf 'Xcursor.theme: prankcursor\nXcursor.size: 48\n' | xrdb -merge
  if [ -f "$HOME/.icons/default/index.theme" ]; then
    cp "$HOME/.icons/default/index.theme" "$HOME/.icons/default/index.theme.prankbak"
    state_set CUR_THEME_BAK 1
  fi
  printf '[Icon Theme]\nName=PrankCursor\nInherits=prankcursor\n' > "$HOME/.icons/default/index.theme"
  ok "Curseur remplacé par l'image — visible dans les nouvelles applis"
  log_on cursor-image "thème curseur -> prankcursor (xrdb + index.theme)"
}
undo_cursor_image() {
  if [ "$(state_get XRDB_SAVED)" = "1" ] && [ -f "$XRDB_BAK" ]; then
    xrdb -load "$XRDB_BAK" 2>/dev/null; rm -f "$XRDB_BAK"; state_del XRDB_SAVED
  fi
  if [ "$(state_get CUR_THEME_BAK)" = "1" ] && [ -f "$HOME/.icons/default/index.theme.prankbak" ]; then
    mv "$HOME/.icons/default/index.theme.prankbak" "$HOME/.icons/default/index.theme"
  else
    grep -q prankcursor "$HOME/.icons/default/index.theme" 2>/dev/null && rm -f "$HOME/.icons/default/index.theme"
  fi
  rm -rf "$HOME/.icons/prankcursor"
  ok "Curseur restauré (applis déjà ouvertes : relancer)"; log_off cursor-image
}

# ============================================================
#  8. CURSOR-BIG — curseur immense
# ============================================================
do_cursor_big() {
  [ -f "$XRDB_BAK" ] || { xrdb -query > "$XRDB_BAK" 2>/dev/null; state_set XRDB_SAVED 1; }
  printf 'Xcursor.size: 96\n' | xrdb -merge
  ok "Curseur en taille 96 — visible dans les nouvelles applis (si le thème a de grandes tailles)"
  log_on cursor-big "Xcursor.size -> 96"
}
undo_cursor_big() {
  if [ "$(state_get XRDB_SAVED)" = "1" ] && [ -f "$XRDB_BAK" ]; then
    xrdb -load "$XRDB_BAK" 2>/dev/null; rm -f "$XRDB_BAK"; state_del XRDB_SAVED
  fi
  ok "Taille du curseur restaurée"; log_off cursor-big
}

# ============================================================
#  9. LOCK-SHOT — screenshot puis i3lock dessus (bloque : lancer en DERNIER)
# ============================================================
do_lock_shot() {
  check_x || return 1
  have i3lock || { die "i3lock absent"; return 1; }
  local shot=/tmp/.lockshot.png
  if   have maim;   then maim "$shot"
  elif have import; then import -window root "$shot"
  else die "il faut maim ou ImageMagick (import)"; return 1; fi
  ok "Bureau capturé, verrouillage..."
  log_on lock-shot "session verrouillée sur screenshot (se déverrouille au mot de passe)"
  i3lock -i "$shot"
}

# ============================================================
#  10. MOUSE-SLOW — souris au ralenti (échelle 15%)
# ============================================================
do_mouse_slow() {
  check_x || return 1
  local m; m=$(mouse_matrix); [ -n "$m" ] && state_set MOUSE_PREV_SLOW "$m"
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" 0.15 0 0 0 0.15 0 0 0 1 \
    && ok "Souris au ralenti (15%)"
  log_on mouse-slow "matrice pointeur -> échelle 0.15"
}
undo_mouse_slow() {
  check_x || return 1
  local m; m=$(state_get MOUSE_PREV_SLOW); m=${m:-1 0 0 0 1 0 0 0 1}
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" $m \
    && ok "Vitesse souris restaurée" && log_off mouse-slow
}

# ============================================================
#  11. MOUSE-INVERT — axes de la souris inversés (180°)
# ============================================================
do_mouse_invert() {
  check_x || return 1
  local m; m=$(mouse_matrix); [ -n "$m" ] && state_set MOUSE_PREV_INVERT "$m"
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" -1 0 1 0 -1 1 0 0 1 \
    && ok "Souris inversée (180°)"
  log_on mouse-invert "matrice pointeur -> inversion"
}
undo_mouse_invert() {
  check_x || return 1
  local m; m=$(state_get MOUSE_PREV_INVERT); m=${m:-1 0 0 0 1 0 0 0 1}
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" $m \
    && ok "Souris restaurée" && log_off mouse-invert
}

# ============================================================
#  12. OPACITY — toutes les fenêtres à 20% d'opacité (picom/compton requis)
# ============================================================
do_opacity() {
  have xprop || { die "xprop requis"; return 1; }
  have xwininfo || { die "xwininfo requis"; return 1; }
  pgrep -x picom >/dev/null 2>&1 || pgrep -x compton >/dev/null 2>&1 \
    || warn "aucun compositeur détecté (picom/compton) : l'effet peut rester invisible"
  local val ids id
  val=$(printf '0x%08x' $(( 4294967295 * 20 / 100 )))
  ids=$(xwininfo -root -children 2>/dev/null | awk '$1 ~ /^0x[0-9a-fA-F]+$/ {print $1}')
  [ -z "$ids" ] && { die "aucune fenêtre trouvée"; return 1; }
  for id in $ids; do
    xprop -id "$id" -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY "$val" 2>/dev/null
  done
  ok "Fenêtres à 20% d'opacité"
  log_on opacity "_NET_WM_WINDOW_OPACITY -> 20% sur toutes les fenêtres"
}
undo_opacity() {
  local ids id
  ids=$(xwininfo -root -children 2>/dev/null | awk '$1 ~ /^0x[0-9a-fA-F]+$/ {print $1}')
  for id in $ids; do
    xprop -id "$id" -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY 0xffffffff 2>/dev/null
  done
  ok "Opacité restaurée"; log_off opacity
}

# ============================================================
#  13. SHUTUP — `shutdown` répond "shutup" (sudo reste intact)
# ============================================================
do_shutup() {
  rc_writable || return 1
  local rc; rc=$(detect_rc)
  mkdir -p "$HOME/.prankbin"
  cat > "$HOME/.prankbin/shutdown" <<'EOF'
#!/bin/sh
echo "shutup 😏   (verrouille ta session la prochaine fois)"
EOF
  chmod +x "$HOME/.prankbin/shutdown"
  grep -q 'PRANK-PATH-SHUT' "$rc" || printf '\nPATH="$HOME/.prankbin:$PATH"  # PRANK-PATH-SHUT\n' >> "$rc"
  ok "shutdown -> shutup — nouveau terminal pour armer (sudo shutdown reste fonctionnel)"
  log_on shutup "fake shutdown en tête de PATH"
}
undo_shutup() {
  local rc; rc=$(detect_rc)
  rm -f "$HOME/.prankbin/shutdown"
  sed -i '/PRANK-PATH-SHUT/d' "$rc" 2>/dev/null
  rmdir "$HOME/.prankbin" 2>/dev/null
  ok "shutdown restauré (shells ouverts : hash -r)"; log_off shutup
}

# ============================================================
#  14. VIM-LIGHT — vim en thème clair
# ============================================================
do_vim_light() {
  [ -n "$(vim_servers)" ] || { die "aucun vim en mode clientserver"; return 1; }
  vim_capture_schemes
  vim_send ':set background=light<CR>' "background=light" || { die "échec envoi"; return 1; }
  vim_send ':colorscheme morning<CR>' "thème clair (morning)"
  log_on vim-light "background=light + colorscheme morning"
}
undo_vim_light() {
  local s sch sent=0
  for s in $(vim_servers); do
    sch=$(vim_scheme_for "$s")
    if [ -n "$sch" ]; then vim --servername "$s" --remote-send ":colorscheme $sch<CR>" 2>/dev/null && sent=1
    else vim --servername "$s" --remote-send ':set background=dark<CR>' 2>/dev/null && sent=1; fi
  done
  [ "$sent" = 1 ] && { ok "vim restauré"; log_off vim-light; } || warn "aucun vim à restaurer"
}

# ============================================================
#  15. ONEKO — le chat qui poursuit le curseur
# ============================================================
do_oneko() {
  have oneko || { die "oneko absent (NixOS : nix-shell -p oneko)"; return 1; }
  pkill oneko 2>/dev/null
  nohup oneko >/dev/null 2>&1 &
  ok "Un chat poursuit le curseur 🐱"; log_on oneko "oneko lancé"
}
undo_oneko() { pkill oneko 2>/dev/null; ok "Chat expulsé"; log_off oneko; }

# ============================================================
#  16. TERMINAL-SHUTDOWN — faux arrêt à l'ouverture d'un terminal
#      SAFE : compte à rebours de 5s puis révélation. Jamais de vrai
#      shutdown : ça détruirait du travail non sauvegardé (interdit) et
#      ce serait irréversible. Premier terminal seulement.
# ============================================================
do_terminal_shutdown() {
  rc_writable || return 1
  local rc; rc=$(detect_rc)
  grep -q 'BEGIN PRANK-TERM-SHUT' "$rc" && { warn "déjà installé"; return 0; }
  cat >> "$rc" <<'EOF'

# --- BEGIN PRANK-TERM-SHUT --- (faux arrêt au 1er terminal ; supprimer ce bloc pour annuler)
if [ -t 1 ] && [ "${-#*i}" != "$-" ]; then
  if [ ! -f "$HOME/.cache/prank_term_seen" ]; then
    printf '\n\033[1;31m  *** ARRÊT DU SYSTÈME DANS 5 SECONDES ***\033[0m\n\n'
    for i in 5 4 3 2 1; do printf '\a   arrêt dans %s...\n' "$i"; sleep 1; done
    printf '\n\033[1;32m  ✋ Faux arrêt ! Tradition : VERROUILLE TA SESSION.\033[0m\n\n'
    mkdir -p "$HOME/.cache"
    touch "$HOME/.cache/prank_term_seen"
  fi
fi
# --- END PRANK-TERM-SHUT ---
EOF
  ok "Piège terminal armé — le PREMIER nouveau terminal fera le faux compte à rebours"
  log_on terminal-shutdown "faux shutdown (5s puis révélation) au 1er terminal"
}
undo_terminal_shutdown() {
  local rc; rc=$(detect_rc)
  sed -i '/^# --- BEGIN PRANK-TERM-SHUT ---$/,/^# --- END PRANK-TERM-SHUT ---$/d' "$rc" 2>/dev/null
  rm -f "$HOME/.cache/prank_term_seen"
  ok "Piège terminal retiré"; log_off terminal-shutdown
}

# ============================================================
#  OUTIL — ouvrir un terminal piégé dans la session cible
# ============================================================
do_new_terminal() {
  local t="${TERMINAL:-}"
  [ -z "$t" ] && for c in i3-sensible-terminal alacritty kitty st urxvt xterm; do
    have "$c" && { t="$c"; break; }
  done
  [ -z "$t" ] && { die "aucun émulateur de terminal trouvé"; return 1; }
  if have i3-msg; then i3-msg exec "$t" >/dev/null; else "$t" & fi
  ok "Nouveau terminal ouvert ($t) — hérite du rc piégé"
}

# ============================================================
#  DISPATCH / LISTE / MENU
# ============================================================
NAMES=(swap-commands swap-apps dvorak vim-red vim-mirror rotate cursor-image
       cursor-big lock-shot mouse-slow mouse-invert opacity shutup vim-light
       oneko terminal-shutdown new-terminal)

name_for_num() {
  local n=$((10#$1))
  [ "$n" -ge 1 ] && [ "$n" -le ${#NAMES[@]} ] && printf '%s\n' "${NAMES[$((n-1))]}"
}

list() {
  say "${B}Blagues :${N}"
  say "   1  swap-commands     1  intervertit les commandes (ls<->cd, cat<->tac)      [fichier rc]"
  say "   2  swap-apps         2  intervertit les logiciels (vim<->firefox, ...)      [fichier rc + PATH]"
  say "   3  dvorak            3  clavier en DVORAK"
  say "   4  vim-red           4  texte vim en rouge (vim ouverts)"
  say "   5  vim-mirror        5  affichage vim inversé (vim ouverts)"
  say "   6  rotate            6  écran retourné"
  say "   7  cursor-image      7  curseur = image donnée en argument (arg requis)"
  say "   8  cursor-big        8  curseur immense"
  say "   9  lock-shot         9  screenshot puis i3lock dessus (BLOQUE : en dernier)"
  say "  10  mouse-slow       10  souris au ralenti"
  say "  11  mouse-invert     11  axes souris inversés"
  say "  12  opacity          12  fenêtres à 20% d'opacité (picom requis)"
  say "  13  shutup           13  shutdown répond 'shutup' (sudo intact)              [fichier rc]"
  say "  14  vim-light        14  vim en thème clair"
  say "  15  oneko            14  le chat qui poursuit le curseur"
  say "  16  terminal-shutdown 15 FAUX shutdown au 1er terminal (safe, 5s)          [fichier rc]"
  say "  17  new-terminal     outil : ouvre un terminal (arme les pièges rc)"
}

run_name() {
  local f
  if [ "$2" = undo ]; then f="undo_${1//-/_}"; else f="do_${1//-/_}"; fi
  declare -F "$f" >/dev/null || { warn "blague inconnue : $1"; return 1; }
  "$f" "${3:-}"
}

menu() {
  local c m name img
  while true; do
    echo; list
    printf '%s' "choix [1-17 / u=N annuler une blague / U=undo-all / q=quitter] : "
    read -r c || break
    case "$c" in
      q|Q) break ;;
      U)   undo_all; continue ;;
      "")  continue ;;
    esac
    if [ "${c%% *}" = "u" ]; then
      run_name "${c#u }" undo; continue
    fi
    name=$(name_for_num "$c") || { warn "choix invalide"; continue; }
    printf '%s' "[$name] appliquer(p) / annuler(u) / retour(b) : "
    read -r m || continue
    case "$m" in
      p) if [ "$name" = cursor-image ]; then
           printf '%s' "image (chemin) : "; read -r img
           run_name "$name" apply "$img"
         else
           run_name "$name" apply
         fi ;;
      u) run_name "$name" undo ;;
    esac
  done
}

undo_all() {
  local n
  for n in terminal-shutdown vim-light oneko shutup opacity mouse-invert mouse-slow \
           cursor-big cursor-image rotate vim-mirror vim-red dvorak swap-apps swap-commands; do
    run_name "$n" undo >/dev/null 2>&1 || true
  done
  say "Reset complet (sauf lock-shot : se déverrouille au mot de passe de la victime)."
}

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,2\}//'; }

main() {
  [ "$(id -u)" = 0 ] && { warn "Interdit en root."; exit 1; }
  local cmd="${1:-menu}"
  case "$cmd" in
    menu)     menu ;;
    list)     list ;;
    undo-all) undo_all ;;
    undo)     [ $# -ge 2 ] || { warn "usage : prank.sh undo <blague>"; exit 1; }; run_name "$2" undo ;;
    help|-h|--help) usage ;;
    *)        run_name "$cmd" apply "${2:-}" ;;
  esac
}

main "$@"
