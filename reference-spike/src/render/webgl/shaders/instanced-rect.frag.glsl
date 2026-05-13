#version 300 es

/**
 * Fragment shader for instanced reads.
 *
 * Does:
 *  - Edge anti-aliasing (so reads don't shimmer when zoomed)
 *  - Gives soft-clip ends a different tone (placeholder; flag bit TBD)
 *
 * Does NOT (yet):
 *  - Mismatch coloring — that needs a per-base texture sampled per fragment.
 *    Spike leaves a uniform `u_drawMismatch` toggled off; T1.B.3 follow-up
 *    will add the mismatch texture path.
 */

precision highp float;

in vec4 v_color;
in vec2 v_uv;
flat in uint v_flags;
flat in float v_mapq;

uniform vec2 u_rectPx;          // (width_px, height_px) of avg read instance
uniform float u_edgeSoftnessPx; // typically 0.5–1.0

out vec4 outColor;

void main() {
  // Compute distance from edge in fragment-local units (uv is 0..1)
  // Convert to pixels using rect size, then derive AA factor.
  vec2 distFromEdgeUV = min(v_uv, 1.0 - v_uv);
  vec2 distPx = distFromEdgeUV * u_rectPx;
  float edge = min(distPx.x, distPx.y);

  float alpha = smoothstep(0.0, u_edgeSoftnessPx, edge);

  outColor = vec4(v_color.rgb, v_color.a * alpha);
}
