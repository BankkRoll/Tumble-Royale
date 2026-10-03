/**
 * Shared 2D-canvas confetti & fireworks. One canvas for the whole overlay;
 * `fireConfetti()` / `fireFireworks()` can be called from anywhere (React or
 * the game). The rAF loop only runs while particles are alive.
 */
import { useEffect, useRef, type JSX } from 'react';
import { playCue } from '../audio-cues.ts';
import { ui } from '../store/uiStore.ts';
import { confettiSets } from '../theme/tokens.ts';

/** Options for a confetti burst. Positions are 0..1 of the viewport. */
export interface ConfettiOptions {
  x?: number;
  y?: number;
  count?: number;
  colors?: readonly string[];
  /** Spread half-angle in degrees around `angle`. */
  spread?: number;
  /** Launch direction in degrees (−90 = up). */
  angle?: number;
  /** Initial speed in px/s. */
  speed?: number;
  /** Ring burst (360°) instead of a cone. */
  ring?: boolean;
  silent?: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  shape: 0 | 1 | 2;
  life: number;
  maxLife: number;
  flutter: number;
  drag: number;
  gravity: number;
}

const particles: Particle[] = [];
let wake: (() => void) | null = null;

function density(): number {
  const a = ui.getState().settings.accessibility;
  if (a.reduceMotion) return 0.3;
  if (a.reduceFlashing) return 0.4;
  return 1;
}

/**
 * Bursts confetti.
 * @example fireConfetti({ x: 0.5, y: 0.4, colors: confettiSets.qualified, ring: true });
 */
export function fireConfetti(opts: ConfettiOptions = {}): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const n = Math.round((opts.count ?? 120) * density());
  const colors = opts.colors ?? confettiSets.candy;
  const spread = ((opts.spread ?? 55) * Math.PI) / 180;
  const angle = ((opts.angle ?? -90) * Math.PI) / 180;
  const speed = opts.speed ?? Math.max(900, h * 1.5);
  const ox = (opts.x ?? 0.5) * w;
  const oy = (opts.y ?? 0.5) * h;
  for (let i = 0; i < n; i++) {
    const a = opts.ring ? Math.random() * Math.PI * 2 : angle + (Math.random() * 2 - 1) * spread;
    const v = speed * (0.35 + Math.random() * 0.75);
    const life = 1.8 + Math.random() * 1.4;
    particles.push({
      x: ox,
      y: oy,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() * 2 - 1) * 12,
      w: 7 + Math.random() * 8,
      h: 4 + Math.random() * 6,
      color: colors[i % colors.length] ?? '#fff',
      shape: (i % 5 === 0 ? 1 : i % 7 === 0 ? 2 : 0) as 0 | 1 | 2,
      life,
      maxLife: life,
      flutter: Math.random() * 10,
      drag: 1.6 + Math.random() * 1.2,
      gravity: 1400,
    });
  }
  if (!opts.silent) playCue('ui.confetti');
  wake?.();
}

/**
 * Fires `bursts` fireworks at random upper-screen positions, staggered.
 * @returns Cancel function.
 */
export function fireFireworks(bursts = 3, colors: readonly string[] = confettiSets.victory): () => void {
  const ids: number[] = [];
  for (let i = 0; i < bursts; i++) {
    ids.push(
      window.setTimeout(() => {
        playCue('ui.fireworks');
        fireConfetti({
          x: 0.15 + Math.random() * 0.7,
          y: 0.15 + Math.random() * 0.3,
          ring: true,
          count: 70,
          speed: 520,
          colors,
          silent: true,
        });
      }, i * 420),
    );
  }
  return () => ids.forEach((id) => window.clearTimeout(id));
}

/** Full-screen confetti canvas; mount once (App does). */
export function ConfettiLayer(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let last = 0;
    let running = false;

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const frame = (now: number): void => {
      const dt = Math.min(0.033, (now - last) / 1000 || 0.016);
      last = now;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i] as Particle;
        p.life -= dt;
        if (p.life <= 0 || p.y > window.innerHeight + 40) {
          particles[i] = particles[particles.length - 1] as Particle;
          particles.pop();
          continue;
        }
        const drag = Math.exp(-p.drag * dt);
        p.vx *= drag;
        p.vy = p.vy * drag + p.gravity * dt * 0.5;
        p.x += (p.vx + Math.sin(p.flutter + now * 0.006) * 40) * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        const alpha = Math.min(1, p.life / 0.5);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        if (p.shape === 1) {
          ctx.beginPath();
          ctx.arc(0, 0, p.h * 0.7, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.shape === 2) {
          ctx.beginPath();
          ctx.ellipse(0, 0, p.h * 0.8, p.h, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#2b1a5e';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.scale(1, Math.cos(p.rot * 2));
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (particles.length > 0) raf = requestAnimationFrame(frame);
      else running = false;
    };

    wake = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    if (particles.length) wake();

    return () => {
      wake = null;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="tr-confetti" aria-hidden />;
}
