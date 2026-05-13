# Stream B Reference Spike — WebGL2 Instanced Rendering

> 这是 Chroma 项目 Stream B 的技术参考实现。
> 目标：证明 WebGL2 实例化能在浏览器 60fps 渲染 100 万 reads，并锁定 agent-render 的实现 pattern。
>
> **这不是产品代码**，是 spike。但工程品质达到产品级，agent-render 应当**直接以此为模板**展开 T1.B.1 - T1.B.4。

---

## 这个 spike 解决了什么

1. **WebGL2 context + program 抽象** — agent-render 直接复用 `gl-context.ts`
2. **64 位基因组坐标精度** — agent-render 直接复用 `coord.ts`，禁止再发明
3. **Instanced read 渲染** — vertex/fragment shader 都给到位，agent-render 改 attribute 即可
4. **Coverage histogram** — 同套 program，不同 instance 数据
5. **Benchmark harness** — 测 100K / 1M reads 在 viewport 内的帧时
6. **对象池 + zero-allocation render loop** — 锁住"hot path 不许 new"的纪律

---

## 怎么运行

```bash
# 假定已经在 chroma 仓库内
cp -r spike/src/render/webgl   src/render/
cp -r spike/src/render/coord   src/render/
cp -r spike/src/render/tracks-render/bam-pileup.ts   src/render/tracks-render/
cp -r spike/src/render/tracks-render/bam-coverage.ts src/render/tracks-render/
cp spike/public/spike.html public/

# 在 vite dev server 跑
pnpm dev
# 访问 http://localhost:5173/spike.html
```

页面上方有 control：read count（10K / 100K / 1M），render mode（pileup / coverage），实时 fps 显示。拖拽鼠标 pan，滚轮 zoom。

---

## 必须打到的数字（M1 gate）

| Read 数 | 模式 | Target | M1 不达标 → |
|---|---|---|---|
| 100K | pileup | 60fps pan | 重新审视 attribute 布局 |
| 1M | pileup | ≥ 30fps pan | 加 LOD，但**不许换框架** |
| 1M | coverage | 60fps pan | 同上 |
| any | initial draw | < 50ms（不含数据加载） | shader 编译有问题 |

---

## 文件清单

```
spike/
├── src/render/
│   ├── coord/
│   │   ├── index.ts            ← 64-bit coord conversion
│   │   └── coord.test.ts       ← 精度测试
│   ├── webgl/
│   │   ├── gl-context.ts       ← context + capability check
│   │   ├── program.ts          ← shader compile / link helper
│   │   ├── buffer-pool.ts      ← Float32Array 池
│   │   └── shaders/
│   │       ├── instanced-rect.vert.glsl
│   │       └── instanced-rect.frag.glsl
│   └── tracks-render/
│       ├── bam-pileup.ts       ← pileup row 分配 + WebGL draw
│       └── bam-coverage.ts     ← histogram WebGL draw
├── public/
│   └── spike.html              ← 独立 demo 页
├── tests/bench/
│   └── render-bench.ts         ← 自动测帧时
└── README.md                   ← 本文
```

---

## agent-render 应当怎么用这份 spike

T1.B.1 (gl context + helpers)：
- 直接复制 `gl-context.ts`、`program.ts`、`buffer-pool.ts`
- 不要改 API，只允许添加新的辅助函数

T1.B.2 (64 位坐标)：
- 直接复制 `coord/`
- 跑 `coord.test.ts`，必须全过

T1.B.3 (pileup renderer)：
- 以 `bam-pileup.ts` 为骨架
- 加上 mismatch 渲染（spike 里没做，留接口在 shader uniform）
- 加上 paired-end 配对（Phase 2）

T1.B.4 (coverage renderer)：
- 直接用 `bam-coverage.ts`，BigWig 复用同一个

T1.B.5 (BigWig renderer)：
- import `bam-coverage.ts` 改色 + log scale 即可

---

## spike 故意不做的事

- ❌ 不集成 Solid signal（这是 L3 的事，spike 用裸 setState）
- ❌ 不解析真实 BAM（用 mock 数据生成器）
- ❌ 不做 Canvas2D 文本叠加（T1.B.6）
- ❌ 不做语义缩放过渡（T1.B.8）
- ❌ 不做 SDF 字体（T1.B.6）

这些会在产品代码里加，spike 只证渲染管线。
