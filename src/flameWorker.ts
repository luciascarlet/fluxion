import { renderFlame, type FlameProject, type RenderSettings } from "./flameEngine";

const workerPostMessage = postMessage as unknown as (message: unknown, transfer: Transferable[]) => void;

self.onmessage = (event: MessageEvent<{ project: FlameProject; settings: RenderSettings; shard: number; shards: number }>) => {
  const { project, settings, shard, shards } = event.data;
  const result = renderFlame(project, settings, shard, shards);
  workerPostMessage(result, [result.pixels.buffer as ArrayBuffer]);
};
