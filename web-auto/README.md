# web-auto

`web-auto` 是面向 `sam3-api` 的 Web 标注工具，支持图片标注、批量文本推理、范例传播、导出和视频项目工作流。

## 目录结构

```text
web-auto/
  app/
    main.py
    storage.py
    sam3_client.py
    exports.py
    utils.py
  static/
    projects.html
    annotate.html
    video_annotate.html
    styles.css
    app.js
    video_app.js
  data/
  run.py
  requirements.txt
  README.md
  REQUIREMENTS_AND_CLARIFICATIONS.md
```

## 依赖安装

```bash
pip install -r requirements.txt
```

## SQLite 说明

从当前版本开始，`web-auto` 使用 SQLite 维护项目图片索引和状态统计，目的是避免大数据集场景下反复重写超大的 `projects.json`。

重点说明：

- `web-auto` 使用的是 Python 自带的 `sqlite3` 模块，不需要额外 `pip install sqlite3`
- 但你的 Python / Conda 环境必须启用 `sqlite3`
- 如果当前环境缺少 `sqlite3`，`web-auto` 启动时会直接报错并提示补齐环境

建议先做一次环境检查：

```bash
python -c "import sqlite3; print(sqlite3.sqlite_version)"
```

如果这条命令报错，说明当前环境没有可用的 SQLite 支持。常见处理方式：

1. 使用标准 CPython 或 Anaconda/Miniconda 自带的 Python 环境
2. 在 Conda 环境中补齐 SQLite：

```bash
conda install sqlite
```

如果你使用的是自编译 Python，请确认构建时启用了 `sqlite3`

## 启动

```bash
python run.py
```

默认访问地址：

```text
http://127.0.0.1:8000
```

## 使用流程

1. 创建图片项目或视频项目
2. 配置 `sam3-api` 地址、阈值、批大小
3. 在项目中添加类别
4. 进行单图推理、全图文本批推、范例分割或范例传播
5. 保存标注并按需导出

## 大规模数据集说明

针对图片数量超过 1 万张的项目，当前版本已经做了两项关键优化：

- 图片清单与状态索引改为 SQLite 存储
- 单张图片标注保存改为增量更新计数，不再每次全量重算项目统计

这能显著降低以下操作的开销：

- 单图保存标注
- 批量推理逐图写回
- 项目统计刷新
- 图片分页读取

## sam3-api 要求

至少需要可用的 `sam3-api` 服务，并支持当前 `web-auto` 使用到的接口：

- `POST /v1/infer`
- `POST /v1/infer_batch`
- `POST /v1/semantic/infer`
- `POST /v1/semantic/infer_batch`
- `GET /health`

推荐先确认 `sam3-api` 可用，再打开 `web-auto`
