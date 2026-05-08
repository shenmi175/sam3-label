# Docker + Nginx Proxy Manager 部署

该部署方式只对公网暴露 Nginx Proxy Manager 的 `80/443/81` 端口。`web-auto` 和 `sam3-api` 不再发布宿主机端口，只能在 Docker 内部网络访问。

## 目录准备

```bash
cp .env.example .env
mkdir -p sam3_checkpoints web-auto/data sam3-api/data
openssl rand -hex 32
```

把生成的随机字符串写入 `.env`：

```text
SAM3_API_TOKEN=生成的随机字符串
```

如果不从 Hugging Face 自动下载模型，把 `sam3.pt` 放到：

```text
sam3_checkpoints/sam3.pt
```

如果你的图片/视频数据不在 `/home/zmb` 下，修改 `.env`：

```text
WEB_AUTO_HOST_DATA_ROOT=/path/to/your/data/root
```

`web-auto` 会把该路径按相同绝对路径挂进容器，已有项目里的绝对路径才不会失效。

## 启动

## GPU 运行

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

CPU 可用于功能验证，不建议用于大规模 SAM3 推理：

```bash
SAM3_API_DEVICE=cpu docker compose up -d --build
```

## 首次配置

Nginx Proxy Manager 官方 Docker 部署文档: https://nginxproxymanager.com/setup/

1. 打开 Nginx Proxy Manager 管理面板：

```text
http://服务器IP:81
```

2. 登录 NPM 后立即修改默认管理员邮箱和密码。

3. 在 NPM 添加 Proxy Host：

```text
Domain Names: 你的域名
Scheme: http
Forward Hostname / IP: web-auto
Forward Port: 8000
Websockets Support: on
Block Common Exploits: on
SSL: Request a new SSL Certificate
Force SSL: on
```

4. 打开你的域名。首次访问 `web-auto` 会跳转到 `/setup`，创建管理员用户名和密码；之后通过 `/login` 登录。

5. `web-auto` 在 Docker 内默认调用：

```text
http://sam3-api:8001
```

该地址已被 `WEB_AUTO_ALLOWED_SAM3_API_BASE_URLS` 限制为内部地址，前端不会拿到 `SAM3_API_TOKEN`。

## 安全边界

- 服务器安全组只需要长期开放 `80/443`。
- `81` 是 NPM 管理端口，建议仅首次配置时开放，或限制为你的固定 IP。
- 不要给 `sam3-api` 创建公网 Proxy Host。
- `.env` 里的 `SAM3_API_TOKEN` 同时用于 `sam3-api` 校验和 `web-auto` 内部调用。
- `web-auto/data/auth.json` 保存管理员密码哈希，不保存明文密码。

## 一键卸载

默认只删除容器和 compose 网络，保留项目数据、模型和缓存：

```bash
./scripts/uninstall.sh
```

删除容器、网络和 Docker volumes，并删除默认的 `web-auto/data`、`sam3-api/data`：

```bash
./scripts/uninstall.sh --purge
```

同时删除本地构建镜像：

```bash
./scripts/uninstall.sh --purge --with-images
```

卸载脚本不会删除 `WEB_AUTO_HOST_DATA_ROOT` 指向的原始图片/视频数据集。

## 常用命令

```bash
docker compose ps
docker compose logs -f nginx-proxy-manager
docker compose logs -f web-auto
docker compose logs -f sam3-api
docker compose restart sam3-api
docker compose down
```

`restart: unless-stopped` 已启用。机器重启后 Docker daemon 启动时会自动恢复容器，除非你手动执行过 `docker compose stop`。

## 持久化内容

- `web-auto/data`: 项目列表、SQLite 索引、UI 状态、项目工作目录。
- `sam3-api/data`: 上传缓存和视频临时数据。
- `sam3_checkpoints`: 本地模型权重，默认读取 `sam3.pt`。
- Docker volumes `npm_data`、`npm_letsencrypt`: NPM 配置和证书。
- Docker volumes `sam3_hf_cache` 和 `sam3_torch_cache`: Hugging Face/Torch 缓存。
