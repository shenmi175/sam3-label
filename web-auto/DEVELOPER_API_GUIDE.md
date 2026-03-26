# web-auto Developer API Guide

`web-auto` 现在是纯后端 API 服务，默认无鉴权，默认返回 JSON。

基础信息：

- Base URL: `http://127.0.0.1:8000`
- OpenAPI: `/docs`
- OpenAPI JSON: `/openapi.json`

## 1. 服务与配置

### `GET /`

返回服务元信息。

### `GET /api/health`

返回服务健康状态。

### `POST /api/sam3/health`

测试远端 `sam3-api` 是否可用。

请求：

```json
{
  "api_base_url": "http://127.0.0.1:8001"
}
```

说明：

- 这就是前端“API测试”按钮应调用的接口

### `GET /api/config/cache_dir`

查看当前后端数据目录。

响应：

```json
{
  "cache_dir": "J:/project_code/sam3/web-auto/data",
  "default_dir": "J:/project_code/sam3/web-auto"
}
```

### `POST /api/config/cache_dir`

切换后端数据目录。

请求：

```json
{
  "cache_dir": "D:/web-auto-data"
}
```

响应：

```json
{
  "ok": true,
  "cache_dir": "D:/web-auto-data",
  "message": "Storage directory updated successfully."
}
```

说明：

- 切换时要求当前没有后台任务在运行
- 后端会重新实例化 `Storage`

## 2. 项目管理

### `GET /api/projects`

项目列表。

### `GET /api/projects/{project_id}?include_images=false`

获取单项目。

说明：

- 大数据集前端应始终使用 `include_images=false`

### `POST /api/projects/open`

创建项目。

图片项目：

```json
{
  "name": "demo-image",
  "project_type": "image",
  "image_dir": "D:/dataset/images",
  "save_dir": "D:/dataset/output",
  "classes_text": "cat,dog,person"
}
```

视频项目：

```json
{
  "name": "demo-video",
  "project_type": "video",
  "video_path": "D:/dataset/video/demo.mp4",
  "save_dir": "D:/dataset/output",
  "classes_text": "person,car"
}
```

### `DELETE /api/projects/{project_id}`

删除项目数据，不删除原始图片或原始视频。

## 3. 类别管理

### `POST /api/projects/{project_id}/classes`

### `POST /api/projects/{project_id}/classes/add`

添加类别。

请求：

```json
{
  "classes_text": "cat,dog,person"
}
```

说明：

- 这就是前端“类别添加”功能应调用的接口
- `/classes` 与 `/classes/add` 当前行为一致，推荐统一使用 `/classes/add`

### `DELETE /api/projects/{project_id}/classes/{class_name}`

删除单个类别。

## 4. 图片列表与文件

### `GET /api/projects/{project_id}/images`

参数：

- `offset`
- `limit`
- `image_id`

响应：

```json
{
  "items": [],
  "total": 12000,
  "offset": 0,
  "limit": 200,
  "image_index": -1
}
```

### `GET /api/projects/{project_id}/images/unlabeled`

用于快速定位下一张未标注图片，适合大数据集场景。

参数：

- `after_image_id`
  可选。从当前图片之后开始查找；如果后续没有未标注图片，会回绕到第一张未标注图片。
- `direction`
  可选。`next` 或 `prev`，用于向后/向前查找未标注图片。

响应：

```json
{
  "image": {
    "id": "img_123",
    "rel_path": "000123.jpg",
    "abs_path": "D:/dataset/images/000123.jpg",
    "status": "unlabeled"
  },
  "image_index": 123
}
```

### `POST /api/projects/{project_id}/images/refresh`

刷新图片目录。

### `POST /api/projects/{project_id}/images/import`

导入图片目录。

### `POST /api/projects/{project_id}/images/upload`

表单上传图片。

### `GET /api/projects/{project_id}/images/{image_id}/file`

获取原图文件。

### `DELETE /api/projects/{project_id}/images/{image_id}`

删除图片及其标注。

## 5. 标注读写

### `GET /api/projects/{project_id}/images/{image_id}/annotations`

获取单图标注。

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

追加保存标注。

## 6. 图片推理

### 6.1 单图推理

### `POST /api/infer`

单图推理并保存。

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

说明：

- `threshold` 就是前端的阈值设定
- `api_base_url` 就是前端填写的 `sam3-api` 地址

`mode` 支持：

- `text`
- `points`
- `boxes`

### `POST /api/infer/preview`

单图推理预览，不保存。

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

说明：

- 这就是前端“范例分割”按钮应调用的接口

## 7. 图片批量推理

### 同步接口

### `POST /api/infer/batch`

同步全图文本批推。

### `POST /api/infer/batch_example`

同步范例传播。

说明：

- 这就是前端“范例传播”对应的同步接口
- 大项目不建议直接用同步接口，推荐任务接口

### 任务接口

### `POST /api/infer/jobs/start_batch`

启动文本批推任务。

### `POST /api/infer/jobs/start_batch_example`

启动范例传播任务。

### `GET /api/infer/jobs/active?project_id=...`

获取项目当前活动任务或暂停任务。

### `GET /api/infer/jobs/{job_id}`

轮询任务详情。

### `POST /api/infer/jobs/stop`

协作式停止。

### `POST /api/infer/jobs/resume`

继续任务。

说明：

- 继续时可以带新的 `threshold`
- 继续时可以带新的 `batch_size`
- 继续时可以带新的 `api_base_url`
- 继续范例传播时也可以调整 `active_class`、`boxes`、`pure_visual`

