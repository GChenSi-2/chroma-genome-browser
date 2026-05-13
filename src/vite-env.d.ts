/// <reference types="vite/client" />

// Raw imports for GLSL shaders. Used like:
//   import vertSrc from './shaders/instanced-rect.vert.glsl?raw';
declare module '*.glsl?raw' {
  const src: string;
  export default src;
}
declare module '*.vert?raw' {
  const src: string;
  export default src;
}
declare module '*.frag?raw' {
  const src: string;
  export default src;
}
