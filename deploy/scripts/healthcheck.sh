#!/bin/sh
# 亚马逊卖家助手健康检查：失败时重启 systemd 服务（由 cron 以 root 运行）。
set -u

PORT="${APP_PORT:-8000}"
URL="http://127.0.0.1:${PORT}/api/health"

if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then
  exit 0
fi

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') health check failed: $URL"

if command -v systemctl >/dev/null 2>&1; then
  systemctl restart amazon-seller-tools.service
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') restarted amazon-seller-tools.service"
fi
