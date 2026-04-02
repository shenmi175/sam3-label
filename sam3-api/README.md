# SAM3 API (sam3-api)

用于把 SAM3 模型部署到服务器，通过 HTTP API 在本地或其他系统（例如 VisioFirm）调用推理。

## 目录

```text
sam3-api/
├── app/
│   ├── __init__.py
│   ├── config.py
│   ├── engine.py
│   ├── mcp_adapter.py
│   ├── semantic_engine.py
│   ├── main.py
│   ├── schemas.py
│   └── utils.py
├── mcp_server.py
├── requirements.txt
├── requirements-mcp.txt
├── run_mcp.py
└── run.py
```

## 接口

### 1) 健康检查

- `GET /health`

返回示例：

```json
{
  "status": "ok",
  "model_loaded": false,
  "semantic_model_loaded": false,
  "video_model_loaded": false,
  "device": "cuda",
  "checkpoint_path": "/path/to/sam3.pt"
}
```

### 2) 模型预热

- `POST /v1/warmup`

用于提前加载模型，避免第一次推理冷启动。

- `POST /v1/semantic/warmup`

用于提前加载官方 SAM3 语义推理器，避免范例语义与范例传播冷启动。

### 3) 单图推理

- `POST /v1/infer`
- `multipart/form-data`

字段：
- `file`: 图片文件（必填）
- `mode`: 推理模式，`text` / `points` / `boxes`（默认 `text`）
- `prompt`: 文本提示词（`text` 模式必填；`points/boxes` 模式可选，留空则按视觉提示推理）
  - `text` 模式支持一次输入多个类别，使用逗号分隔（例如：`person, cat, door`）
- `points`: 点提示（仅 `points` 模式），JSON 数组，支持正负样本标签  
  - 例：`[[120, 220, 1], [260, 180, 0]]` 或 `[{"x":120,"y":220,"label":1}]`
- `boxes`: 框提示（仅 `boxes` 模式），JSON 数组，支持正负样本标签  
  - 例：`[[100, 100, 220, 280, 1], [240, 90, 320, 180, 0]]`
- `point_box_size`: 点模式时将点转换为小框的尺寸（像素；若传 `0~1` 视为图像短边比例），默认 `16`
- `threshold`: 置信度阈值，默认读取环境变量
- `include_mask_png`: 是否返回每个目标的 mask PNG base64（默认 `false`）
- `max_detections`: 最大返回目标数（默认 `100`）

返回字段包含：
- `detections[].bbox_xyxy`
- `detections[].bbox_xywh`
- `detections[].polygon`（可选，便于前端直接填充可视化）
- `detections[].score`
- `detections[].label`
- `detections[].class_id`（`text` 多类别时返回，按输入类别顺序从 `0` 开始）
- `detections[].area`
- `detections[].mask_png_base64`（可选）

示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/infer" \
  -F "file=@/data/example.jpg" \
  -F "mode=text" \
  -F "prompt=person" \
  -F "threshold=0.5" \
  -F "include_mask_png=false" \
  -F "max_detections=100"
```

点提示（正负样本）示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/infer" \
  -F "file=@/data/example.jpg" \
  -F "mode=points" \
  -F "points=[[120,220,1],[260,180,0]]" \
  -F "point_box_size=18" \
  -F "threshold=0.5" \
  -F "include_mask_png=true"
```

框提示（正负样本）示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/infer" \
  -F "file=@/data/example.jpg" \
  -F "mode=boxes" \
  -F "boxes=[[100,100,220,280,1],[240,90,320,180,0]]" \
  -F "threshold=0.5" \
  -F "include_mask_png=true"
