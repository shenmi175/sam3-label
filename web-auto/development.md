# web-auto 开发梳理

本文档基于当前 `web-auto` 已发现的问题与待新增功能，整理为两部分：

1. 问题优化
2. 功能更新

每个条目都包含：

- 问题或目标
- 当前判断
- 是否需要澄清
- 解决方案
- 实施步骤
- 验收标准

## 一、问题优化

### 1. 图片列表分页状态在项目之间串页

#### 问题

当前图片项目切换时，前一个项目的分页偏移量可能残留到下一个项目。

典型场景：

- 在一个 10000 张图片的项目中切到第 30 页
- 返回项目列表
- 再进入一个只有 100 张图片的项目
- 前端仍沿用第 30 页偏移量，导致图片列表为空

#### 当前判断

这是典型的前端页面状态未按 `project_id` 隔离的问题。

大概率原因：

- 图片工作区的 `offset / limit / selectedImageId / image list cache` 在项目切换时没有完整重置
- 或者状态恢复逻辑按“页面级全局状态”恢复，而不是按“项目级状态”恢复

#### 是否需要澄清

不需要，需求明确。

#### 解决方案

将图片工作区状态分成两层：

- 全局默认状态
- 按 `project_id` 持久化的项目状态

进入项目时采用以下规则：

1. 如果该项目有独立保存的 UI 状态，则恢复该项目自己的分页和选中图片
2. 如果没有，则重置到第一页
3. 如果恢复后的 `offset >= totalImages`，自动回退到最后一个有效页

#### 实施步骤

1. 检查前端图片工作区状态恢复逻辑
2. 将 `offset / limit / selectedImageId / focusedAnnotationId / unlabeledNavigationEnabled` 改为按项目隔离
3. 在 `loadProjectInfo()` 完成后，对分页边界做一次校正
4. 在 `loadImages()` 前加保护：
   - 若 `offset < 0`，置 0
   - 若 `offset >= totalImages` 且 `totalImages > 0`，置到最后一页起始偏移
5. 切换项目时清空上一项目的内存缓存

#### 验收标准

- 切换不同项目时不会继承前一个项目的页码
- 小项目不会出现空列表
- 返回项目后能够恢复该项目自己的页码和当前图片

---

### 2. 类别添加时换行没有被正确拆分

#### 问题

在项目页和标注页添加类别时，说明写的是“换行可区分不同提示词”，但实际输入：

```text
person
dog
```

会被解析成一个类别：`person dog`

#### 当前判断

这是输入解析逻辑的问题，不是前端显示问题。

高概率原因：

- 前端把多行文本预处理成单行后再提交
- 或后端 `classes_text` 解析时只按空格或逗号拆分，没有正确处理换行

#### 是否需要澄清

不需要，需求明确。

#### 解决方案

统一类别解析规则，前后端都按相同标准处理：

- 逗号 `,`
- 中文逗号 `，`
- 换行 `\n`
- 分号 `;`
- 中文分号 `；`

空格不作为主分隔符，避免把 `person face` 错拆成两个类别。

#### 实施步骤

1. 检查后端 `classes_text` 解析函数，确认是否只保留“逗号/换行/分号”为分隔符
2. 前端提交前不做“压成一行”的预处理
3. 项目创建页和标注页的“添加类别”入口统一走同一接口和同一解析逻辑
4. 文案补充明确说明：
   - “每行一个类别”
   - “类别内部允许空格”

#### 验收标准

- 输入多行类别后，后端生成多个类别
- `person face` 保持为一个类别
- 项目页和标注页行为一致

---

### 3. 大规模全图文本推理可能跳过部分图片

#### 问题

在大数据集上进行全图文本推理时，怀疑存在图片被跳过的情况。

当前还不明确是：

- SQLite 分页/索引问题
- 前端任务参数问题
- 后端批处理恢复/中断逻辑问题
- 远端 `sam3-api` 调用失败后未被重试的问题

#### 当前判断

这不是单一点问题，应该拆成“定位”和“增强”两层：

1. 先定位到底是没调到、调了失败、还是结果保存失败
2. 再增加重试与范围控制能力

#### 是否需要澄清

需要澄清 1 点，但不阻塞先做：

- “重新标注指定类别图片” 的定义
  建议默认解释为：
  “只处理当前项目中，已有该类别或当前类别相关标注的图片，并且写回时只覆盖该类别，不影响其他类别。”

如果后续希望变成“只根据文件筛选，不看现有标注”，需要再补筛选逻辑定义。


#### 解决方案

分成两步实施。

##### 第一步：定位与补强可靠性

新增任务级统计和失败记录：

