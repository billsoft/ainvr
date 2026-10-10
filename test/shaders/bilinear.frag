#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uInput;
uniform vec2 uOutputSize;
layout(location = 0) out vec4 result;
void main() {
  // GL_LINEAR samples four neighboring texels at level zero.
  result = textureLod(uInput, gl_FragCoord.xy / uOutputSize, 0.0);
}
