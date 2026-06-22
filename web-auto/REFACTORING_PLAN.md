# web-auto 模块化重构阶段规划

## 背景

web-auto 当前已经同时承担自动标注、人工修正、智能过滤、导出、数据看板、项目/图片管理等职责。功能在持续增加后，主要复杂度集中在少数大文件：

- `frontend/js/pages/image-workspace.js`：页面布局、路由生命周期、图片列表、类别管理、自动推理、人工编辑、自动保存、智能过滤、导出等逻辑混在一起。
- `frontend/js/components/image-viewer-v2.js`：画布渲染和几何交互已经相对独立，但仍通过 workspace 回调承接大量业务状态。
- `app/main.py`：API 路由、任务编排、过滤、导出等集中在单文件。
- `app/storage.py`：项目、图片、标注、索引、文件删除、manifest 写入等存储职责集中在单类。

目标不是一次性重写，而是按阶段拆分可复用模块，让“自动标注工作台”和“人工校对工作台”可以共用图片、标注、类别、保存、删除等核心能力。

## 重构目标

1. **复用性**
   - 自动标注页面和人工校对页面共用同一套图片加载、标注保存、类别管理、标注编辑、图片删除逻辑。
   - 新增功能优先挂到共享模块，不再复制 `image-workspace.js` 中的大段逻辑。

2. **可维护性**
   - 将页面壳、业务控制器、UI 面板、API 服务、画布适配器分层。
   - 将单个模块控制在可审查范围内，避免继续扩大大文件。
   - 减少 inline `onclick`、`window.currentWorkspace`、跨模块直接操作 DOM id。

3. **人工校对效率**
   - 支持自动标注完成后进入专门的人工校对模式或页面。
   - 人工校对重点优化：连续标注、快速改类、快速删除、下一张/未标注导航、审核状态。

4. **行为稳定**
   - 保持现有自动推理、批量推理、智能过滤、导出、单图删除、自动保存能力不回退。
   - 每个阶段完成后都能独立运行和验证。

5. **验证可落地**
   - 每阶段包含浏览器验证清单、API/语法检查和关键交互回归。
   - 浏览器验证允许使用本地临时管理员账号 `admin`；密码不写入长期文档或配置，执行验证时从当前任务上下文或本地环境变量读取。

## 非目标

- 不在第一轮重构中替换 SAM3/Sapiens 推理逻辑。
- 不在第一轮重构中改变项目数据格式、图片 ID 策略或 annotation JSON 文件路径。
- 不把自动标注和人工校对拆成两套独立数据模型。
- 不一次性重写所有后端存储逻辑。

## 目标架构

### 前端分层

建议目标目录：

```text
web-auto/frontend/js/
  pages/
    image-auto-workspace.js
    image-review-workspace.js
    image-workspace-shell.js
  modules/
    image-workspace/
      annotation-controller.js
      image-navigation-controller.js
      project-controller.js
      keyboard-command-manager.js
      workspace-state.js
      browser-verification-notes.md
  components/
    image-viewer-v2.js
    annotation-canvas.js
    annotation-list.js
    class-panel.js
    image-list.js
    workspace-toolbar.js
    auto-annotate-panel.js
    review-toolbar.js
    smart-filter-panel.js
    export-panel.js
  services/
    project-api.js
    image-api.js
    annotation-api.js
    inference-api.js
    filter-api.js
    export-api.js
  utils/
    dom.js
    html.js
    geometry.js
    async-guard.js
```

### 前端职责边界

- **Workspace shell**
  - 只负责页面布局、面板装配、路由参数、生命周期。
  - 不直接实现标注保存、推理、过滤等业务细节。

- **Annotation controller**
  - 统一拥有 `selectedImageId`、`annotations`、`focusedAnnotationId`、dirty 状态、autosave、undo/redo。
  - 对外提供 `createAnnotation`、`updateGeometry`、`deleteAnnotation`、`updateClass`、`save` 等方法。
  - 自动页面和人工页面都使用它。

- **Image navigation controller**
  - 统一处理图片列表、分页、筛选、未标注导航、删除图片后选中下一张。
  - 避免每个页面各自实现图片切换和删除后的状态修复。

- **Annotation canvas**
  - 包装 `ImageViewerV2`，向业务层暴露稳定事件：
    - `onAnnotationSelected`
    - `onAnnotationCreated`
    - `onAnnotationGeometryChanged`
    - `onPromptAdded`
  - 画布只负责几何交互和显示，不直接调用 API。

- **Auto annotate panel**
  - 单图推理、批量推理、示例分割、任务状态。
  - 只依赖 project/image/annotation controller 的公共接口。

