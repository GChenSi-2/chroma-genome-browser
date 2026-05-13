export { createGLContext, withGL, type GLContext, type GLContextOptions } from './gl-context';
export { createProgram, type Program } from './program';
export { float32Pool, uint8Pool, uint16Pool } from './buffer-pool';

import instancedRectVert from './shaders/instanced-rect.vert.glsl?raw';
import instancedRectFrag from './shaders/instanced-rect.frag.glsl?raw';
export const shaders = {
  instancedRect: { vert: instancedRectVert, frag: instancedRectFrag },
} as const;
