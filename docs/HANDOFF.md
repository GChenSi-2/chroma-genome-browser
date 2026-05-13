# Project Chroma — 移交文档

> 给 Claude Code 的项目执行手册。
> 项目代号 **Chroma**（取自染色体 chromosome + 视觉色彩 chromatic 的双关）。
> 单人项目 + agent team 并行。本文是唯一事实来源（single source of truth）。

---

## 0. 你（Claude Code）需要先读的东西

按顺序读完这五份文档，再开始动手。**不要跳读。**

1. `HANDOFF.md`（本文）— 总览、范围、原则
2. `ARCHITECTURE.md` — 四层架构、模块边界、技术栈定钉
3. `DESIGN_SYSTEM.md` — 设计语言、配色、字体、动效规范
4. `TWO_DAY_SPRINT.md` — 两天 demo 冲刺的逐 task 拆解
5. `AGENT_PLAYBOOK.md` — 如何启动 agent team、任务分配、冲突解决

读完后，**用中文**向用户回复一份 5 条以内的 confirmation checklist，确认你理解了：
- 项目定位
- 技术栈的硬约束
- 两天范围的边界（什么做、什么不做）
- agent team 的协作方式
- 你打算先动手的第一个 task

得到用户 "go" 之后再开始执行。

---

## 1. 项目定位（不可妥协）

**一句话：** Chroma 是一个现代化、高性能、开源的浏览器基因组浏览器，定位为 IGV.js 的替代品，主攻**生信工程师**和**临床报告嵌入**两个场景。

### 1.1 用户

- **Primary**：生信工程师，每天看几十到几百个 locus，对快捷键、性能、可脚本化高度敏感。
- **Secondary**：临床报告系统的集成方，需要把"variant context viewer"嵌入到他们自己的 Web 应用里。

### 1.2 决策摘要（用户已确认）

| 决策点 | 决定 |
|---|---|
| 替代目标 | IGV.js（浏览器版），不是桌面 IGV |
| 数据敏感性 | BAM 可能含患者数据，**纯本地 / 自托管**，不做云端协作 |
| 开源策略 | 核心引擎完全开源（Apache 2.0） |
| IGV 兼容 | 不兼容 session XML，提供单向导入工具 |
| 团队 | 单人 + Claude agent team |

### 1.3 项目不是什么

明确排除以避免范围蔓延：

- ❌ 不是变异分析 pipeline（不做 calling、annotation、filtering）
- ❌ 不是 LIMS / 样本管理
- ❌ 不是云端协作工具（Phase 3 再说）
- ❌ 不是桌面应用（不打包 Electron / Tauri）
- ❌ 不是 Jupyter / R 内核（不嵌入 notebook）

---

## 2. 三条设计哲学（每个 PR 自检）

每次提交代码前，问自己：

1. **Tufte 化的信息密度** — 这次改动有没有增加无意义的 chrome？分隔线、阴影、border 能不能用空气和层级替代？
2. **语义缩放** — 这个 track 在不同 zoom level 下，**信息形态**是不是变了，而不仅仅是几何缩放？
3. **键盘优先** — 这个交互能不能不用鼠标完成？

---

## 3. 性能基线（硬指标，无商量）

两天 demo 必须打到以下数字，跑不到就是失败：

| 场景 | Chroma 目标 | IGV.js 基线（参考） |
|---|---|---|
| 1Mb region, BAM with 100K reads, 初始渲染 | < 300ms | ~1500ms |
| 同上，拖拽 pan | 稳定 60fps | 20-30fps |
| 缩放（wheel zoom） | 稳定 60fps | 掉帧到 15fps |
| Locus 跳转（基因名搜索→渲染完成） | < 500ms | ~2s |
| 内存占用（10 个 track，1Mb region） | < 300MB | ~600MB+ |

**Benchmark 是 PR 的 gate**，CI 跑不过这些数字就不许 merge。详见 `BENCHMARKS.md`。

---

