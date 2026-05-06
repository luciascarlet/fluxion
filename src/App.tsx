import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  makeDefaultProject,
  mergeShardResults,
  mutateProject,
  randomProject,
  renderFlame,
  variationNames,
  type FlameProject,
  type FlameTransform,
  type RenderResult,
  type RenderSettings,
  type VariationName
} from "./flameEngine";
import "./styles.css";

declare global {
  interface Window {
    fluxion?: {
      getAppInfo: () => Promise<{ name: string; version: string; platform: string }>;
    };
  }
}

const logicalCores = Math.max(2, Math.min(12, navigator.hardwareConcurrency || 4));
const previewSettings: RenderSettings = { width: 960, height: 720, samples: 120_000, supersample: 1, workers: logicalCores };

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workersRef = useRef<Worker[]>([]);
  const previewRunRef = useRef(0);
  const gpuFrameRef = useRef(0);
  const [project, setProject] = useState(() => makeDefaultProject(24031991));
  const [selectedId, setSelectedId] = useState(project.transforms[0].id);
  const [renderMode, setRenderMode] = useState<"gpu" | "cpu">("gpu");
  const [status, setStatus] = useState("Ready");
  const [isRendering, setIsRendering] = useState(false);
  const [exportWidth, setExportWidth] = useState(2400);
  const [exportHeight, setExportHeight] = useState(1800);
  const [exportSamples, setExportSamples] = useState(5_000_000);
  const [previewBudget, setPreviewBudget] = useState(4_000_000);
  const [appInfo, setAppInfo] = useState<{ name: string; version: string; platform: string } | null>(null);

  const selected = project.transforms.find((transform) => transform.id === selectedId) ?? project.transforms[0];

  useEffect(() => {
    window.fluxion?.getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
  }, []);

  const runCpuPreview = useCallback(async (nextProject: FlameProject) => {
    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    setIsRendering(true);
    let completed = 0;
    while (completed < previewBudget && previewRunRef.current === runId) {
      const samples = Math.min(previewSettings.samples, previewBudget - completed);
      const result = await renderWithWorkers(nextProject, { ...previewSettings, samples, orbitSteps: nextProject.orbitSteps });
      if (previewRunRef.current !== runId) break;
      completed += samples;
      paintPixels(canvasRef.current, result);
      setStatus(`CPU live preview: ${completed.toLocaleString()} / ${previewBudget.toLocaleString()} steps · ${nextProject.orbitSteps} orbit steps`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    setIsRendering(false);
  }, [previewBudget]);

  const runGpuPreview = useCallback((nextProject: FlameProject) => {
    window.cancelAnimationFrame(gpuFrameRef.current);
    const runId = previewRunRef.current + 1;
    previewRunRef.current = runId;
    let completed = 0;
    const tick = () => {
      if (previewRunRef.current !== runId) return;
      completed = Math.min(previewBudget, completed + 90_000);
      const ok = drawWebGlPreview(glCanvasRef.current, nextProject, completed, previewBudget);
      if (!ok) {
        setRenderMode("cpu");
        void runCpuPreview(nextProject);
        return;
      }
      setStatus(`GPU live render: ${completed.toLocaleString()} / ${previewBudget.toLocaleString()} samples · ${nextProject.orbitSteps} orbit steps`);
      if (completed < previewBudget) gpuFrameRef.current = window.requestAnimationFrame(tick);
    };
    tick();
  }, [previewBudget, runCpuPreview]);

  const drawCpuPreview = useCallback(async (nextProject: FlameProject) => {
    previewRunRef.current += 1;
    setIsRendering(true);
    setStatus(`Rendering CPU preview across ${logicalCores} workers`);
    const result = await renderWithWorkers(nextProject, { ...previewSettings, samples: previewBudget, orbitSteps: nextProject.orbitSteps });
    paintPixels(canvasRef.current, result);
    setStatus(`CPU preview: ${(result.elapsed / 1000).toFixed(2)}s · ${previewBudget.toLocaleString()} steps`);
    setIsRendering(false);
  }, [previewBudget]);

  const drawGpuPreview = useCallback((nextProject: FlameProject) => {
    const ok = drawWebGlPreview(glCanvasRef.current, nextProject, previewBudget, previewBudget);
    if (!ok) {
      setRenderMode("cpu");
      void drawCpuPreview(nextProject);
      return;
    }
    setStatus("GPU renderer active: WebGL2 point-splat flame path");
  }, [drawCpuPreview]);

  useEffect(() => {
    if (renderMode === "gpu") {
      runGpuPreview(project);
      return;
    }
    const handle = window.setTimeout(() => void runCpuPreview(project), 180);
    return () => window.clearTimeout(handle);
  }, [project, renderMode, runCpuPreview, runGpuPreview]);

  useEffect(() => () => {
    previewRunRef.current += 1;
    window.cancelAnimationFrame(gpuFrameRef.current);
    workersRef.current.forEach((worker) => worker.terminate());
  }, []);

  const updateProject = (patch: Partial<FlameProject>) => setProject((current) => ({ ...current, ...patch }));
  const updateSelected = (patch: Partial<FlameTransform>) => {
    setProject((current) => ({
      ...current,
      transforms: current.transforms.map((transform) => transform.id === selected.id ? { ...transform, ...patch } : transform)
    }));
  };
  const updateAffine = (index: number, value: number) => {
    updateSelected({ affine: selected.affine.map((entry, i) => i === index ? value : entry) as FlameTransform["affine"] });
  };
  const updateVariation = (name: VariationName, value: number) => {
    updateSelected({ variations: { ...selected.variations, [name]: value } });
  };

  const paletteStrip = useMemo(
    () => `linear-gradient(90deg, ${project.palette.filter((_, i) => i % 32 === 0).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`).join(", ")})`,
    [project.palette]
  );

  return (
    <main className="app-shell">
      <aside className="side-panel left-panel" aria-label="Iterator tree and parameters">
        <header className="brand">
          <span className="app-dot" />
          <div>
            <h1>Fluxion</h1>
            <p>{appInfo ? `${appInfo.name} ${appInfo.version}` : "Fractal flame atelier"}</p>
          </div>
        </header>

        <section className="control-section">
          <div className="section-title">
            <span>Iterator Tree</span>
            <button
              className="icon-button"
              title="Add iterator"
              onClick={() => setProject((current) => {
                const added = mutateProject(makeDefaultProject(Date.now())).transforms[0];
                const next = { ...added, id: crypto.randomUUID(), name: `Iterator ${current.transforms.length + 1}` };
                setSelectedId(next.id);
                return { ...current, transforms: [...current.transforms, next] };
              })}
            >
              +
            </button>
          </div>
          <div className="iterator-tree">
            {project.transforms.map((transform, index) => (
              <button
                key={transform.id}
                className={`tree-node ${transform.id === selected.id ? "active" : ""}`}
                onClick={() => setSelectedId(transform.id)}
              >
                <span className="node-index">{index + 1}</span>
                <span>{transform.name}</span>
                <small>{transform.weight.toFixed(2)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="control-section">
          <div className="section-title">
            <span>{selected.name}</span>
            <button
              className="icon-button danger"
              title="Remove iterator"
              disabled={project.transforms.length <= 1}
              onClick={() => setProject((current) => {
                const transforms = current.transforms.filter((transform) => transform.id !== selected.id);
                setSelectedId(transforms[0]?.id ?? selected.id);
                return { ...current, transforms };
              })}
            >
              -
            </button>
          </div>
          <Control label="Weight" value={selected.weight} min={0.05} max={5} step={0.01} onChange={(weight) => updateSelected({ weight })} />
          <Control label="Color" value={selected.color} min={0} max={1} step={0.001} onChange={(color) => updateSelected({ color })} />
          {["A", "B", "C", "D", "X", "Y"].map((label, index) => (
            <Control
              key={label}
              label={`Affine ${label}`}
              value={selected.affine[index]}
              min={index > 3 ? -2 : -1.6}
              max={index > 3 ? 2 : 1.6}
              step={0.001}
              onChange={(value) => updateAffine(index, value)}
            />
          ))}
        </section>

        <section className="control-section variations">
          <div className="section-title"><span>Variations</span></div>
          {variationNames.map((name) => (
            <Control key={name} label={name} value={selected.variations[name] ?? 0} min={0} max={1.5} step={0.001} onChange={(value) => updateVariation(name, value)} />
          ))}
        </section>
      </aside>

      <section className="stage" aria-label="Fractal preview">
        <div className="topbar">
          <div className="segmented">
            <button className={renderMode === "gpu" ? "active" : ""} onClick={() => setRenderMode("gpu")}>GPU</button>
            <button className={renderMode === "cpu" ? "active" : ""} onClick={() => setRenderMode("cpu")}>CPU</button>
          </div>
          <div className="toolbar">
            <button onClick={() => setProject(randomProject())}>Randomize</button>
            <button onClick={() => setProject((current) => mutateProject(current, 0.16))}>Mutate</button>
            <button
              disabled={isRendering}
              onClick={() => renderMode === "gpu" ? drawGpuPreview(project) : void drawCpuPreview(project)}
            >
              Render
            </button>
          </div>
        </div>
        <div className="canvas-well">
          <canvas ref={glCanvasRef} className={renderMode === "gpu" ? "visible" : ""} width={1280} height={900} />
          <canvas ref={canvasRef} className={renderMode === "cpu" ? "visible" : ""} width={previewSettings.width} height={previewSettings.height} />
        </div>
        <footer className="statusbar">
          <span>{status}</span>
          <span>GPU canon · CPU fallback · {project.transforms.length} iterators · seed {project.seed}</span>
        </footer>
      </section>

      <aside className="side-panel right-panel" aria-label="Global project settings">
        <section className="control-section">
          <div className="section-title"><span>Project</span></div>
          <label className="text-field">
            <span>Name</span>
            <input value={project.name} onChange={(event) => updateProject({ name: event.target.value })} />
          </label>
          <div className="palette" style={{ background: paletteStrip }} />
          <Control label="Zoom" value={project.zoom} min={0.35} max={4} step={0.01} onChange={(zoom) => updateProject({ zoom })} />
          <Control label="Orbit Steps" value={project.orbitSteps} min={1} max={96} step={1} onChange={(orbitSteps) => updateProject({ orbitSteps })} />
          <NumberField label="Preview Budget" value={previewBudget} min={10000} max={50000000} onChange={setPreviewBudget} />
          <Control label="Rotation" value={project.rotation} min={-180} max={180} step={0.1} onChange={(rotation) => updateProject({ rotation })} />
          <Control label="Center X" value={project.centerX} min={-2} max={2} step={0.01} onChange={(centerX) => updateProject({ centerX })} />
          <Control label="Center Y" value={project.centerY} min={-2} max={2} step={0.01} onChange={(centerY) => updateProject({ centerY })} />
        </section>

        <section className="control-section">
          <div className="section-title"><span>Lighting</span></div>
          <Control label="Exposure" value={project.exposure} min={0.25} max={4} step={0.01} onChange={(exposure) => updateProject({ exposure })} />
          <Control label="Gamma" value={project.gamma} min={0.7} max={4} step={0.01} onChange={(gamma) => updateProject({ gamma })} />
          <Control label="Vibrance" value={project.vibrance} min={0} max={1.8} step={0.01} onChange={(vibrance) => updateProject({ vibrance })} />
        </section>

        <section className="control-section">
          <div className="section-title"><span>Export</span></div>
          <NumberField label="Width" value={exportWidth} min={64} max={16000} onChange={setExportWidth} />
          <NumberField label="Height" value={exportHeight} min={64} max={16000} onChange={setExportHeight} />
          <NumberField label="Samples" value={exportSamples} min={100000} max={100000000} onChange={setExportSamples} />
          <button
            className="export-button"
            disabled={isRendering}
            onClick={() => void exportImage(project, { width: exportWidth, height: exportHeight, samples: exportSamples, orbitSteps: project.orbitSteps, supersample: 2, workers: logicalCores }, setStatus, setIsRendering)}
          >
            Export PNG
          </button>
        </section>
      </aside>
    </main>
  );
}

function Control(props: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="control">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
      <input type="number" min={props.min} max={props.max} step={props.step} value={Number(props.value.toFixed(3))} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}

function NumberField(props: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="number-field">
      <span>{props.label}</span>
      <input type="number" min={props.min} max={props.max} value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}

async function renderWithWorkers(project: FlameProject, settings: RenderSettings) {
  if (!window.Worker || settings.workers <= 1) return renderFlame(project, settings, 0, 1);
  const shardCount = Math.max(1, Math.min(settings.workers, logicalCores));
  const jobs = Array.from({ length: shardCount }, (_, shard) => new Promise<RenderResult>((resolve, reject) => {
    const worker = new Worker(new URL("./flameWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<RenderResult>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };
    worker.postMessage({ project, settings, shard, shards: shardCount });
  }));
  const shards = await Promise.all(jobs);
  return mergeShardResults(project, settings, shards);
}

function paintPixels(canvas: HTMLCanvasElement | null, result: RenderResult) {
  if (!canvas) return;
  canvas.width = result.width;
  canvas.height = result.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(result.pixels), result.width, result.height), 0, 0);
}

async function exportImage(project: FlameProject, settings: RenderSettings, setStatus: (status: string) => void, setIsRendering: (value: boolean) => void) {
  setIsRendering(true);
  const canvas = document.createElement("canvas");
  canvas.width = settings.width;
  canvas.height = settings.height;
  setStatus(`Exporting canonical GPU PNG: ${settings.width}x${settings.height}, ${settings.samples.toLocaleString()} samples`);
  const ok = drawWebGlPreview(canvas, project, settings.samples, settings.samples);
  if (!ok) {
    setStatus(`GPU export unavailable, falling back to CPU across ${settings.workers} workers`);
    const result = await renderWithWorkers(project, settings);
    paintPixels(canvas, result);
  }
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${settings.width}x${settings.height}.png`;
  link.click();
  setStatus(`GPU export complete: ${settings.width}x${settings.height}`);
  setIsRendering(false);
}

