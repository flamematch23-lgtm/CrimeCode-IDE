#!/usr/bin/env bash
# runpod-volume.sh — utility per gestire il Network Volume RunPod via S3 API.
#
# Premesse:
#   - Il volume va in /runpod-volume dentro il worker serverless.
#   - vLLM è configurato con BASE_PATH=/runpod-volume e cache HF nel volume,
#     quindi i pesi vivono in:
#       /runpod-volume/huggingface/hub/models--<owner>--<name>/...
#   - Le credenziali S3 stanno in ~/.aws/credentials sotto profilo `runpods3`.
#   - L'endpoint S3 dipende dal datacenter del volume (EUR-IS-1 nel nostro caso).
#
# Comandi:
#   ./runpod-volume.sh ls               # elenca contenuto del volume
#   ./runpod-volume.sh size             # totale + breakdown per directory
#   ./runpod-volume.sh tree [PREFIX]    # albero ASCII del volume (o di un path)
#   ./runpod-volume.sh wipe-cache       # elimina la cache HF (forza re-download)
#   ./runpod-volume.sh clean-junk       # elimina file di test (run.sh, training.*)
#   ./runpod-volume.sh download SRC DST # scarica un path S3 → locale
#   ./runpod-volume.sh upload   SRC DST # carica locale → path S3
#   ./runpod-volume.sh prewarm-watch    # monitora la cache HF mentre cresce
#
# Override via env:
#   RUNPOD_VOLUME_ID    — id volume     (default: qsdh4ba6k2)
#   RUNPOD_S3_PROFILE   — aws profile   (default: runpods3)
#   RUNPOD_S3_ENDPOINT  — endpoint URL  (default: https://s3api-eur-is-1.runpod.io)

set -euo pipefail

VOL="${RUNPOD_VOLUME_ID:-qsdh4ba6k2}"
PROFILE="${RUNPOD_S3_PROFILE:-runpods3}"
ENDPOINT="${RUNPOD_S3_ENDPOINT:-https://s3api-eur-is-1.runpod.io}"
S3="s3://${VOL}"

aws_s3() { aws --profile "$PROFILE" --endpoint-url "$ENDPOINT" "$@"; }

cmd_ls()    { aws_s3 s3 ls "${S3}/${1:-}" --human-readable; }
cmd_size()  { aws_s3 s3 ls "${S3}/${1:-}" --recursive --human-readable --summarize | tail -2; }

cmd_tree() {
  local prefix="${1:-}"
  aws_s3 s3 ls "${S3}/${prefix}" --recursive | awk '{print $NF}' \
    | sed -e "s|^${prefix}||" \
    | sort -u
}

cmd_wipe_cache() {
  echo "▶ Eliminazione cache HF in ${S3}/huggingface/ — il prossimo cold start riscarica il modello."
  read -r -p "Confermi? (sì/no) " ans
  [[ "$ans" == "sì" || "$ans" == "si" || "$ans" == "y" ]] || { echo "annullato"; exit 0; }
  aws_s3 s3 rm "${S3}/huggingface/" --recursive
}

cmd_clean_junk() {
  echo "▶ Eliminazione file residui di training (run.sh, training.log, training.pid)…"
  for f in run.sh training.log training.pid; do
    aws_s3 s3 rm "${S3}/${f}" 2>/dev/null && echo "  - rimosso $f" || echo "  · ${f} non presente"
  done
}

cmd_download() {
  local src="${1:?usage: download SRC DST}"
  local dst="${2:?usage: download SRC DST}"
  aws_s3 s3 cp "${S3}/${src}" "$dst" --recursive 2>/dev/null \
    || aws_s3 s3 cp "${S3}/${src}" "$dst"
}

cmd_upload() {
  local src="${1:?usage: upload SRC DST}"
  local dst="${2:?usage: upload SRC DST}"
  if [[ -d "$src" ]]; then
    aws_s3 s3 cp "$src" "${S3}/${dst}" --recursive
  else
    aws_s3 s3 cp "$src" "${S3}/${dst}"
  fi
}

cmd_prewarm_watch() {
  echo "▶ Monitoraggio cache HF (Ctrl+C per uscire)…"
  while true; do
    local out
    out=$(aws_s3 s3 ls "${S3}/huggingface/" --recursive --human-readable --summarize 2>/dev/null | tail -2)
    printf "[%s] %s\n" "$(date +%H:%M:%S)" "${out//$'\n'/ | }"
    sleep 10
  done
}

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \?//'
  exit 1
}

case "${1:-}" in
  ls)             shift; cmd_ls    "${1:-}" ;;
  size)           shift; cmd_size  "${1:-}" ;;
  tree)           shift; cmd_tree  "${1:-}" ;;
  wipe-cache)     cmd_wipe_cache ;;
  clean-junk)     cmd_clean_junk ;;
  download)       shift; cmd_download "$@" ;;
  upload)         shift; cmd_upload   "$@" ;;
  prewarm-watch)  cmd_prewarm_watch ;;
  *)              usage ;;
esac
