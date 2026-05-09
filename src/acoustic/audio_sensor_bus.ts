/**
 * Embodied microphone packet intake for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.4, 16.5, 16.7, 16.14, 16.15, 16.20, and 16.24.
 *
 * The bus is the File 16 schema root. It accepts only microphone-derived
 * packets, validates timing/provenance/signal summaries, and emits immutable
 * packet records that downstream acoustic stages can synchronize, filter,
 * detect, classify, localize, correlate, route, store, and observe.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue, ValidationSeverity, Vector3 } from "../simulation/world_manifest";

export const ACOUSTIC_BLUEPRINT_REF = "architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md" as const;
export const AUDIO_SENSOR_BUS_SCHEMA_VERSION = "mebsuta.audio_sensor_bus.v1" as const;
export const SPEED_OF_SOUND_M_PER_S = 343;
export const HIDDEN_ACOUSTIC_PATTERN =
  /(backend|engine|scene_graph|world_truth|ground_truth|collision_table|rigid_body|object_id|exact_source|source_position|oracle|qa_success|debug_overlay|asset_id|mesh_name)/i;

export type AcousticBand = "none" | "low" | "medium" | "high" | "blocking";
export type AudioChannelLayout = "single_mic" | "binaural_pair" | "array_bundle" | "wrist_mic";
export type AudioPreprocessingStatus = "raw" | "filtered" | "denoised" | "clipped" | "corrupted";
export type AudioSyncStatus = "synchronized" | "partially_synchronized" | "desynchronized";
export type AudioDurationClass = "impulse" | "short" | "sustained" | "repeating";
export type AudioOnsetShape = "sudden" | "gradual" | "repeated" | "continuous";
export type AudioEventClass = "impact" | "slide" | "scrape" | "roll" | "tool_contact" | "voice" | "ambient" | "self_noise" | "unknown";
export type AudioEventSubclass =
  | "drop_like_impact"
  | "soft_placement"
  | "hard_collision"
  | "surface_scrape"
  | "rolling_away"
  | "tool_surface_contact"
  | "speech_like"
  | "actuator_body_noise"
  | "unclassified";
export type AudioExpectednessStatus = "expected" | "unexpected" | "ambiguous" | "impossible_to_judge";
export type AudioRiskLevel = "none" | "low" | "medium" | "high" | "blocking";
export type AudioRoute = "ignore" | "note" | "reobserve" | "verify" | "oops" | "safe_hold" | "human_review";
export type AcousticTaskPhase =
  | "idle"
  | "observe"
  | "approach"
  | "grasp"
  | "carry"
  | "place"
  | "release"
  | "tool_use"
  | "verify"
  | "oops"
  | "safe_hold";
export type AudioTaskPhase = AcousticTaskPhase;
export type AudioIssueCode =
  | "AudioPacketInvalid"
  | "AudioPacketTimingInvalid"
  | "AudioPacketProvenanceInvalid"
  | "AudioSignalInvalid"
  | "AudioHiddenTruthLeak"
  | "AudioBundleInvalid"
  | "AudioPolicyInvalid"
  | "AudioStageInputInvalid";

export interface AcousticTimeWindow {
  readonly start_ms: number;
  readonly end_ms: number;
}

export interface FrequencyBandSummary {
  readonly low_hz_energy: number;
  readonly mid_hz_energy: number;
  readonly high_hz_energy: number;
}

export interface AudioSignalSummary {
  readonly rms_energy: number;
  readonly peak_amplitude: number;
  readonly silence_ratio: number;
  readonly clipping_ratio: number;
  readonly dominant_frequency_hz: number;
  readonly band_energy: FrequencyBandSummary;
  readonly spectral_centroid_hz?: number;
}

export interface AudioSensorPacket {
  readonly audio_packet_ref: Ref;
  readonly sensor_id: Ref;
  readonly embodiment_profile_ref: Ref;
  readonly mount_frame_ref: Ref;
  readonly capture_start_time_ms: number;
  readonly capture_end_time_ms: number;
  readonly sample_rate_hz: number;
  readonly channel_layout: AudioChannelLayout;
  readonly duration_ms: number;
  readonly signal_summary: AudioSignalSummary;
  readonly raw_audio_ref?: Ref;
  readonly preprocessing_status: AudioPreprocessingStatus;
  readonly provenance_class: "embodied_sensor";
  readonly sync_group_ref?: Ref;
  readonly calibration_ref?: Ref;
  readonly determinism_hash?: string;
}

export interface AudioArrayBundle {
  readonly audio_bundle_ref: Ref;
  readonly packet_refs: readonly Ref[];
  readonly packets: readonly AudioSensorPacket[];
  readonly capture_time_window: AcousticTimeWindow;
  readonly sync_status: AudioSyncStatus;
  readonly body_pose_ref: Ref;
  readonly microphone_geometry_ref: Ref;
  readonly self_motion_context_ref: Ref;
  readonly provenance_manifest_ref: Ref;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface EnergyProfile {
  readonly mean_rms_energy: number;
  readonly peak_amplitude: number;
  readonly energy_delta: number;
  readonly silence_ratio: number;
  readonly clipping_ratio: number;
}

export interface FrequencyProfile {
  readonly dominant_frequency_hz: number;
  readonly spectral_centroid_hz: number;
  readonly low_mid_high_ratio: readonly [number, number, number];
  readonly tonal_score: number;
}

export interface OnsetProfile {
  readonly onset_shape: AudioOnsetShape;
  readonly onset_strength: number;
  readonly repetition_count: number;
}

export interface SoundEventCandidate {
  readonly sound_candidate_ref: Ref;
  readonly audio_bundle_ref: Ref;
  readonly event_time_window: AcousticTimeWindow;
  readonly energy_profile: EnergyProfile;
  readonly frequency_profile: FrequencyProfile;
  readonly onset_profile: OnsetProfile;
  readonly duration_class: AudioDurationClass;
  readonly candidate_confidence: number;
  readonly self_noise_likelihood: number;
  readonly supporting_packet_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface AudioTaskPhaseCorrelation {
  readonly task_phase: AcousticTaskPhase;
  readonly active_goal_ref?: Ref;
  readonly expected_sound_classes: readonly AudioEventClass[];
  readonly controller_anomaly_refs: readonly Ref[];
  readonly contact_evidence_refs: readonly Ref[];
  readonly speaker_active: boolean;
}

export interface AudioEvent {
  readonly audio_event_ref: Ref;
  readonly source_candidate_ref: Ref;
  readonly event_class: AudioEventClass;
  readonly event_subclass: AudioEventSubclass;
  readonly classification_confidence: number;
  readonly estimated_direction_ref?: Ref;
  readonly estimated_region_ref?: Ref;
  readonly task_phase_correlation: AudioTaskPhaseCorrelation;
  readonly expectedness_status: AudioExpectednessStatus;
  readonly risk_level: AudioRiskLevel;
  readonly recommended_route: AudioRoute;
  readonly prompt_safe_summary: string;
  readonly provenance_manifest_ref: Ref;
  readonly evidence_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface AudioLocalizationEstimate {
  readonly localization_ref: Ref;
  readonly audio_event_ref: Ref;
  readonly reference_frame_ref: Ref;
  readonly azimuth_estimate_rad: number;
  readonly elevation_estimate_rad: number;
  readonly range_estimate: "near" | "mid" | "far" | "unknown";
  readonly direction_uncertainty_rad: number;
  readonly range_uncertainty_m: number;
  readonly localization_confidence: number;
  readonly reflection_risk: AcousticBand;
  readonly occlusion_risk: AcousticBand;
  readonly direction_unit_body: Vector3;
  readonly contributing_packet_refs: readonly Ref[];
  readonly determinism_hash: string;
}

export interface AudioSensorBusPolicy {
  readonly max_bundle_spread_ms?: number;
  readonly min_sample_rate_hz?: number;
  readonly max_packet_duration_ms?: number;
  readonly allow_raw_audio_ref?: boolean;
}

const DEFAULT_BUS_POLICY = Object.freeze({
  max_bundle_spread_ms: 24,
  min_sample_rate_hz: 8000,
  max_packet_duration_ms: 250,
  allow_raw_audio_ref: true,
});

/**
 * Validates microphone packets and forms a synchronized array bundle.
 */
