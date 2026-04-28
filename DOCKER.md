# Docker 持久化运行

## 目录准备

```bash
cp .env.example .env
mkdir -p sam3_checkpoints web-auto/data sam3-api/data
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

## GPU 运行

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

访问：

```text
http://127.0.0.1:8000
```

`web-auto` 在 Docker 内默认调用：

```text
http://sam3-api:8001
```

如果浏览器 localStorage 里保留过旧地址 `http://127.0.0.1:8001`，在页面顶部的 `sam3-api 地址` 输入框改成 `http://sam3-api:8001`，或清空该站点 localStorage 后刷新。

## CPU 运行

CPU 可用于功能验证，不建议用于大规模 SAM3 推理：

```bash
SAM3_API_DEVICE=cpu docker compose up -d --build
```

## 常用命令

```bash
docker compose ps
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
- Docker volumes `sam3_hf_cache` 和 `sam3_torch_cache`: Hugging Face/Torch 缓存。
