# Docker + Nginx Proxy Manager 部署

该部署方式长期只需要对公网暴露 Nginx Proxy Manager 的 `80/443` 端口。`sam3-api` 不发布宿主机端口；`web-auto` 默认临时暴露 `8000` 作为首次登录和配置入口，配置好域名反代后可以在 `.env` 里把 `WEB_AUTO_BOOTSTRAP_BIND` 改为 `127.0.0.1`。

## 目录准备

```bash
./deploy.sh
```

脚本会自动：

- 复制 `.env.example` 到 `.env`。
- 生成并写入 `SAM3_API_TOKEN`。
- 生成并写入 `WEB_AUTO_ADMIN_PASSWORD`，`web-auto` 默认账号为 `admin`。
- 交互选择 GPU/CPU 模式，默认 GPU。
- 交互设置 `WEB_AUTO_HOST_DATA_ROOT`、NPM 端口和 `web-auto` 初始端口，直接回车使用默认值。
- GPU 模式下检查 Docker NVIDIA runtime；缺失时提示是否自动安装 NVIDIA Container Toolkit，默认安装。
- 询问是否自动配置 NPM 反代，默认不配置；也可以启动后在 `web-auto` 设置里配置。
- 创建持久化目录。
- 预拉取基础镜像、构建并启动服务。
- 如果 Docker Hub 拉取超时，提示输入 registry mirror 并自动写入 `/etc/docker/daemon.json`。

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
./deploy.sh install --gpu
```

也可以直接：

```bash
./deploy.sh
```

CPU 可用于功能验证，不建议用于大规模 SAM3 推理：

```bash
./deploy.sh install --cpu
```

如果你已有可用的 Docker Hub 镜像站：

```bash
./deploy.sh install --mirror https://你的镜像站地址
```

如果宿主机 `nvidia-smi` 正常，但 Docker 报错：

```text
could not select device driver "" with capabilities: [[gpu]]
```

说明 Docker 还没有配置 NVIDIA Container Toolkit。运行：

```bash
./deploy.sh gpu-install
./deploy.sh start --gpu
```

脚本内置的安装流程来自 NVIDIA 官方 Container Toolkit 文档：
https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html

只检查 GPU/Docker runtime 状态：

```bash
./deploy.sh gpu-check
```

如果暂时只想先跑通面板和 CPU 功能：

```bash
./deploy.sh start --cpu
```

## 首次配置

Nginx Proxy Manager 官方 Docker 部署文档: https://nginxproxymanager.com/setup/

脚本结束时会显示：

- `web-auto` 初始访问地址，例如 `http://服务器IP:8000`。
- `web-auto` 默认登录账号和密码。
- 如果已自动配置反代，会显示 `web-auto` 的访问域名。
- NPM 管理地址只作为排障入口，默认绑定 `127.0.0.1:81`，不是日常配置入口。

1. 打开 `web-auto` 初始地址：

```text
http://服务器IP:8000
```

2. 使用脚本结束时显示的 `web-auto` 默认账号和密码登录。

3. 在 `web-auto` 的「全局设置 -> 反代域名」里填写：

```text
域名: label.example.com
证书邮箱: admin@example.com
申请 HTTPS 证书: 开启
强制 HTTPS: 开启
```

4. 点击「配置反代」，`web-auto` 会调用 NPM API 创建/更新 Proxy Host。

5. 打开你的域名。`web-auto` 会进入 `/login`，使用同一个账号和密码登录。

`web-auto` 在 Docker 内默认调用：

```text
http://sam3-api:8001
```

该地址已被 `WEB_AUTO_ALLOWED_SAM3_API_BASE_URLS` 限制为内部地址，前端不会拿到 `SAM3_API_TOKEN`。

## 安全边界

- 服务器安全组只需要长期开放 `80/443`。
- `81` 是 NPM 管理端口，默认只绑定 `127.0.0.1`，日常域名反代配置在 `web-auto` 的设置页完成。
- 不要给 `sam3-api` 创建公网 Proxy Host。
- `.env` 里的 `SAM3_API_TOKEN` 同时用于 `sam3-api` 校验和 `web-auto` 内部调用。
- `web-auto/data/auth.json` 保存管理员密码哈希，不保存明文密码。

## 一键卸载

默认只删除容器和 compose 网络，保留项目数据、模型和缓存：

```bash
./deploy.sh uninstall
```

删除容器、网络和 Docker volumes，并删除默认的 `web-auto/data`、`sam3-api/data`：

```bash
./deploy.sh uninstall --purge
```

同时删除本地构建镜像：

```bash
./deploy.sh uninstall --purge --with-images
```

卸载脚本不会删除 `WEB_AUTO_HOST_DATA_ROOT` 指向的原始图片/视频数据集。

## 常用命令

```bash
./deploy.sh status
./deploy.sh logs nginx-proxy-manager
./deploy.sh logs web-auto
./deploy.sh logs sam3-api
./deploy.sh restart sam3-api
./deploy.sh update
./deploy.sh stop
```

`restart: unless-stopped` 已启用。机器重启后 Docker daemon 启动时会自动恢复容器，除非你手动执行过 `docker compose stop`。

## 持久化内容

- `web-auto/data`: 项目列表、SQLite 索引、UI 状态、项目工作目录。
- `sam3-api/data`: 上传缓存和视频临时数据。
- `sam3_checkpoints`: 本地模型权重，默认读取 `sam3.pt`。
- Docker volumes `npm_data`、`npm_letsencrypt`: NPM 配置和证书。
- Docker volumes `sam3_hf_cache` 和 `sam3_torch_cache`: Hugging Face/Torch 缓存。
