# TWO_DAY_SPRINT.md — 两天冲刺逐 task 拆解

> 这是 demo 阶段的执行剧本。每个 task 标了 owner（lead = Claude Code 主进程，agents = sub-agent）、估时、依赖。
>
> **时钟从用户发出 "go" 开始**，按"工作小时"计（不是真实日历时间，agent 可并行所以总时长 ≠ 任务时长之和）。

---

## Day 0（前置 30 分钟）

### T0.1 仓库初始化 · lead · 15min
```bash
pnpm create vite@latest chroma -- --template solid-ts
cd chroma
pnpm add @gmod/bam @gmod/tabix @gmod/vcf @gmod/bbi @gmod/indexedfasta
pnpm add @preact/signals-core comlink lucide-solid
pnpm add -D @types/node vitest @vitest/web-worker playwright @playwright/test
pnpm add -D tailwindcss@next @tailwindcss/vite
git init && git commit -m "chore: bootstrap"
```

### T0.2 目录骨架 + Tailwind + 设计 token · lead · 15min
按 ARCHITECTURE §5 创建空目录，把 `DESIGN_SYSTEM.md §2` 的 token 抄到 `src/styles/tokens.css`。

**Gate**：`pnpm dev` 能跑出空白页，dark mode toggle 有效。

---

## Day 1（核心引擎，目标：100K reads 60fps 跑通）

### Stream A — 数据层 · agent-data

#### T1.A.1 RangeFetcher + cache · 2h
- `src/data/network/range-fetcher.ts`
- 合并相邻 range（500ms window，64KB threshold）
- `Cache API` 持久化
- 单元测试覆盖：合并、超时、abort

#### T1.A.2 Worker pool + Comlink 封装 · 1.5h
- `src/data/workers/pool.ts`
- 暴露 `parseBamTile`、`parseBigWigTile`、`parseFastaTile`
- AbortSignal 透传到 worker 内的 fetch
- 测试：cancel 已 dispatch 的 task

#### T1.A.3 BAM 解析 worker · 3h
- 输入：url + chrom + start + end + binSize
- 输出：§ARCHITECTURE 3.5 的 `ReadTile` SoA 结构
- 当 binSize >= 8192 时返回 coverage histogram（不返回 read 详情）
- 当 binSize < 8192 时返回 read 列表
- 测试：用 fixtures/hg002.chr20.bam 跑出确定数量的 reads

#### T1.A.4 BigWig 解析 worker · 1.5h
- 输出：`Float32Array` 一维数组（每 bin 一个值）
- 测试：和 `bigWigInfo` 命令行工具的 mean 一致

#### T1.A.5 FASTA reference worker · 1h
- 输出：碱基 packed `Uint8Array`（2-bit）
- LRU 缓存最近访问的 chrom 切片

#### T1.A.6 Tile cache（主线程侧）· 1.5h
- `src/data/tiles/cache.ts`
- LRU，256 上限
- 按距 viewport 距离加权淘汰
- 暴露 signal `tileCache`

**Stream A 总计：~10.5h，由 agent-data 单独完成**

---

### Stream B — 渲染层 · agent-render

#### T1.B.1 WebGL2 context + helpers · 1h
- `src/render/webgl/context.ts`
- 失败 fallback：弹 modal（不在两天内做 canvas2d 降级）
- shader 编译 + program 链接 helper（带错误打印）

#### T1.B.2 64 位坐标系 · 1h
- `src/render/coord/index.ts`
- `viewportMatrix(viewport): mat3`
- `toShaderCoord(pos, origin): number`
- 测试：1e9 + 1e3 精度不丢

#### T1.B.3 Pileup track renderer（核心）· 4h
- `src/render/tracks-render/bam-pileup.ts`
- 输入：ReadTile + viewport
- pileup 算法：贪心放置到第一个空闲 row（用 interval tree 加速）
- WebGL2 instanced draw
- 测试：1M reads draw call < 10ms（在 mock 数据上）

