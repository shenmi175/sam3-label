# Docker 部署

默认方案是不做反代，直接用 `IP:端口` 登录 `web-auto`。`sam3-api` 仍然只在 Docker 内部网络暴露，不映射到宿主机端口。

## 默认访问方式

```text
http://服务器IP:8000
```

登录账号由部署脚本生成：

```text
Username: admin
Password: .env 里的 WEB_AUTO_ADMIN_PASSWORD
```

## 一键安装

```bash
./deploy.sh
```

默认值：

- `SAM3_ACCESS_MODE=direct`
- `WEB_AUTO_HTTP_BIND=0.0.0.0`
- `WEB_AUTO_HTTP_PORT=8000`
- `SAM3_DEPLOY_PROFILE=gpu`

如果 `8000` 端口在服务器上不可用，可以编辑 `.env`：

```text
WEB_AUTO_HTTP_PORT=18000
```

然后重启：

```bash
./deploy.sh start --direct
```

## 直接模式安全边界

- 对外只发布 `web-auto` 的 HTTP 端口，例如 `8000`。
- `sam3-api` 不发布宿主机端口，只允许 `web-auto` 通过 `http://sam3-api:8001` 内部调用。
- 浏览器不会拿到 `SAM3_API_TOKEN`。
- `web-auto` 有登录页面，没有开放注册。

如果需要局域网访问，服务器防火墙或云安全组只需要放行你配置的 `WEB_AUTO_HTTP_PORT`。

## 数据上传目录

项目管理页支持把本地文件或文件夹上传到服务器目录。`deploy.sh` 会默认创建独立项目数据目录：

```text
<sam3 仓库目录>/project-data
<sam3 仓库目录>/project-data/uploads
```

如果数据要写到外置盘，有两种方式。

安装时直接设置主数据根目录：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
```

脚本会写入：

```text
WEB_AUTO_HOST_DATA_ROOT=/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
WEB_AUTO_DEFAULT_UPLOAD_TARGET_DIR=/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/uploads
```

部署后新增一个外置盘挂载：

```bash
./deploy.sh data-root add /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas --default
```

或指定精确上传目录：

```bash
./deploy.sh data-root add /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas \
  --upload-target /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/uploads
```

设置页会在目标目录未挂载时生成可复制命令。

查看所有已挂载数据根目录：

```bash
./deploy.sh data-root list
```

删除一个额外挂载：

```bash
./deploy.sh data-root remove /media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas
```

上传后创建图片项目时，图片目录填写服务器路径，例如：

```text
/media/enabot/f6c408f7-8050-4999-b77c-ce34480ad71b/zmb_datas/uploads/my-project
```

出于安全限制，上传目标必须位于任意一个已挂载数据根目录下。如果页面提示目录未挂载，在服务器执行：

```bash
./deploy.sh data-root add /path/to/data-root --default
```

`web-auto` 设置页的“路径配置”可以修改默认上传保存目录，但只能选择已挂载数据根目录内的目录。设置会保存到 `/data/web-auto/global_config.json`。

更多操作说明见 [数据根目录和上传 Wiki](docs/wiki/data-roots-and-uploads.md)。

## 恢复已有项目输出

新建项目后，`web-auto` 会在项目输出目录写入 `web_auto_project.json`。如果换机器部署或索引丢失，只要数据根目录已经挂载，项目列表会定期扫描这些清单并自动恢复项目索引。

旧版本留下的 `prj_*` 输出目录没有清单时，在页面执行：

```text
项目管理页 -> 恢复已有项目 -> 扫描已有项目
```

选择输出目录，并填写当时创建项目使用的图片目录。恢复只读取已有 `annotations/*.json` 并重建索引，不会重新调用 `sam3-api` 推理。

详细说明见 [项目恢复和已有输出导入 Wiki](docs/wiki/project-recovery.md)。

## 可选 HTTPS 反代

公司网络、NAT、运营商或安全组不允许公网 `80/443` 入站时，不建议启用反代。

确认公网 `80/443` 可入站后，可以手动启用：

```bash
./deploy.sh start --proxy
```

反代模式需要 `.env` 配置：

```text
SAM3_ACCESS_MODE=proxy
PUBLIC_DOMAIN=sam3.example.com
ACME_EMAIL=you@example.com
```

Caddy 相关依据：

- Caddy Automatic HTTPS: https://caddyserver.com/docs/automatic-https
- Caddy reverse_proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy Docker 镜像: https://hub.docker.com/_/caddy
- Let’s Encrypt challenge: https://letsencrypt.org/docs/challenge-types/

## 常用命令

```bash
./deploy.sh status
./deploy.sh doctor
./deploy.sh logs web-auto
./deploy.sh logs sam3-api
./deploy.sh restart web-auto
./deploy.sh reset-admin
./deploy.sh update --direct
```

如果登录提示 `invalid username or password`，说明旧的 `web-auto/data/auth.json` 里已有管理员密码哈希。重置管理员密码：

```bash
./deploy.sh reset-admin
```

也可以指定新密码：

```bash
./deploy.sh reset-admin 'new-password-here'
```

GPU 检查：

```bash
./deploy.sh gpu-check
```

安装 NVIDIA Container Toolkit：

```bash
./deploy.sh gpu-install
./deploy.sh start --gpu --direct
```

## 卸载

保留数据卸载：

```bash
./deploy.sh uninstall
```

删除 Compose volumes 和默认数据目录：

```bash
./deploy.sh uninstall --purge
```

同时删除本地构建镜像：

```bash
./deploy.sh uninstall --purge --with-images
```

卸载脚本不会删除 `sam3_checkpoints`，也不会删除 `WEB_AUTO_HOST_DATA_ROOT` 指向的数据集目录。
