#!/bin/sh
set -eu

# 无外部依赖的 Node 20 应用：直接产出运行目录
mkdir -p dist
cp server.js package.json index.html dist/
cp run.sh dist/run.sh
chmod 755 dist/run.sh
