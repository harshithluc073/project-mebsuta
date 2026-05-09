/**
 * Acoustic world service for Project Mebsuta.
 *
 * Blueprint: `architecture_docs/03_SIMULATION_AND_PHYSICS_ENGINE_ARCHITECTURE.md`
 * sections 3.3, 3.5, 3.10, 3.12, 3.13, 3.17.4, 3.20, and 3.21,
 * with packet redaction constraints aligned to architecture files 04 and 16.
 *
 * The service converts contact and movement evidence into microphone-facing
 * audio packets. It performs deterministic acoustic classification, inverse
 * square attenuation, inter-channel delay estimation, bearing estimation,
 * uncertainty scoring, self-noise classification, synchronization checks, and
 * cognitive-safe redaction. Internal body refs, object refs, exact source
 * positions, material acoustic profiles, and simulator event hashes remain
 * runtime/QA/validator-only.
 */

import { computeDeterminismHash } from "./world_manifest";
import type { ContactAcousticClass, ContactEvent, SafetyRelevance } from "./contact_solver_adapter";
import type { PhysicsWorldSnapshot } from "./simulation_world_service";
import type { Quaternion, Ref, Transform, ValidationIssue, ValidationSeverity, Vector3 } from "./world_manifest";

export const ACOUSTIC_WORLD_SERVICE_SCHEMA_VERSION = "mebsuta.acoustic_world_service.v1" as const;
const SPEED_OF_SOUND_M_PER_S = 343;
const REFERENCE_DISTANCE_M = 1;
const REFERENCE_PRESSURE_PA = 0.00002;
const DEFAULT_PACKET_HZ = 50;
const DEFAULT_SAMPLE_RATE_HZ = 48000;
const DEFAULT_AUDIO_WINDOW_S = 0.02;
const DEFAULT_MAX_AUDIO_SYNC_DELTA_S = 1 / 60;
const DEFAULT_EVENT_CONFIDENCE_FLOOR = 0.05;
const DEFAULT_EVENT_CONFIDENCE_CEILING = 0.98;
const DEFAULT_AMBIGUITY_ANGLE_RAD = Math.PI / 3;
const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];
const ZERO_VECTOR: Vector3 = [0, 0, 0];

export type MicrophoneArrayKind = "mono" | "stereo_head" | "triangular_head" | "wrist_pair" | "distributed_body";
export type AudioPacketStatus = "captured" | "silent" | "degraded" | "blocked";
export type AcousticEventClass = "impact" | "hard_impact" | "collision" | "scrape" | "slip" | "rolling" | "footstep" | "soft_contact" | "self_noise" | "ambiguous";
export type AcousticIntensity = "silent" | "low" | "medium" | "high" | "blocking";
export type AcousticRouteHint = "ignore" | "note" | "reobserve" | "verify" | "oops" | "safe_hold" | "human_review";
export type AudioSynchronizationStatus = "synchronized" | "degraded" | "mismatch";
export type AudioHealthStatus = "nominal" | "degraded" | "blocked";
export type AcousticSourceKind = "contact" | "movement" | "disturbance" | "self_motion";
export type AcousticValidationCode =
  | "UndeclaredMicrophone"
  | "MicrophoneDescriptorInvalid"
  | "AcousticPolicyInvalid"
  | "AudioTimingMismatch"
  | "AudioEventAmbiguous"
  | "SourceRefNotRedacted"
  | "SnapshotInvalid"
  | "ContactEventInvalid"
  | "MovementEventInvalid";

export interface TimestampInterval {
  readonly start_s: number;
  readonly end_s: number;
}

export interface MicrophoneChannelDescriptor {
  readonly channel_id: Ref;
  readonly channel_index: number;
  readonly local_position_m: Vector3;
  readonly gain_db: number;
  readonly noise_floor_db_spl: number;
}

export interface MicrophoneArrayDescriptor {
  readonly microphone_array_id: Ref;
  readonly array_kind: MicrophoneArrayKind;
  readonly mount_frame_ref: Ref;
  readonly mount_transform: Transform;
  readonly calibration_ref: Ref;
  readonly sample_rate_hz: number;
  readonly packet_hz: number;
  readonly supports_raw_waveform: boolean;
  readonly declared_for_cognitive_use: boolean;
  readonly channels: readonly MicrophoneChannelDescriptor[];
  readonly health_status?: AudioHealthStatus;
}

export interface AcousticPolicy {
  readonly acoustic_policy_ref: Ref;
  readonly cognitive_bound: boolean;
  readonly include_waveform_ref: boolean;
  readonly sample_window_s: number;
  readonly max_audio_sync_delta_s: number;
  readonly max_bearing_uncertainty_rad: number;
  readonly min_event_confidence: number;
  readonly ambient_noise_db_spl: number;
  readonly self_noise_body_ref_patterns: readonly string[];
  readonly block_source_refs_in_cognitive_packet: boolean;
  readonly ambiguous_event_route: AcousticRouteHint;
}

export interface MovementAcousticEvent {
  readonly movement_event_id: Ref;
  readonly source_kind: Extract<AcousticSourceKind, "movement" | "disturbance" | "self_motion">;
  readonly timestamp_s: number;
  readonly physics_tick: number;
  readonly source_position_m: Vector3;
  readonly velocity_m_per_s: Vector3;
  readonly acceleration_m_per_s2?: Vector3;
  readonly movement_class: "roll" | "slide" | "drop" | "drag" | "actuator" | "voice" | "unknown";
  readonly intensity_hint?: AcousticIntensity;
  readonly internal_source_ref?: Ref;
  readonly audio_profile_ref?: Ref;
}

export interface AcousticSynchronizationRecord {
  readonly snapshot_ref: Ref;
  readonly physics_tick: number;
  readonly physics_timestamp_s: number;
  readonly audio_sample_time_s: number;
  readonly audio_event_latency_ms: number;
  readonly status: AudioSynchronizationStatus;
  readonly determinism_hash: string;
}

export interface AcousticBearingEstimate {
  readonly frame_ref: "microphone_array";
  readonly azimuth_rad: number;
  readonly elevation_rad: number;
  readonly distance_estimate_m: number;
  readonly angular_uncertainty_rad: number;
  readonly range_uncertainty_m: number;
  readonly confidence: number;
  readonly estimate_basis: "interaural_time_difference_and_level_attenuation";
}

export interface ChannelAcousticSample {
  readonly channel_id: Ref;
  readonly channel_index: number;
  readonly arrival_time_s: number;
  readonly relative_delay_s: number;
  readonly estimated_spl_db: number;
  readonly normalized_amplitude: number;
  readonly signal_to_noise_db: number;
}

export interface SoundEventCandidate {
  readonly sound_event_id: Ref;
  readonly source_kind: AcousticSourceKind;
  readonly acoustic_class: AcousticEventClass;
  readonly source_time_s: number;
  readonly confidence: number;
  readonly expectedness: "expected_self_noise" | "expected_task_sound" | "unexpected" | "ambiguous";
  readonly intensity_estimate: AcousticIntensity;
  readonly bearing_estimate?: AcousticBearingEstimate;
  readonly self_generated_likelihood: number;
  readonly route_hint: AcousticRouteHint;
  readonly prompt_safe_summary: string;
  readonly hidden_source_ref_redacted: boolean;
  readonly qa_source_metadata: {
    readonly internal_source_refs: readonly Ref[];
    readonly source_position_m: Vector3;
    readonly audio_profile_refs: readonly Ref[];
    readonly contact_event_ref?: Ref;
    readonly movement_event_ref?: Ref;
    readonly hidden_truth_visibility: "runtime_qa_validator_only";
  };
  readonly channel_samples: readonly ChannelAcousticSample[];
  readonly determinism_hash: string;
}

