# web-auto 设置面板

## 基础配置

- `sam3-api 地址`: Docker 部署默认是 `http://sam3-api:8001`。
- `语言`: 切换中文或英文。
- `界面主题`: 切换浅色或深色。
- `阈值` 和 `批大小`: 影响前端默认推理参数。

## 路径配置

- `服务器缓存目录`: web-auto 项目元数据和标注缓存目录。
- `服务器可写数据根目录`: 主 Docker 挂载目录，只读展示。
- `已挂载数据根目录`: 所有通过 `deploy.sh data-root` 挂载到容器的目录。
- `默认上传保存目录`: 项目页上传数据集默认写入的目录。
- `新增挂载目录`: 输入宿主机上要挂载进 `web-auto` 的目录，页面会生成完整命令。

`默认上传保存目录` 必须位于“已挂载数据根目录”之一下面。

例如新增外置盘目录：

```text
/mnt/datasets
```

页面会生成类似命令：

```bash
cd /path/to/sam3
./deploy.sh data-root add '/mnt/datasets' --upload-target '/mnt/datasets/uploads'
./deploy.sh data-root doctor '/mnt/datasets/uploads'
```

复制整段到服务器终端运行。`data-root add` 会生成或修复 `docker-compose.mounts.yml`，并重建 `web-auto`，不用再手写 `docker compose -f ...`。

## 运行管理

显示当前运行配置，并提供：

- `重新加载`: 重新读取后端配置。
- `重启 web-auto`: 退出 web-auto 进程，由 Docker 重启策略自动拉起。

注意：重启 web-auto 不能新增 Docker 挂载。新增挂载必须在服务器执行：

```bash
./deploy.sh data-root add /path/to/data-root --default
```

项目管理页面另有“模型服务”区域，可管理 `sam3-api`、`locate-anything-api` 和 `sapiens-api` 容器。`sapiens-api` 使用独立容器和独立 checkpoint 目录，详见 [Sapiens2 服务](sapiens2-service.md)。

## 登录管理

用于修改当前管理员密码。修改后会清除当前登录会话，需要重新登录。
