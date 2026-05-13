/**
 * Shader compilation + program linking.
 *
 * One concept: a `Program` bundles compiled shaders with cached
 * attribute and uniform locations. Locations are looked up ONCE at
 * link time, never in the render loop.
 *
 * agent-render rules:
 *   - Programs are created at startup, never per-frame.
 *   - To draw, call `program.use()` then `program.setUniform*` then drawArrays.
 *   - Don't call `gl.getUniformLocation` in render loop. Ever.
 */

export interface Program {
  /** Underlying GL program object. */
  program: WebGLProgram;
  /** Make this program current. */
  use: () => void;
  /** Cached attribute locations. */
  attribs: Readonly<Record<string, number>>;
  /** Cached uniform locations. */
  uniforms: Readonly<Record<string, WebGLUniformLocation>>;
  /** Free GPU resources. */
  dispose: () => void;
}

export interface ProgramOptions {
  vertSrc: string;
  fragSrc: string;
  /** Attribute names to look up. */
  attribs: readonly string[];
  /** Uniform names to look up. */
  uniforms: readonly string[];
  /** Debug label for error messages. */
  label?: string;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`createShader failed for ${label}`);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? '<no info>';
    gl.deleteShader(shader);
    throw new Error(`[${label}] shader compile failed:\n${info}`);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  opts: ProgramOptions,
): Program {
  const label = opts.label ?? 'program';
  const vs = compileShader(gl, gl.VERTEX_SHADER, opts.vertSrc, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, opts.fragSrc, `${label}.frag`);

  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? '<no info>';
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`[${label}] program link failed:\n${info}`);
  }

  // Shaders can be deleted; they're now linked into the program
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const attribs: Record<string, number> = {};
  for (const name of opts.attribs) {
    const loc = gl.getAttribLocation(program, name);
    if (loc === -1) {
      // Not fatal — attribute might be unused / optimized away
      console.warn(`[${label}] attribute "${name}" not found`);
    }
    attribs[name] = loc;
  }

  const uniforms: Record<string, WebGLUniformLocation> = {};
  for (const name of opts.uniforms) {
    const loc = gl.getUniformLocation(program, name);
    if (!loc) {
      console.warn(`[${label}] uniform "${name}" not found`);
      continue;
    }
    uniforms[name] = loc;
  }

  return {
    program,
    use: () => gl.useProgram(program),
    attribs,
    uniforms,
    dispose: () => gl.deleteProgram(program),
  };
}