export interface AudioPacket {
  readonly schema_version: typeof ACOUSTIC_WORLD_SERVICE_SCHEMA_VERSION;
  readonly audio_packet_id: Ref;
  readonly microphone_array_id: Ref;
  readonly timestamp_interval: TimestampInterval;
  readonly waveform_ref?: Ref;
  readonly event_candidates: readonly SoundEventCandidate[];
  readonly dominant_bearing_estimate?: AcousticBearingEstimate;
  readonly intensity_estimate: AcousticIntensity;
  readonly self_generated_likelihood: number;
  readonly health_status: AudioHealthStatus;
  readonly packet_status: AudioPacketStatus;
  readonly synchronization: AcousticSynchronizationRecord;
  readonly source_redaction_status: "source_refs_stripped_for_cognition" | "qa_internal_only";
  readonly issue_count: number;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
  readonly cognitive_visibility: "microphone_evidence_after_hardware_firewall";
}

export interface CognitiveSafeAudioPacket {
  readonly audio_packet_id: Ref;
  readonly microphone_array_id: Ref;
  readonly timestamp_interval: TimestampInterval;
  readonly waveform_ref?: Ref;
  readonly event_candidates: readonly CognitiveSafeSoundEventCandidate[];
  readonly dominant_bearing_estimate?: AcousticBearingEstimate;
  readonly intensity_estimate: AcousticIntensity;
  readonly self_generated_likelihood: number;
  readonly health_status: AudioHealthStatus;
  readonly prompt_safe_summary: string;
  readonly hidden_fields_removed: readonly string[];
}

export interface CognitiveSafeSoundEventCandidate {
  readonly sound_event_id: Ref;
  readonly acoustic_class: AcousticEventClass;
  readonly source_time_s: number;
  readonly confidence: number;
  readonly expectedness: SoundEventCandidate["expectedness"];
  readonly intensity_estimate: AcousticIntensity;
  readonly bearing_estimate?: AcousticBearingEstimate;
  readonly self_generated_likelihood: number;
  readonly route_hint: AcousticRouteHint;
  readonly prompt_safe_summary: string;
}

export interface AcousticWorldServiceConfig {
  readonly declared_microphones: readonly MicrophoneArrayDescriptor[];
  readonly default_policy?: Partial<AcousticPolicy>;
}

export class AcousticWorldServiceError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "AcousticWorldServiceError";
    this.issues = issues;
  }
}

/**
 * Converts physics/contact evidence into embodied microphone packets.
 *
 * All source localization math is approximate by design: audio may guide
 * attention or verification, but it never becomes a hidden exact pose channel.
 */
export class AcousticWorldService {
  private readonly microphonesById: ReadonlyMap<Ref, MicrophoneArrayDescriptor>;
  private readonly defaultPolicy: AcousticPolicy;
  private readonly eventLog: SoundEventCandidate[] = [];

  public constructor(config: AcousticWorldServiceConfig) {
    const issues: ValidationIssue[] = [];
    const microphones = new Map<Ref, MicrophoneArrayDescriptor>();
    for (const microphone of config.declared_microphones) {
      validateMicrophoneArrayDescriptor(microphone, issues, "$.declared_microphones");
      if (microphones.has(microphone.microphone_array_id)) {
        issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", "$.declared_microphones.microphone_array_id", "Microphone array ids must be unique.", "Rename or remove the duplicate microphone array."));
      }
      microphones.set(microphone.microphone_array_id, freezeMicrophone(microphone));
    }
    if (microphones.size === 0) {
      issues.push(makeIssue("error", "UndeclaredMicrophone", "$.declared_microphones", "At least one microphone array must be declared before producing audio packets.", "Register the microphone hardware descriptor from the virtual hardware spec."));
    }

    this.defaultPolicy = Object.freeze({
      acoustic_policy_ref: config.default_policy?.acoustic_policy_ref ?? "default_acoustic_policy",
      cognitive_bound: config.default_policy?.cognitive_bound ?? true,
      include_waveform_ref: config.default_policy?.include_waveform_ref ?? false,
      sample_window_s: config.default_policy?.sample_window_s ?? DEFAULT_AUDIO_WINDOW_S,
      max_audio_sync_delta_s: config.default_policy?.max_audio_sync_delta_s ?? DEFAULT_MAX_AUDIO_SYNC_DELTA_S,
      max_bearing_uncertainty_rad: config.default_policy?.max_bearing_uncertainty_rad ?? DEFAULT_AMBIGUITY_ANGLE_RAD,
      min_event_confidence: config.default_policy?.min_event_confidence ?? DEFAULT_EVENT_CONFIDENCE_FLOOR,
      ambient_noise_db_spl: config.default_policy?.ambient_noise_db_spl ?? 28,
      self_noise_body_ref_patterns: freezeArray(config.default_policy?.self_noise_body_ref_patterns ?? ["foot", "paw", "hand", "gripper", "actuator", "body"]),
      block_source_refs_in_cognitive_packet: config.default_policy?.block_source_refs_in_cognitive_packet ?? true,
      ambiguous_event_route: config.default_policy?.ambiguous_event_route ?? "reobserve",
    });
    validateAcousticPolicy(this.defaultPolicy, issues, "$.default_policy");

    if (issues.some((issue) => issue.severity === "error")) {
      throw new AcousticWorldServiceError("Acoustic world service configuration failed validation.", issues);
    }

    this.microphonesById = microphones;
  }

