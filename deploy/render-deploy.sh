#!/usr/bin/env bash
# 用 deploy/install.conf 渲染 deploy/*.template 到 deploy/dist/。
# 幂等：改完 install.conf 重新执行即可。
#
# 模板使用 ${VAR} 占位符（envsubst）；只替换 EXPECTED 里的变量，
# nginx 自带的 $host / $remote_addr 等原样保留。
set -euo pipefail

cd "$(dirname "$0")/.."
CONF=deploy/install.conf
DIST=deploy/dist

if [ ! -f "$CONF" ]; then
  echo "error: $CONF not found." >&2
  echo "       cp deploy/install.conf.example $CONF, edit it, then re-run." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$CONF"; set +a

EXPECTED=(SERVER_NAME INSTALL_DIR APP_USER NODE_BIN APP_PORT HEALTH_LOG)
for v in "${EXPECTED[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "error: $v is empty in $CONF" >&2
    exit 1
  fi
done

if ! command -v envsubst >/dev/null 2>&1; then
  echo "error: envsubst not installed. Install with: apt install gettext-base  (or dnf install gettext)" >&2
  exit 1
fi

# 一次性生成变量列表，避免 envsubst 误伤 nginx 的 $host 等
VARS=$(printf '${%s} ' "${EXPECTED[@]}")
mkdir -p "$DIST/nginx" "$DIST/systemd" "$DIST/cron.d"

render() {
  local src=$1 dst=$2
  envsubst "$VARS" < "$src" > "$dst"
  echo "  rendered: $dst"
}

render deploy/nginx/amazon-seller-tools.conf.template      "$DIST/nginx/amazon-seller-tools.conf"
render deploy/systemd/amazon-seller-tools.service.template "$DIST/systemd/amazon-seller-tools.service"
render deploy/cron.d/amazon-seller-tools-health.template   "$DIST/cron.d/amazon-seller-tools-health"

cat <<EOF
Done. Next steps:
  # 1. nginx（先确保 certbot 已签发证书）
  sudo cp $DIST/nginx/amazon-seller-tools.conf /etc/nginx/conf.d/
  sudo nginx -t && sudo systemctl reload nginx
  # 2. systemd
  sudo cp $DIST/systemd/amazon-seller-tools.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now amazon-seller-tools.service
  # 3. 健康检查 cron
  sudo mkdir -p "\$(dirname $HEALTH_LOG)"
  sudo cp $DIST/cron.d/amazon-seller-tools-health /etc/cron.d/
EOF
