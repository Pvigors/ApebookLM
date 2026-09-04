# CAD 模型 MVP：现役架构、边界与数据治理

更新：2026-08-30

## 1. 现役目标

现役候选版本是**CAD v3 免费预检 + Text2CAD V2 受控几何**。它把“能不能生成”放在扣分与入队之前，再把服务端冻结的 `CadRequestPlanV3` 交给模型和几何内核。社区版镜像包含独立 CAD worker 和原生 FreeCAD 二次 STEP 复读；官方 Compose 已完成空卷启动、Replicad→FreeCAD 交叉复读与资源隔离验收，因此默认启用 CAD 入口。worker 未就绪时预检仍会在扣分前拒绝。

用户必须在三条通道中明确选择一条：

- `source_driven`：只从已选来源提取顶层设计对象和可执行约束。部件名不冒充并列目标；同一文档有多个顶层设计时，用户必须选择本次对象。教程、附录、对比对象的尺寸与能力词不得借给主目标。
- `prompt_driven`：用户明确输入对象和尺寸，完全不使用左栏来源。用户描述是唯一几何真源，不存在“附加参考来源”的隐式通道。
- `fixed_template`：只执行页面列出的结构化数值，可不选来源，也不使用已选来源。未结构化的“补充要求”会明确拒绝，不得存入计划后静默忽略。

四孔安装板教学件只能由用户显式点击，绝不作为“无目标”的静默降级。一般生成中的设计假设也必须由用户显式勾选；省略字段等于不同意。

对象不再靠中文字面包含比对。v3 使用版本化 `objectId`，已将 `robotic_arm`（机械臂）与 `humanoid_robot`（人形机器人）分开，并冻结部件数、角色与精度边界。

Text2CAD V2 当前允许：

- 1–24 个命名部件，每件独立材料、颜色和放置变换
- XY / XZ / YZ 平面的矩形、圆、多边形、直线/三点圆弧闭合路径
- 拉伸特征和 `new / add / cut / intersect` 受控布尔序列
- 命名 STEP、合并 STL、毫米单位的二维 DXF 顶视离散边线投影、多色语义网格、部件树和特征历史
- 统一工程坐标：X=整体长度/轴距，Y=整体宽度/深度，Z=整体高度；总长宽高以最终 B-Rep 包围盒验收

支持七类模板：

- 安装平板 `plate`
- 安装支架 `mounting_bracket`
- 设备外壳 `enclosure`
- 连接法兰 `flange`
- 轴径转接套 `shaft_adapter`
- 人形机器人 `humanoid_robot`：16 部件参数化概念装配
- 汽车 `concept_car`：车身 + 四轮共 5 部件参数化概念装配

人形机器人和汽车用于比例、外形占位和方案沟通，**不是可直接制造的整机设计**：当前不包含驱动器/减速器/线束/车架/悬架/内饰、运动学、载荷、公差配合、BOM 或可动关节。STL 是合并网格，不保留装配层级。

系统仍不承诺任意复杂装配、自由曲面、建筑/BIM、钣金展开、工程图/GD&T、CAM 刀路或“保证可制造”。DXF 只表达当前 B-Rep 的 XY 顶视离散边线，不包含三维实体、隐藏线消除、尺寸标注、公差或图框。界面中的几何校验是设计辅助结论，不是行业标准认证。

## 2. 现役链路

```text
免费预检（编辑权限，不要求积分）
  → 三模式解析 / 稳定 objectId / 能力与约束门
  → 冻结 CadRequestPlanV3 + sourceSnapshotHash + planHash
  → 用户查看对象、约束、假设与能力边界后二次确认
  → 幂等键 + 原子扣分入队
  → CAD 专用 claim 车道（非 CAD 车道独立继续）
  → 独立 CAD worker 核对 owner/库版本/FreeCAD heartbeat
  → worker 重算当前来源 planHash，并直接冻结这次复核的 targetEvidence 正文
  → provider 只消费这份内存快照，不再读 live chunks/live source
  → 受限 Text2CadDesignSpec V2 JSON（手选旧模板时为 CadDesignSpec V1）
  → 严格 schema / 单位 / 尺寸 / 需求反向覆盖 / 业务规则门禁
  → V2 严格规范化受控特征序列（V1 固定模板由服务端确定性派生 FeatureGraph）
  → 独立 Node 子进程解释受控轮廓/特征序列
  → Replicad + Open CASCADE/WASM 生成 B-Rep
  → BRepCheck + 体积 + 网格 + 文件完整性校验
  → 隔离 Node 进程重新导入 STEP，核对 mm / solid / B-Rep / 面边 / 体积 / 整体与逐零件包围盒
  → 原生 FreeCAD 再次导入同一 STEP，摘要必须与冻结 manifest 一致
  → STEP / STL / 2D DXF 顶视投影 / mesh / spec / manifest 文件包
  → 现有 run_attempt 栅栏发布为 CAD 制品
```

核心不变量：

