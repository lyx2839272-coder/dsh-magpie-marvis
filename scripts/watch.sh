#!/bin/bash
# 每 20 分钟探一次 Marvis 是否恢复(HTTP 200)；恢复就写标记并退出。
# 环境变量: WORKDIR(默认当前目录)  NODE_BIN(默认 node)
WORKDIR="$WORKDIR"; [ -z "$WORKDIR" ] && WORKDIR="."
LOG="$WORKDIR/marvis-watch.log"
FLAG="$WORKDIR/marvis-recovered.flag"
NODE="$NODE_BIN"; [ -z "$NODE" ] && NODE="node"
rm -f "$FLAG"
for i in $(seq 1 18); do
  out=$(timeout 70 "$NODE" "$WORKDIR/scripts/probe.mjs" 2>&1 | head -1)
  echo "$(date '+%F %T') $out" >> "$LOG"
  case "$out" in
    *" 200 "*) echo "$(date '+%F %T') RECOVERED" >> "$LOG"; date > "$FLAG"; exit 0 ;;
  esac
  sleep 1200
done
echo "$(date '+%F %T') give-up" >> "$LOG"