- `requested_images`
- `processed_images`
- `saved_images`
- `failed_images`
- `skipped_images`
- `failed_image_ids`
- `skipped_image_ids`

并把“跳过原因”分清楚：

- 已有标注被策略跳过
- API 返回空结果
- API 调用失败
- 保存失败

##### 第二步：增加批量推理模式弹窗

把“全图文本推理”改成先弹窗，再启动任务。弹窗支持：

1. 重新标注全部图片
2. 只标注未标注图片
3. 重新标注指定类别相关图片
4. 只标注指定类别相关的未标注图片

同时支持任务结束后的“结果复核弹窗”：

- 总图片数
- 已处理数
- 成功数
- 失败数
- 未标注数
- 每个类别的新增数量

并提供两个按钮：

- `重试未完成`
- `确认关闭`

#### 实施步骤

1. 后端批量推理任务状态增加明细统计字段
2. 在任务过程中记录每张图片的处理结果
3. 完成后返回汇总统计
4. 前端把“全图文本推理”改成参数弹窗
5. 前端在任务完成后弹出汇总结果框
6. 前端“重试未完成”时只提交失败/未完成图片列表

#### 验收标准

- 大数据集任务完成后，可以明确知道哪些图片未处理成功
- 可以一键重试未完成图片
- 可以只跑未标注图片
- 可以按类别相关范围跑任务

---

### 4. 项目页创建日期显示 `Invalid Date`

#### 问题

项目列表页创建日期显示异常，出现 `Invalid Date`。

#### 当前判断

大概率是前端日期解析不兼容导致：

- 后端返回的时间字符串格式前端没有正确解析
- 或者前端对空值/非法值没有兜底

#### 是否需要澄清

不需要。

#### 解决方案

统一时间显示策略：

- 后端统一返回 ISO 8601 字符串
- 前端统一通过一个日期格式化函数处理
- 遇到异常值时显示 `--`

#### 实施步骤

1. 审查项目列表页时间格式化函数
2. 审查后端 `created_at / updated_at` 格式
3. 前端增加 `safeFormatDate(value)` 工具函数
4. 所有列表页统一复用

#### 验收标准

- 不再出现 `Invalid Date`
- 创建日期与更新时间都能正常显示

---

### 5. 暗色主题下中央画布仍然保持亮色

#### 问题

切换到暗色主题后，中间画布区域仍然是亮色背景，与整体主题不一致。

#### 当前判断

这是样式变量没有完全主题化的问题。

大概率原因：

- 画布容器写死了浅色背景值
- 主题切换只作用于全局容器，没有同步到工作区画布层

#### 是否需要澄清

不需要。

#### 解决方案

把画布背景从写死颜色改成 CSS 变量，例如：

- `--canvas-bg`
- `--canvas-grid`
- `--panel-bg`

浅色和暗色主题分别定义。

#### 实施步骤

1. 找出图片页/视频页中央画布容器的内联背景色
2. 抽到主题变量
3. 检查浮动工具条、预览卡、右侧栏在暗色下的对比度
4. 补一个主题切换后的重新渲染

#### 验收标准

- 暗色主题下画布背景不再刺眼
- 图片页和视频页保持统一视觉风格

---

### 6. 智能过滤缺少更多可调过滤条件

#### 问题

现有智能过滤能力偏少，用户希望增加：

- 微小目标过滤
- 实例数量过滤
- 目标位置过滤
- 置信度过滤

并要求在计算过程中显示进度。

#### 当前判断

这是“现有功能增强”，但其一部分属于问题优化，因为当前智能过滤对大数据集的分析粒度不足。

#### 是否需要澄清

需要澄清 2 点，但可以先按默认方案实现：

1. “中心区域 50%” 是否按图像宽高分别取中心 50%
   默认方案：是，采用中心矩形区域。
2. “类别可选” 是否支持：
   - 全部类别
   - 单类
   - 多类
   默认方案：支持多选类别。

**澄清: 中心区域为中心线上下各25%，左右各25%的中心矩形区域，其参数可调整，如上下各30%(一共60%)；类别可选支持多选类别，可以同时除了多个类别**

#### 解决方案

将智能过滤扩展为“规则组合分析器”，每条规则支持：

- 启用开关
- 参数配置
- 作用类别范围

建议首批规则：

1. 小目标过滤
   - 参数：面积占比阈值
2. 实例数量过滤
   - 参数：实例数上限/下限
3. 位置过滤
   - 参数：中心区域比例
4. 置信度过滤
   - 参数：最小置信度

所有规则都通过现有任务化机制运行，并显示真实进度。

#### 实施步骤

1. 扩展智能过滤后端请求模型
2. 扩展逐图分析逻辑，支持规则组合
3. 前端弹窗改为规则列表式配置界面
4. 预览阶段返回每条规则命中的统计
5. 确认阶段沿用任务缓存，避免重复计算

