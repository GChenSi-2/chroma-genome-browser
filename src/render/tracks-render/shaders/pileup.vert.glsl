#version 300 es

/**
 * BAM pileup vertex shader — instanced rectangles, one per read.
 *
 * Per-instance attributes:
 *   a_pos.x = relative start (bp), already pre-subtracted from viewport origin
 *   a_pos.y = read length in bp
 *   a_row   = pileup row index (0..N-1)
 *   a_mapq  = mapping quality 0..60
 *   a_flags = SAM flags bitfield (uint)
 *
 * Strand colors are baked from DESIGN_SYSTEM §2.2:
 *   --strand-forward: #6699cc -> vec3(0.4,   0.6,    0.8   )
 *   --strand-reverse: #cc7a85 -> vec3(0.8,   0.4784, 0.5216)
 *
 * GLSL cannot read CSS variables; bake these literals here and keep them in
 * sync with DESIGN_SYSTEM by hand. If a designer changes the token, edit
 * BOTH places in the same commit.
 */

precision highp float;

// Per-vertex
in vec2 a_quad;             // (0,0) .. (1,1) for TRIANGLE_STRIP

// Per-instance
in vec2 a_pos;              // (relStartBp, lengthBp)
in float a_row;             // pileup row (0..N)
in float a_mapq;            // mapping quality 0..60
in uint  a_flags;           // SAM flags

uniform mat3 u_view;
uniform float u_minWidthPx;
uniform float u_pxPerBp;

out vec4 v_color;
out vec2 v_uv;
flat out uint v_flags;
flat out float v_mapq;

void main() {
  // Enforce minimum visual width so zoomed-out reads don't disappear at <1px.
  float lengthBp = a_pos.y;
  float minLengthBp = u_minWidthPx / max(u_pxPerBp, 1e-6);
  float visualLength = max(lengthBp, minLengthBp);

  vec2 localPos = vec2(
    a_pos.x + a_quad.x * visualLength,
    a_row  + a_quad.y
  );

  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);

  // SAM flag 0x10 = reverse strand
  bool reverse = (a_flags & 16u) != 0u;

  // strand-forward / strand-reverse from DESIGN_SYSTEM §2.2
  vec3 baseColor = reverse
    ? vec3(0.8, 0.4784, 0.5216)
    : vec3(0.4, 0.6,    0.8   );

  // Low MAPQ desaturates toward neutral gray.
  float mapqNorm = clamp(a_mapq / 30.0, 0.0, 1.0);
  vec3 color = mix(vec3(0.60), baseColor, mapqNorm);

  // MAPQ 0 = ambiguous, render very transparent.
  float alpha = mapqNorm < 0.05 ? 0.35 : 1.0;

  v_color = vec4(color, alpha);
  v_uv = a_quad;
  v_flags = a_flags;
  v_mapq = a_mapq;
}
