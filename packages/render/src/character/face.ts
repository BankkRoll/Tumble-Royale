/**
 * Facial animation: expression presets, smooth blending between them, random
 * blinks, idle saccades and look-at, written into the shader uniforms.
 */
import type { TumblerShaderState } from './material.ts';

/** Expression parameters (all blendable). */
export interface Expression {
  /** Mouth open 0–1. */
  open: number;
  /** −1 frown … 1 smile. */
  smile: number;
  /** Mouth half-width in metres on the plate. */
  width: number;
  /** Wobbly-line mouth amount (dizzy, struggling). */
  squiggle: number;
  tongue: number;
  teeth: number;
  /** + angry/determined, − worried/sad. */
  brow: number;
  browRaise: number;
  /** Extra upper-lid closure. */
  lid: number;
  /** Happy "^ ^" closed eyes. */
  happy: number;
  /** Lid tilt: + determined, − sad. */
  tilt: number;
  /** Eye widening (fear, surprise). */
  wide: number;
  /** Pupil size multiplier. */
  pupil: number;
}

const base: Expression = {
  open: 0,
  smile: 0.55,
  width: 0.055,
  squiggle: 0,
  tongue: 0,
  teeth: 0,
  brow: 0,
  browRaise: 0,
  lid: 0,
  happy: 0,
  tilt: 0,
  wide: 0,
  pupil: 1,
};

const ex = (o: Partial<Expression>): Expression => ({ ...base, ...o });

/** Named expression presets. */
export const EXPRESSIONS = {
  neutral: ex({}),
  happy: ex({ smile: 1, width: 0.065, open: 0.3, teeth: 0.5, browRaise: 0.2 }),
  grin: ex({ smile: 1, width: 0.085, open: 0.55, teeth: 1, browRaise: 0.4 }),
  determined: ex({ smile: 0.15, width: 0.05, brow: 1, tilt: 0.55, lid: 0.12 }),
  effort: ex({ open: 0.35, smile: -0.1, width: 0.05, teeth: 1, brow: 0.8, tilt: 0.45 }),
  scared: ex({ open: 1, smile: -0.25, width: 0.034, brow: -1, browRaise: 1, wide: 1, pupil: 0.62 }),
  dizzy: ex({ squiggle: 1, width: 0.06, open: 0.08, smile: 0, lid: 0.22 }),
  tongue: ex({ smile: 0.7, open: 0.22, width: 0.05, tongue: 1, browRaise: 0.3 }),
  laugh: ex({ open: 0.85, smile: 1, width: 0.075, teeth: 0.7, happy: 1, browRaise: 0.5 }),
  sad: ex({ smile: -0.9, width: 0.048, brow: -1, browRaise: 0.4, tilt: -0.55, lid: 0.28, pupil: 1.1 }),
  struggle: ex({ open: 0.4, smile: -0.5, teeth: 1, width: 0.06, brow: 1, lid: 0.22, squiggle: 0.4 }),
  surprised: ex({ open: 0.7, smile: 0.1, width: 0.03, browRaise: 1, wide: 0.8, pupil: 0.85 }),
  smug: ex({ smile: 0.85, width: 0.06, lid: 0.32, brow: 0.3, browRaise: 0.15 }),
  wince: ex({ open: 0.2, smile: -0.4, width: 0.05, teeth: 1, happy: 0.9, brow: 0.6 }),
  content: ex({ smile: 0.95, width: 0.06, happy: 1, browRaise: 0.25 }),
  meh: ex({ smile: -0.15, width: 0.045, browRaise: 0.9, brow: -0.3, lid: 0.15 }),
} as const;

/** An expression preset name. */
export type ExpressionId = keyof typeof EXPRESSIONS;

const KEYS = Object.keys(base) as (keyof Expression)[];

/** Static per-face parameters from the face cosmetic. */
export interface FaceStyleParams {
  pupil: number;
  eyeScale: number;
  lidRest: number;
  blush: number;
  freckles: number;
  lashes: number;
}

/**
 * Drives a Tumbler's face. Owns no GPU state; writes into a {@link TumblerShaderState}.
 */
export class FaceController {
  private readonly cur: Expression = { ...base };
  private target: Expression = EXPRESSIONS.neutral;
  private blinkTimer: number;
  private blinkT = -1;
  private doubleBlink = false;
  private lookX = 0;
  private lookY = 0;
  private sacX = 0;
  private sacY = 0;
  private sacTimer = 0;
  private rnd: () => number;
  /** Forces the dizzy spiral pupils. */
  dizzy = false;
  style: FaceStyleParams = { pupil: 0, eyeScale: 1, lidRest: 0, blush: 1, freckles: 0, lashes: 0 };

  /** @param rnd - Per-instance random source so crowds don't blink in sync. */
  constructor(rnd: () => number) {
    this.rnd = rnd;
    this.blinkTimer = 1 + rnd() * 3;
  }

  /** Sets the expression to blend towards. */
  setExpression(id: ExpressionId): void {
    this.target = EXPRESSIONS[id];
  }

  /**
   * Advances blinks/saccades and blends towards the target expression.
   *
   * @param dt - Seconds.
   * @param time - Animation clock, forwarded to the shader for squiggles/spirals.
   * @param look - Desired look direction (−1…1 each) or null for idle saccades.
   * @param out - Shader state to write.
   */
  update(dt: number, time: number, look: { x: number; y: number } | null, out: TumblerShaderState): void {
    const k = 1 - Math.exp(-dt * 14);
    for (const key of KEYS) this.cur[key] += (this.target[key] - this.cur[key]) * k;

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.doubleBlink = this.rnd() < 0.18;
      this.blinkTimer = 2 + this.rnd() * 3.5;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const d = 0.15;
      blink = Math.sin(Math.min(1, this.blinkT / d) * Math.PI);
      if (this.blinkT >= d) {
        if (this.doubleBlink) {
          this.doubleBlink = false;
          this.blinkT = 0;
        } else this.blinkT = -1;
      }
    }

    this.sacTimer -= dt;
    if (this.sacTimer <= 0) {
      this.sacTimer = 0.6 + this.rnd() * 2;
      this.sacX = (this.rnd() * 2 - 1) * 0.6;
      this.sacY = (this.rnd() * 2 - 1) * 0.35;
    }
    const tx = look ? look.x : this.sacX;
    const ty = look ? look.y : this.sacY;
    // Eyes dart quickly; a fast exponential reads as a saccade, not a slide.
    const ke = 1 - Math.exp(-dt * 25);
    this.lookX += (tx - this.lookX) * ke;
    this.lookY += (ty - this.lookY) * ke;

    const c = this.cur;
    const s = this.style;
    out.faceA.set(this.lookX, this.lookY, Math.min(1, s.lidRest + c.lid + blink * (1 - c.happy)), c.happy);
    out.faceB.set(c.open, c.smile, c.width, c.squiggle);
    out.faceC.set(c.tongue, c.teeth, c.brow, c.browRaise);
    out.faceD.set(s.pupil, s.eyeScale, c.pupil, this.dizzy ? 1 : 0);
    out.faceE.set(s.blush, s.freckles, s.lashes, time);
    out.fx.z = c.tilt;
    out.fx.w = c.wide;
  }
}