#### 验收标准

- 每个规则都可以单独启用
- 支持类别多选
- 预览和确认都有真实进度
- 大项目上不会无反馈卡住

---

## 二、功能更新

### 1. 全图文本推理能力升级

#### 目标

把当前“直接点击即开始”的全图文本推理，升级为“先选策略再执行”的完整工作流。

#### 是否需要澄清

需要澄清 1 点，但可先按默认方案推进：

- “指定类别图片” 的判定口径
  默认先按“现有标注中包含目标类别”来筛选图片。
**澄清：指定类别图片从标注统计中的类别来选择，选择后，若目标图片中包含选择到的类别则进行推理**

#### 方案

新增“批量推理设置弹窗”，包含：

- 推理范围
  - 全部图片
  - 未标注图片
  - 含指定类别的图片
  - 含指定类别且未标注的图片
- 覆盖策略
  - 覆盖同类结果
  - 仅追加新结果
- 类别范围
  - 当前选中类
  - 手动多选类

任务完成后弹出“结果总览弹窗”，支持一键重试未完成图片。

#### 实施步骤

1. 后端增加批处理筛选参数
2. 前端将按钮改成打开弹窗
3. 批处理结果持久化到任务状态
4. 新增任务完成后的汇总弹窗

#### 验收标准

- 用户可控推理范围
- 不需要人工再找漏图
- 可以对未完成部分快速重试

---

### 2. 新增“统计”入口与统计总览

#### 目标

在“智能过滤”左侧新增“统计”按钮，用于查看当前项目的标注概况。

#### 当前判断

该功能应拆成两层：

1. 轻量统计弹窗
2. 详细统计页面

#### 是否需要澄清

需要澄清 1 点，但不阻塞：

- 详细统计页是否需要导出图片/CSV
  默认第一阶段不做导出，只做查看。

**澄清：不做任何导出，之后也不做导出**

#### 方案

##### 第一阶段：统计弹窗

展示：

- 总图片数
- 已标注图片数
- 未标注图片数
- 每个类别的实例数
- 标注形式分布
  - bbox
  - polygon
  - mask-derived polygon

按钮：

- `查看详细统计`
- `关闭`

##### 第二阶段：详细统计页

建议展示：

1. 类别实例数柱状图
2. 已标注 / 未标注图片分布
3. 目标框面积分布
4. 目标框中心点热力图
5. 长宽比分布
6. 每张图实例数分布

#### 实施步骤

1. 后端新增统计汇总接口
2. 后端新增统计明细接口
3. 前端新增统计弹窗
4. 前端新增统计详情页路由
5. 前端接入图表库

#### 验收标准

- 统计弹窗能秒开或可接受地显示 loading
- 详细页能展示可视化图表
- 大项目上不会卡死页面

---

### 3. 智能过滤高级规则面板

#### 目标

把当前智能过滤从“有限几个固定选项”升级成“可组合规则面板”。

#### 方案

规则面板建议分组：

1. 类别范围
2. 面积规则
3. 数量规则
4. 位置规则
5. 置信度规则
6. 合并/删除策略

每组都有：

- 开关
- 参数输入
- 说明文本

并保留：

- 预览分析
- 确认应用
- 任务进度
- 复用预览结果

#### 实施步骤

1. 重构智能过滤弹窗布局
2. 扩展请求结构
3. 后端按规则组合分析
4. 前端按任务状态显示进度和摘要

#### 验收标准

- 规则组合不会互相冲突
- 预览和确认结果一致
- 规则参数能记住上次选择

---

### 4. 统计详情页的可视化能力

#### 目标

让统计不只停留在数字，而是能帮助快速发现数据问题。

#### 方案

建议第一版提供以下图表：

1. 类别实例数量柱状图
2. 每图实例数分布直方图
3. bbox 面积分布直方图
4. bbox 中心点二维热力图
5. bbox 长宽比分布图

并提供筛选：

- 按类别
- 按是否已标注
- 按标注类型

#### 实施步骤

1. 后端返回聚合统计 JSON
2. 前端图表层按需渲染
3. 详情页增加条件筛选
4. 图表间支持联动筛选可放到第二阶段

#### 验收标准

- 图表可读
- 数据和实际标注一致
- 不会因为 1 万张图直接把浏览器卡死

---

## 三、建议的实施顺序

### 第一批：应先修复的问题

1. 图片列表分页串页
2. 类别换行解析错误
3. 创建日期 `Invalid Date`
4. 暗色主题画布背景

### 第二批：影响生产效率的增强

1. 全图文本推理模式弹窗
2. 批量推理结果汇总与重试
3. 智能过滤高级规则