## 4. 技术栈（钉死，不要在执行中临时换）

| 层 | 选型 | 备选（仅当主选爆炸时） |
|---|---|---|
| 语言 | TypeScript 5.x（strict + noUncheckedIndexedAccess） | — |
| 构建 | Vite 5 | — |
| UI 框架 | **Solid.js** | （不用 React，原因见 ARCHITECTURE §3.4） |
| 状态 | `@preact/signals-core`（Solid 自带 signal，外用这个保独立） | — |
| 渲染主力 | WebGL2（手写，不用 Three/PixiJS） | Pixi.js（仅当 WebGL2 手写超时再 fallback） |
| 渲染辅助 | Canvas2D（文本、轴、低密度元素） | — |
| Worker | 原生 Web Worker + Comlink | — |
| 数据解析 | `@gmod/bam`、`@gmod/tabix`、`@gmod/vcf`、`@gmod/bbi` | — |
| 字体 | Inter（UI）+ JetBrains Mono（碱基/坐标） | — |
| CSS | Tailwind v4 + CSS variables（设计 token） | — |
| 组件库 | 不用！自己写 5 个核心组件 | — |
| 测试 | Vitest + Playwright（visual regression） | — |
| 包管理 | pnpm | — |
| Monorepo | 不用，**单 package**（两天范围内不需要） | — |

**关于 Solid.js 的解释**（agent 不许质疑这个决策）：
- 细粒度响应式，更新 viewport 不会重渲染整棵组件树
- 没有 virtual DOM 的开销，更接近"signal 直驱 DOM"
- API 心智模型小，单人维护友好
- bundle 小（~7KB），符合"嵌入式临床报告"场景

---

## 5. 仓库结构

```
chroma/
├── apps/
│   └── demo/                  # Vite demo 站，两天冲刺的产出
├── packages/                  # 暂不分包，先放 src/
├── src/
│   ├── data/                  # L1 数据层
│   │   ├── workers/
│   │   ├── parsers/
│   │   ├── tiles/             # tile 缓存与调度
│   │   └── tracks-data/       # 各 track 类型的数据 schema
│   ├── render/                # L2 渲染层
│   │   ├── webgl/
│   │   │   ├── shaders/
│   │   │   ├── programs/
│   │   │   └── instanced/
│   │   ├── canvas2d/
│   │   ├── coord/             # 64位坐标系（hi/lo 双 Float32）
│   │   └── tracks-render/     # 各 track 类型的渲染器
│   ├── state/                 # L3 状态层（signals）
│   │   ├── viewport.ts
│   │   ├── tracks.ts
│   │   └── selection.ts
│   ├── ui/                    # L4 UI Chrome
│   │   ├── components/
│   │   ├── shortcuts/
│   │   └── pages/
│   ├── plugins/               # Phase 2 才碰
│   └── index.ts
├── tests/
│   ├── unit/
│   ├── visual/                # Playwright 截图回归
│   └── bench/                 # 性能 benchmark
├── fixtures/                  # 测试用的 BAM/VCF 切片
├── docs/
│   ├── HANDOFF.md
│   ├── ARCHITECTURE.md
│   ├── DESIGN_SYSTEM.md
│   ├── TWO_DAY_SPRINT.md
│   ├── AGENT_PLAYBOOK.md
│   └── BENCHMARKS.md
└── package.json
```

