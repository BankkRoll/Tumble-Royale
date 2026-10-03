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

video=$(ls "$capture"/video/*.webm | head -n1)
fade=0.4
width=1280

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
# error diffusion on 3D gradients; 640 px at 12 fps keeps it README-sized.
ffmpeg -v error -y -i "$work/joined.mp4" \
  -vf "fps=12,scale=640:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=128" "$work/palette.png"
ffmpeg -v error -y -i "$work/joined.mp4" -i "$work/palette.png" \
  -lavfi "fps=12,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "$out/trailer.gif"

for png in "$capture"/*.png; do
  [ -e "$png" ] || continue
  name=$(basename "$png" .png)
  ffmpeg -v error -y -i "$png" -c:v libwebp -quality 86 "$out/$name.webp"
done

ls -la "$out"
