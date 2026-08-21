/**
 * Recombines a packed video frame into an RGBA bitmap.
 *
 * The stream carries colour and matte side by side because video has no alpha
 * channel. Putting them back together needs luminance to become alpha, and a
 * 2D canvas cannot do that: `globalCompositeOperation` only ever reads the
 * source's *alpha*, which in the matte half is opaque everywhere. The
 * alternatives are `getImageData` per frame — far too slow — or one line of
 * shader.
 *
 * So this is a WebGL2 context whose only job is a full-screen triangle. The
 * `VideoFrame` is uploaded straight to a texture with no readback, the two
 * halves are sampled in the same pass, and `transferToImageBitmap` hands back
 * an ordinary `ImageBitmap`. Everything downstream — the LRU, the byte budget,
 * the tint composite — carries on unchanged, which is the point: the video is a
 * new *source* of frames, not a new renderer.
 *
 * The canvas is sized to the width the frame will be drawn at, so this doubles
 * as the resize step. A bitmap costs the same whether or not anyone can see the
 * detail.
 */

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // One oversized triangle rather than two triangles: no shared edge for the
  // rasteriser to seam, and three vertices instead of six.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uFrame;
uniform vec2 uHalf;      // size of one half, in texture coordinates
uniform float uMatteX;   // left edge of the matte half
out vec4 outColour;
void main() {
  // The render is drawn top-down; texture space is bottom-up.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y) * uHalf;
  vec3 colour = texture(uFrame, uv).rgb;
  float alpha = texture(uFrame, uv + vec2(uMatteX, 0.0)).r;
  // Premultiplied: ffmpeg multiplied the colour by its own alpha before
  // encoding, so undefined pixels behind the silhouette cost the encoder
  // nothing and the edge does not fringe.
  outColour = vec4(colour, alpha);
}`;

export class MatteCompositor {
  private canvas: OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private texture: WebGLTexture;
  private uHalf: WebGLUniformLocation;
  private uMatteX: WebGLUniformLocation;
  private size = 0;

  constructor(private packedWidth: number, private packedHeight: number) {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Every frame is read back out as a bitmap immediately, so there is
      // nothing to preserve and asking for it costs a copy.
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;

    const program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(program);
    this.uHalf = must(gl.getUniformLocation(program, "uHalf"), "uHalf");
    this.uMatteX = must(gl.getUniformLocation(program, "uMatteX"), "uMatteX");

    const texture = gl.createTexture();
    if (!texture) throw new Error("no texture");
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // No mips and clamped: the sampler never leaves the frame, and a mip chain
    // on a texture replaced every frame is pure upload cost.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "uFrame"), 0);
  }

  /** Composites one decoded frame, at `size` square. */
  compose(frame: VideoFrame, size: number, matteX: number): ImageBitmap {
    const gl = this.gl;

    if (size !== this.size) {
      this.size = size;
      this.canvas.width = size;
      this.canvas.height = size;
      gl.viewport(0, 0, size, size);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame as unknown as TexImageSource,
    );

    const halfW = (this.packedWidth - matteX) / this.packedWidth;
    gl.uniform2f(this.uHalf, halfW, 1);
    gl.uniform1f(this.uMatteX, matteX / this.packedWidth);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas.transferToImageBitmap();
  }

  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const program = gl.createProgram();
  if (!program) throw new Error("no program");
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("no shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
  }
  return program;
}

function must<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`missing uniform ${name}`);
  return value;
}