function drawWebGlPreview(canvas: HTMLCanvasElement | null, project: FlameProject, completedSteps: number, maxSteps: number) {
  if (!canvas) return false;
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) return false;
  const program = createProgram(gl, vertexShader, fragmentShader);
  if (!program) return false;
  gl.useProgram(program);
  const transforms = project.transforms.slice(0, 8);
  const sampleCount = Math.max(1, Math.min(25_000_000, Math.floor(completedSteps)));
  gl.uniform2f(gl.getUniformLocation(program, "resolution"), canvas.width, canvas.height);
  gl.uniform1f(gl.getUniformLocation(program, "seed"), project.seed % 100000);
  gl.uniform1f(gl.getUniformLocation(program, "progress"), Math.max(0.02, completedSteps / Math.max(1, maxSteps)));
  gl.uniform1i(gl.getUniformLocation(program, "orbitSteps"), Math.max(1, Math.min(96, Math.floor(project.orbitSteps))));
  gl.uniform1f(gl.getUniformLocation(program, "zoom"), project.zoom);
  gl.uniform1f(gl.getUniformLocation(program, "rotation"), project.rotation * Math.PI / 180);
  gl.uniform2f(gl.getUniformLocation(program, "center"), project.centerX, project.centerY);
  gl.uniform1i(gl.getUniformLocation(program, "transformCount"), transforms.length);
  gl.uniform3f(gl.getUniformLocation(program, "background"), project.background[0] / 255, project.background[1] / 255, project.background[2] / 255);
  gl.uniform3fv(gl.getUniformLocation(program, "palette"), new Float32Array(project.palette.filter((_, i) => i % 32 === 0).flatMap(([r, g, b]) => [r / 255, g / 255, b / 255])));
  gl.uniform1fv(gl.getUniformLocation(program, "weights"), new Float32Array(transforms.map((t) => t.weight)));
  gl.uniform1fv(gl.getUniformLocation(program, "colors"), new Float32Array(transforms.map((t) => t.color)));
  gl.uniform1fv(gl.getUniformLocation(program, "affines"), new Float32Array(transforms.flatMap((t) => t.affine)));
  gl.uniform1fv(gl.getUniformLocation(program, "variations"), new Float32Array(transforms.flatMap((t) => variationNames.map((name) => t.variations[name] ?? 0))));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(project.background[0] / 255, project.background[1] / 255, project.background[2] / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.POINTS, 0, sampleCount);
  gl.disable(gl.BLEND);
  return true;
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

