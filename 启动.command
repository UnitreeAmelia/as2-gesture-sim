#!/bin/zsh
# AS2 手势遥操作 —— 本地启动脚本
# 双击运行：起一个本地服务并打开浏览器

cd "$(dirname "$0")" || exit 1

PORT=8124
while lsof -i ":$PORT" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://127.0.0.1:$PORT/"

echo ""
echo "  AS2 · 手势遥操作"
echo "  ──────────────────────────────────"
echo "  地址：$URL"
echo "  提示：浏览器会问摄像头权限，点「允许」"
echo "  关闭这个终端窗口即可停止"
echo ""

python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!

sleep 1
open "$URL"

wait $SRV
