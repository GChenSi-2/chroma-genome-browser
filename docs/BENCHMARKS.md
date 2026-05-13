# BENCHMARKS.md — 性能基线与测量规范

> 性能是 Chroma 的存在理由。这份文档定义"快"到底是什么意思，以及怎么测、怎么报。

---

## 1. 核心指标

### 1.1 五个 demo gate scenario

| ID | 场景 | Chroma target | IGV.js 参考 | 测法 |
|---|---|---|---|---|
| B1 | 1Mb region, BAM 100K reads, cold load | < 300ms | ~1500ms | `performance.now()` 包住 viewport.setLocus → onRender |
| B2 | 同上，连续 pan 5 秒 | ≥ 60fps avg, ≥ 50fps p95 | ~25fps avg | `requestAnimationFrame` 测帧间隔 |
| B3 | 同上，wheel zoom in/out 5 秒 | ≥ 60fps avg | ~15fps avg | 同 B2 |
| B4 | Gene search → locus render | < 500ms | ~2000ms | search submit → onRender |
| B5 | 10 tracks @ 1Mb peak memory | < 300MB | ~580MB | `performance.memory.usedJSHeapSize` 取 5 秒 max |

**Gate**：任何一项不达标，**禁止发布 demo**。

### 1.2 衍生指标（不 gate，但要追踪）

- WebGL draw call 数（目标 < 20/frame）
- Worker → main thread message 数（目标 < 50/frame）
- Tile cache hit rate（目标 > 70% in normal browsing）
- Time to interactive（TTI，目标 < 1s）
- Bundle size gzip（目标 < 250KB 不含 worker，< 600KB 含）

---

## 2. 测试硬件

**官方 benchmark 在以下环境跑**：

- MacBook Pro M1（baseline）
- Chrome stable 当前版本
- 1920×1200 显示
- 关闭其他 tab
- 不接电源（避免 thermal 干扰）

报告里必须写跑的硬件，否则数字无意义。

如果用户用其他机器跑出不一样的数字，把它当 secondary report，不作 gate。

---

## 3. Benchmark 工具实现

### 3.1 目录

```
tests/bench/
├── runner.ts           # 启动逻辑
├── scenarios/
│   ├── b1-cold-load.ts
│   ├── b2-pan.ts
│   ├── b3-zoom.ts
│   ├── b4-search.ts
│   └── b5-memory.ts
├── igv-baseline.html   # iframe 里跑 IGV.js 同条件
├── report.ts           # 生成 markdown 报告
└── fixtures/           # 固定 viewport / 数据集
```

### 3.2 启动方式

```bash
pnpm bench                  # 跑全部，输出 stdout
pnpm bench --scenario b2    # 单 scenario
pnpm bench --report         # 输出 markdown 到 BENCHMARK_REPORT.md
pnpm bench --compare igv    # 同时跑 IGV.js 对比
```

### 3.3 Pan/zoom 自动化

不用真实鼠标，而是直接 dispatch 合成事件 + 推 viewport signal：

```typescript
// b2-pan.ts
async function panBenchmark() {
  const samples: number[] = []
  let lastT = performance.now()

  const off = onRenderFrame(() => {
    const now = performance.now()
    samples.push(now - lastT)
    lastT = now
  })

  // 5 秒，每帧 viewport 向右移动 5000bp
  const start = performance.now()
  while (performance.now() - start < 5000) {
    await nextFrame()
    setViewport(v => ({
      ...v,
      start: v.start + 5000n,
      end: v.end + 5000n,
    }))
  }
  off()

  return analyzeFps(samples)
}
```

### 3.4 IGV.js 对比

iframe 加载 IGV.js 同数据 + 同 viewport，通过 `postMessage` 触发同等操作，监听其内部渲染事件（IGV.js 触发 `trackdrawn` 事件）。

如果 IGV.js API 不让我们插桩到帧级，退而求其次：手动操作录屏，用视频帧分析（写不进自动 CI，但 demo 报告里能用）。

---

## 4. 报告格式

### 4.1 README 里的简版

