# ARCHITECTURE.md — Chroma 技术架构

> 这份文档定义"代码长什么样"。任何与此冲突的实现都要被驳回。

---

## 1. 总览：四层架构

```
┌────────────────────────────────────────────────────────┐
│  L4  UI Chrome (Solid + Tailwind)                      │
│      menus, sidebar, dialogs, shortcut hints           │
│      只读 L3 signal，不碰 canvas                        │
└─────────────────────┬──────────────────────────────────┘
                      │ signal read/write
┌─────────────────────▼──────────────────────────────────┐
│  L3  State (signals)                                   │
│      viewport · tracks · selection · url-sync          │
└─────────┬─────────────────────────┬────────────────────┘
          │ subscribe                │ subscribe
┌─────────▼─────────────┐  ┌─────────▼──────────────────┐
│  L2  Render           │  │  L1  Data (Workers)        │
│      WebGL2 + C2D     │◄─┤      parse · tile · cache  │
│      coord precision  │  │      range request scheduler│
└───────────────────────┘  └────────────────────────────┘
```

数据流的**唯一方向**：

- L1 → L3：worker 解析完一个 tile，把数据写进 `tileCache` signal
- L3 → L2：render 层订阅 viewport + visible tiles，重绘
- L4 → L3：用户点 UI，修改 viewport / tracks signal
- L3 → L1：viewport 变了，worker pool 收到新 tile 请求

**禁止**：L4 直接调 L1（不许"组件里 fetch"）、L2 直接改 L1（不许 render 时触发解析）。

---

## 2. L1 数据层

### 2.1 Worker Pool

- 启动时创建 `navigator.hardwareConcurrency - 1` 个 worker，最少 2 个最多 6 个
- 用 **Comlink** 暴露 RPC，主线程像调本地函数一样调 worker
- 每个 worker 是无状态的，task 通过 round-robin 派发
- 取消机制：每个 task 带 `AbortSignal`，viewport 变了立刻 abort 旧任务

### 2.2 Tile 系统

基因组按 **bin 索引化**切 tile：

```
tileKey = `${trackId}:${chrom}:${binSize}:${binIndex}`
binSize ∈ {128, 1024, 8192, 65536, 524288, 4194304}  // 6 个 level
```

- viewport 变化时，先算需要哪些 tile
- 命中缓存 → 直接渲染
- 未命中 → 派发到 worker，同时显示 "loading skeleton"（半透明灰色条）
- LRU 缓存上限 256 tiles，淘汰按"距当前 viewport 的距离"加权

### 2.3 解析库

| 格式 | 库 | 备注 |
|---|---|---|
| BAM | `@gmod/bam` | 需要 BAI 或 CSI |
| CRAM | `@gmod/cram` | 需要 reference cache，Phase 2 |
| VCF | `@gmod/vcf` + `@gmod/tabix` | tabix 索引 |
| BigWig / BigBed | `@gmod/bbi` | — |
| FASTA | 自写（简单） | 需要 .fai |
| BED / GFF | `@gmod/gff` / 自写 BED | — |

**强制**：不要 fork 这些库，用 npm 装。如果有 bug 走上游修。

### 2.4 网络层

- 所有 HTTP range request 走一个统一的 `RangeFetcher`
- **合并相邻请求**：500ms 内若多个 range 间距 < 64KB，合并成一个大 range
- **预取**：viewport 拖到一半时，预取相邻 2 个 tile
- **缓存**：用 `Cache API`（service worker），按 `URL + range` key

### 2.5 数据传输

- worker → 主线程：用 `Transferable` 传 `ArrayBuffer`，零拷贝
- 大对象（read array）布局为 **structure of arrays**：

```typescript
interface ReadTile {
  count: number
  starts: Int32Array      // genomic position lo32
  startsHi: Int32Array    // genomic position hi32（多数情况是 0）
  lengths: Uint16Array
  flags: Uint16Array      // strand, paired, etc.
  mapq: Uint8Array
  // sequence + cigar 单独打包（不是每个 read 都需要可视化）
  seqOffsets: Uint32Array
  seqPacked: Uint8Array   // 2-bit packed
  cigarOffsets: Uint32Array
  cigarOps: Uint8Array
}
```

