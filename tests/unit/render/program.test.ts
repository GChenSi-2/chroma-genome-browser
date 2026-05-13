import { describe, it, expect, vi } from 'vitest';
import { createProgram } from '~render/webgl/program';

/**
 * happy-dom does not ship a WebGL2 implementation, so we stub the bits of
 * `WebGL2RenderingContext` that `createProgram` actually touches. Keeping
 * this fake local to the test file avoids dragging in a new dependency.
 */
interface FakeOptions {
  /** Force shader compile to fail with this message. */
  shaderInfoLog?: string;
  /** Force program link to fail with this message. */
  programInfoLog?: string;
}

function fakeGL(opts: FakeOptions = {}): WebGL2RenderingContext {
  let shaderCounter = 0;
  let programCounter = 0;
  let uniformCounter = 0;

  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,

    createShader: () => ({ __id: ++shaderCounter, type: 'shader' }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: (_s: unknown, p: number) =>
      // COMPILE_STATUS — pass unless shaderInfoLog requests failure
      p === 0x8b81 ? opts.shaderInfoLog === undefined : true,
    getShaderInfoLog: () => opts.shaderInfoLog ?? '',
    deleteShader: () => {},

    createProgram: () => ({ __id: ++programCounter, type: 'program' }),
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: (_p: unknown, p: number) =>
      // LINK_STATUS — pass unless programInfoLog requests failure
      p === 0x8b82 ? opts.programInfoLog === undefined : true,
    getProgramInfoLog: () => opts.programInfoLog ?? '',
    deleteProgram: () => {},
    useProgram: () => {},

    getAttribLocation: (_p: unknown, name: string) => {
      // Treat "missing_*" attribute names as not found
      return name.startsWith('missing_') ? -1 : name.length;
    },
    getUniformLocation: (_p: unknown, name: string) => {
      if (name.startsWith('missing_')) return null;
      return { __uniformId: ++uniformCounter, name };
    },
  };

  return gl as unknown as WebGL2RenderingContext;
}

describe('createProgram', () => {
  it('returns a Program with cached attribs, uniforms, use, dispose', () => {
    const gl = fakeGL();
    const program = createProgram(gl, {
      vertSrc: 'vert',
      fragSrc: 'frag',
      attribs: ['a_quad', 'a_pos'],
      uniforms: ['u_view', 'u_rowHeight'],
      label: 'instancedRect',
    });

    expect(program.program).toBeTruthy();
    expect(typeof program.use).toBe('function');
    expect(typeof program.dispose).toBe('function');

    expect(Object.keys(program.attribs)).toEqual(['a_quad', 'a_pos']);
    expect(program.attribs.a_quad).toBe('a_quad'.length);
    expect(program.attribs.a_pos).toBe('a_pos'.length);

    expect(Object.keys(program.uniforms)).toEqual(['u_view', 'u_rowHeight']);
    expect(program.uniforms.u_view).toBeTruthy();
    expect(program.uniforms.u_rowHeight).toBeTruthy();
  });

  it('omits uniforms reported as missing instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = fakeGL();
    const program = createProgram(gl, {
      vertSrc: 'vert',
      fragSrc: 'frag',
      attribs: [],
      uniforms: ['u_view', 'missing_uniform'],
      label: 'partial',
    });
    expect(program.uniforms.u_view).toBeTruthy();
    expect(program.uniforms.missing_uniform).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws when shader compile fails — error message contains the label', () => {
    const gl = fakeGL({ shaderInfoLog: 'unexpected token at line 7' });
    expect(() =>
      createProgram(gl, {
        vertSrc: 'broken',
        fragSrc: 'frag',
        attribs: [],
        uniforms: [],
        label: 'badShader',
      }),
    ).toThrow(/badShader/);
  });

  it('throws when program link fails — error message contains the label', () => {
    const gl = fakeGL({ programInfoLog: 'mismatched varyings' });
    expect(() =>
      createProgram(gl, {
        vertSrc: 'vert',
        fragSrc: 'frag',
        attribs: [],
        uniforms: [],
        label: 'badLink',
      }),
    ).toThrow(/badLink/);
  });
});