```markdown
## Performance

Tested on M1 MacBook Pro, Chrome 130, 1Mb chr20 region with HG002 BAM (100K reads).

|                         | Chroma   | IGV.js 3.x | Speedup |
| ----------------------- | -------- | ---------- | ------- |
| Initial render          | 280 ms   | 1520 ms    | 5.4×    |
| Pan (avg fps)           | 60       | 24         | 2.5×    |
| Zoom (avg fps)          | 60       | 16         | 3.8×    |
| Gene search → render    | 410 ms   | 1900 ms    | 4.6×    |
| Memory (10 tracks)      | 240 MB   | 580 MB     | 2.4×    |

Full report: [BENCHMARK_REPORT.md](./BENCHMARK_REPORT.md)
```

### 4.2 完整报告

`BENCHMARK_REPORT.md` 自动生成，包含：

- 环境信息（CPU、GPU、浏览器、OS）
- 每个 scenario 的：均值、p50、p95、p99、min、max、samples 数量
- 帧时直方图（ASCII art 即可）
- 与上一次 benchmark 的 diff（如果有 `BENCHMARK_REPORT.last.md`）
- 不通过项的失败原因

---

## 5. CI 集成（两天范围外）

未来要把 benchmark 跑进 CI（GitHub Actions），任何 PR 让任意 scenario 退化 > 10% 阻断 merge。

两天 demo 阶段先手动 `pnpm bench` 在本地跑，记录到 `BENCHMARK_REPORT.md` 提交。

---

## 6. 写性能代码的纪律

### 6.1 hot path 禁忌

`src/render/` 下任何每帧调用的函数：

- ❌ `Array.map / filter / reduce`（用 for 循环）
- ❌ `Object.assign / spread`（直接赋值）
- ❌ `new Float32Array(...)` 在 render loop（用对象池）
- ❌ `getContext('webgl2')` 在 render loop（缓存）
- ❌ `getAttribLocation` / `getUniformLocation` 在 render loop（编译时记下）
- ❌ 任何 `JSON.parse/stringify` 在 render loop

### 6.2 必做

- ✅ 用 `performance.mark()` + `performance.measure()` 标关键段
- ✅ render loop 第一行：`const v = viewport()`（读一次 signal）
- ✅ 复用 `Float32Array` buffer，长度变了用 `subarray()`
- ✅ WebGL state changes 排序：program → VAO → uniform → draw

### 6.3 Profile 工具

- Chrome DevTools Performance tab（首选）
- `console.time / timeEnd`（快速看一个点）
- 自带的 `performance.mark`（永久保留，用 query string `?perf=1` 开启 overlay）

---

## 7. 性能 budget

每个 stream 的渲染时间预算（在 1Mb / 100K reads 场景下，每帧）：

| 阶段 | 预算 (ms) |
|---|---|
| state 更新 | 0.5 |
| WebGL pass (data tracks) | 6.0 |
| Canvas2D pass (axes/labels) | 3.0 |
| compositing | 1.5 |
| **总计** | **11.0 (< 16.6ms = 60fps)** |

每个 task 的 perf 注释（提交时）要标自己占了哪段预算，超了立刻被打回。

---

## 8. 当 benchmark 不达标怎么办

**不要直接降低 target**。按以下顺序排查：

1. **测对了吗** — 重复 5 次取 median，避免 thermal noise
2. **是不是 worker thrashing** — 检查 worker 数和数据量是否匹配
3. **是不是 GC 压力大** — heap snapshot 看 allocation
4. **是不是 GPU 瓶颈** — 看 Chrome's GPU activity
5. **是不是 layout thrashing** — Canvas2D 调用顺序对不对
6. **算法本身是 O(n²) 吗** — 重读代码

只有把以上都排查完，确认是物理上限，才允许：
- 降级渲染质量（更小 atlas、更粗 SDF）
- 增加 LOD（远处 read 合并显示）
- 异步渲染（先画粗版，下一帧补细节）

**这些降级必须 lead 批准 + 在 README 注明**。