1. 模型只能填写受控 JSON，不能提供或执行 Python、JavaScript、OpenSCAD、FreeCAD Macro、shell、路径、URL 或任意代码。
2. V2 特征序列只允许 schema 白名单中的轮廓、拉伸与四种布尔操作；V1 `featureGraph` 仍由服务端模板确定性派生。
3. 几何工人不继承数据库或模型密钥；只读固定规格，只向 `.data/cad-tmp/tmp-*` 写固定文件名。
4. Text2CAD 几何工人有 180 秒硬终止与 1024MB Node 堆上限；外层 CAD 任务有 300 秒上限，并继续受 `run_attempt` 旧跑栅栏约束。CAD 心跳不再伪造 90% 进度，只由真实阶段边界推进。
5. 只有每步布尔真正改变体积、每个部件恰好 1 个有效 solid、部件之间无正体积干涉，且 STEP/STL/二维 DXF/语义网格完整时才发布。旧模板仍保持原定值实体数合同。
   教学示例固定为一个显式用户动作；正式汽车/机器人/机械臂必须由冻结来源或用户目标驱动并通过对象合同门禁。
6. CAD 原生文件首版只允许登录态笔记本成员访问；匿名公开分享、整本 Markdown 导出和复制笔记本都明确跳过 CAD。
7. 自动匹配始终走 Text2CAD V2 受控命令序列；用户手选七种固定模板时，生成结果必须与所选 ID 一致。
8. 新制品使用 `manifestVersion=2` + `libraryVersion=2`。Text2CAD 还必须使 `artifactMode` / `partCount` / `partsHash` 与语义网格、DB 冻结快照全等。已发布 library v1 仍可读；只兼容新字段完整缺失的更旧五种单零件。
9. 所选来源与实际取材来源分别保存；只有 `source_driven` 保留真实来源证据。`prompt_driven` 和 `fixed_template` 始终 `sourceIds=[]`。
10. 数量、字符和字节上限只有一份代码真源：最多 24 个来源、51.2 万字符、2MiB UTF-8 正文。预检、入队和 worker 使用同一上限；超限在 NFKC/正则扫描前就拒绝。
11. 模型调用最多为初始编译、一次 IR 定向修复和一次几何定向修复。终态对象/来源/能力错误不重试；修复轮只携带冻结约束、上一版 IR 和结构化问题，不重发整份来源。
12. 同一用户幂等键在网络重发、并发点击、权重变化或已达在途上限时均只能返回原 job，不得重复扣分。
13. 失败任务保留阶段、错误码、预留积分与退回状态。“删除记录”只软隐藏，不删计量、退回或审计链。
14. 序列化几何的材料与制造工艺是受控 IR 字段；明确材料必须进入 `part.material`，明确工艺必须进入 `process`，不得只作为预览文案。
15. 免费预检和入队有用户/笔记本/全局三层限流、小并发槽和 32/64KiB JSON 实际字节上限；同一来源文本 hash 的分析摘要有界缓存。

## 3. 文件包与生命周期

```text
.data/cad/<outputId>/
  design-spec.json   # canonical 受控规格
  model.step         # 中性 B-Rep 交换文件，不承诺保留原生参数历史
  model.stl          # 制造预览/打印交换文件
  top-view.dxf       # AutoCAD 2000 ASCII；XY 顶视二维 B-Rep 离散边线投影，单位 mm；不是三维实体或制造图
  mesh.json          # Web 三维预览
  manifest.json      # 版本、部件/特征、hash、几何校验和 stepValidation
```

- 删除制品、笔记本或用户时，通用媒体清理会递归删除整个 CAD 文件包。
- 备份脚本把 `cad/` 与音视频、图片一并增量同步。
- 临时包与正式备份目录物理分离；崩溃遗留的 `.data/cad-tmp/tmp-*` 在超过 24 小时后由任务扫描器清理，不会进入 CAD 正式备份。
- 候选包同时保留 `replicad-isolated` 同内核强摘要门，并在 `CAD_REQUIRE_EXTERNAL_STEP_VALIDATOR=1` 时强制 `freecad-native` 第二读取器。两者都通过才发布/下载。FreeCAD 增加了独立编译产物的交换兼容证据，仍**不等于商业 CAD 全兼容或可制造认证**。
- Web 容器固定不认领 CAD；`cad-worker` 以非 root 用户、只读根文件系运行，只挂载 `.data/cad` 成品目录，临时目录是独立 tmpfs，并有 CPU/内存/PID/capability 边界。它只在 DB owner 匹配且 FreeCAD 自检通过时写心跳。Web 在扣分前检查 30 秒心跳、worker ID 与 `CAD_LIBRARY_VERSION`。
- 官方 Compose 通过 `NBLM_CAD_ENABLED=1` 默认启用 CAD；不部署独立 worker 时应设为 `0`。后台“应用设置 → CAD 灰度”仍可即时覆盖默认值。
- 模型库升级发布时先关闭 CAD 灰度、等待旧 CAD 任务排空，再切换包含同一 `libraryVersion` 的 Web/worker，运行多实体健康检查后重开。不允许新 Web 把装配任务交给旧 worker。