### 第三批：分析与运营增强

1. 统计按钮与统计弹窗
2. 统计详情页
3. 数据可视化图表

## 四、SQLite 标注索引层实施方案

本节用于把“统计、智能过滤、批量推理范围筛选”共用的 SQLite 标注索引层细化到可直接开发。

目标不是替换现有 JSON 标注文件，而是增加一层派生索引：

- JSON 仍然是主存储和最终真值
- SQLite 负责快速查询、聚合、筛选和统计
- 每次单图保存标注时，增量更新该图片对应的索引

### 4.1 设计目标

索引层必须同时满足以下目标：

1. 支持统计弹窗秒级返回
2. 支持统计详情页图表查询
3. 支持智能过滤的候选集预筛选
4. 支持批量推理范围筛选
5. 不破坏现有 JSON 文件读写逻辑
6. 支持旧项目迁移和断点回填

### 4.2 存储原则

采用“双写”结构：

- 主存储：`annotation_dir/*.json`
- 派生索引：`web_auto_index.sqlite3`

原则如下：

- 任何标注写入最终都以 JSON 为准
- SQLite 只存“可查询字段”和“聚合字段”
- 不把完整 mask 二进制或整份 polygon 明细全部存进 SQLite
- 只存统计需要的几何摘要

### 4.3 表结构设计

建议新增 3 张表。

#### 表 1：`annotation_image_stats`

用途：

- 单图维度统计
- 快速判断某张图是否有标注、标注量多少、类别数多少
- 支持项目级汇总时少扫一层对象表

字段建议：

- `project_id TEXT NOT NULL`
- `image_id TEXT NOT NULL`
- `instance_count INTEGER NOT NULL DEFAULT 0`
- `class_count INTEGER NOT NULL DEFAULT 0`
- `bbox_count INTEGER NOT NULL DEFAULT 0`
- `polygon_count INTEGER NOT NULL DEFAULT 0`
- `mask_like_count INTEGER NOT NULL DEFAULT 0`
- `score_sum REAL NOT NULL DEFAULT 0`
- `score_avg REAL NOT NULL DEFAULT 0`
- `area_ratio_sum REAL NOT NULL DEFAULT 0`
- `area_ratio_avg REAL NOT NULL DEFAULT 0`
- `updated_at TEXT NOT NULL`
- `content_rev INTEGER NOT NULL DEFAULT 0`

主键：

- `(project_id, image_id)`

索引建议：

- `idx_annotation_image_stats_project`
  `(project_id)`

#### 表 2：`annotation_object_index`

用途：

- 实例级筛选与聚合
- 支撑类别分布、面积分布、位置分布、长宽比分布、规则过滤

字段建议：

- `project_id TEXT NOT NULL`
- `image_id TEXT NOT NULL`
- `ann_id TEXT NOT NULL`
- `class_name TEXT NOT NULL`
- `shape_type TEXT NOT NULL`
  - 取值建议：`bbox` / `polygon` / `mask_polygon`
- `score REAL NOT NULL DEFAULT 0`
- `bbox_x1 REAL NOT NULL DEFAULT 0`
- `bbox_y1 REAL NOT NULL DEFAULT 0`
- `bbox_x2 REAL NOT NULL DEFAULT 0`
- `bbox_y2 REAL NOT NULL DEFAULT 0`
- `bbox_cx REAL NOT NULL DEFAULT 0`
- `bbox_cy REAL NOT NULL DEFAULT 0`
- `bbox_w REAL NOT NULL DEFAULT 0`
- `bbox_h REAL NOT NULL DEFAULT 0`
- `aspect_ratio REAL NOT NULL DEFAULT 0`
- `area_px REAL NOT NULL DEFAULT 0`
- `area_ratio REAL NOT NULL DEFAULT 0`
- `is_center_region INTEGER NOT NULL DEFAULT 0`
- `updated_at TEXT NOT NULL`
- `content_rev INTEGER NOT NULL DEFAULT 0`

主键：

- `(project_id, image_id, ann_id)`

索引建议：

- `idx_annotation_object_project_class`
  `(project_id, class_name)`
- `idx_annotation_object_project_image`
  `(project_id, image_id)`
- `idx_annotation_object_project_score`
  `(project_id, score)`
- `idx_annotation_object_project_area_ratio`
  `(project_id, area_ratio)`
- `idx_annotation_object_project_center`
  `(project_id, is_center_region)`

#### 表 3：`annotation_index_meta`

用途：

- 管理迁移、回填和索引版本
- 记录某个项目当前索引是否完整

字段建议：

