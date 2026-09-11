# 标注可视化对齐验证报告（已修复）

日期：2026-07-30

## 根因

OpenSeadragon 视口坐标系中，X 和 Y **都以图像宽度归一化**（图像宽 = 1.0，高 = H/W）。
此前 `image-viewer-v2.js` 中把 Y 按图像高度归一化（`iy / height`），导致所有标注在竖直
方向被拉伸/偏移，误差因子恰为 W/H（16:9 图为 1.78）。

## 修复内容（web-auto/frontend/js/components/image-viewer-v2.js）

| 函数 | 修改 |
|------|------|
| `imageToScreenRaw` | `vp = (ix / w, iy / w)` （原来 y 除以 h） |
| `screenToImage` | `vp.y * image.width` （原来乘以 height） |
| `centerTransformOnBbox` | Rect 的 y / 高度均除以 w（原来除以 h） |

另：`index.html` 缓存版本 v3.2 → v3.3。

## 验证方法（Playwright 自动化，verify_align.py）

1. 登录 → 打开 `#/project/image/prj_d55b86643cac` → 图片 `34d6de211390558c`（1920×1080）。
2. 从 bundle API 取出全部 27 条标注的 `bbox_xyxy`（源像素坐标）。
3. 数学换算期望屏幕位置：home 视图下 scale = 0.5，图像显示区 [0,100,960,540]。
4. 逐条在 overlay canvas 像素级检查四条边（±6px 容差）。

## 结果

- 已启用显示的类别（bed/cabinet/table/chair/sofa/coffee table）**15/15 全部通过**四边检查。
  例：bed bbox [712.32, 573.48, 1512.96, 739.80] → 屏幕 [356,387,756,470]，四边命中。
- 12 条“未命中”均属于未勾选显示的类别（swivel/armchair/desk/wardrobe 等），画布上本就未绘制。
- 缩放与平移后标注跟随正确（见截图 fixed_02 / fixed_03）。

## 截图

保存于通用输出目录 `/mnt/datasets/visualization-output/`：

- `fixed_01_home_aligned.png` — home 视图，标注与家具对齐
- `fixed_02_zoomed_aligned.png` — 放大后仍对齐
- `fixed_03_panned_aligned.png` — 平移后仍对齐

旧的错误截图已移入同目录 `old_bad/` 子目录。
