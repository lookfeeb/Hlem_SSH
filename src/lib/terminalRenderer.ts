import type { ITerminalAddon, Terminal } from "@xterm/xterm";

type GpuAddon = ITerminalAddon & { onContextLoss: (callback: () => void) => { dispose(): void } };
type RendererTarget = Pick<Terminal, "loadAddon">;
const WARM_RENDERER_MS = 5000;
const MAX_GPU_TERMINALS = 2;
const leases = new Set<TerminalRenderer>();
let addonModule: Promise<typeof import("@xterm/addon-webgl")> | undefined;
const loadAddon = async () => new (await (addonModule ??= import("@xterm/addon-webgl"))).WebglAddon();

/** Keep one recent background renderer warm, with a hard context limit. */
export class TerminalRenderer {
  private addon: GpuAddon | undefined;
  private lossListener: { dispose(): void } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private active = false;
  private enabled = false;
  constructor(private readonly terminal: RendererTarget, private readonly factory: () => Promise<GpuAddon> = loadAddon) {}

  update(enabled: boolean, active: boolean) {
    if (this.disposed) return;
    this.active = active; this.enabled = enabled;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!enabled) { this.release(); return; }
    if (!active) {
      if (this.addon || this.loading) this.timer = setTimeout(() => { this.timer = undefined; this.release(); }, WARM_RENDERER_MS);
      return;
    }
    if (this.addon || this.loading) return;
    for (const renderer of leases) {
      if (leases.size < MAX_GPU_TERMINALS) break;
      if (!renderer.active) renderer.release();
    }
    if (leases.size >= MAX_GPU_TERMINALS) return;
    leases.add(this);
    this.loading = true;
    const generation = ++this.generation;
    void this.factory().then((addon) => {
      if (this.disposed || !this.enabled || generation !== this.generation) { addon.dispose(); return; }
      this.loading = false;
      this.addon = addon;
      this.lossListener = addon.onContextLoss(() => this.release());
      try { this.terminal.loadAddon(addon); }
      catch (error) { this.release(); console.warn("[helm] WebGL2 unavailable; using terminal fallback renderer", error); }
    }).catch((error) => {
      if (generation === this.generation) this.release();
      console.warn("[helm] terminal renderer load failed", error);
    });
  }
  dispose() { this.disposed = true; this.release(); }
  private release() {
    this.generation++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.loading = false;
    this.lossListener?.dispose(); this.lossListener = undefined;
    const addon = this.addon; this.addon = undefined;
    leases.delete(this);
    addon?.dispose();
  }
}

export function terminalRendererCount() { return leases.size; }