  /**
   * Generates a microphone packet from recent contact and movement events.
   *
   * The returned packet may contain QA-only event metadata. Use
   * `redactForCognition` before prompt assembly or model-facing routing.
   */
  public generateAcousticSensorPacket(input: {
    readonly contact_events: readonly ContactEvent[];
    readonly movement_events?: readonly MovementAcousticEvent[];
    readonly microphone_descriptor: MicrophoneArrayDescriptor | Ref;
    readonly acoustic_policy?: Partial<AcousticPolicy>;
    readonly world_snapshot: PhysicsWorldSnapshot;
    readonly sample_time_s?: number;
  }): AudioPacket {
    validateSnapshot(input.world_snapshot);
    const microphone = typeof input.microphone_descriptor === "string"
      ? this.requireMicrophone(input.microphone_descriptor)
      : this.resolveDeclaredMicrophone(input.microphone_descriptor);
    const policy = this.mergePolicy(input.acoustic_policy ?? {});
    const issues: ValidationIssue[] = [];
    validateAcousticPolicy(policy, issues, "$.acoustic_policy");
    validateMicrophoneArrayDescriptor(microphone, issues, "$.microphone_descriptor");

    if (policy.cognitive_bound && !microphone.declared_for_cognitive_use) {
      issues.push(makeIssue("error", "UndeclaredMicrophone", "$.microphone_descriptor.declared_for_cognitive_use", "Microphone array is not declared for cognitive-bound evidence.", "Use a declared cognitive microphone array or keep packet QA-only."));
    }

    const sampleTimeS = input.sample_time_s ?? input.world_snapshot.timestamp_s;
    const synchronization = buildSynchronizationRecord(input.world_snapshot, sampleTimeS, policy.max_audio_sync_delta_s);
    if (synchronization.status === "mismatch") {
      issues.push(makeIssue("error", "AudioTimingMismatch", "$.sample_time_s", "Audio sample time does not correspond to the physics snapshot interval.", "Capture audio from the current coherent physics snapshot."));
    }

    const microphoneWorldTransform = resolveMicrophoneWorldTransform(input.world_snapshot, microphone);
    const channelWorldPositions = microphone.channels.map((channel) => Object.freeze({
      channel,
      world_position_m: transformPoint(microphoneWorldTransform, channel.local_position_m),
    }));
    const candidates = [
      ...input.contact_events.map((event) => this.createCandidateFromContact(event, microphone, policy, channelWorldPositions, microphoneWorldTransform)),
      ...(input.movement_events ?? []).map((event) => this.createCandidateFromMovement(event, microphone, policy, channelWorldPositions, microphoneWorldTransform)),
    ]
      .filter((candidate): candidate is SoundEventCandidate => candidate !== undefined)
      .filter((candidate) => candidate.confidence >= policy.min_event_confidence)
      .sort(compareCandidates);

    for (const event of input.contact_events) {
      validateContactEvent(event, issues);
    }
    for (const event of input.movement_events ?? []) {
      validateMovementEvent(event, issues);
    }
    const dominant = selectDominantCandidate(candidates);
    if (dominant !== undefined && dominant.bearing_estimate !== undefined && dominant.bearing_estimate.angular_uncertainty_rad > policy.max_bearing_uncertainty_rad) {
      issues.push(makeIssue("warning", "AudioEventAmbiguous", "$.event_candidates", "Dominant audio bearing is too uncertain for direct localization.", "Route to reobserve or verification before acting."));
    }

    const blocking = issues.some((issue) => issue.severity === "error");
    if (blocking) {
      throw new AcousticWorldServiceError("Acoustic packet generation failed validation.", freezeArray(issues));
    }

    const packetStatus: AudioPacketStatus = candidates.length === 0
      ? "silent"
      : synchronization.status === "degraded"
        ? "degraded"
        : "captured";
    const intensity = summarizeIntensity(candidates);
    const timestampInterval = buildTimestampInterval(sampleTimeS, policy.sample_window_s);
    const waveformRef = policy.include_waveform_ref
      ? `waveform_${microphone.microphone_array_id}_${input.world_snapshot.physics_tick}_${computeDeterminismHash(candidates.map((candidate) => candidate.determinism_hash)).slice(0, 8)}`
      : undefined;
    const selfGeneratedLikelihood = candidates.length === 0
      ? 0
      : round6(candidates.reduce((sum, candidate) => sum + candidate.self_generated_likelihood, 0) / candidates.length);
    const packetBase = {
      schema_version: ACOUSTIC_WORLD_SERVICE_SCHEMA_VERSION,
      audio_packet_id: `audio_packet_${microphone.microphone_array_id}_${input.world_snapshot.physics_tick}_${computeDeterminismHash([sampleTimeS, candidates.map((candidate) => candidate.sound_event_id)]).slice(0, 8)}`,
      microphone_array_id: microphone.microphone_array_id,
      timestamp_interval: timestampInterval,
      waveform_ref: waveformRef,
      event_candidates: freezeArray(candidates),
      dominant_bearing_estimate: dominant?.bearing_estimate,
      intensity_estimate: intensity,
      self_generated_likelihood: selfGeneratedLikelihood,
      health_status: packetStatus === "degraded" ? "degraded" as const : microphone.health_status ?? "nominal" as const,
      packet_status: packetStatus,
      synchronization,
      source_redaction_status: policy.cognitive_bound ? "source_refs_stripped_for_cognition" as const : "qa_internal_only" as const,
      issue_count: issues.length,
      issues: freezeArray(issues),
      cognitive_visibility: "microphone_evidence_after_hardware_firewall" as const,
    };
    const packet = Object.freeze({
      ...packetBase,
      determinism_hash: computeDeterminismHash(packetBase),
    });
    this.eventLog.push(...candidates);
    return packet;
  }

  /**
   * Returns deterministic QA/observability events retained by the service.
   */
  public getEventLog(): readonly SoundEventCandidate[] {
    return freezeArray(this.eventLog);
  }

  /**
   * Converts an audio packet into Gemini-safe microphone evidence.
   */
  public redactForCognition(packet: AudioPacket): CognitiveSafeAudioPacket {
    if (packet.packet_status === "blocked") {
      throw new AcousticWorldServiceError("Blocked audio packets cannot be exposed to cognition.", [
        makeIssue("error", "SourceRefNotRedacted", "$.packet_status", "Audio packet is blocked from cognitive use.", "Regenerate with a cognitive-bound redaction policy."),
      ]);
    }
    const hiddenLeak = packet.event_candidates.some((candidate) => !candidate.hidden_source_ref_redacted);
    if (hiddenLeak || packet.source_redaction_status !== "source_refs_stripped_for_cognition") {
      throw new AcousticWorldServiceError("Audio packet source refs are not redacted for cognition.", [
        makeIssue("error", "SourceRefNotRedacted", "$.event_candidates", "Cognitive audio packets must strip backend source refs.", "Use the cognitive redaction path before prompt assembly."),
      ]);
    }
    const safeCandidates = packet.event_candidates.map(redactCandidateForCognition);
    return Object.freeze({
      audio_packet_id: packet.audio_packet_id,
      microphone_array_id: packet.microphone_array_id,
      timestamp_interval: packet.timestamp_interval,
      waveform_ref: packet.waveform_ref,
      event_candidates: freezeArray(safeCandidates),
      dominant_bearing_estimate: packet.dominant_bearing_estimate,
      intensity_estimate: packet.intensity_estimate,
      self_generated_likelihood: packet.self_generated_likelihood,
      health_status: packet.health_status,
      prompt_safe_summary: buildPacketPromptSafeSummary(packet),
      hidden_fields_removed: freezeArray([
        "qa_source_metadata.internal_source_refs",
        "qa_source_metadata.source_position_m",
        "qa_source_metadata.audio_profile_refs",
        "qa_source_metadata.contact_event_ref",
        "qa_source_metadata.movement_event_ref",
        "channel_samples",
        "synchronization.snapshot_ref",
        "physics_tick",
        "determinism_hash",
      ]),
    });
  }

  private requireMicrophone(arrayId: Ref): MicrophoneArrayDescriptor {
    const microphone = this.microphonesById.get(arrayId);
    if (microphone === undefined) {
      throw new AcousticWorldServiceError(`Microphone array ${arrayId} is not declared.`, [
        makeIssue("error", "UndeclaredMicrophone", "$.microphone_array_id", "Microphone array must be declared hardware before audio packet generation.", "Register the microphone descriptor in AcousticWorldServiceConfig."),
      ]);
    }
    return microphone;
  }

  private resolveDeclaredMicrophone(candidate: MicrophoneArrayDescriptor): MicrophoneArrayDescriptor {
    const declared = this.requireMicrophone(candidate.microphone_array_id);
    if (computeDeterminismHash(declared) !== computeDeterminismHash(freezeMicrophone(candidate))) {
      throw new AcousticWorldServiceError(`Microphone array ${candidate.microphone_array_id} differs from declared hardware.`, [
        makeIssue("error", "MicrophoneDescriptorInvalid", "$.microphone_descriptor", "Runtime microphone descriptor must match declared hardware.", "Use the registered microphone descriptor or update the hardware manifest."),
      ]);
    }
    return declared;
  }

