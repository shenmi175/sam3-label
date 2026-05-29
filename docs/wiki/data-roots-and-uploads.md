# 数据根目录和上传

## 为什么不能直接上传到任意路径

`web-auto` 运行在 Docker 容器里。容器只能看到启动时挂载进去的宿主机目录。

如果页面报错：

```text
target_dir must be inside a mounted data root
```

说明目标目录在宿主机上存在，但还没有挂载到 `web-auto` 容器。

## 查看已挂载数据根目录

```bash
cd ~/zmb_work/sam3
./deploy.sh data-root list
```

输出中的目录才可以作为上传目标根目录。

## 添加外置盘目录

例如外置盘目录是：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
```

执行：

```bash
cd ~/zmb_work/sam3
./deploy.sh data-root add /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas --default
```

脚本会：

- 创建目录。
- 写入 `.env` 的 `WEB_AUTO_ALLOWED_DATA_ROOTS`。
- 生成 `docker-compose.mounts.yml`。
- 重建 `web-auto` 容器，让 Docker 挂载生效。
- 如果 `sapiens-api` 已启用，也会把同一数据根目录挂载到 `sapiens-api`，方便后续姿态估计任务读取同一批图片。

如果想指定精确的默认上传目录：

```bash
./deploy.sh data-root add /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas \
  --upload-target /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/uploads
```

web-auto 设置页在发现目标目录未挂载时，会自动生成这类命令，复制到服务器终端执行即可。

## 设置默认上传目录

如果使用 `--default`，默认上传目录会被设置为：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/uploads
```

也可以进入 web-auto：

```text
设置 -> 路径配置 -> 默认上传保存目录
```

填写已挂载根目录下的路径。

## 删除额外挂载

```bash
./deploy.sh data-root remove /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
```

不能删除主数据根目录 `WEB_AUTO_HOST_DATA_ROOT`。如果要更换主数据根目录，重新运行：

```bash
./deploy.sh install --direct
```

## 手动检查容器环境

```bash
sudo docker exec sam3-auto-label-web-auto-1 printenv WEB_AUTO_HOST_DATA_ROOT
sudo docker exec sam3-auto-label-web-auto-1 printenv WEB_AUTO_ALLOWED_DATA_ROOTS
```

确认容器内能看到目录：

```bash
sudo docker exec sam3-auto-label-web-auto-1 ls /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
```

## 推荐目录结构

```text
/media/enabot/.../zmb_datas/
  uploads/
    project-a/
    project-b/
  exports/
  raw/
```

图片项目的图片目录可以填：

```text
/media/enabot/.../zmb_datas/uploads/project-a
```
