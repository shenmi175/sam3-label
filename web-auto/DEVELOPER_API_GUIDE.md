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

### `GET /api/config/global`

查看全局配置和运行配置。

响应：

```json
{
  "config": {
    "cache_dir": "/data/web-auto",
    "upload_root": "/home/enabot/datasets",
    "allowed_data_roots": ["/home/enabot/datasets", "/media/enabot/disk/zmb_datas"],
    "default_upload_target_dir": "/home/enabot/datasets/uploads",
    "upload_target_dir": "/home/enabot/datasets",
    "sam3_api_base_url": "http://sam3-api:8001",
    "allowed_sam3_api_base_urls": ["http://sam3-api:8001"],
    "restart_supported": true
  }
}
```

### `POST /api/config/global`

保存全局配置。`upload_target_dir` 必须位于已挂载数据根目录之一内，`sam3_api_base_url` 必须位于允许列表内。

请求：

```json
{
  "cache_dir": "/data/web-auto",
  "upload_target_dir": "/home/enabot/datasets/default",
  "sam3_api_base_url": "http://sam3-api:8001"
}
```

### `POST /api/system/restart`

请求 web-auto 重启。Docker 部署时依赖 `restart: unless-stopped` 自动拉起新进程；重启前要求没有后台任务在运行。

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

### `DELETE /api/projects/{project_id}`

删除项目数据，不删除原始图片。

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

### `GET /api/uploads/config`

获取服务器允许上传的数据根目录。

响应：

```json
{
  "host_data_root": "/home/enabot/datasets",
  "default_target_dir": "/home/enabot/datasets"
}
```

### `POST /api/uploads/dataset`

上传一个本地文件到服务器数据目录。前端大数据集上传会逐个文件调用该接口，以便显示上传进度并避免单个超大 multipart 请求。

表单字段：

- `file`: 文件
- `target_dir`: 服务器目标目录，必须位于已挂载数据根目录之一内
- `relative_path`: 目标目录内的相对路径，可用于保留文件夹结构
- `overwrite`: 是否覆盖同名文件

响应：

```json
{
  "ok": true,
  "path": "/home/enabot/datasets/demo/images/0001.jpg",
  "relative_path": "demo/images/0001.jpg",
  "size": 1024
}
```

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
  "boxes": [[100, 100, 300, 300, 1], [320, 100, 420, 240, 0]],
  "threshold": 0.5,
  "api_base_url": "http://127.0.0.1:8001"
}
```

说明：

- 这就是前端“框选找同类”按钮应调用的接口
- 始终使用纯视觉提示；`active_class` 只用于保存结果类别
- `boxes` 第五位为标签：`1` 正框、`0` 负框，且至少需要一个正框

## 7. 图片批量推理

### 同步接口

### `POST /api/infer/batch`

同步全图文本批推。

### 任务接口

### `POST /api/infer/jobs/start_batch`

启动文本批推任务。

批量模式由 `mode` 字段决定：

- `mode="text"`（默认）：按 `classes` 做全图文本批推
- `mode="la_boxes"`：读取已保存标注中 `source_model="locate-anything"` 的框，按类别分组作为 box prompt 送入 sam3-api 得到分割结果，新的分割标注追加保存，原有 LA 框保留不删除；没有 LA 框的图片计入 `skipped`
  - 仅支持 `model_backend="sam3"`
  - 启动前会检查 sam3-api 可达且 locate-anything-api 未占用显存，否则返回 409 与 `code="SAM3_NOT_READY"`

`contour_mode` 适用于所有 sam3 推理接口（单图 / 预览 / 批量）：

- `"split"`（默认）：一个实例的每个连通域各生成一条标注
- `"merged"`：一个实例只生成一条标注，全部轮廓保存在 `polygons` 字段中

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

任务公共字段示例：

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
  "output_dir": "D:/export",
  "source_models": ["sam3", "manual"],
  "classes": [],
  "val_ratio": 0.0,
  "write_data_yaml": true
}
```

参数：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `project_id` | 必填 | 项目 id |
| `format` | 必填 | `coco` / `yolo` / `json` |
| `include_bbox` | `true` | 导出检测框。YOLO 下 `include_bbox` 且不含 mask 走 det 模式 |
| `include_mask` | `false` | 导出多边形。YOLO 下走 seg 模式（与 det 互斥，seg 优先） |
| `output_dir` | `null` | 留空时写入项目 `exports` 目录（旧行为是写进图片目录，已修正） |
| `source_models` | `["sam3", "manual"]` | 按标注来源筛选，可选 `sam3` / `locate-anything` / `manual` |
| `classes` | `[]` | 类别白名单，空表示使用项目类别表全部类别 |
| `val_ratio` | `0.0` | 仅 YOLO，`0~0.9`，划分验证集比例 |
| `write_data_yaml` | `true` | 仅 YOLO，是否写 `data.yaml` |