- **Review toolbar**
  - 人工校对专用：连续画框/多边形、快捷改类、保存并下一张、标记已审核。
  - 不包含自动推理配置。

- **Keyboard command manager**
  - 集中管理快捷键优先级，避免图片删除、标注删除、切图、画布编辑互相抢事件。
  - 示例优先级：输入框 > 模态框 > 当前画布编辑 > 标注选择 > 图片列表 > 全局导航。

### 后端分层

建议目标目录：

```text
web-auto/app/
  main.py
  api/
    projects.py
    images.py
    annotations.py
    inference.py
    filters.py
    exports.py
    auth.py
    settings.py
  services/
    project_service.py
    image_service.py
    annotation_service.py
    inference_service.py
    smart_filter_service.py
    export_service.py
  repositories/
    project_repository.py
    image_repository.py
    annotation_repository.py
    index_repository.py
  storage/
    files.py
    manifests.py
    sqlite.py
  schemas/
    projects.py
    images.py
    annotations.py
    inference.py
    filters.py
```

### 后端职责边界

- **API router**：只做请求校验、权限/错误码映射、调用 service。
- **Service**：承接业务规则，例如删除图片时同步删除原图、标注 JSON、SQLite 索引、项目统计。
- **Repository**：封装 SQLite 和 JSON/manifest 读写。
- **File storage**：封装路径安全检查、文件删除、导入、上传、tile 缓存。

## 阶段规划

### 阶段 0：基线和防回归

目标：建立可重复验证基线，不改变功能。

任务：
- 固化当前关键流程清单：
  - 打开项目，加载图片列表和当前图片。
  - 自动推理单张图片。
  - 批量推理启动、暂停/恢复状态显示。
  - 手动画框、手动画多边形、拖动/缩放/删标注、改类别。
  - 保存标注、切换图片前自动保存。
  - 删除单张图片和对应标注文件。
  - 智能过滤预览/应用。
  - 导出。
- 增加最小浏览器验证脚本或手动验证记录模板。
- 建立重构前截图/交互录屏参考，尤其是画布、图片列表、标注列表。

验收：
- 现有语法检查通过：
  - `node --check frontend/js/pages/image-workspace.js`
  - `node --check frontend/js/components/image-viewer-v2.js`
  - `python3 -m py_compile app/main.py app/storage.py`
- 浏览器能登录并完成一轮基础标注保存。

### 阶段 1：前端纯工具和 API 服务拆分

目标：先拆低风险纯函数和 API 包装，不改变 UI。

任务：
- 从 `image-workspace.js` 抽出：
  - HTML escaping 到 `utils/html.js`
  - bbox/polygon 工具到 `utils/geometry.js`
  - image bundle cache key/简单缓存到 `modules/image-workspace/workspace-state.js`
- 将 `api.js` 按领域拆出薄包装：
  - `project-api.js`
  - `image-api.js`
  - `annotation-api.js`
  - `inference-api.js`
  - `filter-api.js`
  - `export-api.js`
- 保持原 `api.js` 对外兼容，逐步迁移调用方。

验收：
- 页面行为不变。
- `image-workspace.js` 行数开始下降。
- 不引入新全局变量。

风险控制：
- 每次只迁移一组纯函数或一组 API。
- 迁移后立即运行语法检查和浏览器基础流程。

### 阶段 2：抽出 AnnotationController

目标：把标注状态和保存逻辑从页面中剥离，供自动标注和人工校对复用。

任务：
- 新建 `annotation-controller.js`，管理：
  - `annotations`
  - `focusedAnnotationId`
  - `annotationDirty`
  - `annotationSaving`
  - `annotationRev`
  - `annotationHistory`
  - `annotationRedoStack`
  - autosave timer
- 提供公共方法：
  - `load(imageId)`
  - `setAnnotations(annotations)`
  - `createAnnotation(shape, className)`
  - `updateAnnotationGeometry(id, geometry)`
  - `deleteAnnotation(id)`
  - `updateAnnotationClass(id, className)`
  - `clearAnnotations()`
  - `undo()`
  - `redo()`
  - `flushSave(reason)`
- 将 `ensureAnnotationClasses` 和 `markSelectedImageLabeledState` 的调用边界梳理清楚。

验收：
- 自动保存和切图前保存不回退。
- 拖动/缩放标注后仍能进入 undo/redo。
- 删除最后一个标注后图片状态能更新为未标注。

风险控制：
- 初期 controller 可以由 `image-workspace.js` 实例化，UI 仍留在原页面。
- 不同时改 UI 布局。

### 阶段 3：抽出 ImageNavigationController 和图片列表组件

目标：图片列表、分页、筛选、未标注导航、单图删除统一管理。

