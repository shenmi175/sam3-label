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
  "cache_dir": "/srv/sam3-auto-label/web-auto/data",
  "default_dir": "/srv/sam3-auto-label/web-auto"
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
    "upload_root": "/mnt/datasets",
    "allowed_data_roots": ["/mnt/datasets", "/srv/shared-datasets"],
    "default_upload_target_dir": "/mnt/datasets/uploads",
    "upload_target_dir": "/mnt/datasets",
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
  "upload_target_dir": "/mnt/datasets/default",
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
- `status`
- `class_name`
- `source_model`

当同时传入 `class_name` 和 `source_model` 时，只返回该标注来源下包含该类别的图片；
前端图片类别筛选使用“推理设置”中的后端作为 `source_model`。

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
  "host_data_root": "/mnt/datasets",
  "default_target_dir": "/mnt/datasets"
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
  "path": "/mnt/datasets/demo/images/0001.jpg",
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
  "save_ai_features": false,
  "api_base_url": "http://127.0.0.1:8001"
}
```

说明：

- `threshold` 就是前端的阈值设定
- `api_base_url` 就是前端填写的 `sam3-api` 地址

`mode` 支持：

- `text`
- `points`

### `POST /api/infer/preview`

单图推理预览，不保存。

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

所有 sam3 推理接口固定使用单实例格式：一个模型实例只生成一条标注，全部连通区域保存在
`polygons`，实际数量写入 `component_count`。请求不再接受 `contour_mode`。

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
  "schema_version": 2,
  "project_id": "prj_xxx",
  "task_type": "deduplicate_same_class",
  "class_scope": {"mode": "all", "classes": []},
  "params": {
    "spatial_mode": "instance_cover",
    "coverage_threshold": 0.98
  },
  "preview_token": ""
}
```

说明：

- `start_preview` 完成后会返回 `preview_token`
- `start_apply` 必须带同一次预览返回的 `preview_token`
- 每个 v2 请求只运行一个 `task_type`；`params` 严格拒绝该任务不认识的字段
- `class_scope.mode` 必须显式为 `all` 或 `selected`；`selected` 必须提供非空 `classes`
- 应用会直接复用预览阶段生成的 annotation-ID 变更计划，不再重复扫描项目
- 所有任务都通过 `preview_samples` 返回一张按实际影响量选择的稳定中位数样例；目标框以描边显示，分割以真实蒙版显示：

```json
{
  "preview_samples": [
    {
      "image_id": "img_xxx",
      "rel_path": "images/a.jpg",
      "kind": "annotation_change",
      "geometry_type": "mixed",
      "annotation_count": 12,
      "candidate_count": 4,
      "relabel_count": 0,
      "before_url": "/api/filter/intelligent/artifacts/sfp_xxx/samples/img_xxx_mixed_before.webp",
      "after_url": "/api/filter/intelligent/artifacts/sfp_xxx/samples/img_xxx_mixed_after.webp"
    }
  ]
}
```

`kind` 为 `annotation_change` 或 `image_delete`；`geometry_type` 为 `mixed`、`segmentation` 或 `image`。`annotation_count`、`candidate_count` 和 `relabel_count` 是当前样本计数。同类去重始终按几何类型隔离：目标框只和目标框比较，分割只和分割比较；阈值使用原始浮点值判断。类别归一只改类，不做空间匹配或删除。除永久删除无标注图片外，其余任务共享预览、确认应用与完整 JSON/Mask 回滚流程。旧顶层计数和 `operation_mode` 暂留一版兼容，新客户端应使用 `task_type`、`effect_type`、`summary`、`hits` 与 `warnings`。

预览结果同时返回版本化产物状态：

```json
{
  "preview_artwork": {
    "version": 1,
    "status": "ready",
    "error_code": ""
  }
}
```

