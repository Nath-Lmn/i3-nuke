# Linux Session Pranks — Command Reference

Harmless pranks for colleagues who forgot to lock their i3 session.
Golden rules: never touch their code/work, everything must be reversible in seconds, always own up to it.

## Contents
1. [Session Locking](#1-session-locking)
2. [Display Tricks](#2-display-tricks)
3. [Mouse Tricks](#3-mouse-tricks)
4. [Keyboard Tricks](#4-keyboard-tricks)
5. [i3 Window Manager](#5-i3-window-manager)
6. [Audio & Notifications](#6-audio--notifications)
7. [Desktop Visuals](#7-desktop-visuals)
8. [Vim Pranks (visual only)](#8-vim-pranks)
9. [Bash Command Hijacking](#9-bash-command-hijacking)
10. [PATH Hijacking](#10-path-hijacking)
11. [Deployment](#11-deployment)
12. [Forensics & Undo](#12-forensics--undo)

---

## 1. Session Locking

| Command | Description |
|---|---|
| `maim /tmp/bureau.png` | Take a full-screen screenshot |
| `import -window root /tmp/bureau.png` | Same thing, using ImageMagick instead |
| `i3lock -i /tmp/bureau.png` | Lock the session using the screenshot as background — screen looks normal but is frozen |
| `i3lock -c 000000` | Lock the screen with solid black — victim thinks the machine crashed |

## 2. Display Tricks

| Command | Description |
|---|---|
| `xrandr --query \| grep connected` | List connected displays and find their names (e.g. `eDP-1`) |
| `xrandr --output eDP-1 --rotate inverted` | Flip the screen upside down |
| `xrandr --output eDP-1 --rotate normal` | Undo the rotation |
| `xrandr --output eDP-1 --scale 2x2` | Shrink everything to half size (tiny UI) |

## 3. Mouse Tricks

| Command | Description |
|---|---|
| `xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" -1 0 1 0 -1 1 0 0 1` | Invert both mouse axes (180° flip) |
| `xinput set-prop "Virtual core pointer" "Coordinate Transformation Matrix" 1 0 0 0 1 0 0 0 1` | Identity matrix — resets the mouse to normal |
| `xset m 1/10 4` | Set mouse acceleration to crawl-slow |
| `xset m default` | Restore default mouse acceleration |
| `oneko &` | Spawn a cat that permanently chases the cursor 🐱 |
| `pkill oneko` | Remove the cat |

## 4. Keyboard Tricks

| Command | Description |
|---|---|
| `setxkbmap -query` | Show current keyboard layout and options (check before changing!) |
| `setxkbmap us` | Switch AZERTY → QWERTY ("why does q type a?!") |
| `setxkbmap dvorak` | Hardcore layout switch |
| `setxkbmap fr` | Restore French layout (undo) |
| `setxkbmap -option caps:backspace` | Remap Caps Lock to Backspace |
| `setxkbmap -option` | Clear all keyboard options (undo) |

## 5. i3 Window Manager

Edits go in `~/.config/i3/config`, then apply with:

| Command / Directive | Description |
|---|---|
| `i3-msg reload` | Reload the i3 config in a live session |
| `set $mod Mod3` (replace `Mod4`) | Change the modifier key — all shortcuts appear dead |
| `for_window [class=".*"] floating enable` | Force every window to open floating instead of tiled |
| `gaps inner 60` | Add huge gaps between windows |
| `bindsym $mod+Escape exec i3lock` | The friendly reminder: a lock keybinding the victim should have had |

⚠️ On NixOS/home-manager, the config is often a read-only symlink into `/nix/store` — edits won't work.

## 6. Audio & Notifications

| Command | Description |
|---|---|
| `pactl set-sink-mute @DEFAULT_SINK@ 1` | Mute the default audio output |
| `pactl set-sink-mute @DEFAULT_SINK@ 0` | Unmute (undo) |
| `notify-send -u critical -i battery-low "Battery critical" "2% remaining"` | Send a fake urgent desktop notification |

## 7. Desktop Visuals

| Command | Description |
|---|---|
| `curl -o /tmp/meme.png https://example.com/meme.png` | Download an image for the wallpaper |
| `feh --bg-scale /tmp/meme.png` | Set the desktop wallpaper |
| `xdg-open https://www.youtube.com/watch?v=dQw4w9WgXcQ` | Open a URL in the browser (timeless classic) |
| `i3-msg exec cmatrix` | Launch the Matrix rain in a terminal |

## 8. Vim Pranks

All purely visual — nothing touches the buffer or the file on save.

| Ex command | Description |
|---|---|
| `:set rightleft` | Display the buffer right-to-left (mirror mode) |
| `:set norightleft` | Undo |
| `:set foldmethod=indent` then `zM` | Fold everything — "where did my code go?" |
| `zR` then `:set foldmethod=manual` | Unfold and restore (undo) |
| `:set background=light` | Turn their dark theme into a flashbang |
| `:set spell` | Red squiggly underlines everywhere |
| `:set nospell` | Undo |

⚠️ Never use `autocmd BufWritePre` tricks that rewrite text on save — that touches the code.

## 9. Bash Command Hijacking

Resolution order in bash: **alias → function → builtin → hash cache → PATH**.
`cd`, `exit`, `pwd` are builtins — only aliases/functions can override them.

**The classic swap (loop-proof):**

```bash
# --- BEGIN PRANK (in ~/.bashrc or ~/.zshrc) ---
ls() { builtin cd "$@"; }        # ls teleports you: ls -> home, ls .. -> parent dir
cd() { command ls "${1:-.}"; }   # cd just lists the target dir, never moves
# --- END PRANK ---
```

| Construct | Description |
|---|---|
| `builtin cd "$@"` | Call the *real* `cd` builtin, bypassing our fake function (prevents infinite recursion) |
| `command ls "$@"` | Call the *real* `ls`, bypassing aliases and functions |
| `"${1:-.}"` | Use first argument, default to current dir if empty |

**The teleport variant:**

```bash
ls() { command ls "$@"; builtin cd; }   # shows a correct listing... then silently goes home
```

**Other fun renames:**

| Snippet | Description |
|---|---|
| `vim() { command nano "$@"; }` | Swap vim for nano |
| `nano() { command vim "$@"; }` | The other half of the swap |
| `date() { echo "Time to lock your session."; }` | On-theme `date` |
| `whoami() { echo "not you"; }` | Existential crisis |
| `pwd() { echo "/media/usb/corrupted_disk"; }` | Fake current directory |
| `alias clear='echo "Already clean, sorry."'` | `clear` refuses to work |
| `alias exit='echo "There is a trap..."'` | `exit` refuses to work |

⚠️ Avoid pure-alias swaps (`alias ls='cd'` + `alias cd='ls'`) — bash's anti-recursion makes the result unpredictable. Functions are deterministic.

⚠️ Functions aren't exported to child processes: their scripts and Makefiles keep working.

## 10. PATH Hijacking

Works for external binaries only (not builtins, killed by `sudo`'s secure_path).

```bash
mkdir -p ~/.prankbin                       # create a fake bin dir
cat > ~/.prankbin/ls <<'EOF'               # write a fake command
#!/bin/sh
echo "ls has been promoted. It serves coffee now."
EOF
chmod +x ~/.prankbin/ls                    # make it executable
echo 'PATH="$HOME/.prankbin:$PATH"' >> ~/.bashrc   # inject it at the front of PATH
```

| Command | Description |
|---|---|
| `mkdir -p ~/.prankbin` | Create the fake binary directory |
| `cat > file <<'EOF' ... EOF` | Heredoc: write a script to a file |
| `chmod +x file` | Make the fake command executable |
| `echo 'PATH=...' >> ~/.bashrc` | Prepend the fake dir to PATH for new shells |
| `hash -r` | Clear bash's command cache so an already-running shell picks up PATH changes |

## 11. Deployment

| Command | Description |
|---|---|
| `echo $SHELL` | Check the victim's shell (`/bin/bash` → `~/.bashrc`, zsh → `~/.zshrc`) |
| `cp ~/.bashrc ~/.bashrc.prank.bak` | Backup before editing — undo in 2 seconds |
| `ls -l ~/.bashrc` | Check if it's a symlink into `/nix/store` (read-only → prank blocked, pick another) |
| `i3-msg exec i3-sensible-terminal` | Open a new terminal in their session — it inherits the poisoned config |

Note: config edits only arm **new** shells. Already-open terminals stay clean.

## 12. Forensics & Undo

**How the victim discovers everything:**

| Command | Description |
|---|---|
| `type -a ls` | Show ALL resolution levels: alias, function, every binary in PATH |
| `declare -f ls` | Print the source code of the fake function |
| `\ls` | Backslash bypasses the alias only |
| `command ls` | Bypass aliases AND functions |
| `/usr/bin/ls` | Full path — bypasses everything |
| `unalias -a` | Remove all aliases at once |
| `unset -f ls` | Delete the fake function |

**Quick undo table:**

| Prank | Undo |
|---|---|
| Screen rotation | `xrandr --output eDP-1 --rotate normal` |
| Inverted mouse | identity matrix: `1 0 0 0 1 0 0 0 1` |
| Slow mouse | `xset m default` |
| Keyboard swap | `setxkbmap fr` + `setxkbmap -option` |
| Wallpaper | `feh --bg-scale` with their original wallpaper |
| The cat | `pkill oneko` |
| i3 config | delete the added lines + `i3-msg reload` |
| bashrc hijack | restore `~/.bashrc.prank.bak` (or `grep PRANK ~/.bashrc` and delete the block) |
| Fake PATH binaries | remove the `PATH=` line + `hash -r` |