  private mergePolicy(override: Partial<AcousticPolicy>): AcousticPolicy {
    return Object.freeze({
      ...this.defaultPolicy,
      ...override,
      acoustic_policy_ref: override.acoustic_policy_ref ?? this.defaultPolicy.acoustic_policy_ref,
      cognitive_bound: override.cognitive_bound ?? this.defaultPolicy.cognitive_bound,
      include_waveform_ref: override.include_waveform_ref ?? this.defaultPolicy.include_waveform_ref,
      sample_window_s: override.sample_window_s ?? this.defaultPolicy.sample_window_s,
      max_audio_sync_delta_s: override.max_audio_sync_delta_s ?? this.defaultPolicy.max_audio_sync_delta_s,
      max_bearing_uncertainty_rad: override.max_bearing_uncertainty_rad ?? this.defaultPolicy.max_bearing_uncertainty_rad,
      min_event_confidence: override.min_event_confidence ?? this.defaultPolicy.min_event_confidence,
      ambient_noise_db_spl: override.ambient_noise_db_spl ?? this.defaultPolicy.ambient_noise_db_spl,
      self_noise_body_ref_patterns: freezeArray(override.self_noise_body_ref_patterns ?? this.defaultPolicy.self_noise_body_ref_patterns),
      block_source_refs_in_cognitive_packet: override.block_source_refs_in_cognitive_packet ?? this.defaultPolicy.block_source_refs_in_cognitive_packet,
      ambiguous_event_route: override.ambiguous_event_route ?? this.defaultPolicy.ambiguous_event_route,
    });
  }

  private createCandidateFromContact(
    event: ContactEvent,
    microphone: MicrophoneArrayDescriptor,
    policy: AcousticPolicy,
    channelWorldPositions: readonly { readonly channel: MicrophoneChannelDescriptor; readonly world_position_m: Vector3 }[],
    microphoneWorldTransform: Transform,
  ): SoundEventCandidate | undefined {
    const acousticClass = classifyContactSound(event);
    if (acousticClass === undefined || event.audio_candidate?.intensity === "silent") {
      return undefined;
    }
    const sourcePosition = event.impulse_summary.mean_contact_point_m;
    const channelSamples = computeChannelSamples(sourcePosition, event.timestamp_s, baseSplForContact(event), policy, channelWorldPositions);
    const bearing = estimateBearing(sourcePosition, microphoneWorldTransform, channelSamples, policy);
    const selfLikelihood = classifySelfGeneratedLikelihood(event.internal_body_refs, policy);
    const confidence = computeContactConfidence(event, channelSamples, bearing, selfLikelihood);
    const expectedness: SoundEventCandidate["expectedness"] = selfLikelihood >= 0.7
      ? "expected_self_noise"
      : event.contact_class === "resting_support" || event.contact_class === "grasp"
        ? "expected_task_sound"
        : event.safety_relevance === "none"
          ? "ambiguous"
          : "unexpected";
    const intensity = intensityFromSpl(maxSpl(channelSamples));
    const route = selectRoute(acousticClass, intensity, expectedness, event.safety_relevance, bearing, policy);
    const candidateBase = {
      sound_event_id: `sound_${event.contact_event_id}_${computeDeterminismHash([microphone.microphone_array_id, event.timestamp_s]).slice(0, 8)}`,
      source_kind: "contact" as const,
      acoustic_class: acousticClass,
      source_time_s: event.timestamp_s,
      confidence,
      expectedness,
      intensity_estimate: intensity,
      bearing_estimate: bearing,
      self_generated_likelihood: selfLikelihood,
      route_hint: route,
      prompt_safe_summary: buildEventPromptSafeSummary(acousticClass, intensity, route, expectedness),
      hidden_source_ref_redacted: policy.block_source_refs_in_cognitive_packet,
      qa_source_metadata: Object.freeze({
        internal_source_refs: freezeArray(event.internal_body_refs),
        source_position_m: freezeVector3(sourcePosition),
        audio_profile_refs: freezeArray(event.audio_candidate?.internal_audio_profile_refs ?? event.material_pair.acoustic_profile_refs),
        contact_event_ref: event.contact_event_id,
        hidden_truth_visibility: "runtime_qa_validator_only" as const,
      }),
      channel_samples: freezeArray(channelSamples),
    };
    return Object.freeze({
      ...candidateBase,
      determinism_hash: computeDeterminismHash(candidateBase),
    });
  }

  private createCandidateFromMovement(
    event: MovementAcousticEvent,
    microphone: MicrophoneArrayDescriptor,
    policy: AcousticPolicy,
    channelWorldPositions: readonly { readonly channel: MicrophoneChannelDescriptor; readonly world_position_m: Vector3 }[],
    microphoneWorldTransform: Transform,
  ): SoundEventCandidate | undefined {
    const speed = vectorNorm(event.velocity_m_per_s);
    const acceleration = event.acceleration_m_per_s2 === undefined ? 0 : vectorNorm(event.acceleration_m_per_s2);
    const baseSpl = baseSplForMovement(event.movement_class, speed, acceleration, event.intensity_hint);
    if (baseSpl <= policy.ambient_noise_db_spl + 1) {
      return undefined;
    }
    const channelSamples = computeChannelSamples(event.source_position_m, event.timestamp_s, baseSpl, policy, channelWorldPositions);
    const bearing = estimateBearing(event.source_position_m, microphoneWorldTransform, channelSamples, policy);
    const selfLikelihood = event.source_kind === "self_motion" || event.movement_class === "actuator"
      ? 0.9
      : event.internal_source_ref === undefined
        ? 0.2
        : classifySelfGeneratedLikelihood([event.internal_source_ref], policy);
    const acousticClass = classifyMovementSound(event.movement_class, speed, acceleration, selfLikelihood);
    const confidence = computeMovementConfidence(speed, acceleration, channelSamples, bearing, selfLikelihood);
    const intensity = intensityFromSpl(maxSpl(channelSamples));
    const expectedness: SoundEventCandidate["expectedness"] = selfLikelihood >= 0.7 ? "expected_self_noise" : event.source_kind === "disturbance" ? "unexpected" : "ambiguous";
    const route = selectRoute(acousticClass, intensity, expectedness, event.source_kind === "disturbance" ? "warning" : "none", bearing, policy);
    const candidateBase = {
      sound_event_id: `sound_${event.movement_event_id}_${computeDeterminismHash([microphone.microphone_array_id, event.timestamp_s, speed]).slice(0, 8)}`,
      source_kind: event.source_kind,
      acoustic_class: acousticClass,
      source_time_s: event.timestamp_s,
      confidence,
      expectedness,
      intensity_estimate: intensity,
      bearing_estimate: bearing,
      self_generated_likelihood: selfLikelihood,
      route_hint: route,
      prompt_safe_summary: buildEventPromptSafeSummary(acousticClass, intensity, route, expectedness),
      hidden_source_ref_redacted: policy.block_source_refs_in_cognitive_packet,
      qa_source_metadata: Object.freeze({
        internal_source_refs: freezeArray(event.internal_source_ref === undefined ? [] : [event.internal_source_ref]),
        source_position_m: freezeVector3(event.source_position_m),
        audio_profile_refs: freezeArray(event.audio_profile_ref === undefined ? [] : [event.audio_profile_ref]),
        movement_event_ref: event.movement_event_id,
        hidden_truth_visibility: "runtime_qa_validator_only" as const,
      }),
      channel_samples: freezeArray(channelSamples),
    };
    return Object.freeze({
      ...candidateBase,
      determinism_hash: computeDeterminismHash(candidateBase),
    });
  }
}

