# sam3-api Developer Guide

更新时间: 2026-03-19
位置: `J:\project_code\sam3\sam3-api`

## 1. 总览

`sam3-api` 当前包含三条能力链路:

1. 原生单图推理
- 实现: `app/engine.py`
- 入口:
  - `POST /v1/infer`
  - `POST /v1/infer_batch`
- 适用:
  - 文本检索式单图分割
  - 点提示单图修正
  - 框提示单图修正

2. Ultralytics 图像语义分割
- 实现: `app/semantic_engine.py`
- 入口:
  - `POST /v1/semantic/infer`
  - `POST /v1/semantic/infer_batch`
- 适用:
  - 当前图 concept segmentation
  - 源图范例向多张目标图传播

3. Ultralytics 视频语义跟踪
- 实现: `app/video_semantic_engine.py`
- 底层: `SAM3VideoSemanticPredictor`
- 入口:
  - `POST /v1/video/session/start`
  - `POST /v1/video/session/start_upload`
  - `GET /v1/video/session/{session_id}`
  - `POST /v1/video/session/add_prompt`
  - `POST /v1/video/session/propagate`
  - `POST /v1/video/session/reset`
  - `POST /v1/video/session/close`
- 适用:
  - 文本概念跨视频跟踪
  - 基于框提示的跨视频跟踪
  - 会话级 `threshold` 和 `imgsz` 调整

## 2. 健康检查与预热

### `GET /health`

返回三条链路的加载状态:

- `model_loaded`
- `semantic_model_loaded`
- `video_model_loaded`
- `device`
- `checkpoint_path`

示例:

```bash
curl http://127.0.0.1:8001/health
```

### `POST /v1/warmup`

预热原生单图推理模型。

### `POST /v1/semantic/warmup`

预热 Ultralytics 图像语义模型。

### `POST /v1/video/warmup`

预热 Ultralytics 视频语义模型。

## 3. 图像接口

### `POST /v1/infer`

统一单图入口，支持:

- `mode=text`
- `mode=points`
- `mode=boxes`

表单字段:

- `file`: 必填
- `mode`: `text | points | boxes`
- `prompt`: 文本提示
- `points`: JSON 数组，仅 `points` 模式使用
- `boxes`: JSON 数组，仅 `boxes` 模式使用
- `point_box_size`
- `threshold`
- `include_mask_png`
- `max_detections`

说明:

- 这条链路的图像输入尺寸固定对齐原生 image model。
- 对非默认 `input_size` 的请求会收敛到默认值，不再先报错再回退。

### `POST /v1/semantic/infer`

当前图官方语义分割。

必需条件:

- `prompt` 非空
- `boxes` 非空
- 至少一个正框

### `POST /v1/semantic/infer_batch`

源图范例传播到多张目标图。

表单字段:

- `source_file`: 源图
- `files`: 多张目标图
- `prompt`
- `boxes`
- `threshold`
- `include_mask_png`
- `max_detections`
- `input_size`

## 4. 视频语义会话接口

### 4.1 设计说明

视频会话链路已切换到 Ultralytics 官方语义视频 predictor。

当前真实支持的提示类型:

- `text`
- `boxes`

当前不支持:

- `points`
- `remove_object`

其中:

- `points` 在 `add_prompt` 会返回 `400`
- `remove_object` 会返回 `400`

### 4.2 `POST /v1/video/session/start`

从服务端可访问的视频路径启动会话。

请求体:

```json
{
  "resource_path": "J:/videos/demo.mp4",
  "session_id": "optional-session-id",
  "threshold": 0.5,
  "imgsz": 640
}
```

字段说明:

- `resource_path`: 必填，服务端可访问的视频文件路径
- `session_id`: 可选，自定义会话 ID
- `threshold`: 可选，会话级置信度阈值，范围 `[0, 1]`
- `imgsz`: 可选，会话级 Ultralytics 输入尺寸

返回示例:

```json
{
  "session_id": "6c2f4f6a...",
  "resource_path": "J:\\videos\\demo.mp4",
  "num_frames": 812,
  "width": 1920,
  "height": 1080,
  "threshold": 0.5,
  "imgsz": [644, 644]
}
```

说明:

- `imgsz` 返回的是实际生效尺寸。
- Ultralytics 可能按步长自动调整，比如你传 `640`，最终返回可能是邻近合法值。

### 4.3 `POST /v1/video/session/start_upload`

上传视频并启动会话。

表单字段:

- `file`: 必填，视频文件
- `session_id`: 可选
- `threshold`: 可选
- `imgsz`: 可选

示例:

```bash
curl -X POST "http://127.0.0.1:8001/v1/video/session/start_upload" \
  -F "file=@/data/demo.mp4" \
  -F "threshold=0.4" \
  -F "imgsz=640"
```

### 4.4 `GET /v1/video/session/{session_id}`

查询会话信息。

返回字段:

- `session_id`
- `resource_path`
- `num_frames`
- `width`
- `height`
- `threshold`
- `imgsz`
- `has_text_prompt`

### 4.5 `POST /v1/video/session/add_prompt`

在指定帧上添加文本或框提示，并返回该提示帧的结果。

请求体:

```json
{
  "session_id": "6c2f4f6a...",
  "frame_index": 0,
  "text": "person, forklift",
  "boxes": [[100, 120, 360, 600, 1]],
  "normalized": false,
  "include_mask_png": true,
  "max_detections": 200
}
```

字段说明:

- `session_id`: 必填
- `frame_index`: 必填
- `text`: 可选，逗号分隔时会拆成多类
- `boxes`: 可选，`[x1, y1, x2, y2, label]`
- `normalized`: 可选，`true` 时按 `[0, 1]` 归一化坐标解释
- `include_mask_png`: 可选
- `max_detections`: 可选

规则:

- `text` 和 `boxes` 至少提供一个
- `points` 不支持
- 框模式下推荐只传正框

返回示例:

```json
{
  "session_id": "6c2f4f6a...",
  "frame_index": 0,
  "num_detections": 2,
  "detections": [
    {
      "id": "det_0001",
      "obj_id": 1,
      "label": "person",
      "class_id": 0,
      "score": 0.913201,
      "bbox_xyxy": [101.2, 118.8, 358.1, 601.4],
      "bbox_xywh": [101.2, 118.8, 256.9, 482.6],
      "area": 48922
    }
  ]
}
```

### 4.6 `POST /v1/video/session/propagate`

从指定帧开始沿视频传播。

请求体:

```json
{
  "session_id": "6c2f4f6a...",
  "propagation_direction": "forward",
  "start_frame_index": 1,
  "max_frame_num_to_track": 120,
  "include_mask_png": false,
  "max_detections": 200,
  "max_frames": 0
}
```

字段说明:

- `propagation_direction`: `forward | backward | both`
- `start_frame_index`: 可选
- `max_frame_num_to_track`: 可选
- `include_mask_png`: 可选
- `max_detections`: 可选
- `max_frames`: 可选，限制返回帧数

返回示例:

```json
{
  "session_id": "6c2f4f6a...",
  "num_frames": 120,
  "frames": [
    {
      "frame_index": 1,
      "num_detections": 2,
      "detections": []
    }
  ],
  "truncated": false,
  "latency_ms": 2842.117
}
```

### 4.7 `POST /v1/video/session/reset`

清空当前会话的语义跟踪状态，但保留视频源、`threshold` 和 `imgsz`。

请求体:

```json
{
  "session_id": "6c2f4f6a..."
}
```

### 4.8 `POST /v1/video/session/close`

关闭会话并释放资源。

请求体:

```json
{
  "session_id": "6c2f4f6a..."
}
```

### 4.9 `POST /v1/video/session/remove_object`

当前语义视频链路不支持删除单个对象。

调用会返回 `400`:

```json
{
  "detail": "remove_object is not supported in semantic video sessions"
}
```

## 5. Python 调用示例