- `ready`：已生成对比图。
- `not_needed`：没有命中项，不需要生成对比图。
- `failed`：统计仍有效，但对比图生成失败；应用请求必须额外传 `confirm_preview_failure: true`，否则被拒绝。

当前任务类型为：`remove_small_components`、`remove_edge_spurs`、`shortest_bridge`、`morph_close`、`fill_small_holes`、`deduplicate_same_class`、`remove_small_instances`、`remove_confidence_range`、`remove_position_region`、`delete_by_box_count`、`normalize_classes`、`delete_unlabeled_images`。v1 请求只在能无歧义对应一个任务时迁移；同时启用多个功能会返回 `ambiguous_legacy_filter` 和冲突列表。

## 9. 导出

### `POST /api/export`

执行已经预检并确认的 profile 导出：

```json
{
  "project_id": "prj_xxx",
  "profile": "yolo_instance",
  "output_dir": "/srv/exports",
  "source_models": ["sam3", "manual"],
  "classes": ["bed", "chair"],
  "val_ratio": 0.2,
  "yolo_multipart_policy": "official_bridge",
  "image_mode": "none",
  "expected_content_rev": 12,
  "confirmed_issue_codes": ["YOLO_MULTIPART_BRIDGE"]
}
```

`profile` 必须是 `native_json_v2`、`coco_detection`、`coco_instance`、`yolo_detection`、`yolo_instance` 之一。`source_models` 和 `classes` 必须显式提供至少一项；所有 profile 都使用 `expected_content_rev` 防止预检后内容变化。

成功返回服务器产物路径和统一统计：

```json
{
  "ok": true,
  "profile": "yolo_instance",
  "output": "/srv/exports/project_yolo_instance_20260819_120000",
  "classes": ["bed", "chair"],
  "stats": {
    "images_total": 40,
    "images_written": 40,
    "negative_images": 2,
    "raw_records_total": 480,
    "canonical_instances_total": 470,
    "canonical_instances_selected": 470,
    "annotations_selected": 470,
    "instances_written": 470,
    "regions_written": 492,
    "multipart_instances": 22,
    "output_records": 470
  }
}
```

格式行为：

- 导出按图片调用 `parse_image_annotations`，筛选和规范化均消费 canonical 实例。带 `contour_index` 或 `contour_count` 的旧拆分记录返回 `UNSUPPORTED_SPLIT_ANNOTATION` 并阻断，不再运行时重组。
- 历史拆分标注已经完成一次性迁移；运行时不再提供旧数据迁移 CLI。
- detection profile 接受 bbox-only；polygon 无效但 bbox 有效时会警告并回退到 bbox。instance profile 遇到 bbox-only 时会在用户明确确认后跳过，遇到无效 polygon 仍会阻断。有效区域的 BBox 和 area 均从最终规范化几何重新计算。
- `image_mode=none` 时 Native JSON、COCO 和 YOLO 均输出 ZIP；ZIP 内每张项目图片对应一个标注文件，负样本对应空标注文件，不生成全项目共用的单一标注文件。
- COCO 的每个 `annotations/**/*.json` 都是可独立加载的单图 COCO 文档。COCO detection 每个实例写一个仅含紧致 BBox 的 annotation；COCO instance 在同一个 annotation 的 `segmentation` polygon list 中保留多个区域。类别 ID 为 1-based。
- YOLO detection 使用 0-based 归一化 union BBox。YOLO instance 单区域写一行；multipart 的 `official_bridge` 使用 Ultralytics 官方 `merge_multi_segment` 保持一实例一行，必须确认；`reject` 直接阻断。
- 默认 YOLO ZIP 包含按 `labels/train/`、`labels/val/` 划分的逐图标签、`classes.txt`、`image_index.json`、`manifest.json`、README 和 `train.txt` / `val.txt`，不生成 `data.yaml`，负样本保留空标签。
- 所有 profile 的 `image_mode` 均支持 `none`、`symlink`、`copy`：`none` 输出标注 ZIP；`symlink` 输出目录并在 `images/` 创建原图绝对软链接；`copy` 输出可移动目录并复制原图。YOLO 的图片与标签进一步按 train/val 分目录，并生成可供 Ultralytics 直接训练的 `data.yaml`。旧参数 `link_images=true` 仍兼容并等价于 `image_mode=symlink`。
- train/val 划分由 `image_id` 的 sha1 决定，同一项目多次导出结果完全一致。
- 所有产物均在临时位置验证后发布，并使用唯一名称，绝不覆盖旧产物。

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

