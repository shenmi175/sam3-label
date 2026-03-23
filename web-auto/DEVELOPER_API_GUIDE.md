# web-auto Developer API Guide

`web-auto` 现在是纯后端 API 服务。默认无鉴权，默认返回 JSON，文件下载接口返回二进制流。

OpenAPI:

- `/docs`
- `/openapi.json`

Base URL:

- `http://127.0.0.1:8000`

## General

- 所有业务接口前缀均为 `/api`
- 图片和视频项目共用项目体系，通过 `project_type` 区分
- 图片列表采用分页接口，不建议一次拉全量图片
- 大批量任务优先使用任务接口，不建议前端直接调用同步批处理接口

## CORS

通过环境变量控制：

```bash
WEB_AUTO_ALLOW_ORIGINS=http://127.0.0.1:5173,http://localhost:3000
```

默认 `*`。

## Core Data Shapes

### Project

```json
{
  "id": "prj_xxx",
  "name": "demo",
  "project_type": "image",
  "image_dir": "D:/dataset/images",
  "video_path": "",
  "classes": ["cat", "dog"],
  "num_images": 12000,
  "labeled_images": 3180,
  "unlabeled_images": 8820,
  "content_rev": 42,
  "images": []
}
```

### Image Item

```json
{
  "id": "013ae78f871958ff",
  "rel_path": "subdir/a.jpg",
  "abs_path": "D:/dataset/images/subdir/a.jpg",
  "width": 1920,
  "height": 1080,
  "status": "labeled"
}
```

### Annotation

```json
{
  "id": "det_0001",
  "class_name": "person",
  "raw_label": "person",
  "score": 0.975594,
  "bbox": [0.0, 98.76, 249.11, 464.12],
  "polygon": [[182.0, 102.0], [158.0, 100.0]]
}
```

说明：

- `bbox` 为 `[x1, y1, x2, y2]`
- `polygon` 为二维点序列；无掩码时可为空或缺失
- 前端自定义标注时建议沿用这个结构

## Health

### `GET /`

服务元信息。可用于前端启动时探测服务模式。

### `GET /api/health`

返回：

```json
{
  "status": "ok",
  "service": "web-auto-api",
  "mode": "api_only",
  "projects": 3,
  "allowed_origins": ["*"]
}
```

### `POST /api/sam3/health`

检查远端 `sam3-api` 是否可用。

请求：

```json
{
  "api_base_url": "http://127.0.0.1:8001"
}
```

## Projects

### `GET /api/projects`

项目列表。

### `GET /api/projects/{project_id}?include_images=false`

获取单项目元数据。

说明：

- 大项目前端应始终使用 `include_images=false`
- 只有极小项目或特殊调试场景才建议 `include_images=true`

### `POST /api/projects/open`

创建项目。

图片项目：

```json
{
  "name": "demo-image",
  "project_type": "image",
  "image_dir": "D:/dataset/images",
  "save_dir": "D:/dataset/web-auto-output",
  "classes_text": "cat,dog,person"
}
```

视频项目：

```json
{
  "name": "demo-video",
  "project_type": "video",
  "video_path": "D:/dataset/video/demo.mp4",
  "save_dir": "D:/dataset/web-auto-output",
  "classes_text": "person,car"
}
```

### `DELETE /api/projects/{project_id}`

删除项目数据，不删除原始图片或原始视频。

## Image Pagination And Files

### `GET /api/projects/{project_id}/images`

参数：

- `offset`
- `limit`
- `image_id`，可用于反查所在页

返回：

```json
{
  "items": [],
  "total": 12000,
  "offset": 0,
  "limit": 200,
  "image_index": -1
}
```

### `POST /api/projects/{project_id}/images/refresh`

刷新图片目录，补录新图片。

### `POST /api/projects/{project_id}/images/import`

从另一个目录导入图片到当前项目图片目录。

### `POST /api/projects/{project_id}/images/upload`

表单上传图片文件。

### `GET /api/projects/{project_id}/images/{image_id}/file`

获取原始图片文件。

### `DELETE /api/projects/{project_id}/images/{image_id}`

删除项目中的一张图片及其标注。

## Classes

### `POST /api/projects/{project_id}/classes`

### `POST /api/projects/{project_id}/classes/add`

请求：

```json
{
  "classes_text": "cat,dog,person"
}
```

### `DELETE /api/projects/{project_id}/classes/{class_name}`

## Annotations

### `GET /api/projects/{project_id}/images/{image_id}/annotations`

读取单图标注。

### `POST /api/annotations/save`

覆盖保存单图标注。

```json
{
  "project_id": "prj_xxx",
  "image_id": "img_xxx",
  "annotations": []
}
```