- `project_id TEXT NOT NULL PRIMARY KEY`
- `index_version INTEGER NOT NULL`
- `index_status TEXT NOT NULL`
  - 取值建议：`missing` / `building` / `ready` / `failed`
- `indexed_images INTEGER NOT NULL DEFAULT 0`
- `total_images INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT NOT NULL DEFAULT ''`
- `updated_at TEXT NOT NULL`
- `last_full_rebuild_at TEXT NOT NULL DEFAULT ''`

### 4.4 与现有表的关系

现有 `project_images` 表继续保留，负责：

- 图片列表
- 分页
- 排序
- 已标注 / 未标注状态

新增索引层负责：

- 标注内容聚合
- 类别级、实例级查询
- 统计和过滤加速

两者关系：

- `project_images.status`
  用于判断图像级已标注状态
- `annotation_image_stats`
  用于图像级统计摘要
- `annotation_object_index`
  用于实例级查询

### 4.5 写入更新策略

#### 写入入口

所有增量更新都挂在现有 `save_annotations(project_id, image_id, annotations)` 后。

写入步骤建议：

1. 先写 JSON
2. 再在同一逻辑里重建该图的 SQLite 索引
3. 如果 SQLite 更新失败：
   - JSON 不能回滚
   - 记录 `annotation_index_meta.last_error`
   - 标记该项目 `index_status = building` 或 `failed`

#### 单图重建逻辑

对单张图执行：

1. 删除该图在 `annotation_object_index` 的旧记录
2. 重新解析当前标注列表
3. 生成实例级记录插入 `annotation_object_index`
4. 聚合生成 `annotation_image_stats`
5. 更新 `annotation_index_meta.updated_at`

这样做的优点：

- 实现简单
- 单图写入场景下成本可控
- 不需要复杂 diff

### 4.6 统计字段计算口径

以下口径建议固定，避免前后不一致。

#### `shape_type`

规则：

- 只有 bbox：`bbox`
- 有 polygon：`polygon`
- 如果 polygon 来自 mask 近似转换：`mask_polygon`

#### `area_px`

规则：

- 优先取 polygon 面积
- 没有 polygon 时取 bbox 面积

#### `area_ratio`

规则：

- `area_px / image_area`
- image area 来源于原图宽高

#### `bbox_cx / bbox_cy`

规则：

- 使用归一化坐标，范围 `[0, 1]`
- 便于跨图尺寸统计

#### `aspect_ratio`

规则：

- `bbox_w / max(bbox_h, epsilon)`

#### `is_center_region`

按你已澄清的默认口径：

- 中心矩形区域默认：
  - 左右各 25%
  - 上下各 15%
- 参数以后可扩展
- 这里先存一版默认口径布尔值，用于快速筛选

### 4.7 迁移流程

迁移分三种情况。

#### 情况 A：新项目

流程：

1. 创建项目时写入 `annotation_index_meta`
2. `index_status = ready`
3. `indexed_images = 0`
4. 后续每次单图保存时增量更新

#### 情况 B：旧项目首次打开

流程：

1. 打开项目时检查 `annotation_index_meta`
2. 若没有该项目索引记录：
   - 创建 meta 记录
   - `index_status = missing`
3. 前端进入统计、过滤、批推范围筛选时，如果发现索引未完成：
   - 触发后台回填任务
   - 页面显示“正在建立统计索引”

#### 情况 C：索引版本升级

流程：

1. `annotation_index_meta.index_version < CURRENT_INDEX_VERSION`
2. 标记 `index_status = building`
3. 后台整项目重建
4. 完成后更新版本号

### 4.8 回填任务设计

建议新增“标注索引回填任务”，不要复用现有智能过滤或批推任务。

任务状态至少包含：

- `job_id`
- `project_id`
- `status`
- `indexed_images`
- `total_images`
- `progress_pct`
- `current_image_id`
- `current_image_rel_path`
- `started_at`
- `updated_at`
- `finished_at`
- `error`

执行过程：

1. 遍历项目图片
2. 逐图读取 JSON 标注
3. 生成索引记录
4. 每张图后更新进度

异常策略：

- 单图失败时记录错误并继续
- 整体完成后若有失败图片：
  - `index_status = failed`
  - 保存失败列表
- 允许重试未完成图片

### 4.9 接口设计

建议新增以下接口。

#### 1. 查询索引状态

`GET /api/projects/{project_id}/annotation_index/status`

响应建议：

```json
{
  "project_id": "prj_xxx",
  "index_version": 1,
  "index_status": "ready",
  "indexed_images": 10000,
  "total_images": 10000,
  "progress_pct": 100.0,
  "last_error": ""
}
```

#### 2. 启动索引回填

`POST /api/projects/{project_id}/annotation_index/rebuild`

请求：

```json
{
  "force_full": false
}
```

