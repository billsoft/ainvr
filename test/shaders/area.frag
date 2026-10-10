#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uInput;
uniform vec2 uOutputSize;
layout(location = 0) out vec4 result;
void main() {
#if defined(INTEGER_SCALE) && INTEGER_SCALE == 2
  // An aligned 2x2 footprint has four equal weights. The texture unit's
  // centered bilinear sample computes exactly this box integral.
  result = textureLod(uInput, gl_FragCoord.xy / uOutputSize, 0.0);
#elif defined(INTEGER_SCALE)
  // Whole texels all have weight one; constant loop bounds permit unrolling.
  ivec2 first = ivec2(gl_FragCoord.xy) * INTEGER_SCALE;
  vec4 sum = vec4(0.0);
  for (int y = 0; y < INTEGER_SCALE; ++y)
    for (int x = 0; x < INTEGER_SCALE; ++x)
      sum += texelFetch(uInput, first + ivec2(x, y), 0);
  result = sum / float(INTEGER_SCALE * INTEGER_SCALE);
#else
  // Integrate source texels over the output pixel's footprint. Partial texels
  // receive their exact overlap area, including noninteger downscale factors.
  vec2 scale = vec2(textureSize(uInput, 0)) / uOutputSize;
  vec2 begin = (gl_FragCoord.xy - vec2(0.5)) * scale;
  vec2 end = begin + scale;
  ivec2 first = ivec2(floor(begin)), last = ivec2(ceil(end));
  vec4 sum = vec4(0.0);
  for (int y = first.y; y < last.y; ++y) {
    float wy = max(0.0, min(end.y, float(y + 1)) - max(begin.y, float(y)));
    for (int x = first.x; x < last.x; ++x) {
      float wx = max(0.0, min(end.x, float(x + 1)) - max(begin.x, float(x)));
      sum += texelFetch(uInput, ivec2(x, y), 0) * (wx * wy);
    }
  }
  result = sum / (scale.x * scale.y);
#endif
}
