# AGENT_PLAYBOOK.md — Agent Team 执行手册

> 给 Claude Code 主进程的操作手册：如何启动 sub-agent、分配任务、解决冲突、做 review。

---

## 1. 角色定义

### 1.1 Lead（Claude Code 主进程，就是你）

职责：
- 读完所有 docs，向用户确认理解
- 初始化仓库（T0.1、T0.2）
- 把 Stream A / B / D 分别 dispatch 给 sub-agent
- 每个 stream 完成后**亲自 review 代码 + 跑 benchmark**
- 处理 merge 冲突、架构争议、范围争议
- 与用户沟通的唯一接口（除非用户直接 @ 某个 agent）

**Lead 不写实现代码**，除非：
- Stream F（benchmark、README、deploy）
- 某个 sub-agent 卡死，需要救火
- 跨 stream 的胶水代码

### 1.2 Sub-agents（3 个）

| Agent | Stream | 关注 |
|---|---|---|
| `agent-data` | A、E（VCF parser） | L1 数据层，worker，解析 |
| `agent-render` | B、E（VCF render） | L2 渲染层，WebGL/Canvas，性能 |
| `agent-ui` | C、D | L3 状态层、L4 UI Chrome |

每个 sub-agent 有自己的 worktree，工作在独立 branch，**不允许跨 stream 改文件**（除非通过 lead 协调）。

---

## 2. Git worktree 工作流

### 2.1 初始化

Lead 在 T0.1 之后：

```bash
cd chroma
git checkout -b main
git push -u origin main  # （如果有 remote）

# 为每个 stream 创建 worktree
git worktree add ../chroma-data -b stream/data
git worktree add ../chroma-render -b stream/render
git worktree add ../chroma-ui -b stream/ui
```

每个 sub-agent 在它的 worktree 里独立工作。

### 2.2 文件所有权矩阵

| 路径 | data | render | ui | lead |
|---|---|---|---|---|
| `src/data/**` | ✏️ | 👀 | 👀 | 👀 |
| `src/render/**` | 👀 | ✏️ | 👀 | 👀 |
| `src/state/**` | 👀 | 👀 | ✏️ | 👀 |
| `src/ui/**` | ❌ | ❌ | ✏️ | 👀 |
| `src/styles/**` | ❌ | ❌ | ✏️ | 👀 |
| `tests/bench/**` | ❌ | 👀 | ❌ | ✏️ |
| `docs/**` | ❌ | ❌ | ❌ | ✏️ |
| `apps/demo/**` | ❌ | ❌ | ✏️ | 👀 |
| `package.json` | 👀 | 👀 | 👀 | ✏️ |

- ✏️ = 可写
- 👀 = 可读，不可写
- ❌ = 不可访问

**`package.json` 只有 lead 能改**。Sub-agent 需要新依赖时，写到自己分支的 `NEEDS_DEPS.md`，lead 在 sync 时统一加。

### 2.3 Merge 时机

不在每个 task 完成后立即 merge，而是按 **stream 阶段性里程碑**：

- **M1（Day 1 中段）**：Stream A 完成 T1.A.1-3，Stream B 完成 T1.B.1-3，Stream C 完成所有
- **M2（Day 1 末）**：Stream A、B 全部完成，跑 benchmark
- **M3（Day 2 中段）**：Stream D 完成基础组件，Stream E 完成 VCF
- **M4（Day 2 末）**：全部完成，lead 收尾

每次 merge 由 **lead 发起**：

```bash
cd chroma   # main branch
git merge --no-ff stream/data
git merge --no-ff stream/render
git merge --no-ff stream/ui
# 解决冲突 (大概率在 src/state 或 package.json)
pnpm install && pnpm test && pnpm bench
git commit
```

---

## 3. 任务派发协议

Lead 给 sub-agent 的任务分配消息模板：

```
@agent-{name}

Stream {X} 你的任务：

任务 ID: T{day}.{stream}.{n}
标题: <从 TWO_DAY_SPRINT.md 抄>
估时: {h}
依赖: {上游 task ID 或 "none"}

读这些文档：
- HANDOFF.md (全)
- ARCHITECTURE.md §{相关章节}
- DESIGN_SYSTEM.md §{如涉及 UI}
- TWO_DAY_SPRINT.md (你的 task 段)

你的工作目录: ../chroma-{stream}/
你只能改: {文件路径 glob}

完成定义 (DoD):
- [ ] 代码通过自己写的单元测试
- [ ] tsc --noEmit 无错
- [ ] 没有 console.log
- [ ] 没有 any（除非有注释）
- [ ] commit message 用 conventional commits
- [ ] 在 NEEDS_DEPS.md 列了新依赖（如有）
- [ ] 在自己分支 push

开始之前 reply 你的实现 plan（3-5 bullet），我 review 完你再动手。

不许跨界：不许碰 {禁止区域}
卡壳：超 1.5x 估时立即停，写 BLOCKED.md
```