## 4. 积分口径

- 生成前最多预留 12 积分；当前 Text2CAD V2 与七种固定模板同价。
- 完成后沿用全站真实 Token 结算，多退不补。
- CAD 的非 Token 成本下限为 5 积分，用于覆盖 B-Rep 计算、网格、STEP/STL/二维 DXF 导出和存储。
- `cad_tutorial` 教学示例不调用模型，确定性按 5 积分结算：预留 12、完成退 7。`no_cad_target` 先调模型确认无目标，仍按真实 Token 结算（最低 5、最高 12）；供应商未返回 usage 时收预留价，不能伪装成零 Token 确定性路径。正式模型同样在 usage 缺失时按预留价结算。
- 失败、取消或旧跑失权沿用现有持久积分退回 outbox，不另造账本。

积分权重是首发值；实例压测后应按平均输入/输出 Token、单零件/装配 P95 渲染时长、文件体积和失败重试率复核，在没有样本数据前不虚构分档。

## 5. 数据集许可证门禁

本次实现**没有下载或训练任何外部 CAD 数据集**。当前治理状态：

| 数据/项目 | 已知许可 | 当前用途 | 商用训练状态 |
|---|---|---|---|
| Markov `cad-1000-hours` | 数据卡未声明许可证；公开讨论仍在询问 | 只做格式研究和未来适配规划 | **阻断**，取得书面授权前不得下载进生产、微调、蒸馏或构建衍生训练集 |
| AutoCAD-Bench tasks | CC BY 4.0 | 可用于带归因的离线基准 | 仅基准；训练需另行做来源/归因审查 |
| CADGenBench | Apache 2.0 | 参考“生成—渲染—校验—修正”架构 | 不复制其数据；代码复用需保留许可证 |
| Zero-to-CAD 1M | Apache 2.0 | 候选公开训练/评测源 | 尚未引入；须完成来源、再分发和模型条款审计 |
| DFKI Text2CAD | CC BY-NC-SA 4.0 | 只参考公开论文的“文本→CAD 序列”思路 | **阻断**：仓库、数据和权重均未下载/引入；获得商业书面授权前不得进生产 |
| Replicad | MIT | 现役受控几何 API | 已固定依赖版本并随包保留许可证 |
| replicad-opencascadejs | LGPL-2.1-only | 现役 Open CASCADE/WASM 内核 | 生产开启前需完成 LGPL/WASM 分发与可替换性法务复核 |
| FreeCAD library `0.20.2+dfsg1-4` | LGPL-2.1-or-later | 独立 CAD worker 中的原生 STEP 二次复读 | 按 Debian `libfreecad-python3-0.20` 原包分发；版本、NOTICE、可替换性与容器 SBOM 纳入发布门 |

核对入口：

- Markov CAD 1000 Hours：<https://huggingface.co/datasets/markov-ai/cad-1000-hours>
- 许可证讨论：<https://huggingface.co/datasets/markov-ai/cad-1000-hours/discussions/1>
- AutoCAD-Bench：<https://huggingface.co/markov-ai/autocad-bench>
- AutoCAD-Bench tasks：<https://huggingface.co/datasets/markov-ai/autocad-bench-tasks>
- CADGenBench：<https://github.com/huggingface/cadgenbench>
- Replicad：<https://github.com/sgenoud/replicad>
- FreeCAD 源码与许可：<https://github.com/FreeCAD/FreeCAD>
- Text2CAD 仓库与许可：<https://github.com/SadilKhan/Text2CAD>
- Text2CAD 数据/权重许可：<https://huggingface.co/datasets/SadilKhan/Text2CAD>

任何人若要改变表中“阻断/仅基准”状态，必须把许可证原文、授权主体、允许用途、归因方式、终止条件和数据快照 hash 一并进入发布审查；“能下载”不等于“可商用训练”。

## 6. 下一阶段业务路线

### P1：自然语言参数修订与版本差异

- “把孔径改为 8mm”只生成新 revision，不覆盖旧规格。
- 展示需求 → 参数 → 特征的影响图，明确一句话改动影响了哪些几何特征。
- 加入参数前后尺寸、体积、文件 hash 与可回滚版本。

### P1：发布门禁与制造辅助

- 先聚焦 3 轴 CNC 或 3D 打印单一工艺。
- 检查最小壁厚、孔边距、刀具内圆角、深径比、装夹面、打印悬垂等规则。
- 所有结论标注为建议，并允许配置具体工厂/机器能力。

### P2：工程协作

- STEP AP242 导入与语义 PMI。
- 工程图、BOM、装配健康、仿真证据和检验结果的发布门禁。
- SysML v2 需求与 QIF 检验数据双向追溯。

北极星指标不是“生成了多少模型”，而是：**每个发布包提前发现的跨需求/几何/制造不一致数，以及由此节省的返工时间。**