任务公共字段示例：

```json
{
  "job_id": "job_xxx",
  "project_id": "prj_xxx",
  "job_type": "example_batch",
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

## 8. 智能过滤

### 同步接口

- `POST /api/filter/intelligent/preview`
- `POST /api/filter/intelligent/apply`

### 任务接口

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
- `start_apply` 必须带同一次预览返回的 `preview_token`
- 确认合并会直接复用预览缓存结果，不再重复扫描项目

## 9. 导出

### `POST /api/export`

图片项目导出：

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

## 10. 视频文件与帧

### `GET /api/projects/{project_id}/video/file`

视频文件流，支持 `Range`。

### `GET /api/projects/{project_id}/video/stream`

与 `/video/file` 等价，给前端播放器使用。

### `GET /api/projects/{project_id}/video/frame/{frame_index}`

读取指定帧，返回 `image/jpeg`。

### `POST /api/projects/{project_id}/video/transcode_h264`

转码为更适合浏览器播放的 H.264。

## 11. 视频标注数据

### `GET /api/projects/{project_id}/video/annotations`

获取整段视频标注数据。

响应示例：

```json
{
  "annotations": {
    "project_id": "prj_xxx",
    "project_type": "video",
    "video_name": "demo",
    "num_frames": 100,
    "classes": ["person"],
    "frames": [
      {
        "frame_index": 0,
        "image_id": "img_xxx",
        "file_name": "demo_000000.jpg",
        "annotations": []
      }
    ]
  },
  "annotation_json_path": "D:/output/prj_xxx/demo_annotations.json"
}
```

### `POST /api/projects/{project_id}/video/annotations/save`

保存整段视频标注或部分帧标注。

请求：

```json
{
  "project_id": "prj_xxx",
  "replace_all": true,
  "frames": [
    {
      "frame_index": 0,
      "image_id": "img_xxx",
      "annotations": []
    }
  ]
}
```

说明：

- `replace_all=true` 时，未出现在 `frames` 里的帧会被清空
- `replace_all=false` 时，只更新请求中给出的帧
- 保存后后端会同步更新导出的 `video_annotations.json`

## 12. 视频传播任务

### `GET /api/video/jobs/{project_id}`

获取视频传播任务状态。

### `POST /api/video/jobs/start`

启动视频传播任务。

请求字段包括：

- `classes`
- `prompt_mode`
- `active_class`
- `points`
- `boxes`
- `threshold`
- `imgsz`
- `segment_size_frames`
- `start_frame_index`
- `end_frame_index`
- `prompt_frame_index`
- `api_base_url`

### `POST /api/video/jobs/stop`

### `POST /api/video/jobs/pause`

暂停/停止视频任务。

### `POST /api/video/jobs/resume`

继续视频任务，并允许更新：

- `classes`
- `threshold`
- `imgsz`
- `api_base_url`
- `prompt_mode`
- `prompt_frame_index`
- `active_class`
- `boxes`
- `segment_size_frames`

## 13. UI 状态

这组接口是可选能力，供前端保存界面状态。

- `GET /api/ui_state`
- `POST /api/ui_state`

如果你的新前端不需要服务端存 UI 状态，可以不接。

## 14. 结论：你提到的能力是否缺失

这些能力已经有后端接口，不缺：

- 阈值设定
- API测试
- 类别添加
- 范例分割
- 范例传播
- 批量推理停止/继续
- 智能过滤任务化与预览复用

这次新增补齐的能力：

- 视频流别名接口 `/api/projects/{project_id}/video/stream`
- 视频帧读取接口 `/api/projects/{project_id}/video/frame/{frame_index}`
- 视频标注读取接口 `/api/projects/{project_id}/video/annotations`
- 视频标注保存接口 `/api/projects/{project_id}/video/annotations/save`
- 全局缓存目录接口 `/api/config/cache_dir`

## 15. 2026-03 Batch And Filter Update

### `POST /api/infer/jobs/start_batch`

Additional request fields:

```json
{
  "project_id": "prj_xxx",
  "classes": ["cat", "dog"],
  "scope_mode": "all",
  "related_classes": [],
  "retry_image_ids": [],
  "image_ids": [],
  "all_images": true,
  "batch_size": 8,
  "threshold": 0.5,
  "api_base_url": "http://127.0.0.1:8001"
}
```

`scope_mode` values:

- `all`
- `unlabeled`
- `class_related`
- `class_related_unlabeled`

Result / job fields added for large-dataset review:

- `processed_images`
- `saved_images`
- `failed_images`
- `skipped_images`
- `failed_image_ids`
- `skipped_image_ids`
- `retry_image_ids`
- `class_additions`
- `image_results`
- `selection`

### Smart Filter Job Payload

Additional request fields:

```json
{
  "rule_classes": ["cat", "dog"],
  "small_target_enabled": false,
  "max_area_ratio": 0.02,
  "instance_count_enabled": false,
  "min_instances": 1,
  "max_instances": 0,
  "position_enabled": false,
  "center_x_half_width": 0.25,
  "center_y_half_height": 0.05,
  "confidence_enabled": false,
  "min_confidence": 0.0,
  "max_confidence": 1.0
}
```

Meaning:

- `rule_classes`: class scope for rule analysis
- `small_target_enabled + max_area_ratio`: object area ratio filter
- `instance_count_enabled + min/max_instances`: per-image scoped instance-count filter
- `position_enabled + center_x_half_width + center_y_half_height`: center-rectangle filter
- `confidence_enabled + min/max_confidence`: score range filter
