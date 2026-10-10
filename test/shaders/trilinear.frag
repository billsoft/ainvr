#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uInput;
uniform vec2 uOutputSize;
uniform float uLod;
layout(location = 0) out vec4 result;
void main() {
  // GL_LINEAR_MIPMAP_LINEAR: bilinear sampling on two adjacent mip levels,
  // followed by interpolation between them. uLod = log2(max(scaleX, scaleY)).
  result = textureLod(uInput, gl_FragCoord.xy / uOutputSize, uLod);
}
