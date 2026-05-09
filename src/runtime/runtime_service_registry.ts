/**
 * Dependency-aware service registry for the runtime composition foundation.
 */

import type { RuntimeSurfaceStatus } from "./runtime_readiness_snapshot";
import type { RuntimeServiceHealth, RuntimeServiceLifecycle } from "./service_lifecycle";

export class RuntimeServiceRegistry {
  private readonly services = new Map<string, RuntimeServiceLifecycle>();
  private startedOrder: readonly string[] = Object.freeze([]);

  public register(service: RuntimeServiceLifecycle): void {
    if (this.services.has(service.service_ref)) {
      throw new Error(`Runtime service already registered: ${service.service_ref}.`);
    }
    this.services.set(service.service_ref, service);
  }

  public listServiceRefs(): readonly string[] {
    return Object.freeze([...this.services.keys()]);
  }

  public async startAll(): Promise<void> {
    const order = this.resolveStartOrder();
    const started: string[] = [];
    for (const serviceRef of order) {
      const service = this.requiredService(serviceRef);
      await service.start();
      started.push(serviceRef);
    }
    this.startedOrder = Object.freeze(started);
  }

  public async stopAll(): Promise<void> {
    const reversed = [...this.startedOrder].reverse();
    for (const serviceRef of reversed) {
      await this.requiredService(serviceRef).stop();
    }
    this.startedOrder = Object.freeze([]);
  }

  public healthReports(): readonly RuntimeServiceHealth[] {
    return Object.freeze([...this.services.values()].map((service) => service.health()));
  }

  public surfaces(): readonly RuntimeSurfaceStatus[] {
    return Object.freeze(this.healthReports().map((report) => report.surface_status));
  }

  private resolveStartOrder(): readonly string[] {
    const resolved: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (serviceRef: string): void => {
      if (visited.has(serviceRef)) {
        return;
      }
      if (visiting.has(serviceRef)) {
        throw new Error(`Runtime service dependency cycle detected at ${serviceRef}.`);
      }
      visiting.add(serviceRef);
      const service = this.requiredService(serviceRef);
      for (const dependency of service.dependencies) {
        if (!this.services.has(dependency)) {
          throw new Error(`Runtime service ${serviceRef} depends on missing service ${dependency}.`);
        }
        visit(dependency);
      }
      visiting.delete(serviceRef);
      visited.add(serviceRef);
      resolved.push(serviceRef);
    };

    for (const serviceRef of this.services.keys()) {
      visit(serviceRef);
    }
    return Object.freeze(resolved);
  }

  private requiredService(serviceRef: string): RuntimeServiceLifecycle {
    const service = this.services.get(serviceRef);
    if (service === undefined) {
      throw new Error(`Runtime service is not registered: ${serviceRef}.`);
    }
    return service;
  }
}

