#!/usr/bin/env bash
# ============================================================
#  prank.sh — blagues de session i3 « tradition de l'école »
#
#  Règles de la tradition :
#   - ne JAMAIS toucher au code / travail / git / clés SSH
#   - tout doit être annulable en quelques secondes
#   - assumer son coup (le but est la leçon, pas la casse)
#
#  Usage :
#   ./prank.sh                menu interactif
#   ./prank.sh list           liste les blagues
#   ./prank.sh <prank>        déclenche une blague    ex: ./prank.sh rotate
#   ./prank.sh undo <prank>   annule une blague        ex: ./prank.sh undo rotate
#   ./prank.sh wallpaper <img|URL>   (blague nécessitant un argument)
#   ./prank.sh all            toutes les blagues de session "sures"
#   ./prank.sh undo-all       annule tout ce qui est traqué
# ============================================================

set -u

# ---------- couleurs / helpers ----------
G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; B='\033[1;34m'; N='\033[0m'
say()  { printf "%b\n" "$*"; }
ok()   { say "${G}[ok]${N} $*"; }
warn() { say "${Y}[!]${N}  $*"; }
die()  { say "${R}[x]${N}  $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
STATE="$STATE_DIR/prank_state.env"
I3CFG="$HOME/.config/i3/config"

# ---------- état (pour les undo qui ont besoin de mémoire) ----------
state_set() { mkdir -p "$STATE_DIR"; touch "$STATE"
  grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null
  printf '%s=%s\n' "$1" "$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
state_get() { [ -f "$STATE" ] && grep -m1 "^$1=" "$STATE" | cut -d= -f2-; }

detect_rc() { case "${SHELL:-/bin/bash}" in *zsh*) echo "$HOME/.zshrc";; *) echo "$HOME/.bashrc";; esac; }

check_x() {
  [ -n "${WAYLAND_DISPLAY:-}" ] && { warn "Session Wayland détectée : xrandr/xinput/setxkbmap/i3lock ne marcheront pas."; return 1; }
  [ -z "${DISPLAY:-}" ] && { warn "Pas de DISPLAY : lance-moi DANS la session graphique de la victime."; return 1; }
  return 0
}

primary_output() { xrandr --query 2>/dev/null | grep -m1 -w connected | cut -d' ' -f1; }

