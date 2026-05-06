export type VariationName =
  | "linear"
  | "sinusoidal"
  | "spherical"
  | "swirl"
  | "horseshoe"
  | "polar"
  | "handkerchief"
  | "heart"
  | "disc"
  | "spiral";

export type FlameTransform = {
  id: string;
  name: string;
  weight: number;
  color: number;
  affine: [number, number, number, number, number, number];
  variations: Record<VariationName, number>;
};

export type FlameProject = {
  name: string;
  seed: number;
  orbitSteps: number;
  gamma: number;
  exposure: number;
  vibrance: number;
  rotation: number;
  zoom: number;
  centerX: number;
  centerY: number;
  background: [number, number, number];
  palette: Array<[number, number, number]>;
  transforms: FlameTransform[];
};

export type RenderSettings = {
  width: number;
  height: number;
  samples: number;
  orbitSteps?: number;
  supersample: number;
  workers: number;
};

export type RenderResult = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  elapsed: number;
};

export const variationNames: VariationName[] = [
  "linear",
  "sinusoidal",
  "spherical",
  "swirl",
  "horseshoe",
  "polar",
  "handkerchief",
  "heart",
  "disc",
  "spiral"
];

const TAU = Math.PI * 2;

export function hashSeed(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeDefaultProject(seed = Math.floor(Math.random() * 2 ** 31)): FlameProject {
  const random = hashSeed(seed);
  return {
    name: "Fluxion Flame",
    seed,
    orbitSteps: 28,
    gamma: 2.2,
    exposure: 1.28,
    vibrance: 0.74,
    rotation: 0,
    zoom: 1.28,
    centerX: 0,
    centerY: 0,
    background: [8, 10, 13],
    palette: makePalette(random),
    transforms: Array.from({ length: 4 }, (_, index) => makeTransform(random, index))
  };
}

export function randomProject() {
  return makeDefaultProject(Math.floor(Math.random() * 2 ** 31));
}

export function mutateProject(project: FlameProject, amount = 0.18): FlameProject {
  const random = hashSeed((project.seed + Date.now()) >>> 0);
  const drift = (scale = 1) => (random() * 2 - 1) * amount * scale;
  return {
    ...project,
    seed: Math.floor(random() * 2 ** 31),
    zoom: clamp(project.zoom * (1 + drift(0.72)), 0.35, 3.8),
    rotation: project.rotation + drift(38),
    centerX: project.centerX + drift(0.4),
    centerY: project.centerY + drift(0.4),
    exposure: clamp(project.exposure * (1 + drift(0.52)), 0.25, 4),
    palette: project.palette.map(([r, g, b]) => [
      clamp(Math.round(r + drift(96)), 0, 255),
      clamp(Math.round(g + drift(96)), 0, 255),
      clamp(Math.round(b + drift(96)), 0, 255)
    ]),
    transforms: project.transforms.map((transform) => ({
      ...transform,
      weight: clamp(transform.weight * (1 + drift(0.7)), 0.05, 5),
      color: wrap01(transform.color + drift(0.6)),
      affine: transform.affine.map((value, index) =>
        clamp(value + drift(index > 3 ? 1.6 : 0.8), index > 3 ? -2 : -1.6, index > 3 ? 2 : 1.6)
      ) as FlameTransform["affine"],
      variations: Object.fromEntries(
        variationNames.map((name) => [
          name,
          clamp((transform.variations[name] ?? 0) + drift(1.15), 0, name === "linear" ? 1.2 : 1)
        ])
      ) as Record<VariationName, number>
    }))
  };
}

export function renderFlame(project: FlameProject, settings: RenderSettings, shard = 0, shards = 1): RenderResult {
  const started = performance.now();
  const scale = Math.max(1, settings.supersample);
  const width = settings.width * scale;
  const height = settings.height * scale;
  const total = width * height;
  const density = new Float32Array(total);
  const red = new Float32Array(total);
  const green = new Float32Array(total);
  const blue = new Float32Array(total);
  const random = hashSeed((project.seed + shard * 1013904223) >>> 0);
  const weights = cumulativeWeights(project.transforms);
  const palette = project.palette;
  const samples = Math.max(1, Math.floor(settings.samples / shards));
  const orbitSteps = Math.max(1, Math.min(160, Math.floor(settings.orbitSteps ?? project.orbitSteps)));
  const warmup = 24;
  let x = random() * 2 - 1;
  let y = random() * 2 - 1;
  let c = random();
  const rot = (-project.rotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const viewport = 3.1 / project.zoom;

  for (let i = -warmup; i < samples; i += 1) {
    for (let step = 0; step < orbitSteps; step += 1) {
      const transform = chooseTransform(project.transforms, weights, random());
      const applied = applyTransform(x, y, transform);
      x = applied[0];
      y = applied[1];
      c = (c + transform.color) * 0.5;
    }
    if (i < 0) continue;

    const rx = (x - project.centerX) * cos - (y - project.centerY) * sin;
    const ry = (x - project.centerX) * sin + (y - project.centerY) * cos;
    const px = Math.floor((rx / viewport + 0.5) * width);
    const py = Math.floor((ry / viewport + 0.5) * height);
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const index = py * width + px;
    const color = samplePalette(palette, c);
    density[index] += 1;
    red[index] += color[0];
    green[index] += color[1];
    blue[index] += color[2];
  }

  const pixels = toneMap({ density, red, green, blue }, width, height, project, scale);
  return { width: settings.width, height: settings.height, pixels, elapsed: performance.now() - started };
}

export function mergeShardResults(project: FlameProject, settings: RenderSettings, shards: RenderResult[]) {
  if (shards.length === 1) return shards[0];
  const width = settings.width;
  const height = settings.height;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const shard of shards) {
      r += shard.pixels[i] * shard.pixels[i];
      g += shard.pixels[i + 1] * shard.pixels[i + 1];
      b += shard.pixels[i + 2] * shard.pixels[i + 2];
    }
    pixels[i] = Math.min(255, Math.sqrt(r / shards.length) * project.exposure);
    pixels[i + 1] = Math.min(255, Math.sqrt(g / shards.length) * project.exposure);
    pixels[i + 2] = Math.min(255, Math.sqrt(b / shards.length) * project.exposure);
    pixels[i + 3] = 255;
  }
  return { width, height, pixels, elapsed: shards.reduce((max, shard) => Math.max(max, shard.elapsed), 0) };
}

