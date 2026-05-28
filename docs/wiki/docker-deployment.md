# Docker 部署

## 默认启动

```bash
cd ~/zmb_work/sam3
./deploy.sh install --direct
```

默认访问：

```text
http://服务器IP:8000
```

## SAM3 官方运行栈

`sam3-api` 默认使用 `pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime`。这是按官方 README 的 PyTorch 2.10.0 + CUDA 12.8 说明设置的，避免旧版 PyTorch/CUDA 在 SAM3 BF16 推理时出现 dtype 不一致。

如果旧 `.env` 里还保留 `SAM3_API_BASE_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`，运行 `./deploy.sh update --direct` 会自动更新为官方对齐的默认镜像。

## 更新

```bash
cd ~/zmb_work/sam3
./deploy.sh update --direct
```

如果前端界面没有变化，强制重建：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build --force-recreate web-auto
```

## GPU 问题

检查：

```bash
./deploy.sh gpu-check
```

安装 NVIDIA Container Toolkit：

```bash
./deploy.sh gpu-install
```

## 账号重置

```bash
./deploy.sh reset-admin
```

或指定新密码：

```bash
./deploy.sh reset-admin 'new-password-here'
```
