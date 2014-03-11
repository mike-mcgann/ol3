//! NAMESPACE=ol.renderer.webgl.tilelayer.shader
//! CLASS=ol.renderer.webgl.tilelayer.shader.


//! COMMON
varying vec2 v_texCoord;


//! VERTEX
attribute vec2 a_position;
attribute vec2 a_texCoord;
uniform vec4 u_tileOffset;

void main(void) {
  gl_Position = vec4(a_position * u_tileOffset.xy + u_tileOffset.zw, 0., 1.);
  v_texCoord = a_texCoord;
}


//! FRAGMENT
uniform sampler2D u_texture;
uniform int u_enabled;

void main(void) {
  if ( u_enabled == 1 ) {
      vec4 color = texture2D(u_texture, v_texCoord);
      color.b = 0.0;
      color.g = 0.0;
      gl_FragColor = color;
  } else {
      gl_FragColor = texture2D(u_texture, v_texCoord);
  }
} 
