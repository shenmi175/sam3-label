# SAM3 自动标注平台

基于 Meta SAM3 的自动标注平台：Web 标注界面 + 推理服务 + 一键 Docker 部署。
本仓库以平台为主体维护；上游 `facebookresearch/sam3` 作为 git 子模块固定在
`external/sam3`（固定完整 40 位 SHA，见 `docs/wiki/sam3-submodule.md`）。

## 架构

```text
web-auto          标注前端 + 项目管理/导出（FastAPI，端口 8000）
sam3-api          SAM3 图片/视频推理服务（FastAPI，内部网络 8001）
sapiens-api       Sapiens2 位姿推理（可选，profile: sapiens）
locate-anything-api  LocateAnything 检测（可选，profile: locate）
ops-api           运维接口
task-worker       后台批量任务 worker
caddy             可选反代（proxy 模式）

external/sam3     上游 SAM3 源码（子模块，sam3-api 构建时正常 pip 安装）
external/sapiens2 上游 Sapiens2 源码（子模块）
```

## 获取代码

必须使用 recursive clone 拉取子模块：

```bash
git clone --recursive git@github.com:shenmi175/sam3.git
```

已有仓库补拉子模块：

```bash
git submodule update --init --recursive
```

校验子模块 SHA 与记录一致：

```bash
./scripts/check_submodules.sh
```

注意：不支持直接从非 Git 源码包（tarball）部署——缺少子模块内容时
`deploy.sh` 会明确报错。如需打包分发，先在 Git 工作树中完成
`git submodule update --init --recursive` 再打包。git worktree 场景完全兼容。

## 部署

```bash
./deploy.sh            # 交互式安装（默认 GPU）
./deploy.sh update     # 拉取更新并重建（自动同步子模块）
./deploy.sh start      # 启动
./deploy.sh status     # 状态
```

详见 [DOCKER.md](DOCKER.md) 与 [docs/wiki/docker-deployment.md](docs/wiki/docker-deployment.md)。

## 模型管理

模型权重与 API 的对应关系统一由 `model_registry` 模块描述（各模型的 API 服务、
端口、权重目录、下载方式）：

```bash
./scripts/models.sh list                    # 所有模型及权重状态
./scripts/models.sh status [model_id]       # 权重文件明细
./scripts/models.sh download <model_id>     # 下载 HF 模型（--mirror 走镜像）
```

权重目录默认 `sam3_checkpoints/`、`sapiens_checkpoints/`、`locate_checkpoints/`，
可用 `.env` 中的 `SAM3_CHECKPOINT_DIR` / `SAPIENS_CHECKPOINT_ROOT` /
`LOCATE_CHECKPOINT_DIR` 覆盖。SAM3 与 Sapiens2 权重需按各自许可手动获取
（命令会打印指引）；LocateAnything 支持自动下载。

## 开发

- 平台测试：`pytest tests/`（pytest 配置在根 `pyproject.toml`）
- sam3 兼容性：`sam3-api` 仅通过 `sam3-api/app/sam3_compat.py` 引用 sam3 内部符号；
  升级 `external/sam3` 的流程与风险见 [docs/wiki/sam3-submodule.md](docs/wiki/sam3-submodule.md)
- API 文档：[web-auto/DEVELOPER_API_GUIDE.md](web-auto/DEVELOPER_API_GUIDE.md)、
  [sam3-api/DEVELOPER_API_GUIDE.md](sam3-api/DEVELOPER_API_GUIDE.md)
- 其他 wiki：[docs/wiki/](docs/wiki/README.md)

上游 SAM3 自带的训练/评测脚本不再由本仓库维护，随子模块提供
（`external/sam3/scripts`、`external/sam3/examples` 等）。

## 许可证

平台代码见各服务声明；`external/sam3` 与 SAM3 checkpoint 受 SAM License 约束，
全文见 [external/sam3/LICENSE](external/sam3/LICENSE)（子模块内）。
第三方组件清单：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
