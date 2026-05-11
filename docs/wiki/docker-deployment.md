# Docker 部署

## 默认启动

```bash
cd ~/zmb_work/sam3
./deploy.sh install --direct
```

默认访问：

```text
http://服务器IP:8000
```

## 更新

```bash
cd ~/zmb_work/sam3
./deploy.sh update --direct
```

如果前端界面没有变化，强制重建：

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build --force-recreate web-auto
```

## GPU 问题

检查：

```bash
./deploy.sh gpu-check
```

安装 NVIDIA Container Toolkit：

```bash
./deploy.sh gpu-install
```

## 账号重置

```bash
./deploy.sh reset-admin
```

或指定新密码：

```bash
./deploy.sh reset-admin 'new-password-here'
```