export function generateAcousticSensorPacket(
  contactEvents: readonly ContactEvent[],
  microphoneDescriptor: MicrophoneArrayDescriptor,
  acousticPolicy: Partial<AcousticPolicy>,
  worldSnapshot: PhysicsWorldSnapshot,
): AudioPacket {
  return new AcousticWorldService({ declared_microphones: [microphoneDescriptor] }).generateAcousticSensorPacket({
    contact_events: contactEvents,
    microphone_descriptor: microphoneDescriptor.microphone_array_id,
    acoustic_policy: acousticPolicy,
    world_snapshot: worldSnapshot,
  });
}

function classifyContactSound(event: ContactEvent): AcousticEventClass | undefined {
  const fromCandidate = event.audio_candidate?.acoustic_class;
  if (fromCandidate === "none") {
    return undefined;
  }
  if (fromCandidate === "hard_impact") {
    return "hard_impact";
  }
  if (fromCandidate === "collision") {
    return "collision";
  }
  if (fromCandidate === "scrape") {
    return "scrape";
  }
  if (fromCandidate === "slip_sound") {
    return "slip";
  }
  if (fromCandidate === "rolling") {
    return "rolling";
  }
  if (event.contact_class === "self_collision") {
    return "collision";
  }
  if (event.contact_class === "slip") {
    return "slip";
  }
  if (event.contact_class === "tool" && event.relative_motion_summary === "sliding") {
    return "scrape";
  }
  if (event.contact_class === "unplanned_collision") {
    return event.impulse_summary.impulse_category === "high" || event.impulse_summary.impulse_category === "impossible" ? "hard_impact" : "collision";
  }
  if (event.relative_motion_summary === "rolling") {
    return "rolling";
  }
  if (event.impulse_summary.impulse_category === "none") {
    return undefined;
  }
  return event.impulse_summary.impulse_category === "high" || event.impulse_summary.impulse_category === "impossible" ? "impact" : "soft_contact";
}

function classifyMovementSound(movementClass: MovementAcousticEvent["movement_class"], speed: number, acceleration: number, selfLikelihood: number): AcousticEventClass {
  if (selfLikelihood >= 0.8 && movementClass === "actuator") {
    return "self_noise";
  }
  if (movementClass === "roll") {
    return "rolling";
  }
  if (movementClass === "slide" || movementClass === "drag") {
    return "scrape";
  }
  if (movementClass === "drop" || acceleration > 8 || speed > 1.2) {
    return "impact";
  }
  if (movementClass === "voice") {
    return "ambiguous";
  }
  return "ambiguous";
}

function baseSplForContact(event: ContactEvent): number {
  const impulse = event.impulse_summary.normal_impulse_n_s;
  const tangent = event.impulse_summary.tangential_impulse_n_s;
  const scrapeBonus = event.relative_motion_summary === "sliding" || event.relative_motion_summary === "rolling" ? 6 : 0;
  const safetyBonus = event.safety_relevance === "safe_hold" ? 12 : event.safety_relevance === "warning" ? 7 : 0;
  const profileBonus = event.material_pair.acoustic_profile_refs.length > 0 ? 3 : 0;
  return clamp(34 + 18 * Math.log10(1 + impulse * 8 + tangent * 4) + scrapeBonus + safetyBonus + profileBonus, 24, 112);
}

function baseSplForMovement(
  movementClass: MovementAcousticEvent["movement_class"],
  speed: number,
  acceleration: number,
  hint: AcousticIntensity | undefined,
): number {
  const hintBoost: Readonly<Record<AcousticIntensity, number>> = {
    silent: -30,
    low: 0,
    medium: 10,
    high: 20,
    blocking: 32,
  };
  const classBoost = movementClass === "drop"
    ? 18
    : movementClass === "drag"
      ? 10
      : movementClass === "slide"
        ? 8
        : movementClass === "roll"
          ? 6
          : movementClass === "actuator"
            ? 4
            : 0;
  return clamp(30 + classBoost + 16 * Math.log10(1 + speed) + 5 * Math.log10(1 + acceleration) + (hint === undefined ? 0 : hintBoost[hint]), 0, 112);
}

function computeChannelSamples(
  sourcePosition: Vector3,
  sourceTimeS: number,
  baseSplDb: number,
  policy: AcousticPolicy,
  channelWorldPositions: readonly { readonly channel: MicrophoneChannelDescriptor; readonly world_position_m: Vector3 }[],
): readonly ChannelAcousticSample[] {
  const arrivals = channelWorldPositions.map((entry) => {
    const distance = Math.max(0.01, vectorNorm(subtractVector3(sourcePosition, entry.world_position_m)));
    const propagationDelayS = distance / SPEED_OF_SOUND_M_PER_S;
    const attenuationDb = 20 * Math.log10(distance / REFERENCE_DISTANCE_M);
    const estimatedSpl = baseSplDb - attenuationDb + entry.channel.gain_db;
    const signalToNoise = estimatedSpl - Math.max(policy.ambient_noise_db_spl, entry.channel.noise_floor_db_spl);
    return Object.freeze({
      channel_id: entry.channel.channel_id,
      channel_index: entry.channel.channel_index,
      arrival_time_s: sourceTimeS + propagationDelayS,
      raw_arrival_time_s: sourceTimeS + propagationDelayS,
      estimated_spl_db: clamp(estimatedSpl, 0, 130),
      normalized_amplitude: splToNormalizedAmplitude(estimatedSpl),
      signal_to_noise_db: signalToNoise,
    });
  });
  const earliest = Math.min(...arrivals.map((sample) => sample.raw_arrival_time_s));
  return freezeArray(arrivals
    .map((sample) => Object.freeze({
      channel_id: sample.channel_id,
      channel_index: sample.channel_index,
      arrival_time_s: round9(sample.arrival_time_s),
      relative_delay_s: round9(sample.raw_arrival_time_s - earliest),
      estimated_spl_db: round3(sample.estimated_spl_db),
      normalized_amplitude: round6(sample.normalized_amplitude),
      signal_to_noise_db: round3(sample.signal_to_noise_db),
    }))
    .sort((a, b) => a.channel_index - b.channel_index));
}

function estimateBearing(
  sourcePosition: Vector3,
  microphoneWorldTransform: Transform,
  channelSamples: readonly ChannelAcousticSample[],
  policy: AcousticPolicy,
): AcousticBearingEstimate | undefined {
  if (channelSamples.length === 0) {
    return undefined;
  }
  const inverse = invertRigidTransform(microphoneWorldTransform);
  const localSource = transformPoint(inverse, sourcePosition);
  const distance = Math.max(0.01, vectorNorm(localSource));
  const azimuth = Math.atan2(localSource[1], localSource[0]);
  const elevation = Math.atan2(localSource[2], Math.sqrt(localSource[0] * localSource[0] + localSource[1] * localSource[1]));
  const bestSnr = Math.max(...channelSamples.map((sample) => sample.signal_to_noise_db));
  const delaySpread = Math.max(...channelSamples.map((sample) => sample.relative_delay_s)) - Math.min(...channelSamples.map((sample) => sample.relative_delay_s));
  const confidence = clamp01((bestSnr + 6) / 36) * clamp01(1 - Math.max(0, delaySpread - 0.001) / 0.006);
  const uncertainty = clamp(policy.max_bearing_uncertainty_rad * (1.15 - confidence) + Math.min(0.35, distance * 0.015), 0.03, Math.PI);
  return Object.freeze({
    frame_ref: "microphone_array" as const,
    azimuth_rad: round6(azimuth),
    elevation_rad: round6(elevation),
    distance_estimate_m: round3(distance),
    angular_uncertainty_rad: round6(uncertainty),
    range_uncertainty_m: round3(Math.max(0.05, distance * (0.15 + (1 - confidence) * 0.5))),
    confidence: round6(confidence),
    estimate_basis: "interaural_time_difference_and_level_attenuation" as const,
  });
}

