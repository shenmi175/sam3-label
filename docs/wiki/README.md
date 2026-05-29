# SAM3 Auto Label Wiki

本目录是项目内置 Wiki。服务器不能直接使用 GitHub Wiki 时，可以先看这里。

## 页面

- [Docker 部署](docker-deployment.md)
- [数据根目录和上传](data-roots-and-uploads.md)
- [项目恢复和已有输出导入](project-recovery.md)
- [web-auto 设置面板](web-auto-settings.md)
- [Sapiens2 服务](sapiens2-service.md)

## 推荐部署模型

- `web-auto` 对外暴露一个登录入口，例如 `http://服务器IP:8000`。
- `sam3-api` 只在 Docker 内部网络暴露，不映射宿主机端口。
- 数据集目录由 `deploy.sh data-root` 管理 Docker 挂载。
- web 页面只选择已挂载目录内的上传目标，不直接管理 Docker。
- `sapiens-api` 作为可选独立容器运行，Sapiens2-5B checkpoint 缺失时由项目管理页触发下载并显示进度。
- 项目输出目录写入 `web_auto_project.json`，索引丢失后可从挂载目录恢复。