```

### 4) 批量推理

- `POST /v1/infer_batch`
- `multipart/form-data`

字段：
- `files`: 多张图片

## MCP 适配层

当前仓库已新增独立 MCP 适配层，不影响现有 `run.py` 提供的 REST API。

新增文件：

- `app/mcp_adapter.py`
- `mcp_server.py`
- `run_mcp.py`
- `requirements-mcp.txt`

### 安装

MCP 适配层建议单独放到一个轻量环境里运行，不需要安装 `torch` 或模型权重依赖。

```bash
pip install -r requirements-mcp.txt
```

### 启动方式

stdio:

```bash
python run_mcp.py --transport stdio
```

Streamable HTTP:

```bash
python run_mcp.py --transport http --host 127.0.0.1 --port 8011 --mount-path /mcp
```

默认上游 REST 服务地址：

- `SAM3_API_BASE_URL=http://127.0.0.1:8001`

可选环境变量：

- `SAM3_MCP_TIMEOUT_SEC`
- `SAM3_MCP_HTTP_MOUNT_PATH`

### LiteLLM 接入示例

stdio 模式：

```yaml
mcp_servers:
  sam3:
    transport: stdio
    command: python
    args:
      - J:/project_code/sam3/sam3-api/run_mcp.py
      - --transport
      - stdio
    env:
      SAM3_API_BASE_URL: http://127.0.0.1:8001
```

Streamable HTTP 模式：

```yaml
mcp_servers:
  sam3:
    transport: http
    url: http://127.0.0.1:8011/mcp
```

### MCP Tool 列表

- `sam3_server_info`
- `sam3_health`
- `sam3_warmup`
- `sam3_image_infer_text`
- `sam3_image_infer_points`
- `sam3_image_infer_boxes`
- `sam3_image_infer_batch_text`
- `sam3_semantic_infer`
- `sam3_semantic_batch`
- `sam3_video_start_session`
- `sam3_video_get_session`
- `sam3_video_add_prompt`
- `sam3_video_propagate`
- `sam3_video_reset_session`
- `sam3_video_close_session`
- 其余参数同 `/v1/infer`（包含 `mode/points/boxes`）

返回每张图片的成功/失败状态，不会因单张失败中断整个批次。

示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/infer_batch" \
  -F "files=@/data/1.jpg" \
  -F "files=@/data/2.jpg" \
  -F "mode=text" \
  -F "prompt=dog" \
  -F "threshold=0.45"
```

### 5) 官方语义推理（当前图片）

- `POST /v1/semantic/infer`
- `multipart/form-data`

字段：
- `file`: 图片文件（必填）
- `prompt`: 当前类别/文本提示词（可选；为空时按官方语义 predictor 的 `visual` 模式处理）
- `boxes`: JSON 数组，至少包含 1 个正样本框，可混合负样本框
- `threshold`: 置信度阈值
- `include_mask_png`: 是否返回 mask PNG base64
- `max_detections`: 最大返回目标数

示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/semantic/infer" \
  -F "file=@/data/example.jpg" \
  -F "prompt=cat" \
  -F "boxes=[[100,100,220,280,1],[240,90,320,180,0]]" \
  -F "threshold=0.5"
```

### 6) 官方语义批量传播（全图集）

- `POST /v1/semantic/infer_batch`
- `multipart/form-data`

字段：
- `source_file`: 源图文件（必填）
- `files`: 目标图片列表（必填）
- `prompt`: 当前类别/文本提示词（可选；为空时按纯视觉 exemplar 传播处理）
- `boxes`: 源图上的正负样本框；至少 1 个正框
- `threshold`: 置信度阈值
- `include_mask_png`: 是否返回 mask PNG base64
- `max_detections`: 最大返回目标数

示例：

```bash
curl -X POST "http://127.0.0.1:8001/v1/semantic/infer_batch" \
  -F "source_file=@/data/source.jpg" \
  -F "files=@/data/1.jpg" \
  -F "files=@/data/2.jpg" \
  -F "prompt=cat" \
  -F "boxes=[[100,100,220,280,1],[240,90,320,180,0]]" \
  -F "threshold=0.5"
```

### 7) 视频会话推理（新增）

新增会话式接口，适合本地标注工具按“创建会话 -> 添加提示 -> 传播 -> 关闭会话”流程调用。

