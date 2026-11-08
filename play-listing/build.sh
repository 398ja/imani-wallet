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

# 1. Icon: the Imani mark (public/imani.svg, the same path as the web app icon public/icon-512.png),
#    #171717 on the app background #fafafa, full bleed. Not the Android mipmap: that is still the
#    Capacitor template icon (imani-wallet#558).
sed 's/@media[^}]*}[^}]*}//' "$REPO/public/imani.svg" > "$HERE/.mark.svg"
magick -background none -density 1200 "$HERE/.mark.svg" -resize 300x300 "$HERE/.mark.png"
magick -size 512x512 xc:'#fafafa' "$HERE/.mark.png" -gravity center -composite \
  -alpha on -depth 8 -define png:color-type=6 "$HERE/icon-512.png"
rm -f "$HERE/.mark.svg" "$HERE/.mark.png"

# 1b. The Android launcher icon PNGs, for Android 7 (API 24 and 25), which has no adaptive icons.
#     API 26+ uses the vector drawable/ic_launcher_foreground.xml through mipmap-anydpi-v26.
#     Same mark and colours; legacy launchers do not mask, so the square one has its own rounded
#     corners and the round one is a circle. The template ic_launcher_foreground.png files are gone.
sed 's/@media[^}]*}[^}]*}//' "$REPO/public/imani.svg" > "$HERE/.mark.svg"
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d="${pair%%:*}"; s="${pair##*:}"; m=$(( s * 58 / 100 )); r=$(( s * 18 / 100 ))
  magick -background none -density 1200 "$HERE/.mark.svg" -resize "${m}x${m}" "$HERE/.m.png"
  magick -size "${s}x${s}" xc:none -fill '#fafafa' -draw "roundrectangle 0,0 $((s-1)),$((s-1)) $r,$r" \
    "$HERE/.m.png" -gravity center -composite "$RES/mipmap-$d/ic_launcher.png"
  magick -size "${s}x${s}" xc:none -fill '#fafafa' -draw "circle $((s/2)),$((s/2)) $((s/2)),0" \
    "$HERE/.m.png" -gravity center -composite "$RES/mipmap-$d/ic_launcher_round.png"
done
rm -f "$HERE/.mark.svg" "$HERE/.m.png"

# 2. Feature graphic: site cream background, the app's rounded mark (public/imani.svg, owner choice)
#    in the site accent, wordmark and tagline, centred.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sed -e 's/@media[^}]*}[^}]*}//' -e "s/#171717/$ACCENT/g" "$REPO/public/imani.svg" > "$TMP/mark.svg"
magick -background none -density 600 "$TMP/mark.svg" -resize 150x150 "$TMP/mark.png"
magick -size 1024x500 xc:"$CREAM" \
  "$TMP/mark.png" -gravity center -geometry -205-55 -composite \
  -font "$FONT" -fill "$INK" -pointsize 112 -gravity center -annotate +80-62 'imani' \
  -fill "$INK" -pointsize 46 -annotate +0+78 'Digital vouchers for local shops.' \
  -font Noto-Sans-Regular -fill "$MUTED" -pointsize 26 -annotate +0+135 'Hold them, pay with them, send them to a friend.' \
  -alpha off -depth 8 -define png:color-type=2 "$HERE/feature-graphic-1024x500.png"

# 3. Screenshots: 1170x2532 source is 2.16:1, so pad the width to 1266 (exactly 2:1) with the app background.
i=0
for s in c-home-voucher c-receive c-pay-confirm c-share-1-amount c-share-5-friend-home \
         m-sell-2-amount m-sell-3-delivered tutorial-send-links/c-4-priya-ready; do
  i=$((i+1))
  magick "$SHOTS/$s.png" -background '#fafafa' -gravity center -extent 1266x2532 \
    -alpha off -define png:color-type=2 "$HERE/screenshots/phone-0$i.png"
done
identify -format '%f %wx%h %[channels] %[type] %b\n' "$HERE"/*.png "$HERE"/screenshots/*.png