function computeContactConfidence(
  event: ContactEvent,
  channelSamples: readonly ChannelAcousticSample[],
  bearing: AcousticBearingEstimate | undefined,
  selfLikelihood: number,
): number {
  const impulseWeight = event.impulse_summary.impulse_category === "impossible" || event.impulse_summary.impulse_category === "high"
    ? 0.36
    : event.impulse_summary.impulse_category === "moderate"
      ? 0.24
      : event.impulse_summary.impulse_category === "low"
        ? 0.12
        : 0;
  const snrWeight = clamp01((maxSnr(channelSamples) + 3) / 30) * 0.34;
  const bearingWeight = (bearing?.confidence ?? 0) * 0.2;
  const selfPenalty = selfLikelihood >= 0.8 ? 0.15 : 0;
  return round6(clamp(0.08 + impulseWeight + snrWeight + bearingWeight - selfPenalty, DEFAULT_EVENT_CONFIDENCE_FLOOR, DEFAULT_EVENT_CONFIDENCE_CEILING));
}

function computeMovementConfidence(
  speed: number,
  acceleration: number,
  channelSamples: readonly ChannelAcousticSample[],
  bearing: AcousticBearingEstimate | undefined,
  selfLikelihood: number,
): number {
  const motionWeight = clamp01((speed + acceleration * 0.1) / 2) * 0.35;
  const snrWeight = clamp01((maxSnr(channelSamples) + 3) / 30) * 0.35;
  const bearingWeight = (bearing?.confidence ?? 0) * 0.18;
  const selfPenalty = selfLikelihood >= 0.8 ? 0.1 : 0;
  return round6(clamp(0.08 + motionWeight + snrWeight + bearingWeight - selfPenalty, DEFAULT_EVENT_CONFIDENCE_FLOOR, DEFAULT_EVENT_CONFIDENCE_CEILING));
}

function classifySelfGeneratedLikelihood(sourceRefs: readonly Ref[], policy: AcousticPolicy): number {
  if (sourceRefs.length === 0) {
    return 0.15;
  }
  const matches = sourceRefs.filter((sourceRef) => policy.self_noise_body_ref_patterns.some((pattern) => sourceRef.toLowerCase().includes(pattern.toLowerCase()))).length;
  return round6(clamp(0.12 + matches / sourceRefs.length * 0.82, 0, 0.96));
}

function selectRoute(
  acousticClass: AcousticEventClass,
  intensity: AcousticIntensity,
  expectedness: SoundEventCandidate["expectedness"],
  safety: SafetyRelevance,
  bearing: AcousticBearingEstimate | undefined,
  policy: AcousticPolicy,
): AcousticRouteHint {
  if (intensity === "blocking" || safety === "safe_hold") {
    return "safe_hold";
  }
  if (safety === "warning" || acousticClass === "hard_impact" || acousticClass === "collision") {
    return "verify";
  }
  if (acousticClass === "slip" || acousticClass === "scrape") {
    return "oops";
  }
  if (expectedness === "expected_self_noise") {
    return "ignore";
  }
  if (bearing === undefined || bearing.angular_uncertainty_rad > policy.max_bearing_uncertainty_rad) {
    return policy.ambiguous_event_route;
  }
  if (intensity === "medium" || intensity === "high") {
    return "reobserve";
  }
  return expectedness === "ambiguous" ? "note" : "reobserve";
}

function redactCandidateForCognition(candidate: SoundEventCandidate): CognitiveSafeSoundEventCandidate {
  return Object.freeze({
    sound_event_id: candidate.sound_event_id,
    acoustic_class: candidate.acoustic_class,
    source_time_s: candidate.source_time_s,
    confidence: candidate.confidence,
    expectedness: candidate.expectedness,
    intensity_estimate: candidate.intensity_estimate,
    bearing_estimate: candidate.bearing_estimate,
    self_generated_likelihood: candidate.self_generated_likelihood,
    route_hint: candidate.route_hint,
    prompt_safe_summary: candidate.prompt_safe_summary,
  });
}

function selectDominantCandidate(candidates: readonly SoundEventCandidate[]): SoundEventCandidate | undefined {
  return [...candidates].sort((a, b) => {
    const intensityDelta = intensityRank(b.intensity_estimate) - intensityRank(a.intensity_estimate);
    if (intensityDelta !== 0) {
      return intensityDelta;
    }
    return b.confidence - a.confidence || a.sound_event_id.localeCompare(b.sound_event_id);
  })[0];
}

function summarizeIntensity(candidates: readonly SoundEventCandidate[]): AcousticIntensity {
  if (candidates.length === 0) {
    return "silent";
  }
  return candidates.map((candidate) => candidate.intensity_estimate).sort((a, b) => intensityRank(b) - intensityRank(a))[0];
}

function intensityFromSpl(splDb: number): AcousticIntensity {
  if (splDb < 32) {
    return "silent";
  }
  if (splDb < 48) {
    return "low";
  }
  if (splDb < 68) {
    return "medium";
  }
  if (splDb < 88) {
    return "high";
  }
  return "blocking";
}

function intensityRank(intensity: AcousticIntensity): number {
  if (intensity === "blocking") {
    return 4;
  }
  if (intensity === "high") {
    return 3;
  }
  if (intensity === "medium") {
    return 2;
  }
  if (intensity === "low") {
    return 1;
  }
  return 0;
}

function maxSpl(samples: readonly ChannelAcousticSample[]): number {
  return samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.estimated_spl_db));
}

function maxSnr(samples: readonly ChannelAcousticSample[]): number {
  return samples.length === 0 ? -Number.POSITIVE_INFINITY : Math.max(...samples.map((sample) => sample.signal_to_noise_db));
}

function compareCandidates(a: SoundEventCandidate, b: SoundEventCandidate): number {
  return a.source_time_s - b.source_time_s || intensityRank(b.intensity_estimate) - intensityRank(a.intensity_estimate) || a.sound_event_id.localeCompare(b.sound_event_id);
}

function buildSynchronizationRecord(snapshot: PhysicsWorldSnapshot, sampleTimeS: number, toleranceS: number): AcousticSynchronizationRecord {
  const deltaS = Math.abs(sampleTimeS - snapshot.timestamp_s);
  const status: AudioSynchronizationStatus = deltaS <= toleranceS * 0.25
    ? "synchronized"
    : deltaS <= toleranceS
      ? "degraded"
      : "mismatch";
  const recordBase = {
    snapshot_ref: snapshot.snapshot_ref,
    physics_tick: snapshot.physics_tick,
    physics_timestamp_s: snapshot.timestamp_s,
    audio_sample_time_s: sampleTimeS,
    audio_event_latency_ms: secondsToMilliseconds(deltaS),
    status,
  };
  return Object.freeze({
    ...recordBase,
    determinism_hash: computeDeterminismHash(recordBase),
  });
}

function resolveMicrophoneWorldTransform(snapshot: PhysicsWorldSnapshot, microphone: MicrophoneArrayDescriptor): Transform {
  if (microphone.mount_frame_ref === "W" || microphone.mount_frame_ref === snapshot.world_ref) {
    return freezeTransform({
      frame_ref: "W",
      position_m: microphone.mount_transform.position_m,
      orientation_xyzw: microphone.mount_transform.orientation_xyzw,
    });
  }
  const mountObject = snapshot.object_states.find((object) => object.object_ref === microphone.mount_frame_ref);
  if (mountObject === undefined) {
    throw new AcousticWorldServiceError(`Microphone mount frame ${microphone.mount_frame_ref} is not present in snapshot ${snapshot.snapshot_ref}.`, [
      makeIssue("error", "UndeclaredMicrophone", "$.microphone_descriptor.mount_frame_ref", "Microphone mount frame must be world or a body/object present in the physics snapshot.", "Declare the mount frame in the embodiment sensor table and include it in snapshots."),
    ]);
  }
  return composeTransforms(mountObject.transform, microphone.mount_transform, "W");
}

