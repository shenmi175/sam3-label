# Docker + Caddy 部署

最终方案只对公网暴露 Caddy 的 `80/443`。`web-auto` 和 `sam3-api` 只在 Docker 内部网络里互通，`sam3-api` 不发布宿主机端口。

## 成熟方案依据

- Caddy 官方支持 Automatic HTTPS，会自动申请、续期和启用证书: https://caddyserver.com/docs/automatic-https
- Caddy 官方 `reverse_proxy` 指令用于反向代理到内部服务: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy 官方 Docker 镜像: https://hub.docker.com/_/caddy
- Let’s Encrypt HTTP-01 校验要求公网能够访问域名的 `80` 端口: https://letsencrypt.org/docs/challenge-types/
- Let’s Encrypt 建议保持 `80` 端口开放，用于校验和 HTTP 到 HTTPS 跳转: https://letsencrypt.org/docs/allow-port-80/

## 部署前必须确认

1. 域名已经添加 `A` 记录，指向服务器公网 IPv4。
2. 删除该域名的 `AAAA` 记录。本脚本采用最稳定的 IPv4 HTTP-01/TLS-ALPN 路径，避免 Let’s Encrypt 走到错误的 IPv6 地址。
3. DNS 不要先开 CDN 代理，脚本要求 `A` 记录直接等于服务器公网 IPv4。
4. 云厂商安全组、服务器防火墙、路由器端口转发必须放行公网 `80` 和 `443`。
5. 宿主机本地不能已有其他服务占用 `80/443`。
6. GPU 模式需要宿主机 `nvidia-smi` 正常，并且 Docker 已配置 NVIDIA Container Toolkit。

`./deploy.sh` 会检查域名 `A` 解析、拒绝 `AAAA` 记录、检查 `80/443` 本地占用和 GPU Docker runtime。检查失败会直接停止，不会继续启动半配置状态。

Compose 默认固定使用 `caddy:2.11.2-alpine`，不使用 `latest`。

## 一键安装

```bash
./deploy.sh
```

交互式安装会强制要求填写：

- `Public domain for web-auto`: 例如 `sam3.example.com`，不能留空，不能填 URL。
- `Email for Let's Encrypt account`: 真实邮箱，供 ACME 账户使用。

可以回车使用默认值的项目：

- `Deployment mode`: 默认 `gpu`，可选 `cpu`。
- `Host data root mounted into web-auto`: 默认当前用户 home 目录。
- 是否配置 Docker Hub 镜像站: 默认不配置。

安装完成后输出：

```text
web-auto:
  https://你的域名

web-auto login:
  Username: admin
  Password: .env 中生成的 WEB_AUTO_ADMIN_PASSWORD
```

## 更新和重启

```bash
./deploy.sh update
./deploy.sh restart
./deploy.sh restart web-auto
./deploy.sh restart sam3-api
./deploy.sh restart caddy
```

`update` 会重新执行 DNS 和端口预检，然后重建并启动。

## 查看状态和日志

```bash
./deploy.sh status
./deploy.sh doctor
./deploy.sh logs caddy
./deploy.sh logs web-auto
./deploy.sh logs sam3-api
```

`doctor` 会输出当前域名解析、本机 80/443 监听、Caddy 本地 HTTP/HTTPS 探测、TLS 握手探测和 Caddy 日志。

Caddy 证书申请失败时优先看：

```bash
./deploy.sh logs caddy
```

常见原因是域名 `A` 记录不指向当前服务器、存在 `AAAA` 记录，或者公网 `80/443` 没有放行。

## Docker Hub 镜像站

如果服务器无法访问 Docker Hub，可以配置 registry mirror：

```bash
./deploy.sh mirror https://你的镜像站地址
./deploy.sh update
```

也可以安装时选择配置。

## GPU

检查 GPU 环境：

```bash
./deploy.sh gpu-check
```

安装 NVIDIA Container Toolkit：

```bash
./deploy.sh gpu-install
./deploy.sh start --gpu
```

临时 CPU 模式：

```bash
./deploy.sh start --cpu
```

## 端口和安全边界

- 对公网开放: Caddy `80/tcp`、`443/tcp`、`443/udp`。
- Docker 内部服务: `web-auto:8000`、`sam3-api:8001`。
- `sam3-api` 不映射到宿主机端口，只能被 `web-auto` 通过 Docker 网络访问。
- web-auto 登录由 `WEB_AUTO_ADMIN_USERNAME` 和 `WEB_AUTO_ADMIN_PASSWORD` 控制。
- 内部 API token 由 `SAM3_API_TOKEN` 在 `.env` 里自动生成，web-auto 调用 sam3-api 时使用。

## 卸载

保留数据卸载：

```bash
./deploy.sh uninstall
```

删除 Compose volumes 和默认数据目录：

```bash
./deploy.sh uninstall --purge
```

同时删除本地构建镜像：

```bash
./deploy.sh uninstall --purge --with-images
```

卸载脚本不会删除 `sam3_checkpoints`，也不会删除 `WEB_AUTO_HOST_DATA_ROOT` 指向的数据集目录。