用途：

- 首次回填
- 版本升级回填
- 手动重建

#### 3. 查询索引任务状态

`GET /api/projects/{project_id}/annotation_index/job`

用途：

- 前端轮询建立进度

#### 4. 快速统计汇总

`GET /api/projects/{project_id}/stats/summary`

响应建议：

```json
{
  "project_id": "prj_xxx",
  "total_images": 10000,
  "labeled_images": 8200,
  "unlabeled_images": 1800,
  "total_instances": 53210,
  "class_counts": [
    {"class_name": "cat", "count": 22011},
    {"class_name": "dog", "count": 13120}
  ],
  "shape_counts": {
    "bbox": 1200,
    "polygon": 45000,
    "mask_polygon": 7010
  }
}
```

#### 5. 统计详情

`GET /api/projects/{project_id}/stats/detail`

建议按查询参数拆图表数据，而不是一次性返回全部明细。

参数建议：

- `section=class_counts`
- `section=image_instance_hist`
- `section=area_hist`
- `section=center_heatmap`
- `section=aspect_hist`
- `classes`
- `shape_types`

这样可以避免一次接口返回过大。

#### 6. 智能过滤候选预筛选

不一定暴露成公开接口，也可以作为后端内部查询层。

建议内部能力支持：

- 按类别筛对象
- 按面积筛对象
- 按位置筛对象
- 按置信度筛对象
- 返回候选图片 id 集合

#### 7. 批量推理范围查询

建议新增内部查询函数，不一定单独暴露接口。

支持：

- 全部图片
- 未标注图片
- 含指定类别的图片
- 含指定类别且未标注的图片

### 4.10 查询实现建议

#### 统计弹窗

优先查：

- `project_images`
- `annotation_image_stats`
- `annotation_object_index`

不要再调用全量 `all_annotations()`。

#### 智能过滤

采用两阶段：

1. SQLite 预筛选候选图片
2. 对候选图片回读 JSON 做精确分析

这样能显著降低全项目全量扫描成本。

#### 批量推理范围筛选

先用 SQLite 生成目标图片集合，再启动推理任务。

### 4.11 性能预期

在 1 万张图规模下，预期效果如下。

#### 没有索引层

- 统计弹窗：慢
- 智能过滤预览：慢
- 指定类别批量推理：慢
- 导出统计：慢

#### 有索引层后

- 统计弹窗：应接近秒开
- 统计详情页：取决于图表类型，但应明显快于扫 JSON
- 智能过滤：候选集大幅缩小
- 指定类别批推：范围筛选变快

### 4.12 风险与规避

#### 风险 1：JSON 与 SQLite 索引不一致

规避：

- 写入顺序固定
- 提供手动重建索引能力
- 在统计页发现异常时提示“索引重建”

#### 风险 2：首次迁移耗时长

规避：

- 后台任务化
- 前端显示进度
- 支持断点重试

#### 风险 3：SQLite 文件变大

规避：

- 不存完整 polygon 点集
- 只存统计摘要字段

#### 风险 4：索引版本升级复杂

规避：

- 引入 `index_version`
- 每次结构变化走版本化回填

### 4.13 验收标准

索引层完成后，至少满足：

1. 新项目单图保存时自动更新索引
2. 旧项目可以后台回填索引
3. 统计弹窗不再扫描全量 JSON
4. 智能过滤支持先候选筛选再精确分析
5. 指定类别批量推理范围筛选走 SQLite
6. 索引损坏时可以手动重建

### 4.14 第一阶段开发任务清单

本阶段目标只做“标注索引基础设施”，不直接改统计页、智能过滤 UI、批量推理弹窗。

第一阶段交付范围：

1. SQLite 索引表落地
2. 单图保存时增量维护索引
3. 旧项目索引回填任务
4. 索引状态接口
5. 统计汇总接口第一版

不在本阶段内的内容：

- 统计详情页图表
- 智能过滤高级规则界面
- 批量推理范围弹窗
- 批量推理逐图重试弹窗

#### 4.14.1 文件级改动清单

##### `web-auto/app/storage.py`

本文件是第一阶段核心。

建议新增或修改的函数：

1. `_init_index_db()`
   - 新增 `annotation_image_stats`
   - 新增 `annotation_object_index`
   - 新增 `annotation_index_meta`
   - 增加必要索引

2. `_ensure_annotation_index_meta(project_id: str, total_images: int) -> None`
   - 若项目没有 meta 记录，则初始化

3. `_annotation_index_delete_image(project_id: str, image_id: str) -> None`
   - 删除单图旧索引

4. `_annotation_index_build_rows(project: dict, image: dict, annotations: list[dict]) -> tuple[dict, list[dict]]`
   - 输入当前图片标注
   - 输出：
     - 单图汇总行
     - 实例索引行列表