#### T1.B.4 Coverage histogram renderer · 1.5h
- `src/render/tracks-render/bam-coverage.ts`
- 简单 `TRIANGLE_STRIP`，每 bin 两个三角形
- 顶部抗锯齿边缘（fragment shader 同 pileup）

#### T1.B.5 BigWig renderer · 1h
- 复用 coverage renderer，区别在颜色与缩放
- 支持 log scale toggle

#### T1.B.6 Reference (sequence ruler) renderer · 2h
- basePixelWidth < 4 时只画刻度（Canvas2D）
- basePixelWidth >= 4 时画碱基字符（WebGL2 SDF 文本）
- SDF 字体：用 [msdf-bmfont-xml](https://github.com/soimy/msdf-bmfont-xml) 预生成 atlas，**项目里直接包含一份 atlas，不在 build 时生成**

#### T1.B.7 渲染调度器 · 2h
- `src/render/scheduler.ts`
- 订阅 viewport + tracks signal
- `requestAnimationFrame` 驱动
- dirty flag：viewport 变 → 全部 redraw；track 变 → 部分 redraw
- 帧预算：> 10ms 时降低质量（暂时禁用 mismatch）

#### T1.B.8 语义缩放过渡 · 1.5h
- 监听 `semanticLevel` 切换
- 双缓冲 layer，alpha blend 200ms
- 测试：在边界附近反复缩放不闪烁

**Stream B 总计：~14h，agent-render 主力**

---

### Stream C — 状态与 URL · agent-ui (这阶段还轻松)

#### T1.C.1 Viewport / tracks / selection signals · 1h
- 按 ARCHITECTURE §4 实现
- 派生 signal：basePixelWidth、semanticLevel、visibleTileKeys

#### T1.C.2 URL ↔ State 双向同步 · 2h
- `src/state/url-sync.ts`
- hash 改 → 更新 viewport
- viewport 改 → replaceState（debounce 100ms）
- tracks 改 → 写 query
- 测试：粘贴 URL 进浏览器，应用还原相同视图

#### T1.C.3 Locus parser · 1h
- 支持 `chr1:1,000,000-2,000,000`、`chr1:1000000`、`1:1M-2M`
- 错误时返回 `Result<Locus, string>`

---

### Day 1 收尾（lead 主导）· 1h

- Merge 三个 stream，跑 benchmark
- 必须达到的数字：
  - 加载 hg002 chr20:1-1M BAM tile < 800ms（首次）
  - pileup 拖拽 60fps
  - coverage zoom 60fps
- 不达到的话：**立刻找瓶颈**，agents 暂停新任务

**Day 1 出货物：一个能用键盘 pan/zoom 的 pileup demo（无 UI chrome）**

---

## Day 2（UI、打磨、benchmark 报告）

### Stream D — UI Chrome · agent-ui

#### T2.D.1 TopBar · 1.5h
- Logo（文字 + 渐变色块）
- Locus input（中央，单行）
- 右侧：theme toggle、help 按钮
- 高度 40px，无 border-bottom（用空气分隔）

#### T2.D.2 TrackPanel · 2h
- 左侧 220px 列表
- 每行：拖手图标（不可拖，预留）+ icon + label + visibility eye + ⋯ menu
- 选中态：左侧 2px accent 条
- 增加 track 按钮在底部

#### T2.D.3 MiniMap · 2h
- 顶部固定，高度 24px
- 染色体级 ideogram（用 cytoband 数据，预先内置 GRCh38）
- 当前 viewport 高亮框
- 点击跳转

#### T2.D.4 HelpOverlay · 1h
- `?` 触发
- 半透明背景，居中卡片
- 列出所有快捷键，按"导航/Track/视图"分组

#### T2.D.5 Search palette · 2h
- `/` 触发，居中
- 输入基因名（先用预内置的 HGNC top 1000 + Ensembl API fallback）
- 上下箭头 + Enter 跳转
- 显示 chrom:pos 预览

#### T2.D.6 空状态 · 0.5h
- 按 DESIGN_SYSTEM §8.2 实现

#### T2.D.7 Loading skeleton · 1h
- 各 track 类型一个 skeleton
- CSS 高光扫过动画

---

### Stream E — 第三种 track 类型（VCF）· agent-render

#### T2.E.1 VCF 解析 worker · 1.5h
#### T2.E.2 VCF tick renderer · 1.5h
- 每个 variant 一个 tick（垂直线），按 type 上色
- hover 显示 tooltip：ID、REF/ALT、QUAL、FILTER、INFO 关键字段

---

### Stream F — Benchmark & Polish · lead

#### T2.F.1 Benchmark suite · 2h
- `tests/bench/perf.ts`
- 跑 ARCHITECTURE §3 五个场景
- 输出 markdown 报告（含 IGV.js 同条件数字）
- IGV.js 对比通过一个 iframe 跑，自动化 timer 取 `requestAnimationFrame` 帧时

#### T2.F.2 Demo 数据集 + landing · 1h
- 内置 3 个 demo：
  - "HG002 Illumina chr20" → BAM + coverage
  - "HG002 PacBio HiFi chr20" → 长读对比
  - "GIAB benchmark variants" → VCF + BAM
- 首页空状态点击直接载入

#### T2.F.3 README + GIF · 1.5h
- README：what / why / quickstart / benchmark / 截图
- 用 vhs 或手动 OBS 录三段 GIF：
  1. 从全染色体 zoom 到单碱基（4 秒）
  2. 100K reads 拖拽流畅（3 秒）
  3. /搜索基因 → 跳转（3 秒）

#### T2.F.4 部署 · 0.5h
- Vercel / Cloudflare Pages（任选最快的）
- 配置 CORS 允许 IGV S3 数据源

---

### Day 2 收尾 · lead · 1h

最终验收 checklist：

- [ ] 5 个 benchmark 数字全部达标，写进 README
- [ ] 三个 demo 数据集都能一键载入
- [ ] 所有键盘快捷键能 work
- [ ] URL 分享可还原视图
- [ ] Dark mode 完整可用
- [ ] 没有 console error / warning
- [ ] Lighthouse perf > 90, a11y > 95
- [ ] git log 干净（每个 task 一个 commit）
- [ ] 部署 URL 可访问

**Day 2 出货物：可分享的 demo URL + benchmark 报告 + README + 3 个 GIF**

---

## 总时长估算

| 流 | 任务总时 | Owner |
|---|---|---|
| Stream A (data) | 10.5h | agent-data |
| Stream B (render) | 14h | agent-render |
| Stream C (state) | 4h | agent-ui (空闲时) |
| Stream D (UI chrome) | 10h | agent-ui |
| Stream E (VCF) | 3h | agent-render (空闲时) |
| Stream F (bench/polish) | 5h | lead |
| 收尾 & merge | 2h | lead |
| **并行执行总挂钟时间** | **~16h** | （瓶颈是 Stream B） |

16 小时挂钟时间分到两天，每天 8 小时密集工作。**这是非常紧的预算**，任何一个 task 超时都会冲击交付。

---

## 中断 & 卡壳协议

任何 task 超过估时 1.5 倍 → 立即停手 → 在 `BLOCKED.md` 写：

```
## [TASK ID] [短描述]

### 我试了什么
- ...

### 我看到什么
- 错误 / 现象

### 我的假设
- ...

### 我需要的决策
- A: ...
- B: ...
```

push 到 main，@用户。**不要憋着**。

---

## Stretch（确实有时间才做）

按优先级，能塞就塞：

1. Split view（两个 viewport 并排，独立 viewport state，shared tracks）
2. 截图导出 PNG
3. Gene model track（GFF 解析 + exon 矩形 + intron 角线）
4. CIGAR 完整支持（insertion bar + deletion gap）
5. 简单 paired-end 配对线