function makeTransform(random: () => number, index: number): FlameTransform {
  const angle = (index / 4) * TAU + (random() - 0.5) * 0.9;
  const s = 0.45 + random() * 0.62;
  const variations = Object.fromEntries(variationNames.map((name) => [name, 0])) as Record<VariationName, number>;
  variations.linear = random() * 0.58;
  variations[variationNames[1 + Math.floor(random() * (variationNames.length - 1))]] = 0.35 + random() * 0.9;
  variations[variationNames[1 + Math.floor(random() * (variationNames.length - 1))]] += random() * 0.5;
  return {
    id: crypto.randomUUID(),
    name: `Iterator ${index + 1}`,
    weight: 0.6 + random() * 1.8,
    color: random(),
    affine: [
      Math.cos(angle) * s,
      -Math.sin(angle) * s,
      Math.sin(angle) * s,
      Math.cos(angle) * s,
      (random() * 2 - 1) * 0.86,
      (random() * 2 - 1) * 0.86
    ],
    variations
  };
}

function makePalette(random: () => number): FlameProject["palette"] {
  const anchors = Array.from({ length: 5 }, () => [
    40 + random() * 215,
    40 + random() * 215,
    40 + random() * 215
  ] as [number, number, number]);
  return Array.from({ length: 256 }, (_, index) => {
    const t = index / 255;
    const scaled = t * (anchors.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(anchors.length - 1, left + 1);
    const f = smooth(scaled - left);
    return [
      lerp(anchors[left][0], anchors[right][0], f),
      lerp(anchors[left][1], anchors[right][1], f),
      lerp(anchors[left][2], anchors[right][2], f)
    ];
  });
}

function applyTransform(x: number, y: number, transform: FlameTransform) {
  const [a, b, c, d, e, f] = transform.affine;
  const ax = a * x + b * y + e;
  const ay = c * x + d * y + f;
  let nx = 0;
  let ny = 0;
  for (const name of variationNames) {
    const amount = transform.variations[name];
    if (!amount) continue;
    const [vx, vy] = variation(name, ax, ay);
    nx += vx * amount;
    ny += vy * amount;
  }
  return [clamp(nx, -8, 8), clamp(ny, -8, 8)];
}

function variation(name: VariationName, x: number, y: number): [number, number] {
  const r2 = x * x + y * y + 1e-9;
  const r = Math.sqrt(r2);
  const theta = Math.atan2(y, x);
  switch (name) {
    case "sinusoidal":
      return [Math.sin(x), Math.sin(y)];
    case "spherical":
      return [x / r2, y / r2];
    case "swirl": {
      const s = Math.sin(r2);
      const c = Math.cos(r2);
      return [x * s - y * c, x * c + y * s];
    }
    case "horseshoe":
      return [((x - y) * (x + y)) / r, (2 * x * y) / r];
    case "polar":
      return [theta / Math.PI, r - 1];
    case "handkerchief":
      return [r * Math.sin(theta + r), r * Math.cos(theta - r)];
    case "heart":
      return [r * Math.sin(theta * r), -r * Math.cos(theta * r)];
    case "disc": {
      const p = theta / Math.PI;
      return [p * Math.sin(Math.PI * r), p * Math.cos(Math.PI * r)];
    }
    case "spiral":
      return [(Math.cos(theta) + Math.sin(r)) / r, (Math.sin(theta) - Math.cos(r)) / r];
    default:
      return [x, y];
  }
}

function cumulativeWeights(transforms: FlameTransform[]) {
  let total = 0;
  return transforms.map((transform) => {
    total += Math.max(0.001, transform.weight);
    return total;
  });
}

function chooseTransform(transforms: FlameTransform[], weights: number[], value: number) {
  const target = value * weights[weights.length - 1];
  return transforms[weights.findIndex((weight) => target <= weight)] ?? transforms[transforms.length - 1];
}

function samplePalette(palette: FlameProject["palette"], color: number) {
  return palette[Math.min(palette.length - 1, Math.max(0, Math.floor(wrap01(color) * palette.length)))];
}

function toneMap(
  buffers: { density: Float32Array; red: Float32Array; green: Float32Array; blue: Float32Array },
  width: number,
  height: number,
  project: FlameProject,
  scale: number
) {
  const out = new Uint8ClampedArray((width / scale) * (height / scale) * 4);
  const maxDensity = buffers.density.reduce((max, value) => Math.max(max, value), 0) || 1;
  const invGamma = 1 / Math.max(0.1, project.gamma);
  const bg = project.background;
  const targetWidth = width / scale;
  for (let y = 0; y < height; y += scale) {
    for (let x = 0; x < width; x += scale) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = (y + sy) * width + x + sx;
          const d = buffers.density[index];
          if (d <= 0) {
            ar += bg[0];
            ag += bg[1];
            ab += bg[2];
            continue;
          }
          const alpha = Math.log1p(d) / Math.log1p(maxDensity);
          const r = buffers.red[index] / d;
          const g = buffers.green[index] / d;
          const b = buffers.blue[index] / d;
          const lit = Math.pow(alpha * project.exposure, invGamma);
          const vib = project.vibrance;
          ar += clamp(bg[0] * (1 - lit) + r * lit * (0.65 + vib), 0, 255);
          ag += clamp(bg[1] * (1 - lit) + g * lit * (0.65 + vib), 0, 255);
          ab += clamp(bg[2] * (1 - lit) + b * lit * (0.65 + vib), 0, 255);
          aa += alpha;
        }
      }
      const samples = scale * scale;
      const oi = ((y / scale) * targetWidth + x / scale) * 4;
      out[oi] = ar / samples;
      out[oi + 1] = ag / samples;
      out[oi + 2] = ab / samples;
      out[oi + 3] = aa > 0 ? 255 : 255;
    }
  }
  return out;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function wrap01(value: number) {
  return ((value % 1) + 1) % 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
