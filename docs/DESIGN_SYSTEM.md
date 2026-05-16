# DESIGN_SYSTEM.md — Chroma 设计语言

> 这是项目的视觉宪法。任何"我觉得这样好看"的临时决策需要先在这里加一条规则。

---

## 1. 设计哲学（再强调一次）

1. **Tufte data-ink** — 像素必须为数据服务，UI chrome 越少越好
2. **语义缩放** — zoom 不只是放大，是信息形态变化
3. **键盘优先** — 鼠标是辅助

派生原则：

- **无分割线**：用空气（margin）和层级（typography weight）分隔，不用 1px border 切块
- **无阴影**：除了 modal 的极淡阴影（`0 1px 2px rgba(0,0,0,0.05)`），其他一律 flat
- **无圆角**（数据轨道）：tracks、canvas 元素是直角；UI chrome 允许 4px 圆角
- **动效有目的**：只为 (a) 表达连续性 (b) 告知状态变化。装饰性动画一律砍

---

## 2. 色彩

### 2.1 设计 token（CSS variables）

```css
:root {
  /* Surface — 灰阶基础 */
  --surface-0: #ffffff;        /* page bg */
  --surface-1: #fafafa;        /* panel bg */
  --surface-2: #f4f4f5;        /* hover */
  --surface-3: #e4e4e7;        /* divider when ABSOLUTELY needed */

  /* Ink — 文本与图标 */
  --ink-primary: #18181b;
  --ink-secondary: #52525b;
  --ink-tertiary: #a1a1aa;
  --ink-disabled: #d4d4d8;

  /* Accent — 强调色，谨慎使用 */
  --accent: #2563eb;           /* 链接、focus ring、active state */
  --accent-soft: #dbeafe;

  /* Semantic */
  --danger: #dc2626;
  --warn:   #d97706;
  --ok:     #16a34a;
}

[data-theme="dark"] {
  --surface-0: #0a0a0b;
  --surface-1: #131316;
  --surface-2: #1c1c20;
  --surface-3: #2a2a30;

  --ink-primary: #fafafa;
  --ink-secondary: #a1a1aa;
  --ink-tertiary: #71717a;
  --ink-disabled: #3f3f46;

  --accent: #60a5fa;
  --accent-soft: #1e3a8a;

  --danger: #f87171;
  --warn:   #fbbf24;
  --ok:     #4ade80;
}
```

### 2.2 数据语义色（Okabe-Ito 色盲安全）

**这些色只能在 data viz 中使用，不能用在 UI chrome 上。**

```css
:root {
  /* Strand */
  --strand-forward: #6699cc;   /* 柔和蓝 */
  --strand-reverse: #cc7a85;   /* 柔和粉红 */

  /* Bases — Okabe-Ito hue separations, desaturated so large fills
     satisfy Sec 2.3 (saturation > 80 forbidden as background) */
  --base-A: #6fa572;           /* sage   */
  --base-C: #6488b5;           /* slate  */
  --base-G: #c99966;           /* amber  */
  --base-T: #c97a7a;           /* coral  */
  --base-N: #acaaa6;           /* warm gray */

  /* Variant types (VCF) */
  --var-snv:   #e69f00;
  --var-ins:   #56b4e9;
  --var-del:   #cc79a7;
  --var-mnv:   #009e73;
  --var-sv:    #d55e00;

  /* Coverage */
  --cov-fill:  #94a3b8;
  --cov-line:  #475569;
}
```

