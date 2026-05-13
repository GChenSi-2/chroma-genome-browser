#version 300 es

/**
 * Instanced read-rectangle vertex shader.
 *
 * One instance = one read (or one coverage bin).
 * Per-instance attributes are packed into 2 vec4s to fit common
 * GPU attribute limits (16 vec4s minimum).
 *
 * Coordinate convention:
 *   a_quad: unit quad corners {(0,0), (1,0), (0,1), (1,1)} for TRIANGLE_STRIP
 *   a_instance0.xy = (startRelativeBp, lengthBp)
 *   a_instance0.zw = (rowIndex, _padding)
 *   a_instance1.xy = (mapq01, _padding)   // mapq normalized to [0,1]
 *   a_instance1.z  = flags (bitfield encoded as float — but uses uint via attribute)
 *
 * We use `flat` qualifier on integer outputs so GPU doesn't try to
 * interpolate them across the quad.
 */

precision highp float;

// Per-vertex
in vec2 a_quad;             // (0,0) .. (1,1)

// Per-instance
in vec2 a_pos;              // (relStartBp, lengthBp)
in float a_row;             // pileup row (0..N)
in float a_mapq;            // mapping quality, raw 0..60
in uint  a_flags;           // SAM flags bitfield

uniform mat3 u_view;        // bp,row -> NDC
uniform float u_rowHeight;  // px, but converted via matrix
uniform float u_minWidthPx; // ensure read is at least 1px wide
uniform float u_pxPerBp;    // helper for minWidth enforcement

out vec4 v_color;
out vec2 v_uv;
flat out uint v_flags;
flat out float v_mapq;

void main() {
  // Enforce minimum visual width — when zoomed out, reads compress to <1px
  // and disappear without this.
  float lengthBp = a_pos.y;
  float minLengthBp = u_minWidthPx / max(u_pxPerBp, 1e-6);
  float visualLength = max(lengthBp, minLengthBp);

  vec2 localPos = vec2(
    a_pos.x + a_quad.x * visualLength,
    a_row  + a_quad.y * 1.0     // 1 row tall, scaled by view matrix
  );

  vec3 ndc = u_view * vec3(localPos, 1.0);
  gl_Position = vec4(ndc.xy, 0.0, 1.0);

  // Strand color (bit 0x10 = reverse strand in SAM)
  bool reverse = (a_flags & 16u) != 0u;
  vec3 baseColor = reverse
    ? vec3(0.80, 0.55, 0.58)   // soft pink — reverse
    : vec3(0.55, 0.68, 0.85);  // soft blue — forward

  // Low MAPQ desaturates toward gray
  float mapqNorm = clamp(a_mapq / 30.0, 0.0, 1.0);
  vec3 gray = vec3(0.60);
  vec3 color = mix(gray, baseColor, mapqNorm);

  // MAPQ 0 = ambiguous, render very transparent
  float alpha = mapqNorm < 0.05 ? 0.35 : 1.0;

  v_color = vec4(color, alpha);
  v_uv = a_quad;
  v_flags = a_flags;
  v_mapq = a_mapq;
}