任务：
- 新建 `image-navigation-controller.js`：
  - 加载图片页。
  - 维护 `offset/limit/totalImages/images`。
  - 处理 filter status/class。
  - 删除图片后选择下一张或清空画布。
- 新建 `image-list.js`：
  - 渲染图片列表。
  - 支持列表项聚焦、`Delete` 删除、右侧 `x` 删除。
  - 不直接调用后端，只触发事件。

验收：
- 图片列表和分页行为不变。
- 删除图片后不会显示已删除图片缓存。
- 当前模型目录或挂载目录不受影响。

风险控制：
- 先替换图片列表渲染，再迁移导航逻辑。
- 删除文件类操作保留确认弹窗。

### 阶段 4：抽出 UI 面板

目标：减少 `image-workspace.js` 的模板和事件绑定体积。

任务：
- 抽出以下面板：
  - `class-panel.js`
  - `annotation-list.js`
  - `workspace-toolbar.js`
  - `auto-annotate-panel.js`
  - `smart-filter-panel.js`
  - `export-panel.js`
- 去除新增代码中的 inline `onclick`。
- 用组件事件替代直接访问 `window.currentWorkspace`。

验收：
- `image-workspace.js` 只保留页面装配和少量协调逻辑。
- 自动推理、智能过滤、导出弹窗功能不回退。

风险控制：
- 一次只抽一个面板。
- 面板抽出后保留相同 DOM id，直到调用方全部迁移。

### 阶段 5：引入人工校对模式

目标：先在同一个页面内提供“自动标注/人工校对”模式切换，不立即拆路由。

任务：
- 增加 workspace mode：
  - `auto`
  - `review`
- `auto` 模式保留当前自动标注控件。
- `review` 模式隐藏或弱化自动推理配置，突出：
  - 当前类别。
  - 手动画框/多边形。
  - 连续标注模式。
  - 快速删除/改类。
  - 保存并下一张。
  - 下一张未标注/待校对。
- 快捷键增强：
  - 数字键切类别。
  - `Delete` 删除选中标注。
  - `B/P/V/F` 保留。
  - `Enter` 完成 polygon。
  - `Esc` 取消当前操作或取消选中。

验收：
- 用户可以从自动标注结果直接切换到人工校对。
- 多类别漏检时，可以快速选类别并补标。
- 误检时，可以选中后快速删除。

风险控制：
- 该阶段仍不拆独立路由，减少状态迁移风险。
- 保留返回自动模式的入口。

### 阶段 6：拆独立路由但共享控制器

目标：提供清晰入口，同时避免复制逻辑。

任务：
- 增加路由：
  - `/project/image/:id/auto`
  - `/project/image/:id/review`
  - 可保留 `/project/image/:id` 重定向或默认进入 auto。
- 新建 `image-workspace-shell.js` 作为共享壳。
- `image-auto-workspace.js` 和 `image-review-workspace.js` 只配置不同面板和默认模式。
- 切换路由时保留：
  - 当前项目。
  - 当前图片。
  - 当前类别。
  - 当前筛选条件。

验收：
- 自动页面和人工页面都能打开同一项目同一张图。
- 两个页面的保存、删除、切图使用同一 controller。
- 不再复制图片加载和标注保存代码。

风险控制：
- 路由切换前强制 flush dirty annotations。
- unmount 时取消 pending request/timer。

### 阶段 7：后端 API 模块化

目标：在前端稳定后再拆后端，降低同时变更风险。

任务：
- 先拆 Pydantic schemas 到 `schemas/`。
- 再按领域拆 router：
  - `projects.py`
  - `images.py`
  - `annotations.py`
  - `inference.py`
  - `filters.py`
  - `exports.py`
- 将复杂业务迁移到 services：
  - 删除图片。
  - 批量删除无标注图片。
  - 智能过滤应用/回滚。
  - 标注保存和索引更新。
- 将 storage 中 SQLite 操作逐步迁移到 repositories。

验收：
- API 路径和响应格式保持兼容。
- 旧前端不需要同步大改。
- 单图删除、批量删除、保存标注、智能过滤统计一致。

风险控制：
- 每拆一个 router，都保留原 endpoint 行为。
- 存储层拆分期间增加针对临时项目目录的 smoke test。

## 浏览器验证策略

浏览器验证允许用于每个阶段。验证账号：

- 用户名：`admin`
- 密码：不写入仓库文档；执行时从当前任务上下文或本地环境变量 `WEB_AUTO_E2E_PASSWORD` 获取。

推荐验证地址：

- 直连：`http://172.16.1.65:8000/#/`
- 本机：`http://127.0.0.1:8000/#/`

推荐验证流程：

