# external/sam3 子模块说明

本仓库的 SAM3 源码来自上游 `https://github.com/facebookresearch/sam3`，以 git
子模块形式固定在 `external/sam3`，**pin 到完整 40 位 SHA**（gitlink 记录）。

## 当前 pin

| 子模块 | 上游仓库 | 固定 SHA | 说明 |
|---|---|---|---|
| external/sam3 | facebookresearch/sam3 | `66b74826020e1c5b54ee3782ed360fa0b85cbee7` | 2026-05-09 上游同步点（merge b452ec8）；与平台原 vendored sam3/ 内容逐字节一致 |
| external/sapiens2 | facebookresearch/sapiens2 | `7e5bae88456ac418ff0e58e74106c9fe192055d4` | sapiens-api 构建依赖 |

## 初始化

```bash
git clone --recursive <repo-url>          # 新克隆
git submodule update --init --recursive   # 已有仓库补拉
./scripts/check_submodules.sh             # 校验检出 SHA == gitlink 记录
```

`deploy.sh` 的 install / update / start 会自动调用 `ensure_external_submodules`：
内容缺失且在 Git 工作树（含 worktree）中 → 自动 init；**非 Git 源码包且内容缺失 →
明确报错退出**（不会静默跳过）。

## worktree 与 tarball

- git worktree：完全兼容（脚本用 `git rev-parse --git-dir` 判断，`.git` 为文件也可）。
- tarball / 源码包：不含子模块内容时无法部署，需先在 Git 工作树中
  `git submodule update --init --recursive` 再打包。

## sam3-api 如何使用子模块

`docker/sam3-api.Dockerfile` 将 `external/sam3` COPY 进镜像并 **正常（非 editable）
pip 安装**；PYTHONPATH 不指向 sam3 源码目录。构建期硬校验：

- `importlib.metadata.version('sam3')` 可解析
- `sam3.__file__` 必须落在 site-packages，不在源码目录
- `/app/external/sam3/LICENSE` 存在

`sam3-api` 代码仅通过 `sam3-api/app/sam3_compat.py` 引用 sam3 内部符号
（Sam3Processor、build_sam3_image_model、PostProcessImage、data_misc 一组、
copy_data_to_device、Sam3VideoPredictor、load_video_frames）。

## 升级 external/sam3 的流程

升级 ≠ 改一行就完事：sam3-api 依赖多个 sam3 内部模块的具名符号，上游重构可能破坏。
流程：

1. 修改 gitlink：`cd external/sam3 && git fetch && git checkout <new-sha>`，
   回根仓库 `git add external/sam3`。
2. 更新 `sam3-api/app/sam3_compat.py` 顶部的 `SAM3_PIN_SHA` 与本文档表格。
3. 跑兼容测试：`pytest tests/test_sam3_compat.py tests/test_sam3_io_utils_compat.py`
   （需 sam3 可 import 的环境，例如 sam3-api 镜像内）。
4. 全平台测试：`pytest tests/`。
5. 重建镜像并做 GPU 冒烟：`docker compose build sam3-api` → 单图推理验证。
6. 全部通过才合并；任何符号缺失会由 compat 层抛出带 pin SHA 的明确错误。

## 上游评测脚本

上游的 `scripts/eval`、`measure_speed.py`、`qualitative_test.py`、examples 等不再
由本仓库根目录维护；需要时直接在子模块内使用（`external/sam3/scripts` 等）。

## SHA 变更记录

| 日期 | 子模块 | 旧 SHA | 新 SHA | 变更原因 |
|---|---|---|---|---|
| 2026-07 | external/sam3 | （vendored 目录） | `66b74826020e1c5b54ee3782ed360fa0b85cbee7` | 仓库重构：sam3 独立为子模块 |
