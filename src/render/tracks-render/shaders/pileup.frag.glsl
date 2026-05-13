#version 300 es

/**
 * BAM pileup fragment shader.
 *
 * Responsibilities:
 *   - Edge anti-aliasing (smoothstep on the distance to the nearest rect edge,
 *     measured in physical pixels — avoids shimmer when zoomed in).
 *   - Mismatch overlay gate: a uniform flag reserved for the future per-base
 *     atlas binding. See ARCHITECTURE §3.3 and the TODO in `bam-pileup.ts`.
 *
 * Mismatch atlas is intentionally NOT bound here yet — agent-data ships the
 * BAM worker without it in T1.A.3. Once T1.A.3.5 lands the per-read base
 * texture, this shader gains a `sampler2D u_mismatchAtlas` and samples
 * (gl_FragCoord.x normalized within the read) -> base id -> color.
 */

precision highp float;

in vec4 v_color;
in vec2 v_uv;
flat in uint v_flags;
flat in float v_mapq;

uniform vec2 u_rectPx;          // (width_px, height_px) of avg read instance
uniform float u_edgeSoftnessPx; // typically 0.5..1.0
uniform int u_showMismatches;   // 0 = disabled (T1.B.3 default), 1 = enabled

out vec4 outColor;

void main() {
  // Distance to nearest edge, in pixels.
  vec2 distFromEdgeUV = min(v_uv, 1.0 - v_uv);
  vec2 distPx = distFromEdgeUV * u_rectPx;
  float edge = min(distPx.x, distPx.y);
  float alpha = smoothstep(0.0, u_edgeSoftnessPx, edge);

  vec3 rgb = v_color.rgb;

  // When mismatches are enabled (semantic level == 'base') we will sample the
  // mismatch atlas here and overwrite `rgb` for fragments where the read base
  // differs from the reference. Until T1.A.3.5 the uniform stays 0, so this
  // branch is dead and the GPU optimizer drops it.
  if (u_showMismatches == 1) {
    // TODO(T1.A.3.5): bind mismatch atlas Uint8Array as a R8 texture and
    // sample per-base via gl_FragCoord.x mapping. See ARCHITECTURE §3.3.
    rgb = mix(rgb, rgb, 1.0);
  }

  outColor = vec4(rgb, v_color.a * alpha);
}