const vertexShader = `#version 300 es
precision highp float;
uniform vec2 resolution;
uniform float seed;
uniform float progress;
uniform float zoom;
uniform float rotation;
uniform vec2 center;
uniform int orbitSteps;
uniform int transformCount;
uniform vec3 palette[8];
uniform float weights[8];
uniform float colors[8];
uniform float affines[48];
uniform float variations[80];
out vec4 sampleColor;

float random(float value) {
  return fract(sin(value * 12.9898 + seed * 78.233) * 43758.5453123);
}

vec3 pickPalette(float t) {
  float x = clamp(t, 0.0, 0.999) * 7.0;
  int i = int(floor(x));
  return mix(palette[i], palette[min(i + 1, 7)], smoothstep(0.0, 1.0, fract(x)));
}

int chooseTransform(float value) {
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= transformCount) {
      break;
    }
    total += max(0.001, weights[i]);
  }
  float target = value * total;
  float running = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= transformCount) {
      break;
    }
    running += max(0.001, weights[i]);
    if (target <= running) {
      return i;
    }
  }
  return max(0, transformCount - 1);
}

vec2 variation(int name, vec2 p) {
  float r2 = dot(p, p) + 0.0000001;
  float r = sqrt(r2);
  float theta = atan(p.y, p.x);
  if (name == 1) return vec2(sin(p.x), sin(p.y));
  if (name == 2) return p / r2;
  if (name == 3) {
    float s = sin(r2);
    float c = cos(r2);
    return vec2(p.x * s - p.y * c, p.x * c + p.y * s);
  }
  if (name == 4) return vec2(((p.x - p.y) * (p.x + p.y)) / r, (2.0 * p.x * p.y) / r);
  if (name == 5) return vec2(theta / 3.14159265, r - 1.0);
  if (name == 6) return vec2(r * sin(theta + r), r * cos(theta - r));
  if (name == 7) return vec2(r * sin(theta * r), -r * cos(theta * r));
  if (name == 8) {
    float q = theta / 3.14159265;
    return vec2(q * sin(3.14159265 * r), q * cos(3.14159265 * r));
  }
  if (name == 9) return vec2((cos(theta) + sin(r)) / r, (sin(theta) - cos(r)) / r);
  return p;
}

void main() {
  float id = float(gl_VertexID);
  vec2 z = vec2(random(id + 11.0), random(id + 29.0)) * 2.0 - 1.0;
  float color = random(id + 47.0);
  for (int stepId = 0; stepId < 96; stepId++) {
    if (stepId >= orbitSteps) {
      break;
    }
    int index = chooseTransform(random(id * 0.131 + float(stepId) * 17.17));
    int ai = index * 6;
    vec2 affinePoint = vec2(
      affines[ai] * z.x + affines[ai + 1] * z.y + affines[ai + 4],
      affines[ai + 2] * z.x + affines[ai + 3] * z.y + affines[ai + 5]
    );
    vec2 nextPoint = vec2(0.0);
    float totalVariation = 0.0;
    for (int name = 0; name < 10; name++) {
      float amount = variations[index * 10 + name];
      nextPoint += variation(name, affinePoint) * amount;
      totalVariation += amount;
    }
    z = clamp(totalVariation > 0.0 ? nextPoint : affinePoint, vec2(-8.0), vec2(8.0));
    color = mix(color, colors[index], 0.5);
  }

  float c = cos(-rotation);
  float s = sin(-rotation);
  vec2 p = z - center;
  vec2 rotated = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  float viewport = 3.1 / zoom;
  vec2 clip = vec2(rotated.x / viewport, rotated.y / viewport) * 2.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 1.0;
  float alpha = 0.018 / max(0.12, sqrt(progress));
  sampleColor = vec4(pickPalette(color) * alpha, alpha);
}`;

const fragmentShader = `#version 300 es
precision highp float;
in vec4 sampleColor;
out vec4 fragColor;
void main() {
  fragColor = sampleColor;
}`;

createRoot(document.getElementById("root")!).render(<App />);
