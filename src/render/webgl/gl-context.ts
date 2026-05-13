/**
 * WebGL2 context lifecycle.
 *
 * Owns the canvas, handles DPR, listens for context loss,
 * and exposes a typed `gl` reference.
 *
 * agent-render note:
 *   - Do NOT call canvas.getContext('webgl2') anywhere else.
 *   - Use `withGL(ctx, fn)` for any GL operation outside render loop
 *     to guarantee context-not-lost check.
 */

export interface GLContext {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  dpr: number;
  /** Logical width in CSS pixels. */
  width: number;
  /** Logical height in CSS pixels. */
  height: number;
  /** Subscribe to context lost / restored events. */
  onLost: (cb: () => void) => () => void;
  onRestored: (cb: () => void) => () => void;
  /** Resize canvas to match parent + DPR. */
  resize: () => void;
  /** Free everything. */
  dispose: () => void;
}

export interface GLContextOptions {
  canvas: HTMLCanvasElement;
  /** Override DPR (testing). Default `window.devicePixelRatio`. */
  dpr?: number;
  /** Premultiplied alpha for compositing with Canvas2D overlay. */
  premultipliedAlpha?: boolean;
  /** Antialias — keep false, we do edge AA in fragment shader. */
  antialias?: boolean;
}

export function createGLContext(opts: GLContextOptions): GLContext {
  const { canvas } = opts;
  const dpr = opts.dpr ?? window.devicePixelRatio ?? 1;

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: opts.premultipliedAlpha ?? true,
    antialias: opts.antialias ?? false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;

  if (!gl) {
    throw new Error('WebGL2 not supported in this browser');
  }

  // Enable common state
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );

  const lostCbs = new Set<() => void>();
  const restoredCbs = new Set<() => void>();

  const lostHandler = (e: Event) => {
    e.preventDefault();
    lostCbs.forEach((cb) => cb());
  };
  const restoredHandler = () => {
    restoredCbs.forEach((cb) => cb());
  };
  canvas.addEventListener('webglcontextlost', lostHandler, false);
  canvas.addEventListener('webglcontextrestored', restoredHandler, false);

  let curWidth = 0;
  let curHeight = 0;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (w === curWidth && h === curHeight) return;
    curWidth = w;
    curHeight = h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  resize();

  return {
    canvas,
    gl,
    dpr,
    get width() {
      return curWidth;
    },
    get height() {
      return curHeight;
    },
    onLost(cb) {
      lostCbs.add(cb);
      return () => lostCbs.delete(cb);
    },
    onRestored(cb) {
      restoredCbs.add(cb);
      return () => restoredCbs.delete(cb);
    },
    resize,
    dispose() {
      canvas.removeEventListener('webglcontextlost', lostHandler);
      canvas.removeEventListener('webglcontextrestored', restoredHandler);
      lostCbs.clear();
      restoredCbs.clear();
      const ext = gl.getExtension('WEBGL_lose_context');
      ext?.loseContext();
    },
  };
}

/** Defensive helper: run `fn` only if context not lost. */
export function withGL<T>(
  ctx: GLContext,
  fn: (gl: WebGL2RenderingContext) => T,
): T | undefined {
  if (ctx.gl.isContextLost()) return undefined;
  return fn(ctx.gl);
}