# rotation actuelle d'un output (vide => normal)
current_rotation() {
  local line pre
  line=$(xrandr --query 2>/dev/null | awk -v o="$1" '$1==o && $2 ~ /^connected/' | head -n1)
  pre=${line%% (normal*}   # retire le groupe "(normal left inverted right)" toujours présent
  printf '%s\n' "$pre" | awk '{for(i=1;i<=NF;i++) if($i=="left"||$i=="right"||$i=="inverted"||$i=="normal") print $i}'
}

mouse_matrix() {
  xinput list-props "Virtual core pointer" 2>/dev/null \
    | awk '/Coordinate Transformation Matrix/ {gsub(/,/,""); print $5,$6,$7,$8,$9,$10,$11,$12,$13}'
}

i3_reload() { have i3-msg && i3-msg reload >/dev/null 2>&1 && ok "config i3 rechargée"; }

# ============================================================
#  BLAGUES
# ============================================================

# ---------- 1. verrouillage (à lancer en DERNIER, ça bloque le terminal) ----------
do_lock_shot() {
  check_x || return 1
  have i3lock || { die "i3lock absent"; return 1; }
  local shot=/tmp/.lockshot.png
  if   have maim;   then maim "$shot"
  elif have import; then import -window root "$shot"
  else die "il faut maim ou ImageMagick (import)"; return 1; fi
  ok "Bureau capturé, verrouillage..."
  i3lock -i "$shot"
}
do_lock_black() { check_x || return 1; have i3lock || { die "i3lock absent"; return 1; }; i3lock -c 000000; }

# ---------- 2. rotation écran ----------
do_rotate() {
  check_x || return 1
  local out; out=$(primary_output)
  [ -z "$out" ] && { die "aucun écran trouvé"; return 1; }
  state_set ROT_OUT "$out"; state_set ROT_PREV "$(current_rotation "$out")"
  xrandr --output "$out" --rotate inverted && ok "Écran à l'envers ($out)"
}
undo_rotate() {
  have xrandr || return 1
  local out rot
  out=$(state_get ROT_OUT); rot=$(state_get ROT_PREV)
  out=${out:-$(primary_output)}; [ -z "$rot" ] && rot=normal; rot=${rot:-normal}
  xrandr --output "$out" --rotate "$rot" && ok "Rotation restaurée ($rot)"
}

# ---------- 3. souris ----------
do_mouse_invert() {
  check_x || return 1
  local m; m=$(mouse_matrix); [ -n "$m" ] && state_set MOUSE_PREV "$m"
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" -1 0 1 0 -1 1 0 0 1 \
    && ok "Axe souris inversé (180°)"
}
undo_mouse_invert() {
  check_x || return 1
  local m; m=$(state_get MOUSE_PREV); m=${m:-1 0 0 0 1 0 0 0 1}
  xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" $m && ok "Souris restaurée"
}
do_mouse_slow()   { check_x || return 1; xset m 1/10 4 && ok "Souris au ralenti"; }
undo_mouse_slow() { check_x || return 1; xset m default && ok "Vitesse souris restaurée"; }

# ---------- 4. le chat ----------
do_cat() {
  have oneko || { die "oneko absent (NixOS : nix-shell -p oneko)"; return 1; }
  pkill oneko 2>/dev/null
  nohup oneko >/dev/null 2>&1 &
  ok "Un chat poursuit désormais le curseur 🐱"
}
undo_cat() { pkill oneko 2>/dev/null; ok "Chat expulsé (s'il y en avait un)"; }

# ---------- 5. clavier ----------
do_keyboard() {
  check_x || return 1
  local lay opt
  lay=$(setxkbmap -query 2>/dev/null | awk '/^layout:/{print $2}')
  opt=$(setxkbmap -query 2>/dev/null | awk '/^options:/{print $2}')
  state_set KB_LAYOUT "${lay:-us}"; state_set KB_OPT "${opt:-}"
  setxkbmap us && ok "Clavier passé en US (avant : ${lay:-?})"
}
undo_keyboard() {
  check_x || return 1
  local lay opt; lay=$(state_get KB_LAYOUT); opt=$(state_get KB_OPT); lay=${lay:-fr}
  setxkbmap "$lay"
  if [ -n "$opt" ]; then setxkbmap -option "$opt"; else setxkbmap -option; fi
  ok "Clavier restauré ($lay)"
}

# ---------- 6. son / notifications ----------
do_audio_mute()   { have pactl || { die "pactl absent"; return 1; }; pactl set-sink-mute @DEFAULT_SINK@ 1 && ok "Son coupé"; }
undo_audio_mute() { have pactl && pactl set-sink-mute @DEFAULT_SINK@ 0; ok "Son remis"; return 0; }
do_notify() {
  have notify-send || { die "notify-send absent"; return 1; }
  notify-send -u critical -i battery-low "Batterie critique" "2% restants. Verrouille ta session la prochaine fois."
  ok "Fausse notification envoyée"
}

# ---------- 7. wallpaper ----------
do_wallpaper() {
  local img="${1:-}"
  [ -z "$img" ] && { warn "usage : prank.sh wallpaper <image | URL>"; return 1; }
  have feh || { die "feh absent"; return 1; }
  if [ -f "$HOME/.fehbg" ]; then state_set FEHBG 1; else state_set FEHBG 0; fi
  if [[ "$img" == http* ]]; then
    curl -fsLo /tmp/.prank_wall.png "$img" || { die "téléchargement échoué"; return 1; }
    img=/tmp/.prank_wall.png
  fi
  [ -f "$img" ] || { die "image introuvable : $img"; return 1; }
  feh --bg-scale "$img" && ok "Wallpaper changé"
}
undo_wallpaper() {
  if [ "$(state_get FEHBG)" = "1" ] && [ -f "$HOME/.fehbg" ]; then
    sh "$HOME/.fehbg" && ok "Wallpaper d'origine restauré (~/.fehbg)"
  elif have nitrogen && nitrogen --restore 2>/dev/null; then
    ok "Wallpaper restauré (nitrogen)"
  else
    warn "wallpaper d'origine inconnu — à restaurer à la main"
  fi
}

# ---------- 8. config i3 (ignorée si lecture seule, ex. symlink /nix/store) ----------
do_i3_mod() {
  [ -w "$I3CFG" ] || { die "$I3CFG absent ou en lecture seule (NixOS ?)"; return 1; }
  grep -q '^set \$mod Mod4' "$I3CFG" || { die 'aucune ligne "set $mod Mod4" trouvée'; return 1; }
  sed -i 's/^set \$mod Mod4$/set $mod Mod3   # PRANK-MOD/' "$I3CFG" && i3_reload && ok '$mod déplacé sur Mod3 (Alt)'
}
undo_i3_mod() {
  grep -q 'PRANK-MOD' "$I3CFG" 2>/dev/null || { warn "rien à annuler"; return 1; }
  sed -i 's/^set \$mod Mod3.*/set $mod Mod4/' "$I3CFG" && i3_reload && ok '$mod revenu sur Mod4'
}
do_i3_float() {
  [ -w "$I3CFG" ] || { die "$I3CFG absent ou en lecture seule (NixOS ?)"; return 1; }
  grep -q 'PRANK-FLOAT' "$I3CFG" && { warn "déjà installé"; return 0; }
  printf 'for_window [class=".*"] floating enable  # PRANK-FLOAT\n' >> "$I3CFG" \
    && i3_reload && ok "Toutes les fenêtres s'ouvriront en flottant"
}
undo_i3_float() {
  grep -q 'PRANK-FLOAT' "$I3CFG" 2>/dev/null || { warn "rien à annuler"; return 1; }
  sed -i '/PRANK-FLOAT/d' "$I3CFG" && i3_reload && ok "Tiling restauré"
}

# ---------- 9. bashrc : swap ls/cd ----------
do_bash_swap() {
  local rc; rc=$(detect_rc)
  [ -w "$rc" ] || { die "$rc non inscriptible"; return 1; }
  grep -q '^# --- BEGIN PRANK ---' "$rc" && { warn "déjà installé dans $rc"; return 0; }
  cat >> "$rc" <<'EOF'

# --- BEGIN PRANK --- (supprimer ce bloc pour annuler)
ls() { builtin cd "$@"; }        # ls te téléporte (ls .. -> dossier parent)
cd() { command ls "${1:-.}"; }   # cd liste seulement, ne bouge pas
# --- END PRANK ---
EOF
  ok "Installé dans $rc — ouvrir un NOUVEAU terminal pour armer"
}
undo_bash_swap() {
  local rc; rc=$(detect_rc)
  sed -i '/^# --- BEGIN PRANK ---$/,/^# --- END PRANK ---$/d' "$rc" \
    && ok "Bloc retiré de $rc (shells ouverts : lancer 'unset -f ls cd')"
}

# ---------- 10. bashrc : renommages ----------
do_bash_renames() {
  local rc; rc=$(detect_rc)
  [ -w "$rc" ] || { die "$rc non inscriptible"; return 1; }
  grep -q '^# --- BEGIN PRANK-RENAME ---' "$rc" && { warn "déjà installé"; return 0; }
  cat >> "$rc" <<'EOF'

# --- BEGIN PRANK-RENAME --- (supprimer ce bloc pour annuler)
vim()  { command nano "$@"; }
nano() { command vim "$@"; }
date() { echo "Il est l'heure de verrouiller ta session."; }
whoami() { echo "pas toi"; }
pwd()  { echo "/media/usb/disque_corrompu"; }
alias clear='echo "Déjà net, désolé."'
alias exit='echo "Il y a un piège..."'
# --- END PRANK-RENAME ---
EOF
  ok "Renommages installés dans $rc — nouveau terminal pour armer"
}
undo_bash_renames() {
  local rc; rc=$(detect_rc)
  sed -i '/^# --- BEGIN PRANK-RENAME ---$/,/^# --- END PRANK-RENAME ---$/d' "$rc" \
    && ok "Renommages retirés de $rc"
}

# ---------- 11. faux binaire dans PATH ----------
do_path_fake() {
  mkdir -p "$HOME/.prankbin"
  cat > "$HOME/.prankbin/ls" <<'EOF'
#!/bin/sh
echo "ls a été promu. Il fait désormais le café."
echo "(astuce : /usr/bin/ls fonctionne encore)"
EOF
  chmod +x "$HOME/.prankbin/ls"
  local rc; rc=$(detect_rc)
  grep -q 'PRANK-PATH' "$rc" || printf '\nPATH="$HOME/.prankbin:$PATH"  # PRANK-PATH\n' >> "$rc"
  ok "Faux bin installé — nouveau terminal pour armer"
}
undo_path_fake() {
  local rc; rc=$(detect_rc)
  sed -i '/PRANK-PATH/d' "$rc"
  rm -rf "$HOME/.prankbin"
  ok "Faux bin retiré (shells ouverts : lancer 'hash -r')"
}

# ---------- 12. vim en cours d'exécution (si +clientserver) ----------
do_vim_rl() {
  have vim || { die "vim absent"; return 1; }
  local servers; servers=$(vim --serverlist 2>/dev/null)
  [ -z "$servers" ] && { die "aucun serveur vim (il faut vim lancé avec --servername)"; return 1; }
  local s
  for s in $servers; do
    vim --servername "$s" --remote-send ':set rightleft<CR>' 2>/dev/null \
      && ok "vim '$s' : rightleft activé (code en miroir)"
  done
}
undo_vim_rl() {
  local servers; servers=$(vim --serverlist 2>/dev/null)
  local s
  for s in $servers; do
    vim --servername "$s" --remote-send ':set norightleft<CR>' 2>/dev/null \
      && ok "vim '$s' : rightleft annulé"
  done
}

# ---------- 13. ouvrir un terminal piégé ----------
do_new_terminal() {
  local t="${TERMINAL:-}"
  [ -z "$t" ] && for c in i3-sensible-terminal alacritty kitty st urxvt xterm; do
    have "$c" && { t="$c"; break; }
  done
  [ -z "$t" ] && { die "aucun émulateur de terminal trouvé"; return 1; }
  if have i3-msg; then i3-msg exec "$t" >/dev/null; else "$t" & fi
  ok "Nouveau terminal ouvert ($t) — il hérite du bashrc piégé"
}

# ============================================================
#  MODES GLOBAUX
# ============================================================
run_all() {
  say "${B}=== Toutes les blagues de session « sûres » ===${N}"
  do_rotate; do_mouse_invert; do_mouse_slow; do_cat; do_keyboard
  do_audio_mute; do_notify
  say "${B}=== fini. Les locks et les modifs de fichiers sont séparés. ===${N}"
}
undo_all() {
  undo_rotate; undo_mouse_invert; undo_mouse_slow; undo_cat
  undo_keyboard; undo_audio_mute
  say "NB : les blagues fichier (bash-*, path-fake, i3-*) s'annulent individuellement."
}

# ============================================================
#  LISTE / MENU / DISPATCH
# ============================================================
NAMES=(lock-shot lock-black rotate mouse-invert mouse-slow cat keyboard
       audio-mute notify wallpaper i3-mod i3-floating bash-swap
       bash-renames path-fake vim-rightleft new-terminal)

name_for_num() {
  local n=$((10#$1))
  [ "$n" -ge 1 ] && [ "$n" -le ${#NAMES[@]} ] && printf '%s\n' "${NAMES[$((n-1))]}"
}

list() {
  say "${B}Blagues disponibles :${N}"
  say "   1  lock-shot     capture le bureau + i3lock dessus (bloque : lancer en DERNIER)"
  say "   2  lock-black    i3lock écran noir « crash » (bloque : lancer en DERNIER)"
  say "   3  rotate        écran à l'envers"
  say "   4  mouse-invert  axes souris inversés"
  say "   5  mouse-slow    souris au ralenti"
  say "   6  cat           un chat poursuit le curseur"
  say "   7  keyboard      clavier US"
  say "   8  audio-mute    son coupé"
  say "   9  notify        fausse notification batterie"
  say "  10  wallpaper     changement de fond d'écran (argument : image ou URL)"
  say "  11  i3-mod        \$mod -> Mod3 (raccourcis morts) [fichier config]"
  say "  12  i3-floating   toutes fenêtres flottantes [fichier config]"
  say "  13  bash-swap     ls <-> cd dans bashrc [fichier]"
  say "  14  bash-renames  vim/nano, date, whoami, pwd... [fichier]"
  say "  15  path-fake     faux 'ls' en tête de PATH [fichier]"
  say "  16  vim-rightleft vim ouvert : mode miroir (si +clientserver)"
  say "  17  new-terminal  ouvre un terminal (hérite du bashrc piégé)"
  say "  --- 'all' = 3,4,5,6,7,8,9 ---"
}

menu() {
  local c m name img
  while true; do
    echo; list
    printf '%s' "choix [1-17 / a=all / A=undo-all / q=quitter] : "
    read -r c || break
    case "$c" in
      q|Q) break ;;
      a)   run_all; continue ;;
      A)   undo_all; continue ;;
      "")  continue ;;
    esac
    name=$(name_for_num "$c") || { warn "choix invalide"; continue; }
    printf '%s' "[$name] appliquer(p) / annuler(u) / retour(b) : "
    read -r m || continue
    case "$m" in
      p) if [ "$name" = wallpaper ]; then
           printf '%s' "image (chemin ou URL) : "; read -r img
           run_name "$name" apply "$img"
         else
           run_name "$name" apply
         fi ;;
      u) run_name "$name" undo ;;
    esac
  done
}

run_name() {   # $1=nom  $2=apply|undo  $3=argument optionnel (wallpaper)
  local f
  if [ "$2" = undo ]; then f="undo_${1//-/_}"; else f="do_${1//-/_}"; fi
  declare -F "$f" >/dev/null || { warn "blague inconnue : $1"; return 1; }
  "$f" "${3:-}"
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,2\}//'
}

main() {
  [ "$(id -u)" = 0 ] && { warn "Interdit en root. Les blagues appartiennent à la session utilisateur."; exit 1; }
  local cmd="${1:-menu}"
  case "$cmd" in
    menu)     menu ;;
    list)     list ;;
    all)      run_all ;;
    undo-all) undo_all ;;
    undo)     [ $# -ge 2 ] || { warn "usage : prank.sh undo <prank>"; exit 1; }; run_name "$2" undo ;;
    help|-h|--help) usage ;;
    *)        run_name "$cmd" apply "${2:-}" ;;
  esac
}

main "$@"