接口列表：
- `POST /v1/video/warmup`
- `POST /v1/video/session/start`
- `POST /v1/video/session/start_upload`
- `GET /v1/video/session/{session_id}`
- `POST /v1/video/session/add_prompt`
- `POST /v1/video/session/propagate`
- `POST /v1/video/session/remove_object`
- `POST /v1/video/session/reset`
- `POST /v1/video/session/close`

`start` 请求体示例：

```json
{
  "resource_path": "J:/datasets/demo.mp4"
}
```

说明：
- `resource_path` 支持 `MP4` 文件或 `JPEG` 帧目录。
- 当调用方与 `sam3-api` 不在同一台机器、路径不可达时，可使用 `start_upload` 直接上传视频文件并创建会话。
- `add_prompt` 默认使用像素坐标（`normalized=false`），可传：
  - `text`：文本提示词
  - `points`：`[[x,y,label], ...]`（label>0 视为正样本）
  - `boxes`：`[[x1,y1,x2,y2,label], ...]`
- `propagate` 支持方向：`forward` / `backward` / `both`。

`add_prompt` 请求体示例（文本）：

```json
{
  "session_id": "xxxx",
  "frame_index": 0,
  "text": "person, dog",
  "include_mask_png": false
}
```

`add_prompt` 请求体示例（点选）：

```json
{
  "session_id": "xxxx",
  "frame_index": 15,
  "points": [[320, 200, 1], [260, 180, 0]],
  "obj_id": 1,
  "include_mask_png": true
}
```

`propagate` 请求体示例：

```json
{
  "session_id": "xxxx",
  "propagation_direction": "forward",
  "start_frame_index": 15,
  "include_mask_png": false
}
```

## 环境变量

- `SAM3_API_DEVICE`: `cuda` / `cpu`（默认自动检测）
- `SAM3_API_CHECKPOINT`: `sam3.pt` 路径
- `SAM3_API_LOAD_FROM_HF`: `1` 时允许从 HF 拉取 checkpoint
- `SAM3_API_COMPILE`: `1` 时启用 compile
- `SAM3_API_DEFAULT_THRESHOLD`: 默认阈值（默认 `0.5`）
- `SAM3_API_WARMUP_ON_START`: `1` 时服务启动即预热模型
- `SAM3_API_CORS_ORIGINS`: 允许跨域来源，逗号分隔（默认 `*`）
- `SAM3_API_MAX_BATCH_FILES`: 批量接口最大文件数（默认 `32`）
- `SAM3_API_MAX_IMAGE_MB`: 单图最大大小 MB（默认 `50`）
- `SAM3_API_VIDEO_UPLOAD_DIR`: 视频上传缓存目录（默认 `sam3-api/data/uploads`）
- `SAM3_API_MAX_VIDEO_MB`: 上传视频最大大小 MB（默认 `4096`）
- `SAM3_API_VIDEO_FORCE_FP32_INPUTS`: `1` 时将视频会话输入帧转为 `float32`，避免部分环境下 `bfloat16/float` 类型冲突（默认 `1`）
- `SAM3_API_VIDEO_DISABLE_BF16_CONTEXT`: `1` 时关闭 SAM3 部分模块常驻 BF16 autocast 上下文，避免 `Input type (BFloat16) and bias type (float)` 错误（默认 `1`）

## 运行（服务器）

```bash
cd sam3-api
pip install -r requirements.txt
python run.py
```

默认监听：`0.0.0.0:8001`

## 部署建议

- 生产环境建议用 `gunicorn + uvicorn worker` 或容器化部署
- 单 GPU 推荐先用 1 个 worker（每个 worker 会加载一份模型）
- 接入 Nginx 并启用 Token/JWT 鉴权

## 与当前仓库结构的关系

本服务默认假设目录结构与当前项目一致：

- `sam3-api` 与 `sam3`、`sam3_checkpoints` 同级

如果你服务器结构不同，请使用 `SAM3_API_CHECKPOINT` 指定权重路径。
