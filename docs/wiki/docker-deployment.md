# Docker 部署

## 默认启动

```bash
cd /path/to/sam3
./deploy.sh install
```

默认访问：

```text
http://服务器IP:8000
```

## SAM3 官方运行栈

`sam3-api` 默认使用 `pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime`。这是按官方 README 的 PyTorch 2.10.0 + CUDA 12.8 说明设置的，避免旧版 PyTorch/CUDA 在 SAM3 BF16 推理时出现 dtype 不一致。

如果旧 `.env` 里还保留 `SAM3_API_BASE_IMAGE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime`，运行 `./deploy.sh update` 会自动更新为官方对齐的默认镜像。

PyTorch 2.10 镜像的系统 Python 启用了 PEP 668 限制，`sam3-api` 会在镜像内使用 `/opt/venv` 安装项目依赖，并继承基础镜像自带的 torch/torchvision。

## 更新

```bash
cd /path/to/sam3
./deploy.sh update
```

如果前端界面没有变化，强制重建：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build --force-recreate web-auto
```

## 可选 Sapiens2-5B

Sapiens2 姿态估计使用独立 `sapiens-api` 容器。推荐在 web-auto 项目管理页的“模型服务”区域点击“启用”，页面会显示构建、启动和模型下载进度。

服务器命令仍可作为兜底方式：

```bash
cd /path/to/sam3
./deploy.sh sapiens enable
```

如果 `sapiens2_5b_pose.safetensors` 或 DETR 人体检测器不存在，页面会自动启动下载并显示进度。

常用命令：

```bash
./deploy.sh services status
./deploy.sh services restart sapiens-api
./deploy.sh sapiens disable
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