5. `_annotation_index_write_image(project: dict, image: dict, annotations: list[dict]) -> None`
   - 单图索引重建入口
   - 先删旧，再写新

6. `_annotation_index_mark_status(project_id: str, *, status: str, indexed_images: int | None = None, total_images: int | None = None, last_error: str = '') -> None`
   - 更新 meta 状态

7. `get_annotation_index_status(project_id: str) -> dict[str, Any]`
   - 供接口读取索引状态

8. `rebuild_annotation_index_for_project(project_id: str, *, progress_cb: Callable | None = None, image_ids: list[str] | None = None) -> dict[str, Any]`
   - 全量或部分回填
   - 供后台任务调用

9. `get_stats_summary(project_id: str) -> dict[str, Any]`
   - 第一版统计汇总
   - 仅走 SQLite 聚合

10. 修改 `save_annotations(...)`
   - 在 JSON 写入后调用 `_annotation_index_write_image(...)`

11. 修改 `delete_project(...)`
   - 删除项目时同步清理标注索引相关表数据

##### `web-auto/app/main.py`

建议新增：

1. `AnnotationIndexRebuildIn(BaseModel)`
   - `project_id: str`
   - `force_full: bool = False`

2. 索引任务状态容器
   - 可独立于 infer/video/filter 任务，避免混用
   - 建议：
     - `ANNOTATION_INDEX_JOB_LOCK`
     - `ANNOTATION_INDEX_JOB_THREADS`
     - `ANNOTATION_INDEX_JOB_STATES`

3. 新接口：
   - `GET /api/projects/{project_id}/annotation_index/status`
   - `POST /api/projects/{project_id}/annotation_index/rebuild`
   - `GET /api/projects/{project_id}/annotation_index/job`
   - `GET /api/projects/{project_id}/stats/summary`

4. 新任务 worker：
   - `_run_annotation_index_rebuild_job(...)`
   - `_spawn_annotation_index_job(...)`
   - `_get_annotation_index_job_state_or_404(...)`

##### `web-auto/DEVELOPER_API_GUIDE.md`

本阶段需补文档：

1. 索引状态接口
2. 索引重建接口
3. 索引任务状态接口
4. 统计汇总接口

##### `web-auto/FRONTEND_REQUIREMENTS.md`

本阶段只需要补前端约束，不要求马上实现页面：

1. 当索引未完成时，统计入口需显示“索引构建中”
2. 统计弹窗优先读取 `/stats/summary`
3. 若索引状态不是 `ready`，页面必须有 loading / rebuilding 提示

#### 4.14.2 函数级实现顺序

建议严格按下面顺序开发，便于逐步验证。

##### 步骤 1：扩展 SQLite 表结构

先改：

- `Storage._init_index_db()`

完成后验证：

- 新数据库初始化成功
- 旧数据库可自动补表

##### 步骤 2：单图索引重建能力

新增：

- `_annotation_index_build_rows(...)`
- `_annotation_index_delete_image(...)`
- `_annotation_index_write_image(...)`

完成后验证：

- 传入单图标注后，能正确写入 2 张索引表
- 空标注时能清空该图索引

##### 步骤 3：接入 `save_annotations(...)`

修改：

- `save_annotations(...)`

执行顺序建议：

1. 校验项目与图片
2. 写 JSON
3. 更新 `project_images.status`
4. 写 SQLite 标注索引
5. 保存 `projects.json`

完成后验证：

- 单图保存后，JSON 和 SQLite 同步更新

##### 步骤 4：索引状态管理

新增：

- `_ensure_annotation_index_meta(...)`
- `_annotation_index_mark_status(...)`
- `get_annotation_index_status(...)`

完成后验证：

- 新项目能自动生成 meta
- 状态可读

##### 步骤 5：全量回填任务

新增：

- `rebuild_annotation_index_for_project(...)`
- 后台任务状态结构
- 对应 API

完成后验证：

- 旧项目可执行全量回填
- 中途失败能记录进度和错误

##### 步骤 6：统计汇总接口

新增：

- `get_stats_summary(project_id)`
- `GET /api/projects/{project_id}/stats/summary`

完成后验证：

- 不依赖 `all_annotations()`
- 汇总数字正确

#### 4.14.3 接口详细设计

##### `GET /api/projects/{project_id}/annotation_index/status`

用途：

- 页面判断索引是否可用
- 显示构建进度

返回字段建议：

- `project_id`
- `index_version`
- `index_status`
- `indexed_images`
- `total_images`
- `progress_pct`
- `last_error`
- `updated_at`

##### `POST /api/projects/{project_id}/annotation_index/rebuild`