### `POST /api/annotations/append`

追加标注，后端会补唯一 `id`。

## Image Inference

### `POST /api/infer`

单图直接推理并保存。

请求：

```json
{
  "project_id": "prj_xxx",
  "image_id": "img_xxx",
  "mode": "text",
  "classes": ["cat", "dog"],
  "active_class": "",
  "points": [],
  "boxes": [],
  "threshold": 0.5,
  "api_base_url": "http://127.0.0.1:8001"
}
```

`mode` 支持：

- `text`
- `points`
- `boxes`

### `POST /api/infer/preview`

与 `/api/infer` 类似，但只返回检测结果，不保存。

### `POST /api/infer/example_preview`

当前图范例分割预览。

请求：

```json
{
  "project_id": "prj_xxx",
  "image_id": "img_xxx",
  "active_class": "cat",
  "boxes": [[100, 100, 300, 300, 1]],
  "pure_visual": false,
  "threshold": 0.5,
  "api_base_url": "http://127.0.0.1:8001"
}
```

### `POST /api/infer/batch`

同步全图文本批量推理。大项目前端不建议直接使用。

### `POST /api/infer/batch_example`

同步范例传播。大项目前端不建议直接使用。

## Batch Infer Jobs

推荐使用任务接口。

### `POST /api/infer/jobs/start_batch`

启动文本批推任务。

### `POST /api/infer/jobs/start_batch_example`

启动范例传播任务。

### `GET /api/infer/jobs/active?project_id=...`

获取当前项目活动任务或暂停任务。

### `GET /api/infer/jobs/{job_id}`

轮询任务进度。

### `POST /api/infer/jobs/stop`

协作式停止。

### `POST /api/infer/jobs/resume`

继续剩余任务。继续时可带新的 `threshold`、`batch_size`、`api_base_url`。

任务公共字段：

```json
{
  "job_id": "job_xxx",
  "project_id": "prj_xxx",
  "job_type": "text_batch",
  "status": "running",
  "message": "处理中 10/12000: a.jpg",
  "progress_done": 10,
  "progress_total": 12000,
  "progress_pct": 0.083,
  "current_image_id": "img_xxx",
  "current_image_rel_path": "a.jpg",
  "result": {}
}
```

## Intelligent Filter

支持同步接口和任务接口。前端建议使用任务接口。

### Sync

- `POST /api/filter/intelligent/preview`
- `POST /api/filter/intelligent/apply`

### Job

- `POST /api/filter/intelligent/jobs/start_preview`
- `POST /api/filter/intelligent/jobs/start_apply`
- `GET /api/filter/intelligent/jobs/active?project_id=...`
- `GET /api/filter/intelligent/jobs/{job_id}`

请求：

```json
{
  "project_id": "prj_xxx",
  "merge_mode": "same_class",
  "coverage_threshold": 0.98,
  "canonical_class": "",
  "source_classes": [],
  "area_mode": "instance",
  "preview_token": ""
}
```

说明：

- `start_preview` 完成后会返回 `preview_token`
- `start_apply` 必须带上这个 `preview_token`
- 若预览后标注发生变化，或规则配置变化，后端会拒绝复用并要求重新预览
- `start_apply` 会直接复用上一次预览缓存结果，不再重复扫描项目

## Export

### `POST /api/export`

图片项目：

```json
{
  "project_id": "prj_xxx",
  "format": "coco",
  "include_bbox": true,
  "include_mask": false,
  "output_dir": "D:/export"
}
```

视频项目仅支持：

- `format=json`

## Video

### `GET /api/projects/{project_id}/video/file`

支持 Range 请求的视频流。

### `POST /api/projects/{project_id}/video/transcode_h264`

将视频转成更适合浏览器播放的 H.264。

### `GET /api/video/jobs/{project_id}`

获取视频传播任务状态。

### `POST /api/video/jobs/start`

启动视频语义传播任务。

### `POST /api/video/jobs/stop`

### `POST /api/video/jobs/resume`

### `POST /api/video/jobs/pause`

与 `stop` 同义。

## UI State

这组接口是可选能力，供前端保存用户界面状态。

- `GET /api/ui_state`
- `POST /api/ui_state`

如果你自己的前端不需要服务端存 UI 状态，可以不接。

## Frontend Integration Advice

- 列表页只拉项目元数据和图片分页，不要拉全量图片
- 图片内容用 `/images/{image_id}/file`
- 标注面板切图时只拉单图标注
- 大任务统一走任务接口，并轮询 `job_id`
- 智能过滤确认合并必须复用 `preview_token`
- 前端应自行处理大列表虚拟滚动、图片缓存和任务恢复
