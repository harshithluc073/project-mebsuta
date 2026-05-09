/**
 * Spatial audio direction estimation from synchronized microphone packets.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.4, 16.5.5, 16.6, 16.7.1, 16.18, and 16.20.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, Vector3, ValidationIssue } from "../simulation/world_manifest";
import {
  AudioArrayBundle,
  AudioEvent,
  AudioLocalizationEstimate,
  SPEED_OF_SOUND_M_PER_S,
  bandFromScore,
  clamp,
  clamp01,
  freezeArray,
  makeAcousticRef,
  makeAudioIssue,
  round6,
  uniqueRefs,
} from "./audio_sensor_bus";
import type { AudioSynchronizationReport } from "./audio_synchronizer";

export const SPATIAL_AUDIO_LOCALIZER_SCHEMA_VERSION = "mebsuta.spatial_audio_localizer.v1" as const;

export interface MicrophoneGeometryRecord {
  readonly sensor_id: Ref;
  readonly mount_frame_ref: Ref;
  readonly relative_position_m: Vector3;
}

export interface SpatialAudioLocalizationPolicy {
  readonly max_tdoa_abs_ms?: number;
  readonly min_localization_confidence?: number;
  readonly default_uncertainty_rad?: number;
}

export interface AudioLocalizationSet {
  readonly schema_version: typeof SPATIAL_AUDIO_LOCALIZER_SCHEMA_VERSION;
  readonly localization_set_ref: Ref;
  readonly audio_bundle_ref: Ref;
  readonly localizations: readonly AudioLocalizationEstimate[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

const DEFAULT_POLICY = Object.freeze({
  max_tdoa_abs_ms: 2.5,
  min_localization_confidence: 0.12,
  default_uncertainty_rad: Math.PI / 3,
});

export class SpatialAudioLocalizer {
  private readonly policy: Required<SpatialAudioLocalizationPolicy>;

  public constructor(policy: SpatialAudioLocalizationPolicy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
  }

  /**
   * Estimates coarse direction and uncertainty without assigning source identity.
   */
  public estimateAudioDirections(
    events: readonly AudioEvent[],
    bundle: AudioArrayBundle,
    syncReport: AudioSynchronizationReport,
    microphoneGeometry: readonly MicrophoneGeometryRecord[],
    referenceFrameRef: Ref,
  ): AudioLocalizationSet {
    const issues: ValidationIssue[] = [];
    if (!syncReport.localization_allowed) {
      issues.push(makeAudioIssue("warning", "AudioStageInputInvalid", "$.sync_report", "Localization blocked by desynchronized microphones.", "Use event routing without directional confidence or recapture audio."));
    }
    const localizations = syncReport.localization_allowed
      ? events.map((event) => this.localizeEvent(event, bundle, microphoneGeometry, referenceFrameRef, issues))
      : [];
    const base = {
      schema_version: SPATIAL_AUDIO_LOCALIZER_SCHEMA_VERSION,
      localization_set_ref: makeAcousticRef("audio_localization_set", bundle.audio_bundle_ref, localizations.length),
      audio_bundle_ref: bundle.audio_bundle_ref,
      localizations: freezeArray(localizations),
      issues: freezeArray([...syncReport.issues, ...issues]),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  private localizeEvent(
    event: AudioEvent,
    bundle: AudioArrayBundle,
    geometry: readonly MicrophoneGeometryRecord[],
    referenceFrameRef: Ref,
    issues: ValidationIssue[],
  ): AudioLocalizationEstimate {
    const packets = bundle.packets.filter((packet) => event.evidence_refs.includes(packet.audio_packet_ref));
    const activePackets = packets.length > 0 ? packets : bundle.packets;
    const pair = strongestPair(activePackets, geometry);
    if (pair === undefined) {
      issues.push(makeAudioIssue("warning", "AudioBundleInvalid", "$.microphone_geometry", "At least two microphone positions are needed for directional localization.", "Provide binaural or array microphone geometry."));
      return unknownLocalization(event, referenceFrameRef, activePackets.map((packet) => packet.audio_packet_ref));
    }
    const dtMs = clamp(pair.left.capture_start_time_ms - pair.right.capture_start_time_ms, -this.policy.max_tdoa_abs_ms, this.policy.max_tdoa_abs_ms);
    const baseline = Math.max(0.01, norm(sub(pair.leftGeometry.relative_position_m, pair.rightGeometry.relative_position_m)));
    const timeAngle = Math.asin(clamp((SPEED_OF_SOUND_M_PER_S * (dtMs / 1000)) / baseline, -1, 1));
    const ampRatio = safeLogRatio(pair.left.signal_summary.peak_amplitude, pair.right.signal_summary.peak_amplitude);
    const azimuth = round6(clamp(timeAngle * 0.72 + ampRatio * 0.08, -Math.PI, Math.PI));
    const elevation = round6(clamp((pair.leftGeometry.relative_position_m[2] - pair.rightGeometry.relative_position_m[2]) / baseline * 0.35, -Math.PI / 4, Math.PI / 4));
    const confidence = clamp01(event.classification_confidence * 0.44 + Math.min(1, Math.abs(pair.left.signal_summary.peak_amplitude - pair.right.signal_summary.peak_amplitude) + baseline) * 0.25 + (bundle.sync_status === "synchronized" ? 0.25 : 0.08));
    const uncertainty = round6(clamp(this.policy.default_uncertainty_rad * (1.25 - confidence) + Math.abs(dtMs) / Math.max(1, this.policy.max_tdoa_abs_ms) * 0.18, 0.08, Math.PI));
    const base = {
      localization_ref: makeAcousticRef("audio_localization", event.audio_event_ref, azimuth, uncertainty),
      audio_event_ref: event.audio_event_ref,
      reference_frame_ref: makeAcousticRef(referenceFrameRef),
      azimuth_estimate_rad: azimuth,
      elevation_estimate_rad: elevation,
      range_estimate: rangeFromAmplitude(Math.max(pair.left.signal_summary.peak_amplitude, pair.right.signal_summary.peak_amplitude)),
      direction_uncertainty_rad: uncertainty,
      range_uncertainty_m: round6(0.25 + uncertainty * 0.9),
      localization_confidence: round6(Math.max(this.policy.min_localization_confidence, confidence)),
      reflection_risk: bandFromScore(uncertainty / Math.PI),
      occlusion_risk: bandFromScore((1 - confidence) * 0.65),
      direction_unit_body: directionVector(azimuth, elevation),
      contributing_packet_refs: uniqueRefs(activePackets.map((packet) => packet.audio_packet_ref)),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function estimateAudioDirections(
  events: readonly AudioEvent[],
  bundle: AudioArrayBundle,
  syncReport: AudioSynchronizationReport,
  microphoneGeometry: readonly MicrophoneGeometryRecord[],
  referenceFrameRef: Ref,
  policy: SpatialAudioLocalizationPolicy = {},
): AudioLocalizationSet {
  return new SpatialAudioLocalizer(policy).estimateAudioDirections(events, bundle, syncReport, microphoneGeometry, referenceFrameRef);
}

function strongestPair(packets: readonly AudioArrayBundle["packets"][number][], geometry: readonly MicrophoneGeometryRecord[]) {
  if (packets.length < 2) return undefined;
  const sorted = [...packets].sort((a, b) => b.signal_summary.peak_amplitude - a.signal_summary.peak_amplitude || a.sensor_id.localeCompare(b.sensor_id));
  const left = sorted[0];
  const right = sorted.find((packet) => packet.sensor_id !== left.sensor_id) ?? sorted[1];
  const leftGeometry = geometry.find((entry) => entry.sensor_id === left.sensor_id) ?? geometry[0];
  const rightGeometry = geometry.find((entry) => entry.sensor_id === right.sensor_id) ?? geometry.find((entry) => entry.sensor_id !== leftGeometry.sensor_id) ?? geometry[1];
  if (leftGeometry === undefined || rightGeometry === undefined) return undefined;
  return { left, right, leftGeometry, rightGeometry };
}

function unknownLocalization(event: AudioEvent, frameRef: Ref, packetRefs: readonly Ref[]): AudioLocalizationEstimate {
  const base = {
    localization_ref: makeAcousticRef("audio_localization_unknown", event.audio_event_ref),
    audio_event_ref: event.audio_event_ref,
    reference_frame_ref: makeAcousticRef(frameRef),
    azimuth_estimate_rad: 0,
    elevation_estimate_rad: 0,
    range_estimate: "unknown" as const,
    direction_uncertainty_rad: Math.PI,
    range_uncertainty_m: 10,
    localization_confidence: 0,
    reflection_risk: "high" as const,
    occlusion_risk: "high" as const,
    direction_unit_body: Object.freeze([1, 0, 0]) as unknown as Vector3,
    contributing_packet_refs: uniqueRefs(packetRefs),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function directionVector(azimuth: number, elevation: number): Vector3 {
  return Object.freeze([
    round6(Math.cos(azimuth) * Math.cos(elevation)),
    round6(Math.sin(azimuth) * Math.cos(elevation)),
    round6(Math.sin(elevation)),
  ]) as unknown as Vector3;
}

function rangeFromAmplitude(peak: number): AudioLocalizationEstimate["range_estimate"] {
  if (peak >= 0.72) return "near";
  if (peak >= 0.25) return "mid";
  if (peak > 0.04) return "far";
  return "unknown";
}

function safeLogRatio(a: number, b: number): number {
  return 20 * Math.log10(Math.max(1e-6, a) / Math.max(1e-6, b));
}

function sub(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vector3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}
