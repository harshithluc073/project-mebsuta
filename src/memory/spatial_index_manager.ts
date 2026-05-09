/**
 * Spatial index manager for Project Mebsuta episodic spatial memory.
 *
 * Blueprint: `architecture_docs/15_RAG_EPISODIC_SPATIAL_MEMORY_ARCHITECTURE.md`
 * sections 15.4.1, 15.7, 15.10, 15.19.2, 15.20.1, and 15.24.
 *
 * The manager provides deterministic region, proximity, and relation lookup
 * over agent-maintained poses and coarse regions.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, Vector3 } from "../simulation/world_manifest";
import {
  MEMORY_BLUEPRINT_REF,
  cleanMemoryRef,
  freezeMemoryArray,
  makeMemoryIssue,
  makeMemoryRef,
  roundMemoryNumber,
  roundMemoryScore,
} from "./memory_write_gate";
import type { SpatialMemoryRecord } from "./spatial_record_builder";

export const SPATIAL_INDEX_MANAGER_SCHEMA_VERSION = "mebsuta.spatial_index_manager.v1" as const;

export interface SpatialMemoryIndexEntry {
  readonly entry_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly object_memory_ref: Ref;
  readonly frame_ref?: Ref;
  readonly position_m?: Vector3;
  readonly region_ref?: Ref;
  readonly relation_refs: readonly Ref[];
  readonly confidence: number;
  readonly staleness_score: number;
  readonly searchable: boolean;
}

export interface SpatialMemoryQuery {
  readonly query_ref?: Ref;
  readonly frame_ref?: Ref;
  readonly center_m?: Vector3;
  readonly radius_m?: number;
  readonly region_ref?: Ref;
  readonly relation_ref?: Ref;
  readonly min_confidence?: number;
  readonly max_staleness?: number;
  readonly include_contradicted?: boolean;
}

export interface SpatialMemoryRetrievalHit {
  readonly hit_ref: Ref;
  readonly memory_record_ref: Ref;
  readonly distance_m?: number;
  readonly spatial_score: number;
  readonly matched_by: readonly ("region" | "proximity" | "relation" | "record_scan")[];
  readonly record: SpatialMemoryRecord;
}

export interface SpatialRetrievalResultSet {
  readonly schema_version: typeof SPATIAL_INDEX_MANAGER_SCHEMA_VERSION;
  readonly blueprint_ref: typeof MEMORY_BLUEPRINT_REF;
  readonly query_ref: Ref;
  readonly hits: readonly SpatialMemoryRetrievalHit[];
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly cognitive_visibility: "spatial_retrieval_result_set";
  readonly determinism_hash: string;
}

export class SpatialIndexManager {
  private readonly entries: readonly SpatialMemoryIndexEntry[];
  private readonly recordsByRef: ReadonlyMap<Ref, SpatialMemoryRecord>;

  public constructor(records: readonly SpatialMemoryRecord[] = []) {
    this.recordsByRef = new Map(records.map((record) => [record.memory_record_ref, record]));
    this.entries = freezeMemoryArray(records.map(toIndexEntry).sort((a, b) => a.entry_ref.localeCompare(b.entry_ref)));
  }

  /**
   * Adds records and returns a new immutable manager instance.
   */
  public withRecords(records: readonly SpatialMemoryRecord[]): SpatialIndexManager {
    const merged = [...this.recordsByRef.values(), ...records];
    const deduped = [...new Map(merged.map((record) => [record.memory_record_ref, record])).values()];
    return new SpatialIndexManager(deduped);
  }

  /**
   * Retrieves spatial memories by region, proximity, relation, or scan.
   */
  public retrieveSpatialMemories(query: SpatialMemoryQuery): SpatialRetrievalResultSet {
    const issues: ValidationIssue[] = [];
    validateQuery(query, issues);
    const queryRef = cleanMemoryRef(query.query_ref ?? makeMemoryRef("spatial_memory_query", query.region_ref ?? query.relation_ref ?? "scan"));
    const hits = this.entries
      .filter((entry) => entry.searchable || query.include_contradicted === true)
      .filter((entry) => entry.confidence >= (query.min_confidence ?? 0))
      .filter((entry) => entry.staleness_score <= (query.max_staleness ?? 1))
      .map((entry) => hitForEntry(entry, this.recordsByRef.get(entry.memory_record_ref), query))
      .filter(isHit)
      .sort(compareHits);
    const base = {
      schema_version: SPATIAL_INDEX_MANAGER_SCHEMA_VERSION,
      blueprint_ref: MEMORY_BLUEPRINT_REF,
      query_ref: queryRef,
      hits: freezeMemoryArray(hits),
      issues: freezeMemoryArray(issues),
      ok: !issues.some((issue) => issue.severity === "error"),
      cognitive_visibility: "spatial_retrieval_result_set" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  /**
   * Returns the immutable lookup entries used by this manager.
   */
  public snapshotEntries(): readonly SpatialMemoryIndexEntry[] {
    return this.entries;
  }
}

export function retrieveSpatialMemories(records: readonly SpatialMemoryRecord[], query: SpatialMemoryQuery): SpatialRetrievalResultSet {
  return new SpatialIndexManager(records).retrieveSpatialMemories(query);
}

function toIndexEntry(record: SpatialMemoryRecord): SpatialMemoryIndexEntry {
  const pose = record.record_class === "verified_spatial" ? record.estimated_pose : record.estimated_pose_or_region;
  const objectMemoryRef = record.object_descriptor.object_memory_ref;
  const relationRefs = record.record_class === "verified_spatial" ? record.relation_records.map((relation) => relation.relation_ref) : pose?.relation_refs ?? [];
  const confidence = record.confidence_class === "verified"
    ? 1
    : record.record_class === "observed_spatial" || record.record_class === "search_hint"
      ? record.identity_confidence
      : 0.5;
  return Object.freeze({
    entry_ref: makeMemoryRef("spatial_index_entry", record.memory_record_ref),
    memory_record_ref: record.memory_record_ref,
    object_memory_ref: objectMemoryRef,
    frame_ref: pose?.frame_ref,
    position_m: pose?.position_m,
    region_ref: pose?.region_ref,
    relation_refs: freezeMemoryArray(relationRefs.map(cleanMemoryRef).sort()),
    confidence: roundMemoryScore(confidence),
    staleness_score: roundMemoryScore(record.staleness_score),
    searchable: record.retrieval_permissions.perception || record.retrieval_permissions.cognitive,
  });
}

function hitForEntry(entry: SpatialMemoryIndexEntry, record: SpatialMemoryRecord | undefined, query: SpatialMemoryQuery): SpatialMemoryRetrievalHit | undefined {
  if (record === undefined) return undefined;
  const matches: ("region" | "proximity" | "relation" | "record_scan")[] = [];
  let distance: number | undefined;
  if (query.region_ref !== undefined && entry.region_ref === cleanMemoryRef(query.region_ref)) matches.push("region");
  if (query.relation_ref !== undefined && entry.relation_refs.includes(cleanMemoryRef(query.relation_ref))) matches.push("relation");
  if (query.center_m !== undefined && query.radius_m !== undefined && entry.position_m !== undefined && (query.frame_ref === undefined || entry.frame_ref === query.frame_ref)) {
    distance = distanceBetween(entry.position_m, query.center_m);
    if (distance <= query.radius_m) matches.push("proximity");
  }
  if (query.region_ref === undefined && query.relation_ref === undefined && query.center_m === undefined) matches.push("record_scan");
  if (matches.length === 0) return undefined;
  const spatialScore = scoreHit(matches, distance, query.radius_m, entry);
  return Object.freeze({
    hit_ref: makeMemoryRef("spatial_hit", entry.memory_record_ref, matches.join("_")),
    memory_record_ref: entry.memory_record_ref,
    distance_m: distance,
    spatial_score: spatialScore,
    matched_by: freezeMemoryArray(matches.sort()),
    record,
  });
}

function scoreHit(matches: readonly string[], distance: number | undefined, radius: number | undefined, entry: SpatialMemoryIndexEntry): number {
  const matchScore = Math.min(1, matches.length * 0.34);
  const distanceScore = distance === undefined || radius === undefined || radius <= 0 ? 0.5 : 1 - Math.min(1, distance / radius);
  return roundMemoryScore(0.4 * matchScore + 0.35 * distanceScore + 0.25 * entry.confidence - 0.18 * entry.staleness_score);
}

function validateQuery(query: SpatialMemoryQuery, issues: ValidationIssue[]): void {
  if (query.radius_m !== undefined && (!Number.isFinite(query.radius_m) || query.radius_m < 0)) {
    issues.push(makeMemoryIssue("error", "MemoryPolicyInvalid", "$.radius_m", "Spatial query radius must be finite and nonnegative.", "Use a meter radius at or above zero."));
  }
  if (query.center_m !== undefined && query.radius_m === undefined) {
    issues.push(makeMemoryIssue("warning", "MemoryPolicyInvalid", "$.radius_m", "Center query without radius falls back to scan.", "Attach a radius for proximity lookup."));
  }
}

function compareHits(a: SpatialMemoryRetrievalHit, b: SpatialMemoryRetrievalHit): number {
  return b.spatial_score - a.spatial_score || (a.distance_m ?? Number.POSITIVE_INFINITY) - (b.distance_m ?? Number.POSITIVE_INFINITY) || a.memory_record_ref.localeCompare(b.memory_record_ref);
}

function distanceBetween(a: Vector3, b: Vector3): number {
  return roundMemoryNumber(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
}

function isHit(value: SpatialMemoryRetrievalHit | undefined): value is SpatialMemoryRetrievalHit {
  return value !== undefined;
}
