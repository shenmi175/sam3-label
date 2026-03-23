# Backend API Gap Checklist

本文件原本用于记录前端需求中尚未补齐的后端接口。当前状态如下。

## 已确认原本就存在的接口

这些接口并不缺失，只是之前在接口文档里写得不够明确：

- `POST /api/sam3/health`
  - 前端 API 测试
- `POST /api/projects/{project_id}/classes/add`
  - 类别添加
- `POST /api/infer`
  - 单图推理，带 `threshold` 和 `api_base_url`
- `POST /api/infer/preview`
  - 单图预览推理
- `POST /api/infer/example_preview`
  - 当前图范例分割
- `POST /api/infer/batch_example`
  - 同步范例传播
- `POST /api/infer/jobs/start_batch_example`
  - 任务化范例传播
- `POST /api/infer/jobs/resume`
  - 批量推理继续，可更新阈值等参数

## 本次已补齐的接口

### 1. 视频播放与取帧

- `GET /api/projects/{project_id}/video/stream`
  - 视频流别名接口，支持播放器直接接入
- `GET /api/projects/{project_id}/video/frame/{frame_index}`
  - 读取指定帧，返回 JPEG

### 2. 视频标注读写

- `GET /api/projects/{project_id}/video/annotations`
  - 读取整段视频标注
- `POST /api/projects/{project_id}/video/annotations/save`
  - 保存整段视频标注或部分帧标注

### 3. 全局缓存目录

- `GET /api/config/cache_dir`
  - 查看当前后端数据目录
- `POST /api/config/cache_dir`
  - 切换后端数据目录

## 结论

当前 `FRONTEND_REQUIREMENTS.md` 中提到的主要接口能力已经具备。

最新、完整接口说明请直接查看：

- `DEVELOPER_API_GUIDE.md`
