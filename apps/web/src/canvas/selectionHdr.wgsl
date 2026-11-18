struct Fragment {
  @builtin(position) position: vec4f,
  @location(0) point: vec2f,
  @location(1) @interpolate(flat) bounds: vec4f,
  @location(2) @interpolate(flat) parameters: vec4f,
}

@group(0) @binding(0) var<uniform> viewport: vec4f;

@vertex fn vertex(
  @builtin(vertex_index) index: u32,
  @location(0) bounds: vec4f,
  @location(1) parameters: vec4f,
) -> Fragment {
  let vertices = array(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),
                       vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let size = bounds.zw;
  var low = vec2f(-1);
  var high = size + vec2f(1);
  if (parameters.y > 0) {
    // Cover the perimeter with four strips so large boards don't shade their interiors.
    let spread = parameters.w;
    let corner = parameters.x + 1;
    let top = min(size.y * .5, corner);
    let bottom = max(size.y * .5, size.y - corner);
    low = vec2f(-spread);
    high = size + vec2f(spread);
    switch (index / 6u) {
      case 0u: { high.y = top; }
      case 1u: { low.y = bottom; }
      case 2u: { low.y = top; high = vec2f(corner, bottom); }
      default: { low = vec2f(size.x - corner, top); high.y = bottom; }
    }
  }
  let point = bounds.xy + mix(low, high, vertices[index % 6u]);
  let clip = point / viewport.xy * vec2f(2, -2) + vec2f(-1, 1);
  return Fragment(vec4f(clip, 0, 1), point, bounds, parameters);
}

fn edgeDistance(input: Fragment) -> f32 {
  let radius = input.parameters.x;
  let halfSize = input.bounds.zw * .5;
  let q = abs(input.point - input.bounds.xy - halfSize) - halfSize + vec2f(radius);
  return length(max(q, vec2f(0))) + min(max(q.x, q.y), 0.0) - radius;
}

@fragment fn mask(input: Fragment) -> @location(0) vec4f {
  let distance = edgeDistance(input);
  let feather = max(fwidth(distance), .65) * .5;
  let coverage = (1 - smoothstep(-feather, feather, distance)) * input.parameters.z;
  return vec4f(0, 0, 0, coverage);
}

@fragment fn light(input: Fragment) -> @location(0) vec4f {
  let distance = edgeDistance(input);
  let feather = max(fwidth(distance), .65);
  let outside = smoothstep(0.0, feather, distance);
  let normalized = max(distance, 0.0) / (input.parameters.w * .28);
  let falloff = exp(-.5 * normalized * normalized);
  let amount = viewport.z;
  let dark = viewport.w > .5;
  let alpha = falloff * outside * input.parameters.y * min(1.0, 2 * amount) * select(.84, .64, dark);
  let tint = select(vec3f(1, .96, .84), vec3f(.78, .61, .43), dark);
  return vec4f(tint * (1 + 2 * amount) * alpha, alpha);
}
