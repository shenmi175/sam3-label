# 项目恢复和已有输出导入

`web-auto` 的项目列表来自项目索引，不是简单扫描文件夹。索引包括：

- `projects.json`：项目基本信息。
- `web_auto_index.sqlite3`：图片、标注和筛选索引。
- 项目输出目录：`prj_xxx/annotations/*.json` 和导出文件。
- 项目清单：`prj_xxx/web_auto_project.json`。

## 新项目的成熟恢复方式

新建项目后，`web-auto` 会在输出目录写入：

```text
web_auto_project.json
```

这个文件记录项目 ID、图片目录、输出目录、类别和计数信息。以后即使换机器部署，只要：

1. 图片目录仍然挂载到 `web-auto` 容器内。
2. 输出目录仍然挂载到 `web-auto` 容器内。
3. 输出目录里保留 `web_auto_project.json` 和 `annotations/`。

打开项目列表时，后端会定期扫描已挂载数据根目录并自动导入这些项目清单，重建 SQLite 索引，不需要重新跑推理。

## 恢复旧项目输出目录

旧版本创建的 `prj_*` 输出目录可能没有 `web_auto_project.json`。这类目录不能百分百自动判断原始图片目录，需要手动提供图片目录。

在页面操作：

```text
项目管理页 -> 恢复已有项目 -> 扫描已有项目
```

如果项目在某个子目录下，例如：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/openimg/prj_xxx
```

可以把“扫描根目录”直接填成：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/openimg
```

选择旧的 `prj_*` 输出目录后，填写当时创建项目使用的图片目录，然后点击“恢复项目”。

恢复过程会：

- 扫描图片目录，按稳定规则重新生成 image_id。
- 读取 `prj_xxx/annotations/{image_id}.json`。
- 把已有标注导入 SQLite。
- 更新项目列表的已标注/待标注数量。
- 写入新的 `web_auto_project.json`，后续可自动恢复。

不会重新调用 `sam3-api`，也不会重新推理。

## 手动 API

扫描可恢复项目：

```bash
curl -s http://服务器IP:8000/api/projects/discover
```

导入带清单的项目：

```bash
curl -s -X POST http://服务器IP:8000/api/projects/import_existing \
  -H 'Content-Type: application/json' \
  -d '{"manifest_path":"/data/zmb_datas/prj_xxx/web_auto_project.json"}'
```

导入旧输出目录：

```bash
curl -s -X POST http://服务器IP:8000/api/projects/import_existing \
  -H 'Content-Type: application/json' \
  -d '{
    "output_dir": "/data/zmb_datas/prj_xxx",
    "image_dir": "/data/zmb_datas/001",
    "name": "001"
  }'
```

## 注意事项

- 旧输出目录支持 `prj_xxx/annotations` 和 `prj_xxx/output/annotations` 两种结构。
- 图片目录必须和当时创建项目时的根目录一致。image_id 由图片相对路径生成，根目录不一致可能匹配不到旧标注。
- 输出目录必须保留 `annotations/`。
- 如果目录在宿主机上存在但容器看不到，先用 `./deploy.sh data-root add <路径>` 挂载。
- 删除项目会移除对应项目清单，避免下次自动扫描又把它导入回来。

## 扫描不到时排查

确认容器能看到目录：

```bash
sudo docker exec sam3-auto-label-web-auto-1 sh -lc \
  'printenv WEB_AUTO_ALLOWED_DATA_ROOTS; ls -ld /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/openimg; find /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/openimg -maxdepth 3 -type d -name "prj_*" -print'
```

如果容器内没有这个目录，先执行：

```bash
./deploy.sh data-root add /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas --default
```

如果已经添加过但容器环境还是旧的，重建 `web-auto`：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build --force-recreate web-auto
```
