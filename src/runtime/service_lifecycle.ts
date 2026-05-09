/**
 * Lifecycle contract used by runtime services composed in PIT-B02.
 */

import type { RuntimeSurfaceStatus } from "./runtime_readiness_snapshot";

export type RuntimeServiceState = "registered" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface RuntimeServiceHealth {
  readonly service_ref: string;
  readonly state: RuntimeServiceState;
  readonly ready: boolean;
  readonly surface_status: RuntimeSurfaceStatus;
  readonly issues: readonly string[];
}

export interface RuntimeServiceLifecycle {
  readonly service_ref: string;
  readonly dependencies: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): RuntimeServiceHealth;
}

export class InMemoryRuntimeService implements RuntimeServiceLifecycle {
  public readonly service_ref: string;
  public readonly dependencies: readonly string[];
  private state: RuntimeServiceState = "registered";
  private readonly surfaceFactory: (ready: boolean, state: RuntimeServiceState) => RuntimeSurfaceStatus;

  public constructor(input: {
    readonly service_ref: string;
    readonly dependencies?: readonly string[];
    readonly surfaceFactory: (ready: boolean, state: RuntimeServiceState) => RuntimeSurfaceStatus;
  }) {
    this.service_ref = input.service_ref;
    this.dependencies = Object.freeze([...(input.dependencies ?? [])]);
    this.surfaceFactory = input.surfaceFactory;
  }

  public async start(): Promise<void> {
    this.state = "starting";
    this.state = "running";
  }

  public async stop(): Promise<void> {
    this.state = "stopping";
    this.state = "stopped";
  }

  public health(): RuntimeServiceHealth {
    const ready = this.state === "running";
    return Object.freeze({
      service_ref: this.service_ref,
      state: this.state,
      ready,
      surface_status: this.surfaceFactory(ready, this.state),
      issues: Object.freeze(ready || this.state === "stopped" ? [] : [`Service ${this.service_ref} is ${this.state}.`]),
    });
  }
}