用途：

- 手动触发回填
- 版本升级后重建

请求体：

```json
{
  "project_id": "prj_xxx",
  "force_full": false
}
```

返回：

- `job`

##### `GET /api/projects/{project_id}/annotation_index/job`

用途：

- 轮询回填任务

返回字段建议：

- `job_id`
- `project_id`
- `status`
- `indexed_images`
- `total_images`
- `progress_pct`
- `current_image_id`
- `current_image_rel_path`
- `started_at`
- `updated_at`
- `finished_at`
- `error`

##### `GET /api/projects/{project_id}/stats/summary`

用途：

- 统计弹窗首屏数据

返回字段建议：

- `total_images`
- `labeled_images`
- `unlabeled_images`
- `total_instances`
- `class_counts`
- `shape_counts`
- `score_summary`
  - `avg`
  - `min`
  - `max`

#### 4.14.4 迁移顺序

迁移时不要一次切全链路，按以下顺序最稳。

##### 迁移阶段 A：建表但不启用查询

目标：

- 只新增表
- 不改变现有统计逻辑

验证点：

- 服务能正常启动
- 旧项目不报错

##### 迁移阶段 B：新写入自动增量更新

目标：

- 新保存的图片开始有索引
- 老图片暂时没有索引也没关系

验证点：

- 新标注写入后索引正常

##### 迁移阶段 C：旧项目后台回填

目标：

- 补齐存量索引

验证点：

- 可中断
- 可重试
- 可看到进度

##### 迁移阶段 D：统计汇总切换到 SQLite

目标：

- 首个真正消费索引的功能先切到统计

验证点：

- 统计结果和旧逻辑一致
- 性能明显改善

#### 4.14.5 回滚策略

如果第一阶段上线后出现问题，回滚方式必须简单。

建议回滚策略：

1. 保留 JSON 主写入逻辑不变
2. SQLite 索引更新失败不阻塞 JSON 保存
3. 统计接口若发现索引不可用：
   - 返回“索引未完成”
   - 不直接回退到全量 JSON 扫描
4. 索引损坏时允许：
   - 删除项目索引数据
   - 重新回填

#### 4.14.6 测试清单

第一阶段至少补这些测试。

##### 单元测试

1. bbox-only 标注索引构建
2. polygon 标注索引构建
3. 空标注清空索引
4. 多类别统计聚合
5. 中心区域判断

##### 集成测试

1. 新建项目后首次保存标注，索引正确生成
2. 旧项目回填任务完成后，统计可读
3. 删除项目后索引数据被清理
4. 单图重写标注后，索引同步更新

##### 性能测试

1. 1000 图项目统计汇总耗时
2. 10000 图项目统计汇总耗时
3. 10000 图回填总耗时

#### 4.14.7 本阶段默认口径

为了避免第一阶段反复澄清，以下口径在本阶段直接固定：

1. JSON 仍然是唯一真值，SQLite 仅为派生索引
2. `area_ratio` 采用目标面积 / 图像面积
3. `bbox_cx / bbox_cy` 使用归一化坐标
4. `shape_type` 仅区分 `bbox / polygon / mask_polygon`
5. 中心区域采用当前已澄清口径的默认值
6. 统计汇总第一阶段不做导出
7. 索引未完成时，统计接口返回“索引未完成”，而不是退回全量 JSON 扫描

#### 4.14.8 本阶段是否仍有澄清项

结论：

- 本阶段没有阻塞性澄清项
- 可以直接按本节方案开发

说明：

- 后续“统计详情页长什么样”“智能过滤规则 UI 怎么排布”属于第二阶段及以后问题
- 不影响第一阶段先把 SQLite 标注索引层落地

## 五、当前仍需明确的产品口径

以下问题建议在实施前最终确认，但不影响先做基础框架：

1. “指定类别图片” 的判定口径
   默认建议：按现有标注中是否包含该类别判断。
2. 智能过滤中的“位置过滤”区域定义
   默认建议：使用图像中心矩形区域。
3. 统计详情页是否需要第一版就支持导出
   默认建议：第一版只做查看，不做导出。
4. 智能过滤规则中的类别范围
   默认建议：支持多选类别，而不是仅单类。

## 六、总体结论

当前列出的需求中，没有发现必须暂停开发才能继续的硬阻塞项。

结论如下：

- 问题类条目基本都有明确解决方案
- 功能类条目中，批量推理范围定义和统计页导出方式存在轻度产品歧义
- 这些歧义不影响先做基础能力与界面结构

建议按“先修问题，再补批量任务增强，最后做统计分析”的顺序推进。  
这条路径风险最低，也最容易尽快提升大规模数据集场景下的可用性。
