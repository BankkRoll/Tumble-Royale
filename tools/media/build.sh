#!/usr/bin/env bash
# Builds README media from a capture made by apps/client/e2e/media.spec.ts.
#
#   tools/media/build.sh <capture-dir> <start:duration> [<start:duration> ...]
#
# Each segment (seconds into the recording) is cut from the capture's video,
# joined with short crossfades into docs/media/trailer.mp4, and turned into a
# looping docs/media/trailer.gif sized for the README. Stills in the capture
# directory are re-encoded as WebP into docs/media/.
#
# The README hero is an animated WebP: full colour at HD for a fraction of a
# GIF's size. A GIF is still written for places that only take GIFs.
#
# Requires ffmpeg with libx264 and libwebp.
set -euo pipefail

capture=${1:?capture dir}
shift
[ "$#" -gt 0 ] || { echo "give at least one start:duration segment" >&2; exit 1; }

repo=$(cd "$(dirname "$0")/../.." && pwd)
out="${MEDIA_DEST:-$repo/docs/media}"
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# NOTE: one of the two globs never matches, so ls exits non-zero; pipefail must not abort on it.
video=$(ls "$capture"/video/*.mp4 "$capture"/video/*.webm 2>/dev/null | head -n1 || true)
[ -n "$video" ] || { echo "no video in $capture/video" >&2; exit 1; }
fade=0.4
# README GIF size knobs; the MP4 keeps full quality.
gif_width=${GIF_WIDTH:-720}
gif_fps=${GIF_FPS:-12}
gif_colors=${GIF_COLORS:-128}
width=${TRAILER_WIDTH:-1920}

# Cut each segment to a constant frame rate so xfade offsets line up.
i=0
inputs=()
durations=()
for seg in "$@"; do
  start=${seg%%:*}
  dur=${seg##*:}
  ffmpeg -v error -y -ss "$start" -t "$dur" -i "$video" \
    -vf "fps=30,scale=${width}:-2:flags=lanczos" -an -c:v libx264 -crf 16 -preset veryfast "$work/s$i.mp4"
  inputs+=(-i "$work/s$i.mp4")
  durations+=("$dur")
  i=$((i + 1))
done

# Chain xfades: each transition starts `fade` seconds before the running clip ends.
if [ "$i" -eq 1 ]; then
  cp "$work/s0.mp4" "$work/joined.mp4"
else
  filter=""
  prev="0:v"
  offset=0
  for ((k = 1; k < i; k++)); do
    offset=$(awk -v o="$offset" -v d="${durations[$((k - 1))]}" -v f="$fade" 'BEGIN { print o + d - f }')
    filter+="[$prev][$k:v]xfade=transition=fade:duration=$fade:offset=$offset[v$k];"
    prev="v$k"
  done
  ffmpeg -v error -y "${inputs[@]}" -filter_complex "${filter%;}" -map "[$prev]" \
    -c:v libx264 -crf 16 -preset veryfast "$work/joined.mp4"
fi

ffmpeg -v error -y -i "$work/joined.mp4" -c:v libx264 -crf 27 -preset slow -pix_fmt yuv420p \
  -movflags +faststart "$out/trailer.mp4"

# Two-pass palette GIF. Ordered (bayer) dithering compresses far better than
# error diffusion on 3D gradients.
ffmpeg -v error -y -i "$work/joined.mp4" \
  -vf "fps=$gif_fps,scale=$gif_width:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=$gif_colors" "$work/palette.png"
ffmpeg -v error -y -i "$work/joined.mp4" -i "$work/palette.png" \
  -lavfi "fps=$gif_fps,scale=$gif_width:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$out/trailer.gif"

# Animated WebP hero: full colour, so gradients stay smooth where a GIF bands.
# PERF: libwebp_anim takes several minutes but is about 20% smaller than
# libwebp at the same quality, which matters for a README hero.
ffmpeg -v error -y -i "$work/joined.mp4" \
  -vf "fps=${HERO_FPS:-15},scale=${HERO_WIDTH:-1280}:-1:flags=lanczos" \
  -c:v libwebp_anim -lossless 0 -quality "${HERO_QUALITY:-62}" -compression_level 6 -loop 0 -an \
  "$out/trailer.webp"

for png in "$capture"/*.png; do
  [ -e "$png" ] || continue
  name=$(basename "$png" .png)
  ffmpeg -v error -y -i "$png" -c:v libwebp -quality 86 "$out/$name.webp"
done

ls -la "$out"