### 5.1 启动视频语义会话

```python
import requests

resp = requests.post(
    "http://127.0.0.1:8001/v1/video/session/start",
    json={
        "resource_path": r"J:\videos\demo.mp4",
        "threshold": 0.45,
        "imgsz": 640,
    },
    timeout=120,
)
resp.raise_for_status()
data = resp.json()
print(data["session_id"], data["imgsz"])
```

### 5.2 文本提示后前向传播

```python
import requests

session_id = "your-session-id"

requests.post(
    "http://127.0.0.1:8001/v1/video/session/add_prompt",
    json={
        "session_id": session_id,
        "frame_index": 0,
        "text": "person, forklift",
        "include_mask_png": False,
    },
    timeout=120,
).raise_for_status()

resp = requests.post(
    "http://127.0.0.1:8001/v1/video/session/propagate",
    json={
        "session_id": session_id,
        "propagation_direction": "forward",
        "start_frame_index": 1,
        "max_frame_num_to_track": 120,
        "include_mask_png": False,
    },
    timeout=600,
)
resp.raise_for_status()
frames = resp.json()["frames"]
print(len(frames))
```

### 5.3 框提示后前向传播

```python
import requests

session_id = "your-session-id"

requests.post(
    "http://127.0.0.1:8001/v1/video/session/add_prompt",
    json={
        "session_id": session_id,
        "frame_index": 12,
        "boxes": [[180, 120, 360, 420, 1]],
        "normalized": False,
        "include_mask_png": True,
    },
    timeout=120,
).raise_for_status()
```

## 6. 错误处理建议

### 400

表示调用参数不合法，常见原因:

- `threshold` 不在 `[0, 1]`
- `frame_index` 越界
- `text` 和 `boxes` 都为空
- 给视频语义接口传了 `points`
- 调用了 `remove_object`

### 404

常见原因:

- `session_id` 不存在
- `resource_path` 找不到

### 500

常见原因:

- 模型未正常加载
- 视频文件解码失败
- 第三方依赖异常

### 507

表示显存或内存不足。

## 7. `web-auto` 对接建议

视频项目推荐按下面方式调用:

- 文本传播:
  - `start/start_upload` 设置 `threshold` 和 `imgsz`
  - `add_prompt` 只传 `text`
  - `propagate` 用 `forward`

- 框传播:
  - `start/start_upload` 设置 `threshold` 和 `imgsz`
  - `add_prompt` 只传 `boxes`
  - `propagate` 用 `forward`

不要再把旧的点提示路径映射到视频工作流。

## 8. 关键代码入口

- 路由: `app/main.py`
- 原生图像引擎: `app/engine.py`
- 图像语义引擎: `app/semantic_engine.py`
- 视频语义引擎: `app/video_semantic_engine.py`

## 9. MCP Adapter

为保证不影响现有 REST 调用方式，MCP 适配层是独立进程，不修改 `run.py` 或任何现有 `/v1/*` 路由。

文件：

- `app/mcp_adapter.py`
- `mcp_server.py`
- `run_mcp.py`
- `requirements-mcp.txt`

建议：

- MCP 适配层单独运行在轻量环境里
- 不需要安装 `torch`、`ultralytics`、模型权重
- 只需要能访问现有 `sam3-api` HTTP 服务

设计：

- MCP Server 不直接调用模型，而是通过 HTTP 调现有 `sam3-api`
- 同时支持 `stdio` 和 `Streamable HTTP`
- 更适合 LiteLLM 集成

环境变量：

- `SAM3_API_BASE_URL`
- `SAM3_MCP_TIMEOUT_SEC`
- `SAM3_MCP_HTTP_MOUNT_PATH`

启动：

```bash
python run_mcp.py --transport stdio
python run_mcp.py --transport http --host 127.0.0.1 --port 8011 --mount-path /mcp
```

LiteLLM 示例：

stdio:

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

HTTP:

```yaml
mcp_servers:
  sam3:
    transport: http
    url: http://127.0.0.1:8011/mcp
```
