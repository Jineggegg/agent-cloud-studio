import { useEffect, useRef, useState } from 'react';

// Soft, low-saturation colour points (linear RGB 0..1) that drift and blend; dark keeps enough light to read as motion.
const PALETTES = {
  light: [[0.93, 0.84, 0.77], [0.74, 0.84, 0.78], [0.78, 0.82, 0.93], [0.91, 0.80, 0.85]],
  dark: [[0.15, 0.22, 0.19], [0.25, 0.16, 0.13], [0.11, 0.15, 0.27], [0.21, 0.12, 0.21]],
} as const;
// Render at a fraction of device resolution: the image is blurry by design, so pixels are wasted otherwise.
const RESOLUTION_SCALE = 0.35;
const MAX_FPS = 30;

const VERTEX = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Four moving colour points blended by inverse distance, a gentle domain warp, and dither to avoid banding.
const FRAGMENT = `precision highp float;
uniform vec2 r;uniform float t;uniform vec3 c[4];
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){float a=r.x/r.y;vec2 uv=gl_FragCoord.xy/r;uv.x*=a;
 uv+=.05*vec2(sin(uv.y*3.1+t*.23),cos(uv.x*2.7-t*.19));
 vec3 col=vec3(0.);float ws=0.;
 for(int i=0;i<4;i++){float f=float(i);
  vec2 q=vec2(.5*a,.5)+vec2(.42*a*sin(t*(.071+.023*f)+f*1.9),.38*cos(t*(.059+.019*f)+f*2.6));
  float d=distance(uv,q),w=1./pow(d*d+.03,1.5);col+=c[i]*w;ws+=w;}
 col/=ws;col+=(h(gl_FragCoord.xy+fract(t))-.5)/96.;gl_FragColor=vec4(col,1.);}`;

type Stop = () => void;

function isDark() {
  return document.documentElement.classList.contains('dark');
}

function start(canvas: HTMLCanvasElement, paused: () => boolean): Stop | null {
  const options = { antialias: false, alpha: false, depth: false, powerPreference: 'low-power' as const };
  const gl = (canvas.getContext('webgl2', options) ?? canvas.getContext('webgl', options)) as WebGLRenderingContext | null;
  if (!gl || gl.isContextLost()) return null;
  const shader = (kind: number, source: string) => {
    const created = gl.createShader(kind)!;
    gl.shaderSource(created, source);
    gl.compileShader(created);
    return created;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const uResolution = uniform('r');
  const uTime = uniform('t');
  const uColors = uniform('c');

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const current = Float32Array.from(PALETTES[isDark() ? 'dark' : 'light'].flat());
  const startedAt = performance.now();
  let frame = 0;
  let lastDraw = 0;
  let previous = 0;

  const resize = () => {
    const scale = Math.min(window.devicePixelRatio || 1, 2) * RESOLUTION_SCALE;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const draw = (now: number) => {
    const target = PALETTES[isDark() ? 'dark' : 'light'].flat();
    // Ease colours toward the active theme so switching light/dark crossfades instead of popping.
    const blend = reduced.matches || !previous ? 1 : 1 - Math.exp(-(now - previous) / 300);
    previous = now;
    for (let index = 0; index < 12; index += 1) current[index] += (target[index] - current[index]) * blend;
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - startedAt) / 1000);
    gl.uniform3fv(uColors, current);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const loop = (now: number) => {
    frame = requestAnimationFrame(loop);
    if (now - lastDraw < 1000 / MAX_FPS - 4) return;
    lastDraw = now;
    draw(now);
  };
  const play = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (document.hidden || gl.isContextLost()) return;
    if (reduced.matches || paused()) { draw(startedAt + 40_000); return; }
    frame = requestAnimationFrame(loop);
  };
  const observer = new ResizeObserver(() => { resize(); play(); });
  observer.observe(canvas);
  const themeWatcher = new MutationObserver(play);
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', play);
  reduced.addEventListener('change', play);
  const onLost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(frame); frame = 0; };
  canvas.addEventListener('webglcontextlost', onLost);
  resize();
  play();
  (canvas as HTMLCanvasElement & { studioPlay?: () => void }).studioPlay = play;
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    themeWatcher.disconnect();
    document.removeEventListener('visibilitychange', play);
    reduced.removeEventListener('change', play);
    canvas.removeEventListener('webglcontextlost', onLost);
    // Free GPU objects but keep the context alive: a remount (StrictMode, fast refresh) reuses this canvas's context.
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  };
}

/** Used by StudioHomeScreen as the slowly flowing, blurred colour wallpaper; falls back to CSS blobs without WebGL. */
export function StudioFluidBackground({ paused = false }: { paused?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  // Whether WebGL started; without it the CSS blob wallpaper stays visible.
  const [webgl, setWebgl] = useState(false);

  useEffect(() => {
    const node = canvas.current;
    if (!node || typeof ResizeObserver === 'undefined' || !window.matchMedia) return;
    const stop = start(node, () => pausedRef.current);
    // Deferred so the fallback wallpaper never flashes off before the first WebGL frame.
    const timer = window.setTimeout(() => setWebgl(Boolean(stop)), 0);
    return () => { window.clearTimeout(timer); stop?.(); };
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    (canvas.current as (HTMLCanvasElement & { studioPlay?: () => void }) | null)?.studioPlay?.();
  }, [paused]);

  return <div className={`home-wallpaper ${webgl ? 'is-webgl' : ''}`} aria-hidden="true">
    <canvas ref={canvas} className="home-wallpaper-canvas" />
    <span /><span /><span />
  </div>;
}