---

## 4. Sub-agent 启动前的 plan review

Sub-agent 收到 task → 不要立刻写代码，先回 3-5 bullet 的实现 plan 给 lead：

例（T1.B.3 Pileup renderer）：

```
Plan for T1.B.3 BAM pileup renderer:

1. 用 interval tree 实现 pileup row assignment，O(n log n)
2. WebGL2 VAO + instanced quad，instance attrs: start/len/row/flags/mapq
3. vertex shader 走 §3.1 的 hi/lo 坐标
4. fragment shader：strand 颜色 + mapq 降饱和 + edge AA
5. Mismatch 暂不画（留 T1.B.3.5 续作），coverage 边线先不画

不确定点：
- pileup row 数上限设多少？我倾向 200，超过截断并提示
```

Lead **必须确认** plan，不许跳过。Lead 可能回：

- ✅ "Go"
- ✏️ "改第 5 条：mismatch 不能拆出来，T1.B.3 必须含 mismatch 才算完，否则 base view 退化"
- ❓ "Pileup row 上限 200 OK，截断提示用 'N+ reads omitted' 文案"

---

## 5. PR / Branch review checklist

Lead 在 merge 前对每个 stream 跑一遍：

### 5.1 自动检查

```bash
pnpm tsc --noEmit            # 0 error
pnpm lint                    # 0 warning
pnpm test                    # all pass
pnpm bench                   # 跑 benchmark，对比上次
pnpm build                   # 能 build
```

### 5.2 人工检查（lead 看代码）

- [ ] 文件没超 400 行
- [ ] 函数没超 80 行（render hot path）
- [ ] 模块边界没违反（§ARCHITECTURE 6）
- [ ] 没有"防御性 any"
- [ ] 命名一致（变量、文件、组件都符合项目惯例）
- [ ] 没有死代码、TODO、FIXME（除非追踪到 issue）

### 5.3 视觉检查（UI 相关）

- [ ] 跑 dev 看一眼实际效果
- [ ] Dark mode 切换正常
- [ ] 1280×800 不溢出
- [ ] 用键盘走一遍主流程

不过 review **驳回，sub-agent 修**。不要 lead 帮改，否则下次还错。

---

## 6. 冲突处理

### 6.1 合并冲突

最容易冲突的两处：

1. `src/state/*.ts` — 三个 stream 都要订阅 signal
2. `package.json` — 依赖增加

**预防**：lead 在 T0.2 时把 `src/state/` 的接口签名（type）一次性定义清楚，sub-agent 只 import 不改。

**真冲突时**：lead 手动解，不让 sub-agent 自己 `git rebase`（容易搞砸）。

### 6.2 架构争议

如果 sub-agent 在 plan review 时反对架构决策（例如"我想用 React 不用 Solid"）：

- lead 拒绝，重申 HANDOFF §4 的硬约束
- 如果 sub-agent 给出**新的证据**（比如 Solid 某个 bug 阻塞），lead 升级给用户决策

### 6.3 范围争议

Sub-agent 想做范围外的事（"我顺便加个 Manhattan plot"）：

- lead 拒绝
- 在 `STRETCH.md` 记一笔，two-day 之后再讨论

---

## 7. 与用户的沟通频次

**Lead 主动找用户**的时机：

- 收到任务后的 confirmation checklist（必须）
- 每个 milestone 后（M1/M2/M3/M4）报告进度 + benchmark 数字
- 任何 `BLOCKED.md` 出现时立刻 @
- 设计决策需要审美判断时（颜色、间距、动效细节）

**Lead 不打扰用户**：

- 实现细节
- 文件命名
- 测试写法
- 进度顺利时（直到下一个 milestone）

报告模板：

```
📍 Milestone M{n} 完成

Done:
- [list of merged tasks]

Benchmark:
- 1M reads pan: {x}fps (target 60)  ✅/⚠️/❌
- ...

Risks:
- {any blocker}

Next:
- [next milestone tasks]

Need decision:
- {if any}
```