### `POST /api/export/preflight`

所有 profile 共用本接口预检，只检查、不写文件：

```json
{
  "project_id": "prj_xxx",
  "profile": "yolo_instance",
  "output_dir": "/srv/exports",
  "source_models": ["sam3", "manual"],
  "classes": ["bed", "chair"],
  "val_ratio": 0.2,
  "yolo_multipart_policy": "official_bridge",
  "image_mode": "none",
  "confirmed_issue_codes": []
}
```

返回 `project_content_rev`、统一统计、`warnings`、`blockers`、`confirmation_required_codes` 和格式专用 `format_details`。YOLO bridge 报告受影响实例数、连接数、新增像素、桥接前后像素面积、IoU 和面积变化，不设置自动质量阈值：

```json
{
  "ok": true,
  "profile": "yolo_instance",
  "project_content_rev": 12,
  "confirmation_required_codes": ["YOLO_MULTIPART_BRIDGE"],
  "format_details": {
    "multipart_bridge": {
      "affected_instances": 22,
      "connections": 24,
      "added_pixels": 180,
      "iou": 0.9912,
      "area_change_ratio": 0.0089
    }
  },
  "warnings": [{ "code": "YOLO_MULTIPART_BRIDGE", "severity": "warning", "count": 22 }],
  "blockers": []
}
```

存在 blocker 时 `ok=false`。导出时缺少所需确认返回 `409 EXPORT_CONFIRMATION_REQUIRED`；版本变化返回 `409 EXPORT_STALE`；其他预检阻断返回 `400 EXPORT_PREFLIGHT_BLOCKED`。执行数据清洗后必须重新预检。

Native JSON v2 ZIP 结构：

```text
manifest.json
classes.json
image_index.json
README.txt
annotations/<图片相对目录>/<标注文件名>.json
```

- schema 为 `web-auto.annotation-bundle.v2`；逐图文件包含图像引用和规范化的 `instances[]/regions[]`。
- 多区域实例保持一个实例、多条 region；BBox 和面积由有效区域重新计算，bbox-only 实例保留有效 BBox。
- 未知安全元数据放入 `attributes`；递归删除 mask/overlay/Base64、内部资源地址和绝对路径。
- ZIP 只允许 JSON 和固定 `README.txt`，不包含原图、mask PNG、overlay 或任何图像二进制。
- `image_index.json` 提供原图相对路径、标注路径和可用的宽高，供接收方绑定自己的图像。
- ZIP 先在目标目录生成临时文件，通过校验后原子改名；同名时自动追加序号，不覆盖已有导出。

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
- `feature_failed`

`save_ai_features` 仅对 `mode="text"` 且 SAM3 后端生效。特征固定写入项目
`feature/`；关闭时不会创建该目录。暂停、继续和失败重试会保留原任务的开关值。

### 人工标注 AI 辅助

- `POST /api/ai/session/open`
- `POST /api/ai/point`
- `POST /api/ai/prompts/clear`
- `POST /api/ai/mask/accept`
- `POST /api/ai/session/close`
- `GET /api/ai/features/status?project_id=...&image_id=...`
- `POST /api/ai/features/delete`

会话只返回候选 polygon/polygons、bbox 和质量分数；接受前不会修改标注存储。
删除接口要求 `confirmed=true`，项目有正在写特征的批量任务时返回 409。

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
