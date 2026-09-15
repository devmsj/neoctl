# Linux Docker 部署

## 准备

宿主机安装 Bash、Docker Engine 和 Buildx，启用资源限额支持。镜像使用 Ubuntu，不要求宿主机使用 Ubuntu；构建时自动选择基础镜像支持的本机架构。

neoctl 在宿主机运行，使用满足项目依赖要求的 Node LTS；容器内 Node 独立预装。

## 构建与创建

```bash
cd docker_deploy
docker build --pull -t neo-workspace:1 .
bash create-container.sh
docker exec -it neo-workspace bash
```

默认 root、`/workspace`、2 CPU、4 GiB 内存、512 进程，数据卷 `neo-workspace-data`。已有容器不覆盖，使用 `docker start neo-workspace` 启动。

可配置变量：`NAME`、`IMAGE`、`VOLUME`、`NETWORK`、`CPUS`、`MEMORY`、`PIDS`、`PROXY_GATEWAY`。

## 网络与代理

默认 `NETWORK=none`。使用 `network.sh` 创建专用 bridge，放行 IPv4 公网，阻断宿主机、内网、云元数据及 IPv6 出站。`BLOCK_CIDRS` 必须包含宿主机公网 IP 和其他管理入口 IP。规则只作用于该 bridge，不清空原有规则。磁盘/inode 配额另配。

```bash
BLOCK_CIDRS='宿主机公网IP/32' bash network.sh
```

使用 systemd 示例时，替换项目路径和 Node PATH，在 `/etc/neoctl-docker/deploy.env` 配置 `BLOCK_CIDRS`。将工作容器设为 `--restart=no`，由服务先恢复网络规则再启动。

```bash
NETWORK=neo-egress bash create-container.sh
```

使用代理时，将实际转发地址传入 `PROXY_GATEWAY`：

```bash
NETWORK=neo-egress PROXY_GATEWAY='代理转发IP' bash create-container.sh
docker exec neo-workspace bash -c 'proxy-on 7890 && curl https://example.com'
```

替换占位地址；转发服务提供获批端口的 HTTP 代理并支持 CONNECT，代理侧同样限制目标访问。`proxy-on` 和 `proxy-off` 只影响当前 Bash。

## neoctl 接入

默认使用原本地后端。设置 `NEO_EXECUTION_BACKEND=docker` 和 `NEO_EXECUTION_CONTAINER` 启用唯一容器，命令、文件、cwd、上传、下载和图片文件走容器。模型调用与平台密钥留宿主机，执行失败不回退宿主机。

```bash
npm --prefix ../engine ci
npm --prefix ../web ci
NEO_WEB_BASE_PATH=/neo/ npm --prefix ../web run build
NEO_ENV_FILE=/etc/neoctl/model.env bash start-service.sh
```

服务监听 `127.0.0.1:6666`，内部运行时监听 `127.0.0.1:3109`。配置文件权限设为 `600`。

将 `nginx-location.conf` 放入目标域名的 HTTPS server 配置，配置访问账号后执行 `nginx -t`，通过后平滑 reload。不要新增公网监听。

## 验证

```bash
NEO_EXECUTION_BACKEND=docker node smoke-backend.mjs
NEO_EXECUTION_BACKEND=docker node smoke-web.mjs
```

`smoke-web.mjs` 使用临时配置启动回环服务，运行前确保 6666 和 3109 未占用。代理函数及地址映射不等于代理服务已连通，需另配获批端口转发及对应放行规则。
