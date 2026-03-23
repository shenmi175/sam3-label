# web-auto

`web-auto` 现已调整为纯后端 API 服务，不再内置任何页面或静态前端资源。

前端请单独实现，并通过 HTTP 调用本服务的 `/api/*` 接口。后端职责包括：

- 项目管理
- 图片与视频文件访问
- 标注读写
- 单图推理、批量推理、范例传播
- 智能过滤
- 导出
- 视频传播任务

## 目录结构

```text
web-auto/
  app/
    main.py
    storage.py
    sam3_client.py
    exports.py
    utils.py
  data/
  run.py
  requirements.txt
  README.md
  DEVELOPER_API_GUIDE.md
  FRONTEND_REQUIREMENTS.md
  REQUIREMENTS_AND_CLARIFICATIONS.md
```

## 安装

```bash
pip install -r requirements.txt
```

## SQLite 说明

`web-auto` 使用 Python 自带的 `sqlite3` 模块维护项目图片索引和状态统计，不需要额外 `pip install sqlite3`。

启动前建议先检查当前 Python 环境是否可用：

```bash
python -c "import sqlite3; print(sqlite3.sqlite_version)"
```

如果报错，说明当前环境缺少 SQLite 支持。常见处理方式：

```bash
conda install sqlite
```

## 启动

```bash
python run.py
```

默认地址：

```text
http://127.0.0.1:8000
```

OpenAPI 文档：

```text
http://127.0.0.1:8000/docs
```

## 跨域配置

后端已启用 CORS，默认允许所有来源：

```text
WEB_AUTO_ALLOW_ORIGINS=*
```

如果你只想允许固定前端来源，可在启动前设置逗号分隔列表：

```bash
set WEB_AUTO_ALLOW_ORIGINS=http://127.0.0.1:5173,http://localhost:3000
python run.py
```

## sam3-api 要求

至少需要可用的 `sam3-api` 服务，并支持当前 `web-auto` 使用到的接口：

- `GET /health`
- `POST /v1/infer`
- `POST /v1/infer_batch`
- `POST /v1/semantic/infer`
- `POST /v1/semantic/infer_batch`
- 视频语义会话相关接口

## 文档

- 后端接口文档：`DEVELOPER_API_GUIDE.md`
- 前端需求文档：`FRONTEND_REQUIREMENTS.md`
- `REQUIREMENTS_AND_CLARIFICATIONS.md` 为历史说明，新的独立前端请以前两份文档为准

## 当前方案实现难度

把 `web-auto` 改成纯后端 API 的难度不大，属于中低风险改造：

- 后端原本就已经以 `/api/*` 为主
- 现有图片、视频、任务、导出逻辑都能保留
- 主要工作是移除静态前端、补跨域、明确接口文档

真正的工作量会转移到你新的前端实现上，而不是后端。
