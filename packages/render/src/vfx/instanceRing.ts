import { InstancedInterleavedBuffer } from 'three/webgpu';

/**
 * Ring-buffered per-instance storage shared by every GPU-analytic pool.
 *
 * Responsibilities:
 * - Owns one preallocated `Float32Array` + `InstancedInterleavedBuffer` per pool.
 * - Hands out slots in ring order (oldest instance is recycled first).
 * - Tracks which slots were written this frame and uploads only those, as one
 *   or two update ranges (two when the frame's writes wrapped around the end).
 * - Tracks the furthest death time so idle pools can skip their draw call.
 */

/**
 * Ring allocator over an interleaved instanced buffer.
 *
 * Slots are `stride` floats wide. Writes go straight into {@link data}; call
 * {@link flush} once per frame to push the dirty range to the GPU.
 */
export class InstanceRing {
  /** CPU mirror of the GPU buffer. Written in place by spawners. */
  readonly data: Float32Array;
  /** GPU buffer, wrapped by `instancedBufferAttribute(buffer, 'vec4', stride, offset)` nodes. */
  readonly buffer: InstancedInterleavedBuffer;
  /** Floats per slot. */
  readonly stride: number;
  /** Allocated slots (hard maximum). */
  readonly allocated: number;

  private limit: number;
  private head = 0;
  private highWater = 0;
  private frameStart = 0;
  private frameCount = 0;
  private latestEnd = 0;

  /**
   * @param capacity - Slots to allocate; the active limit can later shrink below it.
   * @param stride - Floats per slot (multiple of 4).
   */
  constructor(capacity: number, stride: number) {
    this.allocated = Math.max(1, capacity | 0);
    this.limit = this.allocated;
    this.stride = stride;
    this.data = new Float32Array(this.allocated * stride);
    this.buffer = new InstancedInterleavedBuffer(this.data, stride, 1);
  }

  /** Instances the draw call must cover (slots ever written, up to the limit). */
  get drawCount(): number {
    return this.highWater;
  }

  /** Active ring size. */
  get capacity(): number {
    return this.limit;
  }

  /**
   * Changes the active ring size, clamped to the allocation.
   *
   * @param capacity - Requested live-instance budget.
   */
  setCapacity(capacity: number): void {
    const next = Math.max(1, Math.min(this.allocated, capacity | 0));
    if (next === this.limit) return;
    this.limit = next;
    this.reset();
  }

  /**
   * Claims the next slot and records when its instance dies.
   *
   * @param endTime - Absolute time (seconds) after which the instance is invisible.
   * @returns Float offset of the slot inside {@link data}.
   */
  alloc(endTime: number): number {
    const slot = this.head;
    this.head = slot + 1 >= this.limit ? 0 : slot + 1;
    if (this.frameCount === 0) this.frameStart = slot;
    if (this.frameCount < this.limit) this.frameCount++;
    if (slot + 1 > this.highWater) this.highWater = slot + 1;
    if (endTime > this.latestEnd) this.latestEnd = endTime;
    return slot * this.stride;
  }

  /**
   * Re-uploads one already-written slot (used to cut an instance short).
   *
   * @param offset - Float offset returned by {@link alloc}.
   */
  touch(offset: number): void {
    this.buffer.addUpdateRange(offset, this.stride);
    this.buffer.needsUpdate = true;
  }

  /**
   * True while at least one instance can still be visible.
   *
   * @param now - Current effect time in seconds.
   */
  isActive(now: number): boolean {
    return this.highWater > 0 && now <= this.latestEnd;
  }

  /** Uploads the slots written since the last flush. */
  flush(): void {
    if (this.frameCount === 0) return;
    const s = this.stride;
    // Ranges only clear when the renderer uploads; if the pool goes unrendered
    // for a while, collapse them into one full upload instead of growing forever.
    if (this.buffer.updateRanges.length > 32) {
      this.buffer.clearUpdateRanges();
      this.frameStart = 0;
      this.frameCount = this.highWater;
    }
    const end = this.frameStart + this.frameCount;
    if (end <= this.limit) {
      this.buffer.addUpdateRange(this.frameStart * s, this.frameCount * s);
    } else {
      this.buffer.addUpdateRange(this.frameStart * s, (this.limit - this.frameStart) * s);
      this.buffer.addUpdateRange(0, (end - this.limit) * s);
    }
    this.buffer.needsUpdate = true;
    this.frameCount = 0;
  }

  /** Forgets every instance. The GPU copy is left stale but no longer drawn. */
  reset(): void {
    this.head = 0;
    this.highWater = 0;
    this.frameCount = 0;
    this.latestEnd = 0;
  }
}
