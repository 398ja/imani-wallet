#!/usr/bin/env bash
# Regenerates every Play listing image from the owner's sources. Needs ImageMagick 7 (magick).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WWW="${IMANI_WWW:-$HOME/IdeaProjects/imani-www}"
SHOTS="${IMANI_SHOTS:-$HOME/IdeaProjects/imani-marketting/deck/shots}"
RES="$REPO/android/app/src/main/res"
FONT="${FONT:-Noto-Sans-Bold}"
CREAM='#f3efe7'; INK='#1b1814'; ACCENT='#1c6cf5'; MUTED='#615a50'

# 1. Icon: adaptive launcher icon (white background + xxxhdpi foreground), full bleed.
magick -size 512x512 xc:'#ffffff' \( "$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" -resize 512x512 \) \
  -composite -alpha on -define png:color-type=6 "$HERE/icon-512.png"

# 2. Feature graphic: site cream background, mark in site accent, wordmark and tagline, centred.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sed "s/currentColor/$ACCENT/" "$WWW/mark.svg" > "$TMP/mark.svg"
magick -background none -density 600 "$TMP/mark.svg" -resize 150x150 "$TMP/mark.png"
magick -size 1024x500 xc:"$CREAM" \
  "$TMP/mark.png" -gravity center -geometry -205-55 -composite \
  -font "$FONT" -fill "$INK" -pointsize 112 -gravity center -annotate +80-62 'imani' \
  -fill "$INK" -pointsize 46 -annotate +0+78 'Digital vouchers for local shops.' \
  -font Noto-Sans-Regular -fill "$MUTED" -pointsize 26 -annotate +0+135 'Hold them, pay with them, send them to a friend.' \
  -alpha off -define png:color-type=2 "$HERE/feature-graphic-1024x500.png"

# 3. Screenshots: 1170x2532 source is 2.16:1, so pad the width to 1266 (exactly 2:1) with the app background.
i=0
for s in c-home-voucher c-receive c-pay-confirm c-share-1-amount c-share-5-friend-home \
         m-sell-2-amount m-sell-3-delivered tutorial-send-links/c-4-priya-ready; do
  i=$((i+1))
  magick "$SHOTS/$s.png" -background '#fafafa' -gravity center -extent 1266x2532 \
    -alpha off -define png:color-type=2 "$HERE/screenshots/phone-0$i.png"
done
identify -format '%f %wx%h %[channels] %[type] %b\n' "$HERE"/*.png "$HERE"/screenshots/*.png