function buildTimestampInterval(sampleTimeS: number, windowS: number): TimestampInterval {
  const half = windowS / 2;
  return Object.freeze({
    start_s: Math.max(0, sampleTimeS - half),
    end_s: sampleTimeS + half,
  });
}

function buildPacketPromptSafeSummary(packet: AudioPacket): string {
  if (packet.packet_status === "silent") {
    return "No task-relevant microphone event was detected in the synchronized audio window.";
  }
  if (packet.intensity_estimate === "blocking") {
    return "A high-risk microphone event was detected; the robot should pause or verify before continuing.";
  }
  if (packet.packet_status === "degraded") {
    return "A microphone event was detected with degraded timing; re-observation is recommended before acting.";
  }
  return "Synchronized microphone evidence is available with source identity redacted.";
}

function buildEventPromptSafeSummary(
  acousticClass: AcousticEventClass,
  intensity: AcousticIntensity,
  route: AcousticRouteHint,
  expectedness: SoundEventCandidate["expectedness"],
): string {
  if (route === "safe_hold") {
    return `A ${intensity} ${acousticClass} sound suggests safety review before motion continues.`;
  }
  if (route === "oops") {
    return `A ${acousticClass} sound may indicate task failure evidence and should be checked with visual or tactile confirmation.`;
  }
  if (route === "verify") {
    return `A ${intensity} ${acousticClass} sound should trigger verification before declaring task progress.`;
  }
  if (route === "reobserve") {
    return `A ${acousticClass} sound was heard; reobserve toward the estimated direction before acting.`;
  }
  if (expectedness === "expected_self_noise") {
    return "The sound is likely self-generated robot noise and should not trigger external investigation by itself.";
  }
  return "A low-confidence microphone cue was noted as context only.";
}

function validateSnapshot(snapshot: PhysicsWorldSnapshot): void {
  const issues: ValidationIssue[] = [];
  validateRef(snapshot.snapshot_ref, issues, "$.snapshot_ref", "SnapshotInvalid");
  validateRef(snapshot.world_ref, issues, "$.world_ref", "SnapshotInvalid");
  if (!Number.isInteger(snapshot.physics_tick) || snapshot.physics_tick < 0) {
    issues.push(makeIssue("error", "SnapshotInvalid", "$.physics_tick", "Physics tick must be a nonnegative integer.", "Use snapshots emitted by SimulationWorldService."));
  }
  validateNonNegativeFinite(snapshot.timestamp_s, issues, "$.timestamp_s", "SnapshotInvalid");
  if (issues.some((issue) => issue.severity === "error")) {
    throw new AcousticWorldServiceError("Physics snapshot is invalid for acoustic sampling.", issues);
  }
}