不要用 `Read[]` 这种 array of objects，**GC 会把你拖死**。

---

## 3. L2 渲染层

### 3.1 坐标系（**关键，写错全错**）

基因组坐标可达 ~3e9（人类基因组），单精度 Float32 在 ~16e6 之后开始丢精度。

**方案：相对坐标 + hi/lo split。**

```typescript
// 内部存储
type GenomicCoord = bigint  // 64-bit, 0 to ~3e9

// 渲染时：先减 viewport origin，再传 shader
function toShaderCoord(pos: bigint, origin: bigint): number {
  return Number(pos - origin)  // 差值通常 < 1e7，安全
}
```

所有 shader 接收的是**相对 viewport origin 的偏移**，不是绝对基因组坐标。

文件 `src/render/coord/index.ts` 是唯一允许做这个转换的地方。其他文件**禁止** `bigint → number` 的直接 cast。

### 3.2 WebGL2 实例化渲染

核心 pattern（pileup track 示例）：

```glsl
// vertex shader (pseudo)
in vec2 a_quad;          // unit quad [0,0]-[1,1]
in float a_readStart;    // instance: 相对坐标
in float a_readLength;
in float a_readY;        // pileup row
in uint a_flags;
in float a_mapq;

uniform mat3 u_viewMatrix;
uniform float u_basePixelWidth;

out vec4 v_color;
out vec2 v_uv;

void main() {
  vec2 pos = vec2(
    a_readStart + a_quad.x * a_readLength,
    a_readY + a_quad.y
  );
  gl_Position = vec4((u_viewMatrix * vec3(pos, 1.0)).xy, 0, 1);

  // strand 决定基础色
  bool reverse = (a_flags & 16u) != 0u;
  v_color = reverse ? vec4(0.85, 0.55, 0.55, 1.0) : vec4(0.55, 0.70, 0.85, 1.0);

  // 低 mapq 降饱和
  v_color.rgb = mix(vec3(0.6), v_color.rgb, smoothstep(0.0, 30.0, a_mapq));

  v_uv = a_quad;
}
```

```glsl
// fragment shader
in vec4 v_color;
in vec2 v_uv;
out vec4 outColor;

void main() {
  // anti-alias 边缘
  float edge = min(min(v_uv.x, 1.0 - v_uv.x), min(v_uv.y, 1.0 - v_uv.y));
  float alpha = smoothstep(0.0, 0.01, edge);
  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
```

每帧 **1 个 program、1 个 VAO、1 次 drawArraysInstanced(GL_TRIANGLE_STRIP, 0, 4, readCount)**。100 万 reads 在 M1 上实测 < 8ms。

### 3.3 Mismatch / 单碱基显示

当 base pixel width > 4 时，进入"单碱基模式"，需要叠加 mismatch 高亮：

- 在 instance attribute 里塞一个 `mismatchTextureOffset`（指向 mismatch atlas 的 texel）
- fragment shader 采样 atlas，在 read 上画 ACGT 色块
- atlas 是 worker 在解析时一次性 pack 好的 `Uint8Array`，每 read 一段，每 base 4 bits（4 种碱基 + N + softclip + ...）

base pixel width > 12 时再叠加文本（A/C/G/T 字符），用 SDF 字体。

### 3.4 为什么不用 Three.js / PixiJS / regl

- Three.js：3D 取向，BatchedMesh 不太适配每帧变化的 instance
- PixiJS：v8 性能好，但 sprite-batch 抽象绕，且不易做自定义 shader
- regl：API 优雅但社区已停滞

手写 WebGL2 200 行能搞定核心，控制力最大。**只有**两天 demo 写不完 mismatch 渲染时，允许临时引 PixiJS 应急。

### 3.5 Canvas2D 用在哪

