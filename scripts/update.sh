#!/usr/bin/env bash
# ClaudeGate 一键更新
#
# 它不猜你的配置 —— 端口、环境变量、数据卷全部从现有容器读出来原样复用，
# 只把镜像换掉。所以第一次怎么起的，以后就还是怎么起。
#
# 用法（在部署机上）：
#   bash update.sh                  # 走镜像站 ghcr.nju.edu.cn（默认，国内快）
#   bash update.sh ghcr.io          # 走权威源（镜像站还没同步完时用）
#   CG_NAME=claudegate bash update.sh
#
# 更新完最后会打印三样东西：本地镜像摘要、容器状态、最近 15 行日志。
# 摘要对不上说明镜像站还没同步到最新，重跑一次或改用 ghcr.io。

set -euo pipefail

NAME="${CG_NAME:-claudegate}"
REG="${1:-ghcr.nju.edu.cn}"
IMAGE="$REG/moteam-cn/claudegate:latest"

echo "==> 目标镜像：$IMAGE"
docker pull "$IMAGE"

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "==> 读取现有容器 $NAME 的配置"
  PORTS=$(docker inspect "$NAME" --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}} -p {{.HostPort}}:{{$p}}{{end}}{{end}}')
  ENVS=$(docker inspect "$NAME" --format '{{range .Config.Env}} -e {{.}}{{end}}')
  VOLS=$(docker inspect "$NAME" --format '{{range .Mounts}}{{if eq .Type "volume"}} -v {{.Name}}:{{.Destination}}{{else}} -v {{.Source}}:{{.Destination}}{{end}}{{end}}')
  NET=$(docker inspect "$NAME" --format '{{.HostConfig.NetworkMode}}')
  case "$NET" in ""|default|bridge) NETFLAG="" ;; *) NETFLAG="--network $NET" ;; esac
  echo "    端口:${PORTS:- 无}"
  echo "    挂载:${VOLS:- 无}"
  docker rm -f "$NAME" >/dev/null
else
  echo "==> 没有现成容器，按默认起一个（端口 8800，数据卷 $NAME-data）"
  echo "    如果你本来就是别的端口/代理，Ctrl-C 停掉，先按文档起一次，以后这个脚本就认得它了"
  PORTS=" -p 8800:8800"
  ENVS=" -e DATA_DIR=/data"
  VOLS=" -v $NAME-data:/data"
  NETFLAG=""
fi

# 这里刻意不加引号：PORTS/ENVS/VOLS 就是要按空格拆成多个参数
# shellcheck disable=SC2086
docker run -d --name "$NAME" --restart unless-stopped $PORTS $ENVS $VOLS $NETFLAG "$IMAGE"

echo
echo "==> 本地镜像摘要（拿它和发布摘要比对）"
docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}'
echo
echo "==> 容器状态"
docker ps --filter "name=$NAME" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
echo
echo "==> 最近日志（重点看「出口自检」那一行：代理没生效会拒绝启动）"
sleep 3
docker logs --tail 15 "$NAME" 2>&1 || true