`source_models` 默认排除 `locate-anything`：LA 标注只有 bbox、没有轮廓，而 LA 框→分割生成的 SAM3 掩码标注与之一一对应，同时导出会让每个实例重复出现一次。

返回：

```json
{
  "ok": true,
  "output": "/path/to/exports/coco_20260731_120000",
  "classes": ["bed", "chair"],
  "stats": {
    "images_total": 40,
    "images_written": 38,
    "images_missing": 2,
    "annotations_total": 520,
    "annotations_written": 480,
    "skipped_source": 20,
    "skipped_class": 4,
    "skipped_no_polygon": 16,
    "skipped_no_bbox": 0,
    "by_source": { "sam3": 500, "manual": 20 },
    "by_class": { "bed": 300, "chair": 200 }
  }
}
```

`by_source` / `by_class` 统计的是通过来源+类别筛选后的标注数；`skipped_*` 分别是被来源、类别、无轮廓、无有效框跳过的数量。

筛选后一条标注都不剩（但项目本身有标注）时返回 400：

```json
{
  "code": "EXPORT_EMPTY",
  "message": "...",
  "by_source": { "locate-anything": 7951 },
  "by_class": { "bed": 7951 },
  "selected_sources": ["sam3", "manual"]
}
```

格式行为：

- 类别 id 只来自项目类别表（或 `classes` 白名单）的固定顺序，表外类别跳过并计入 `skipped_class`，同一项目多次导出 id 稳定。
- COCO：`include_mask=true` 时没有轮廓的标注会被跳过并计入 `skipped_no_polygon`，不再写出非法的 `segmentation: []`；merged 模式的多轮廓写成同一标注的多个子多边形。
- YOLO-seg：YOLO 格式没有多部件实例表示，merged 模式的每个轮廓会拆成独立一行（class id 相同）。掩码像素不丢，但实例行数会多于标注数。
- YOLO 产物：`classes.txt`、`labels/`、`train.txt`、`val.txt`（`val_ratio > 0` 时）、`data.yaml`（`write_data_yaml=true` 时）。
- train/val 划分由 `image_id` 的 sha1 决定，同一项目多次导出结果完全一致。
- **不复制也不软链图片**，`train.txt` / `val.txt` / `data.yaml` 直接引用原图绝对路径。
- 图片文件缺失时跳过该图并计入 `images_missing`，不会让整个导出失败。

### `POST /api/export/preview`

只统计、不写文件，供导出面板打开时填充来源/类别条数：

```json
{ "project_id": "prj_xxx" }
```

返回：

```json
{
  "ok": true,
  "project_id": "prj_xxx",
  "images_total": 120,
  "images_with_annotations": 118,
  "annotations_total": 54410,
  "classes": ["bed", "chair"],
  "by_source": { "sam3": 46458, "locate-anything": 7951, "manual": 1 },
  "by_class": { "bed": 30000, "chair": 24410 },
  "no_polygon_by_source": { "locate-anything": 7951, "sam3": 47 }
}
```

`no_polygon_by_source` 表示各来源下没有轮廓的标注数，用来提示用户勾选该来源后 mask 导出会跳过多少条。

## 10. UI 状态

这组接口是可选能力，供前端保存界面状态。

- `GET /api/ui_state`
- `POST /api/ui_state`

如果你的新前端不需要服务端存 UI 状态，可以不接。

## 11. 结论：你提到的能力是否缺失

这些能力已经有后端接口，不缺：

- 阈值设定
- API测试
- 类别添加
- 同图框选找同类
- 批量推理停止/继续
- 智能过滤任务化与预览复用

这次新增补齐的能力：

- 全局缓存目录接口 `/api/config/cache_dir`

## 12. 2026-03 Batch And Filter Update

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
  "operation_mode": "merge",
  "merge_mode": "same_class",
  "spatial_mode": "instance_cover",
  "coverage_threshold": 0.98,
  "area_mode": "instance",
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

- `operation_mode`: `merge`, `rule`, or `delete_unlabeled`
- `merge_mode`: `same_class` or `canonical_class`
- `spatial_mode`: `instance_cover` or `bbox_cover`
- `coverage_threshold`: remove the smaller instance when the larger instance covers at least this ratio of it
- `area_mode`: choose which instance is considered larger, by instance area or bbox area
- `rule_classes`: class scope for rule analysis
- `small_target_enabled + max_area_ratio`: object area ratio filter
- `instance_count_enabled + min/max_instances`: per-image scoped instance-count filter
- `position_enabled + center_x_half_width + center_y_half_height`: center-rectangle filter
- `confidence_enabled + min/max_confidence`: score range filter
- `delete_unlabeled`: preview and then delete images whose annotation list is empty; apply removes the image file, its `annotations/{image_id}.json`, and related project/index rows

Notes:

- `spatial_mode=instance_cover` prefers polygon/mask coverage and falls back to bbox coverage when instance geometry is unavailable
- `spatial_mode=bbox_cover` always uses bbox containment coverage
- `delete_unlabeled` is a physical delete and cannot be restored by smart-filter rollback