1. 登录。
2. 打开一个 image project。
3. 选择一张已有标注图片。
4. 切换自动/人工模式。
5. 手动画一个 bbox，确认标注列表出现新标注。
6. 修改新标注类别。
7. 选中标注后按 `Delete` 删除。
8. 画一个 polygon，按 `Enter` 完成。
9. 保存并切换下一张，确认前一张标注仍存在。
10. 删除一张测试图片，确认图片列表、项目统计、文件和标注 JSON 同步更新。
11. 回到自动模式，确认单图推理/批量入口仍可用。

每阶段至少保留以下验证记录：

```text
阶段：
提交：
验证地址：
浏览器：
项目：
通过流程：
失败流程：
截图/备注：
```

## 质量门槛

每阶段完成前至少执行：

```bash
node --check web-auto/frontend/js/pages/image-workspace.js
node --check web-auto/frontend/js/components/image-viewer-v2.js
python3 -m py_compile web-auto/app/main.py web-auto/app/storage.py
git diff --check
```

当新增模块后，语法检查应扩展到对应新文件。

涉及后端删除、保存、索引更新时，增加临时项目 smoke test：

- 创建临时项目。
- 添加两张测试图片。
- 保存一张空标注、一张非空标注。
- 删除空标注图片。
- 验证项目统计、SQLite 索引、annotation JSON、原图文件状态。

## 重构完成判定

达到以下条件可认为第一轮模块化完成：

- 自动标注和人工校对有独立入口或清晰模式切换。
- 两者共用同一套 annotation/image controller。
- `image-workspace.js` 不再承载全部业务逻辑，主要负责装配。
- 新增人工校对功能不需要改自动推理面板。
- 新增自动推理功能不需要改人工校对面板。
- 删除图片、保存标注、类别更新、撤销重做只有一个主要实现入口。
- 浏览器验证清单覆盖自动和人工两条核心路径。

## 推荐执行顺序

优先执行前端重构，后端只做必要接口补充。推荐顺序：

1. 阶段 0：基线和验证模板。
2. 阶段 1：纯工具/API 服务拆分。
3. 阶段 2：AnnotationController。
4. 阶段 3：ImageNavigationController。
5. 阶段 5：人工校对模式。
6. 阶段 4：持续抽面板，降低大文件体积。
7. 阶段 6：拆独立路由。
8. 阶段 7：后端模块化。

这样先解决用户最直接的人工校对效率问题，同时逐步降低后续功能添加成本。

## 当前执行进展

- 阶段 1 已开始落地：前端 API 已按领域拆分为 `services/`，`api.js` 保留兼容外观；HTML escaping、几何工具、图片 bundle 缓存状态已抽出。
- 阶段 2 已开始落地：标注创建、删除、类别更新、几何更新、撤销重做、自动保存和手动保存已迁移到 `AnnotationController`。
- 阶段 3 已开始落地：图片列表组件和 `ImageNavigationController` 已承接分页、筛选、未标注导航和单图删除。
- 阶段 4 已开始落地：类别面板、标注列表、图片列表、顶部工作台工具栏、数据看板外壳、导出面板、智能过滤面板模板已经组件化；自动标注控制和人工校对工具条已拆到独立组件。类别面板渲染、选择、删除和新增弹窗已迁移到 `ClassController`；智能过滤事件绑定、payload 收集、任务轮询和结果摘要已迁移到 `SmartFilterController`，数据看板内容渲染和重建索引事件已迁移到 `DataDashboardController`，导出弹窗事件绑定和导出调用已迁移到 `ExportController`，预览结果渲染、事件绑定和保存逻辑已迁移到 `PreviewController`，单图推理、示例预览、批量任务启动/轮询/暂停恢复、批量配置和结果弹窗已迁移到 `InferenceController`。全局键盘快捷键已迁移到 `KeyboardCommandManager`，GPU 状态轮询和渲染已迁移到 `GpuStatusController`，左右栏和类别/标注/预览区折叠布局已迁移到 `LayoutController`；`image-workspace.js` 页面内 inline `onclick` 已清理；全局任务浮窗也已改为事件委托并对任务文本做 HTML 转义。
- 阶段 5 已开始落地：现有图片工作台已增加“自动标注/人工校对”同页模式。人工校对模式会隐藏自动推理配置，提供当前类别、连续标注、快速改类/删标注、保存下一张、下一张未标注入口，并支持数字键快速切换类别。模式切换、工具条状态同步、连续模式、保存下一张、数字键切类和“改为当前类”已迁移到 `ReviewController`。

后续优先继续阶段 4 的面板拆分，把自动推理相关 UI 和项目/pose 页面剩余 inline DOM 事件继续移出；等共享控制器稳定后再进入阶段 6 的独立路由拆分。