**为什么 src/ 在根而不在 packages/**：单人 + 两天，monorepo 的成本（构建配置、依赖管理）不值。等 Phase 2 完成且有第二个 package（比如 `@chroma/clinical-embed`）需求时再切分。

---

## 6. 范围（两天冲刺）

详细 task 见 `TWO_DAY_SPRINT.md`，这里只列**最终交付物**：

✅ **必须有**
1. Demo 站可访问，URL 可分享视图状态
2. 加载远程 BAM（IGV S3 demo 数据集）
3. 三种 track：reference (FASTA)、alignment (BAM)、coverage (BigWig)
4. 语义缩放：BAM 在 >50kb 显示 coverage histogram，<50kb 显示 pileup，<200bp 显示单碱基
5. 键盘导航：`g` jump、`/` search、`h/l` pan、`+/-` zoom、`?` help
6. 性能：100K reads pileup 60fps 拖拽
7. 一个 README + 一个 GIF demo + 一个 benchmark 报告

✅ **如果时间允许（按优先级）**
8. VCF track（variant ticks + tooltip）
9. Split view（两个 viewport 并排）
10. Dark mode 切换
11. 截图导出 PNG

❌ **不做（即使 agent 想做）**
- 自定义 track 拖拽排序（用快捷键）
- 设置面板的图形 UI（用 JSON config）
- 插件系统
- 单元测试的 100% 覆盖率（写关键路径就行）
- i18n（先英文）
- 移动端响应式（不在用户场景里）

---

## 7. 工程纪律（Claude Code 必读）

### 7.1 提交规范

- 每个 task 一个 commit，message 用 conventional commits：`feat(render): instanced read rectangles`
- 不许出现 `WIP`、`fix typo`、`update` 这种 message
- 每个 PR 必须包含：变更说明、性能影响（哪怕是"无影响"也要写）、截图（如果是 UI 改动）

### 7.2 代码品味红线

以下情况**直接重写，不要 patch**：

- 渲染相关函数 > 80 行 → 拆
- 一个文件 > 400 行 → 拆
- `any` 出现在 src/ 中（除非有 `// @ts-expect-error` 注释解释）→ 修
- `console.log` 留在 commit 里 → 用 debug 库或删
- 任何 setTimeout(fn, 0) / requestIdleCallback 的"hack" → 找根因
- 直接操作 DOM（除了 ui/ 之外）→ 走 signal

### 7.3 性能纪律

每个写 render 层的 PR 必须附带一行：

```
Perf: 1Mb / 100K reads pan @ XX fps (target 60), peak XXX MB (target <300)
```

数字从 `pnpm bench` 跑出来贴上。

### 7.4 不许写的代码

- 不许在主线程做 BAM/VCF 解析
- 不许用 Float32 直接存 genomic coordinate（必须走 `src/render/coord/` 的 helper）
- 不许在 WebGL render loop 里 `new` 对象
- 不许给 Canvas 元素加 React/Solid 子节点
- 不许用 localStorage 存 viewport state（用 URL）

### 7.5 卡住的时候

如果一个 task 你预估 > 4 小时还没跑通，**停下来，写一个 `BLOCKED.md` 描述你试了什么、看到什么报错、你的假设**，然后请用户介入。不要一个人挖坑挖到天黑。

---

## 8. Agent Team 启动方式

详见 `AGENT_PLAYBOOK.md`。一句话版本：

- 你（Claude Code）是 **lead**，负责架构决策、PR review、合并冲突仲裁
- 你 spawn **3 个 sub-agent**，按层切：data、render、ui
- 每个 sub-agent 有自己的 worktree，工作在独立 branch
- 你每完成一个里程碑做一次 sync，跑 benchmark，再分发下一批 task

---

## 9. 与用户的沟通

用户是项目的产品负责人和最终审美判官。以下情况**必须**找用户确认，不要自己决定：

- 任何配色 / 字体 / 间距的视觉决策（哪怕"看起来差不多"）
- 任何快捷键定义
- 性能不达标时的取舍（要不要降级渲染质量）
- 第三方库引入（超出 §4 列表的）
- 范围相关的"要不要做这个"问题

用户不需要被打扰的：

- 实现细节（用什么 shader 写法、怎么组织文件）
- 命名问题（除非语义有歧义）
- 测试写法

---

## 10. 成功的样子

两天结束时，能给用户一个链接，他点开就看到：

1. 一个加载快得让他笑出来的基因组浏览器
2. 一个能并排和 igv.js 对比的 benchmark 页
3. 一段干净到他想立刻 open source 的代码

走起。