- 坐标轴 + 刻度
- Track header / label
- Gene model（exon 矩形 + intron 线，元素数量少）
- Tooltip
- Selection 高亮框

每帧渲染顺序：

```
clear → webgl pass (data tracks) → c2d pass (axes, labels, overlays) → present
```

WebGL 和 Canvas2D 是两个独立 `<canvas>`，绝对定位叠加，互不干扰。

---

## 4. L3 状态层

### 4.1 三个核心 signal

```typescript
// src/state/viewport.ts
export const [viewport, setViewport] = createSignal<Viewport>({
  chrom: 'chr1',
  start: 0n,           // bigint
  end: 1_000_000n,
  pxWidth: 1200,
})

// src/state/tracks.ts
export const [tracks, setTracks] = createSignal<TrackConfig[]>([])

// src/state/selection.ts
export const [selection, setSelection] = createSignal<Selection | null>(null)
```

### 4.2 派生 signal

```typescript
export const basePixelWidth = createMemo(() => {
  const v = viewport()
  return v.pxWidth / Number(v.end - v.start)
})

export const semanticLevel = createMemo<'overview'|'coverage'|'pileup'|'base'>(() => {
  const bpw = basePixelWidth()
  if (bpw < 0.001) return 'overview'
  if (bpw < 0.05)  return 'coverage'
  if (bpw < 4)     return 'pileup'
  return 'base'
})
```

renderer 订阅 `semanticLevel`，level 切换时触发**淡入淡出过渡**（不是硬切）。

### 4.3 URL 同步

```
chroma.app/#chr1:1000000-2000000?t=eyJ0cmFja3MiOlt7Im4...
```

- `viewport` 走 hash，base16 编码（短）
- `tracks` 走 query，base64(JSON)（长但完整）
- 写入用 `replaceState`（不污染历史），导航操作用 `pushState`

---

## 5. L4 UI 层

### 5.1 组件清单（demo 范围）

只写这 5 个，其他用原生 HTML：

1. `<TopBar>` — logo、search、locus input、shortcut hint
2. `<TrackPanel>` — 左侧 track 列表，每行 label + visibility toggle
3. `<GenomeView>` — 主舞台，挂载 canvas
4. `<MiniMap>` — 染色体级 overview
5. `<HelpOverlay>` — `?` 触发，键盘 cheatsheet

### 5.2 不写的

- 不写自定义 button/input/dialog 组件，原生 + Tailwind
- 不引 Radix / shadcn / Headless UI（两天不值得）
- 不写动画组件，CSS transition 直接写

---

## 6. 模块边界（违反即驳回 PR）

```
✅ ui → state（读 + 写）
✅ render → state（只读）
✅ render → data（只读 tile cache）
✅ data → state（写 tile cache）

❌ ui → render（不许直接调 renderer 方法）
❌ ui → data（不许直接调 worker）
❌ render → ui（不许操作 DOM）
❌ data → render（不许引用 webgl）
❌ data → ui（不许任何 DOM 操作）
```

`render` 和 `data` 之间不直接通信，通过 state 中转。这看起来绕，但保证了**渲染层是纯函数式**（同样的 state 永远渲染同样的画面），便于测试和回放。

---

## 7. 错误处理

- **解析错误**：worker 抛出 → 主线程 catch → 把对应 track 标为 "error" 状态 → UI 显示带 retry 按钮的占位
- **网络错误**：自动重试 3 次（指数退避），仍失败按解析错误处理
- **WebGL 上下文丢失**：监听 `webglcontextlost`，弹 modal "render context lost, please reload"
- **不允许**：吞错误（`catch {}`）、`alert()`、`console.error` 当处理

---

## 8. 测试策略（两天范围）

```
unit:    coord 转换、tile key 计算、URL 序列化   — 必须 100%
visual:  3 个核心 track 的截图，diff < 1%        — 必须
bench:   §3 的 5 个性能场景                      — 必须
e2e:     "搜基因→跳转→缩放" 一条主路径           — 必须
```

不追求覆盖率，追求**关键不变量被锁住**。