function validateMicrophoneArrayDescriptor(microphone: MicrophoneArrayDescriptor, issues: ValidationIssue[], path: string): void {
  validateRef(microphone.microphone_array_id, issues, `${path}.microphone_array_id`, "MicrophoneDescriptorInvalid");
  validateRef(microphone.mount_frame_ref, issues, `${path}.mount_frame_ref`, "MicrophoneDescriptorInvalid");
  validateTransform(microphone.mount_transform, issues, `${path}.mount_transform`, "MicrophoneDescriptorInvalid");
  validateRef(microphone.calibration_ref, issues, `${path}.calibration_ref`, "MicrophoneDescriptorInvalid");
  validatePositiveFinite(microphone.sample_rate_hz, issues, `${path}.sample_rate_hz`, "MicrophoneDescriptorInvalid");
  validatePositiveFinite(microphone.packet_hz, issues, `${path}.packet_hz`, "MicrophoneDescriptorInvalid");
  if (!Number.isInteger(microphone.sample_rate_hz)) {
    issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.sample_rate_hz`, "Microphone sample rate must be an integer.", "Use a declared sample rate such as 48000."));
  }
  if (!["mono", "stereo_head", "triangular_head", "wrist_pair", "distributed_body"].includes(microphone.array_kind)) {
    issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.array_kind`, "Microphone array kind is unsupported.", "Use a declared hardware microphone array kind."));
  }
  if (microphone.channels.length === 0) {
    issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.channels`, "Microphone array must define at least one channel.", "Declare channel geometry for the microphone array."));
  }
  const seenIndexes = new Set<number>();
  const seenRefs = new Set<Ref>();
  for (let index = 0; index < microphone.channels.length; index += 1) {
    const channel = microphone.channels[index];
    validateRef(channel.channel_id, issues, `${path}.channels[${index}].channel_id`, "MicrophoneDescriptorInvalid");
    if (!Number.isInteger(channel.channel_index) || channel.channel_index < 0) {
      issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.channels[${index}].channel_index`, "Channel index must be a nonnegative integer.", "Use stable zero-based channel indexes."));
    }
    if (seenIndexes.has(channel.channel_index)) {
      issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.channels[${index}].channel_index`, "Channel indexes must be unique.", "Remove duplicate microphone channel indexes."));
    }
    if (seenRefs.has(channel.channel_id)) {
      issues.push(makeIssue("error", "MicrophoneDescriptorInvalid", `${path}.channels[${index}].channel_id`, "Channel ids must be unique.", "Remove duplicate microphone channel ids."));
    }
    seenIndexes.add(channel.channel_index);
    seenRefs.add(channel.channel_id);
    validateVector3(channel.local_position_m, issues, `${path}.channels[${index}].local_position_m`, "MicrophoneDescriptorInvalid");
    validateFinite(channel.gain_db, issues, `${path}.channels[${index}].gain_db`, "MicrophoneDescriptorInvalid");
    validateNonNegativeFinite(channel.noise_floor_db_spl, issues, `${path}.channels[${index}].noise_floor_db_spl`, "MicrophoneDescriptorInvalid");
  }
}

function validateAcousticPolicy(policy: AcousticPolicy, issues: ValidationIssue[], path: string): void {
  validateRef(policy.acoustic_policy_ref, issues, `${path}.acoustic_policy_ref`, "AcousticPolicyInvalid");
  validatePositiveFinite(policy.sample_window_s, issues, `${path}.sample_window_s`, "AcousticPolicyInvalid");
  validateNonNegativeFinite(policy.max_audio_sync_delta_s, issues, `${path}.max_audio_sync_delta_s`, "AcousticPolicyInvalid");
  validatePositiveFinite(policy.max_bearing_uncertainty_rad, issues, `${path}.max_bearing_uncertainty_rad`, "AcousticPolicyInvalid");
  if (policy.max_bearing_uncertainty_rad > Math.PI) {
    issues.push(makeIssue("error", "AcousticPolicyInvalid", `${path}.max_bearing_uncertainty_rad`, "Bearing uncertainty must not exceed pi radians.", "Use a bounded angular uncertainty threshold."));
  }
  if (!Number.isFinite(policy.min_event_confidence) || policy.min_event_confidence < 0 || policy.min_event_confidence > 1) {
    issues.push(makeIssue("error", "AcousticPolicyInvalid", `${path}.min_event_confidence`, "Minimum event confidence must be in [0, 1].", "Use a confidence threshold between zero and one."));
  }
  validateNonNegativeFinite(policy.ambient_noise_db_spl, issues, `${path}.ambient_noise_db_spl`, "AcousticPolicyInvalid");
}

function validateContactEvent(event: ContactEvent, issues: ValidationIssue[]): void {
  validateRef(event.contact_event_id, issues, "$.contact_events.contact_event_id", "ContactEventInvalid");
  validateNonNegativeFinite(event.timestamp_s, issues, "$.contact_events.timestamp_s", "ContactEventInvalid");
  validateVector3(event.impulse_summary.mean_contact_point_m, issues, "$.contact_events.impulse_summary.mean_contact_point_m", "ContactEventInvalid");
  validateNonNegativeFinite(event.impulse_summary.normal_impulse_n_s, issues, "$.contact_events.impulse_summary.normal_impulse_n_s", "ContactEventInvalid");
  validateNonNegativeFinite(event.impulse_summary.tangential_impulse_n_s, issues, "$.contact_events.impulse_summary.tangential_impulse_n_s", "ContactEventInvalid");
}

function validateMovementEvent(event: MovementAcousticEvent, issues: ValidationIssue[]): void {
  validateRef(event.movement_event_id, issues, "$.movement_events.movement_event_id", "MovementEventInvalid");
  validateNonNegativeFinite(event.timestamp_s, issues, "$.movement_events.timestamp_s", "MovementEventInvalid");
  if (!Number.isInteger(event.physics_tick) || event.physics_tick < 0) {
    issues.push(makeIssue("error", "MovementEventInvalid", "$.movement_events.physics_tick", "Movement event physics tick must be a nonnegative integer.", "Attach the movement event to a scheduler tick."));
  }
  validateVector3(event.source_position_m, issues, "$.movement_events.source_position_m", "MovementEventInvalid");
  validateVector3(event.velocity_m_per_s, issues, "$.movement_events.velocity_m_per_s", "MovementEventInvalid");
  if (event.acceleration_m_per_s2 !== undefined) {
    validateVector3(event.acceleration_m_per_s2, issues, "$.movement_events.acceleration_m_per_s2", "MovementEventInvalid");
  }
}

function validateTransform(transform: Transform, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  validateRef(transform.frame_ref, issues, `${path}.frame_ref`, code);
  validateVector3(transform.position_m, issues, `${path}.position_m`, code);
  if (!Array.isArray(transform.orientation_xyzw) || transform.orientation_xyzw.length !== 4 || transform.orientation_xyzw.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, `${path}.orientation_xyzw`, "Quaternion must contain exactly four finite values.", "Use normalized [x, y, z, w]."));
    return;
  }
  const norm = Math.sqrt(transform.orientation_xyzw.reduce((sum, component) => sum + component * component, 0));
  if (norm < 1e-9 || Math.abs(norm - 1) > 1e-6) {
    issues.push(makeIssue("error", code, `${path}.orientation_xyzw`, "Quaternion must be unit length.", "Normalize the microphone transform quaternion."));
  }
}

function validateRef(value: string, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  if (typeof value !== "string" || value.trim().length === 0 || /\s/.test(value)) {
    issues.push(makeIssue("error", code, path, "Reference must be a non-empty whitespace-free string.", "Use an opaque trace ref without spaces."));
  }
}

function validateVector3(value: Vector3, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
    issues.push(makeIssue("error", code, path, "Vector3 must contain exactly three finite numeric components.", "Use [x, y, z] in canonical units."));
  }
}

function validateFinite(value: number, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  if (!Number.isFinite(value)) {
    issues.push(makeIssue("error", code, path, "Value must be finite.", "Provide a finite numeric value."));
  }
}

function validatePositiveFinite(value: number, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  if (!Number.isFinite(value) || value <= 0) {
    issues.push(makeIssue("error", code, path, "Value must be positive and finite.", "Provide a calibrated positive finite value."));
  }
}

function validateNonNegativeFinite(value: number, issues: ValidationIssue[], path: string, code: AcousticValidationCode): void {
  if (!Number.isFinite(value) || value < 0) {
    issues.push(makeIssue("error", code, path, "Value must be nonnegative and finite.", "Provide a calibrated nonnegative finite value."));
  }
}

function makeIssue(severity: ValidationSeverity, code: AcousticValidationCode, path: string, message: string, remediation: string): ValidationIssue {
  return Object.freeze({ severity, code, path, message, remediation });
}

function splToNormalizedAmplitude(splDb: number): number {
  const pressure = REFERENCE_PRESSURE_PA * Math.pow(10, splDb / 20);
  return clamp01(pressure / 2);
}

function composeTransforms(parent: Transform, child: Transform, frameRef: Ref): Transform {
  const rotatedPosition = rotateVector(parent.orientation_xyzw, child.position_m);
  return freezeTransform({
    frame_ref: frameRef,
    position_m: addVector3(parent.position_m, rotatedPosition),
    orientation_xyzw: normalizeQuaternion(multiplyQuaternions(parent.orientation_xyzw, child.orientation_xyzw)),
  });
}

function invertRigidTransform(transform: Transform): Transform {
  const inverseOrientation = quaternionConjugate(transform.orientation_xyzw);
  const inversePosition = rotateVector(inverseOrientation, scaleVector3(transform.position_m, -1));
  return freezeTransform({
    frame_ref: transform.frame_ref,
    position_m: inversePosition,
    orientation_xyzw: inverseOrientation,
  });
}

function transformPoint(transform: Transform, point: Vector3): Vector3 {
  return addVector3(transform.position_m, rotateVector(transform.orientation_xyzw, point));
}

function rotateVector(q: Quaternion, v: Vector3): Vector3 {
  const qv: Quaternion = [v[0], v[1], v[2], 0];
  const rotated = multiplyQuaternions(multiplyQuaternions(q, qv), quaternionConjugate(q));
  return [rotated[0], rotated[1], rotated[2]];
}

function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quaternionConjugate(q: Quaternion): Quaternion {
  return [-q[0], -q[1], -q[2], q[3]];
}

function normalizeQuaternion(q: Quaternion): Quaternion {
  const norm = Math.sqrt(q.reduce((sum, value) => sum + value * value, 0));
  if (norm < 1e-12) {
    return IDENTITY_QUATERNION;
  }
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

function addVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function subtractVector3(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVector3(value: Vector3, scalar: number): Vector3 {
  return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

function vectorNorm(value: Vector3): number {
  return Math.sqrt(value[0] * value[0] + value[1] * value[1] + value[2] * value[2]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function secondsToMilliseconds(seconds: number): number {
  return round3(seconds * 1000);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function round9(value: number): number {
  return Math.round(value * 1000000000) / 1000000000;
}

function freezeMicrophone(microphone: MicrophoneArrayDescriptor): MicrophoneArrayDescriptor {
  return Object.freeze({
    ...microphone,
    mount_transform: freezeTransform(microphone.mount_transform),
    channels: freezeArray(microphone.channels.map((channel) => Object.freeze({
      ...channel,
      local_position_m: freezeVector3(channel.local_position_m),
    }))),
  });
}

function freezeTransform(transform: Transform): Transform {
  return Object.freeze({
    frame_ref: transform.frame_ref,
    position_m: freezeVector3(transform.position_m),
    orientation_xyzw: Object.freeze([transform.orientation_xyzw[0], transform.orientation_xyzw[1], transform.orientation_xyzw[2], transform.orientation_xyzw[3]]) as unknown as Quaternion,
  });
}

function freezeVector3(value: Vector3): Vector3 {
  return Object.freeze([value[0], value[1], value[2]]) as unknown as Vector3;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