export class AudioSensorBus {
  private readonly policy: Required<AudioSensorBusPolicy>;

  public constructor(policy: AudioSensorBusPolicy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_BUS_POLICY, ...policy });
    if (!Number.isFinite(this.policy.max_bundle_spread_ms) || this.policy.max_bundle_spread_ms <= 0) {
      throw new Error("AudioSensorBus policy requires a positive max_bundle_spread_ms.");
    }
  }

  /**
   * Captures an immutable array bundle from microphone packets.
   */
  public captureAudioArrayBundle(input: {
    readonly packets: readonly AudioSensorPacket[];
    readonly body_pose_ref: Ref;
    readonly microphone_geometry_ref: Ref;
    readonly self_motion_context_ref: Ref;
    readonly provenance_manifest_ref: Ref;
    readonly requested_bundle_ref?: Ref;
  }): AudioArrayBundle {
    const issues: ValidationIssue[] = [];
    const normalizedPackets = input.packets.map((packet, index) => normalizePacket(packet, issues, `$.packets[${index}]`, this.policy));
    validateRef(input.body_pose_ref, "$.body_pose_ref", issues, "AudioBundleInvalid");
    validateRef(input.microphone_geometry_ref, "$.microphone_geometry_ref", issues, "AudioBundleInvalid");
    validateRef(input.self_motion_context_ref, "$.self_motion_context_ref", issues, "AudioBundleInvalid");
    validateRef(input.provenance_manifest_ref, "$.provenance_manifest_ref", issues, "AudioBundleInvalid");
    if (normalizedPackets.length === 0) {
      issues.push(makeAudioIssue("error", "AudioBundleInvalid", "$.packets", "At least one embodied microphone packet is required.", "Capture a declared microphone packet before acoustic processing."));
    }
    const window = mergedWindow(normalizedPackets);
    const spreadMs = normalizedPackets.length <= 1
      ? 0
      : Math.max(...normalizedPackets.map((packet) => midpoint(packet))) - Math.min(...normalizedPackets.map((packet) => midpoint(packet)));
    const syncStatus: AudioSyncStatus = spreadMs <= this.policy.max_bundle_spread_ms * 0.35
      ? "synchronized"
      : spreadMs <= this.policy.max_bundle_spread_ms
        ? "partially_synchronized"
        : "desynchronized";
    if (syncStatus === "desynchronized") {
      issues.push(makeAudioIssue("error", "AudioBundleInvalid", "$.packets", "Microphone packet timing spread exceeds the synchronization policy.", "Recapture microphones inside the configured timing window."));
    }
    const bundleRef = cleanAcousticRef(input.requested_bundle_ref ?? makeAcousticRef("audio_bundle", input.provenance_manifest_ref, window.start_ms, window.end_ms));
    const base = {
      audio_bundle_ref: bundleRef,
      packet_refs: uniqueRefs(normalizedPackets.map((packet) => packet.audio_packet_ref)),
      packets: freezeArray(normalizedPackets),
      capture_time_window: window,
      sync_status: syncStatus,
      body_pose_ref: cleanAcousticRef(input.body_pose_ref),
      microphone_geometry_ref: cleanAcousticRef(input.microphone_geometry_ref),
      self_motion_context_ref: cleanAcousticRef(input.self_motion_context_ref),
      provenance_manifest_ref: cleanAcousticRef(input.provenance_manifest_ref),
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function createAudioArrayBundle(input: Parameters<AudioSensorBus["captureAudioArrayBundle"]>[0], policy: AudioSensorBusPolicy = {}): AudioArrayBundle {
  return new AudioSensorBus(policy).captureAudioArrayBundle(input);
}

export function normalizePacket(packet: AudioSensorPacket, issues: ValidationIssue[], path: string, policy: Required<AudioSensorBusPolicy> = DEFAULT_BUS_POLICY): AudioSensorPacket {
  validateRef(packet.audio_packet_ref, `${path}.audio_packet_ref`, issues, "AudioPacketInvalid");
  validateRef(packet.sensor_id, `${path}.sensor_id`, issues, "AudioPacketInvalid");
  validateRef(packet.embodiment_profile_ref, `${path}.embodiment_profile_ref`, issues, "AudioPacketInvalid");
  validateRef(packet.mount_frame_ref, `${path}.mount_frame_ref`, issues, "AudioPacketInvalid");
  if (packet.provenance_class !== "embodied_sensor") {
    issues.push(makeAudioIssue("error", "AudioPacketProvenanceInvalid", `${path}.provenance_class`, "Audio packets must originate from embodied microphones.", "Route only microphone-derived sensor packets into File 16."));
  }
  if (!Number.isFinite(packet.capture_start_time_ms) || !Number.isFinite(packet.capture_end_time_ms) || packet.capture_end_time_ms < packet.capture_start_time_ms) {
    issues.push(makeAudioIssue("error", "AudioPacketTimingInvalid", `${path}.capture_time`, "Audio capture times must be finite and monotonic.", "Use synchronized packet timestamps in milliseconds."));
  }
  if (!Number.isFinite(packet.sample_rate_hz) || packet.sample_rate_hz < policy.min_sample_rate_hz) {
    issues.push(makeAudioIssue("error", "AudioPacketInvalid", `${path}.sample_rate_hz`, "Audio sample rate is below policy.", "Use a microphone sample rate that preserves event timing."));
  }
  if (!Number.isFinite(packet.duration_ms) || packet.duration_ms <= 0 || packet.duration_ms > policy.max_packet_duration_ms) {
    issues.push(makeAudioIssue("error", "AudioPacketTimingInvalid", `${path}.duration_ms`, "Audio packet duration must be positive and inside policy.", "Provide bounded windows for deterministic acoustic stages."));
  }
  validateSignalSummary(packet.signal_summary, `${path}.signal_summary`, issues);
  if (!policy.allow_raw_audio_ref && packet.raw_audio_ref !== undefined) {
    issues.push(makeAudioIssue("warning", "AudioPacketProvenanceInvalid", `${path}.raw_audio_ref`, "Raw audio retention is disabled by policy.", "Strip raw waveform references before routing."));
  }
  const text = JSON.stringify(packet);
  if (HIDDEN_ACOUSTIC_PATTERN.test(text)) {
    issues.push(makeAudioIssue("error", "AudioHiddenTruthLeak", path, "Audio packet contains hidden simulator or backend-source wording.", "Redact source identity and simulator details before acoustic routing."));
  }
  const base = {
    ...packet,
    audio_packet_ref: cleanAcousticRef(packet.audio_packet_ref),
    sensor_id: cleanAcousticRef(packet.sensor_id),
    embodiment_profile_ref: cleanAcousticRef(packet.embodiment_profile_ref),
    mount_frame_ref: cleanAcousticRef(packet.mount_frame_ref),
    raw_audio_ref: packet.raw_audio_ref === undefined ? undefined : cleanAcousticRef(packet.raw_audio_ref),
    sync_group_ref: packet.sync_group_ref === undefined ? undefined : cleanAcousticRef(packet.sync_group_ref),
    calibration_ref: packet.calibration_ref === undefined ? undefined : cleanAcousticRef(packet.calibration_ref),
    signal_summary: freezeSignal(packet.signal_summary),
  };
  return Object.freeze({ ...base, determinism_hash: packet.determinism_hash ?? computeDeterminismHash(base) });
}

export function makeAudioIssue(severity: ValidationSeverity, code: AudioIssueCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

export function validateRef(value: Ref, path: string, issues: ValidationIssue[], code: AudioIssueCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/u.test(value) || HIDDEN_ACOUSTIC_PATTERN.test(value)) {
    issues.push(makeAudioIssue("error", code, path, "Reference must be non-empty, whitespace-free, and simulation-blind.", "Use an opaque embodied runtime reference."));
  }
}

export function validateSignalSummary(summary: AudioSignalSummary, path: string, issues: ValidationIssue[]): void {
  for (const [field, value] of Object.entries({
    rms_energy: summary.rms_energy,
    peak_amplitude: summary.peak_amplitude,
    silence_ratio: summary.silence_ratio,
    clipping_ratio: summary.clipping_ratio,
    dominant_frequency_hz: summary.dominant_frequency_hz,
    low_hz_energy: summary.band_energy.low_hz_energy,
    mid_hz_energy: summary.band_energy.mid_hz_energy,
    high_hz_energy: summary.band_energy.high_hz_energy,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      issues.push(makeAudioIssue("error", "AudioSignalInvalid", `${path}.${field}`, "Signal summary fields must be finite and nonnegative.", "Compute bounded signal statistics from microphone data."));
    }
  }
  if (summary.peak_amplitude > 1.5 || summary.silence_ratio > 1 || summary.clipping_ratio > 1) {
    issues.push(makeAudioIssue("warning", "AudioSignalInvalid", path, "Normalized amplitude, silence, or clipping ratios exceed expected bounds.", "Clamp normalized ratios before downstream classification."));
  }
}

export function mergedWindow(packets: readonly AudioSensorPacket[]): AcousticTimeWindow {
  if (packets.length === 0) return Object.freeze({ start_ms: 0, end_ms: 0 });
  return Object.freeze({
    start_ms: Math.min(...packets.map((packet) => packet.capture_start_time_ms)),
    end_ms: Math.max(...packets.map((packet) => packet.capture_end_time_ms)),
  });
}

export function midpoint(packet: AudioSensorPacket): number {
  return (packet.capture_start_time_ms + packet.capture_end_time_ms) / 2;
}

export function cleanAcousticRef(value: Ref): Ref {
  return makeAcousticRef(value);
}

export function makeAcousticRef(...parts: readonly (string | number)[]): Ref {
  const normalized = parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length === 0 || HIDDEN_ACOUSTIC_PATTERN.test(normalized) ? "acoustic_ref_redacted" : normalized;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

export function bandFromScore(score: number): AcousticBand {
  const value = clamp01(score);
  if (value >= 0.88) return "blocking";
  if (value >= 0.68) return "high";
  if (value >= 0.38) return "medium";
  if (value > 0.05) return "low";
  return "none";
}

export function riskRank(risk: AudioRiskLevel): number {
  if (risk === "blocking") return 4;
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

export function routeRank(route: AudioRoute): number {
  if (route === "safe_hold" || route === "human_review") return 5;
  if (route === "oops") return 4;
  if (route === "verify") return 3;
  if (route === "reobserve") return 2;
  if (route === "note") return 1;
  return 0;
}

export function uniqueRefs(values: readonly Ref[]): readonly Ref[] {
  return freezeArray([...new Set(values.map(cleanAcousticRef))].sort());
}

export function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeSignal(summary: AudioSignalSummary): AudioSignalSummary {
  return Object.freeze({
    ...summary,
    band_energy: Object.freeze({ ...summary.band_energy }),
  });
}