---

## 8. 资源 & 测试数据

### 8.1 公开 BAM/VCF 测试数据

```
HG002 Illumina (chr20 切片，方便测试):
  https://s3.amazonaws.com/igv.org.demo/HG002_GRCh38_2_subset.bam
  + .bai

HG002 PacBio HiFi:
  https://s3.amazonaws.com/igv.org.demo/HG002_GRCh38_pacbio.bam

GIAB benchmark VCF:
  https://ftp-trace.ncbi.nlm.nih.gov/giab/ftp/release/AshkenazimTrio/HG002_NA24385_son/
    NISTv4.2.1/GRCh38/HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz
  + .tbi

Reference FASTA (GRCh38):
  https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.fa.gz
  (太大，开发用 chr20 切片)

ENCODE BigWig (signal):
  https://www.encodeproject.org/files/ENCFF356LFX/@@download/ENCFF356LFX.bigWig
```

### 8.2 本地 fixtures

放 `fixtures/`：

- `hg002.chr20.10mb.bam` + .bai（chr20:30-40Mb 切片，~50MB）
- `giab.chr20.10mb.vcf.gz` + .tbi
- `chr20.fa` + .fai（chr20 reference，~64MB，gitignore，由脚本下载）
- `encode.chr20.bw`（10MB）

`scripts/fetch-fixtures.sh` 一键下载。

---

## 9. 一些预期会踩的坑（提前预警 sub-agent）

### 9.1 `@gmod/bam` 在 Node 测试环境跑不动

它依赖 `generic-filehandle`，浏览器和 Node 接口不一样。测试时用 `LocalFile`，浏览器用 `RemoteFile`。**单元测试要分两套**。

### 9.2 BigWig 的 zoom level

`@gmod/bbi` 默认拿最细粒度数据，对大 viewport 会很慢。要主动调用 `getFeatures({ basesPerSpan: ... })` 选 zoom level。

### 9.3 WebGL2 在 Safari 16 之前 buggy

只支持 Safari 17+ 和 Chrome/Firefox 当前两个版本。README 写清。

### 9.4 `SharedArrayBuffer` 需要 COOP/COEP headers

不在两天范围内启用，先用普通 `Transferable`。如果想启用，Vercel 部署需要 `vercel.json` 配 headers。

### 9.5 `bigint` 在 JSON serialize 时报错

URL state 写入时要先 `String(bigint)`，反过来用 `BigInt(str)`。**Tracks 配置序列化的 helper 必须处理 bigint**。

### 9.6 Solid 的 `createMemo` 在 worker 里不可用

State 层只在主线程跑。Worker 内只发 message，不订阅 signal。

---

## 10. 失败模式与降级

如果两天结束差太远，按以下顺序降级：

1. **VCF track** 砍 → demo 只有 BAM + BigWig
2. **MiniMap** 砍 → 顶部留空
3. **Search palette** 砍 → 只保留 `g` 跳转输入
4. **语义缩放过渡动画** 砍 → 硬切（功能保留，体验降级）
5. **Mismatch 渲染** 砍 → pileup 只显示 strand 颜色

**绝对不能砍的**：

- WebGL2 instanced 渲染（这是项目的存在意义）
- 性能 benchmark 报告（没有这个发布出去不可信）
- URL 状态共享（这是和 IGV.js 的关键差异之一）
- 键盘导航（这是和 IGV.js 的关键差异之二）

---

## 11. 完成的样子

最后一次报告应该看起来像：

```
🚢 Chroma demo ready

URL: https://chroma-demo.vercel.app
Repo: https://github.com/{user}/chroma
Commit: {sha}

Benchmark (vs IGV.js 3.x):
- Initial render 1Mb/100K reads: 280ms (IGV.js 1520ms)  5.4x
- Pan 60fps: ✅ stable (IGV.js avg 24fps)
- Zoom 60fps: ✅ stable (IGV.js drops to 16fps)
- Search → render: 410ms (IGV.js 1900ms)  4.6x
- Memory: 240MB (IGV.js 580MB)

Shipped:
- 3 track types (ref, BAM pileup+coverage, BigWig)
- VCF stretch ✅
- Keyboard nav full
- URL state share
- Dark mode
- 3 demo datasets

Known gaps (post-demo):
- Paired-end visualization
- CRAM support
- Gene model track
- Plugin API

Two-day target: hit ✅
```
