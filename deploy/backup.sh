#!/bin/sh
# Scheduled Postgres backups for deploy/docker-compose.yml (the `backup` service).
#
# Every BACKUP_INTERVAL_HOURS: pg_dump in custom format to
# $BACKUP_DIR/tumble-<UTC timestamp>.dump, then delete dumps older than
# BACKUP_KEEP_DAYS. Connection settings come from the standard PG* variables.
# A dump is written under a temporary name and renamed when complete, so a
# failed or interrupted run never leaves a truncated file that looks valid.
set -eu

dir="${BACKUP_DIR:-/backups}"
interval_hours="${BACKUP_INTERVAL_HOURS:-24}"
keep_days="${BACKUP_KEEP_DAYS:-14}"
case "$interval_hours$keep_days" in
  *[!0-9]*)
    echo "[backup] BACKUP_INTERVAL_HOURS and BACKUP_KEEP_DAYS must be whole numbers" >&2
    exit 2
    ;;
esac

# The sleep runs in the background so `docker compose stop` ends the loop at once.
trap 'exit 0' INT TERM

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  partial="$dir/.tumble-$stamp.dump.partial"
  if pg_dump --format=custom --no-owner --file="$partial"; then
    mv "$partial" "$dir/tumble-$stamp.dump"
    echo "[backup] wrote tumble-$stamp.dump ($(du -h "$dir/tumble-$stamp.dump" | cut -f1))"
  else
    rm -f "$partial"
    echo "[backup] pg_dump failed; retrying in ${interval_hours}h" >&2
  fi
  find "$dir" -maxdepth 1 -name 'tumble-*.dump' -mtime +"$keep_days" -print -exec rm -f {} \; |
    sed 's/^/[backup] pruned /'
  sleep "$((interval_hours * 3600))" &
  wait $!
done
