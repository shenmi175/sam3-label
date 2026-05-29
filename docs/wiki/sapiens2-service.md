# Sapiens2 服务

`sapiens-api` 是独立容器，不会安装依赖到 `sam3-api`。它只在 Docker 内部网络开放，web-auto 通过内部地址调用。

官方资料：

- Sapiens2 仓库: https://github.com/facebookresearch/sapiens2
- Sapiens2 模型列表: `external/sapiens2/docs/MODEL_ZOO.md`
- 姿态估计说明: `external/sapiens2/docs/POSE.md`

## 在 web-auto 启用

进入 web-auto 项目管理页，找到“模型服务”区域，点击 `sapiens-api` 卡片上的“启用”。

web-auto 会通过内部 `ops-api` 执行受限 Docker 操作：

- 构建 `sapiens-api:local` 镜像。
- 创建并启动 `sapiens-api` 容器。
- 把已挂载数据根目录同步挂载到 `sapiens-api`。
- 写入 `.env` 的 `SAPIENS_ENABLED=1`，后续 `deploy.sh update` 会保留该服务。
- 在卡片中显示构建/创建日志。

服务器命令仍保留为兜底方式：

```bash
cd ~/zmb_work/sam3
git submodule update --init --recursive external/sapiens2
./deploy.sh sapiens enable
```

web-auto 当前接入的是姿态估计工作流。默认模型固定为 `sapiens2_5b`，模型文件位置为：

```text
SAPIENS_CHECKPOINT_ROOT/pose/sapiens2_5b_pose.safetensors
SAPIENS_CHECKPOINT_ROOT/detector/detr-resnet-101-dc5/
```

默认 `SAPIENS_CHECKPOINT_ROOT=./sapiens_checkpoints`，也可以在 `.env` 里改到外置盘目录。

## 自动下载

启用 `sapiens-api` 后，模型服务卡片会检查：

- `sapiens-api` 容器是否已创建并运行。
- `sapiens2_5b_pose.safetensors` 是否存在。
- DETR 人体检测器 `facebook/detr-resnet-101-dc5` 是否已下载。
- 如果模型或检测器缺失，会启动下载任务并显示进度条。

下载地址使用 Hugging Face 官方仓库：

```text
https://huggingface.co/facebook/sapiens2-pose-5b/resolve/main/sapiens2_5b_pose.safetensors
https://huggingface.co/facebook/detr-resnet-101-dc5
```

下载会先写入 `.part` 文件，完成后再替换成正式 checkpoint。中断后再次下载会尝试续传。

如果服务器访问 Hugging Face 需要令牌，在 `.env` 或 shell 环境中设置：

```bash
HF_TOKEN=你的令牌
```

然后重建或重启 `sapiens-api`。

## 姿态估计项目

在项目管理页点击“创建项目”，项目类型选择“姿态估计标注”，填写图片目录和输出目录后创建。打开该项目会进入独立的姿态估计标注页面，而不是 SAM3 图片分割页面。

姿态标注页支持：

- 调用 `sapiens-api` 对当前图片执行 308 点人体姿态估计。
- 显示人体框、骨架连线和关键点。
- 拖动关键点微调位置。
- 保存、清空当前图片姿态标注。
- 使用左右方向键切换图片，`Ctrl+S` 保存。

## 服务管理

项目管理页可以启动、停止、重启以下内部服务：

- `sam3-api`
- `sapiens-api`
- `caddy`，仅反代模式使用

服务器命令也可直接执行：

```bash
./deploy.sh services status
./deploy.sh services restart sam3-api
./deploy.sh services restart sapiens-api
./deploy.sh sapiens disable
```

`web-auto` 不允许在页面内停止，避免把当前管理入口杀掉。如需重启 web-auto，请在设置页或服务器终端执行。