**色盲验证**：所有数据色组合通过 [Coblis](https://www.color-blindness.com/coblis-color-blindness-simulator/) 三种类型测试。

### 2.3 不许用的色

- 纯黑 `#000` 和纯白 `#fff` 不出现在 ink 上（刺眼）
- 红绿同时出现表达对立含义（色盲不可分辨）
- 任何饱和度 > 80 的色用作背景或大面积填充

---

## 3. 字体

### 3.1 字族

```css
--font-ui:    'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--font-mono:  'JetBrains Mono', 'SF Mono', Consolas, monospace;
```

- **Inter**：所有 UI 文本
- **JetBrains Mono**：基因坐标、碱基字符、CIGAR string、所有等宽场景

### 3.2 字号

```css
--text-xs:   11px;   /* 坐标轴刻度 */
--text-sm:   12px;   /* track label，secondary text */
--text-base: 13px;   /* body，主要 UI */
--text-md:   14px;   /* 强调文本 */
--text-lg:   18px;   /* section heading */
--text-xl:   24px;   /* 几乎不用 */
```

**不许使用其他字号**。设计 token 之外的字号一律拒绝。

### 3.3 字重

- 400 (regular)：body
- 500 (medium)：label、强调
- 600 (semibold)：heading

**不用 300（看起来虚弱）和 700（太重，破坏密度）**。

### 3.4 行高

- UI 文本：1.4
- 长文本（说明、文档）：1.6
- 等宽数据：1.2（保持密度）

---

## 4. 间距

8 倍数体系，加一个 4 用于密集场景：

```css
--space-1:  4px;
--space-2:  8px;
--space-3:  12px;
--space-4:  16px;
--space-5:  24px;
--space-6:  32px;
--space-7:  48px;
--space-8:  64px;
```

**Track 内部用 4/8，UI panel 用 16/24。不用 10、20、30 这些非体系值。**

---

## 5. Track 视觉规范

每个 track 是一个 horizontal band，高度按类型固定：

| Track 类型 | 高度 (px) | 备注 |
|---|---|---|
| Reference (sequence ruler) | 20 | 顶部固定 |
| Gene annotation | 32 | 单层 |
| BAM coverage | 60 | 上方 |
| BAM pileup | 自适应 80-400 | 下方 |
| VCF | 28 | tick + tooltip |
| BigWig | 80 | 可调 |

Track 之间：

- 间距 4px（不画 divider）
- Hover 时整条 track 背景变 `--surface-1`（仅在 dark mode 用 `--surface-2`）
- Selected track 左侧 2px accent 色条（不用 border 而用 ::before）

Track header（左侧 label）：

- 宽度固定 160px
- 右对齐，避免 label 长度不一时数据起始线不齐
- text-sm + ink-secondary
- 单行省略 + tooltip 显示全名

---

## 6. 鼠标与键盘交互

### 6.1 光标

```
default                — 默认
grab                   — 可拖拽区域 (hover viewport)
grabbing               — 拖拽中
ew-resize              — track 边缘（高度调整）
text                   — 选择 read / variant 时
crosshair              — 测距模式（按住 m）
```

### 6.2 快捷键（demo 范围必须实现）

```
导航
  g            打开 "go to" 输入框
  /            打开基因/locus 搜索
  h / l        左 / 右 pan（按住加速）
  j / k        上 / 下（多 track view）
  + / -        zoom in / out（以光标为中心）
  0            zoom to fit (chromosome)
  z            zoom to selection
  Cmd/Ctrl + → ←   undo/redo navigation

Track
  Cmd/Ctrl + ↑ ↓   重排 selected track
  v             toggle visibility
  d             duplicate
  Delete        remove

视图
  s            截图当前 viewport (PNG)
  Cmd/Ctrl + C  复制当前 locus 字符串 (chr:start-end)
  Cmd/Ctrl + L  复制视图分享链接
  t            toggle theme
  ?            help overlay
  Esc          关闭 overlay / 取消 selection
```

### 6.3 Pan / Zoom 物理

- 拖拽 pan：1:1 跟随鼠标，无加速
- Wheel zoom：以光标位置为锚点，每滚动一次缩放因子 1.25
- Wheel + Shift：水平 pan
- Pinch（trackpad）：zoom 锚点为 pinch 中心
- 所有操作有 inertia（拖完后滑行），用 `requestAnimationFrame` 实现 ease-out

### 6.4 Tooltip

- Hover 0.3s 才出现（避免误触）
- 跟随鼠标，避开屏幕边缘
- 内容：粗体 title + 表格化键值对
- 字体：text-sm，等宽用于数值列
- 背景 `--surface-1` + 极淡 border `--surface-3`
- 不带箭头/三角（陈旧）

---

## 7. 动效

### 7.1 时长

```css
--motion-quick:  120ms;   /* hover、focus */
--motion-base:   200ms;   /* panel open/close */
--motion-slow:   320ms;   /* semantic zoom 过渡 */
```

### 7.2 缓动

```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);     /* 默认 */
--ease-in:  cubic-bezier(0.7, 0, 0.84, 0);     /* exit */
```

**不用 `linear`，不用 `ease`（浏览器默认丑）。**

### 7.3 语义缩放过渡

从 coverage → pileup（或反之）：

1. 触发条件：basePixelWidth 跨越阈值
2. 旧 layer fade out（200ms ease-in）+ 新 layer fade in（200ms ease-out），重叠 100ms
3. 不做 morph（read 矩形从 coverage bar 变形过去）—— 太复杂且容易看起来卡

### 7.4 不做的动效

- 不做 page transition（页只有一个）
- 不做 loading spinner（用 skeleton）
- 不做按钮的"按下弹起"动画
- 不做任何 bounce / overshoot

---

## 8. 加载与空状态

### 8.1 Skeleton

Track 未加载时显示：

- 整 track 高度的半透明矩形（`rgba(--ink-tertiary, 0.1)`）
- 内部一道从左到右扫过的高光（2s 循环，CSS animation）
- **不用 spinner**

### 8.2 空 viewport

首次打开（无 track）显示居中文案：

```
Chroma
A genome browser that respects your time.

Try one of:
  • Load HG002 (Illumina, GRCh38)
  • Load HG002 (PacBio HiFi)
  • Load your URL...

Press ? for shortcuts
```

字号：text-md，行间距 1.6，颜色 ink-secondary。

### 8.3 加载失败

错误占位（替换 skeleton）：

- 灰色背景
- 居中：错误图标（lucide `circle-x`，16px，danger 色） + 简短消息 + "Retry" 文字按钮
- 不弹 toast，不弹 modal

---

## 9. 截图导出规范（Phase 1 stretch）

- 默认导出 2x DPR PNG
- 包含 1px footer：`generated by chroma · chr:start-end · 2026-05-12`
- footer 字号 text-xs，ink-tertiary，距底 8px

---

## 10. Logo & 品牌

两天范围**不做 logo**，用文字标识 "Chroma" + JetBrains Mono + medium weight + 一个小色块作为 favicon：

```
[■] Chroma
```

色块用 CSS `linear-gradient(135deg, var(--base-A), var(--base-T))`（绿到红，呼应碱基色，且色盲安全的差异方向）。

---

## 11. 移交资产

- 字体：Inter 和 JetBrains Mono 走 Google Fonts 或自托管（self-host 更快）
- 图标：Lucide React（虽然我们用 Solid，但 lucide-solid 现成）
- 没有自定义插画，没有 marketing 素材

---

## 12. Review checklist（每个 UI PR）

提交前自检：

- [ ] 没有非 token 颜色
- [ ] 没有非 token 字号
- [ ] 没有非 token 间距
- [ ] 所有交互元素有 keyboard 等价物
- [ ] hover / focus / active 三态都画了
- [ ] Dark mode 单独 review 过
- [ ] 在 1280×800（最小支持分辨率）下没溢出
- [ ] Lighthouse a11y > 95
