/**
 * Deterministic acoustic preprocessing for File 16.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.7.3, 16.14, 16.18, 16.20, and 16.21.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AudioArrayBundle,
  AudioSensorPacket,
  AudioSignalSummary,
  AudioPreprocessingStatus,
  clamp01,
  cleanAcousticRef,
  freezeArray,
  makeAcousticRef,
  makeAudioIssue,
  round6,
} from "./audio_sensor_bus";
import type { AudioSynchronizationReport } from "./audio_synchronizer";

export const AUDIO_PREPROCESSOR_SCHEMA_VERSION = "mebsuta.audio_preprocessor.v1" as const;

export interface AudioPreprocessingPolicy {
  readonly ambient_noise_floor?: number;
  readonly high_pass_hz?: number;
  readonly low_pass_hz?: number;
  readonly clipping_ratio_block_threshold?: number;
  readonly self_noise_reference_sensor_patterns?: readonly string[];
}

export interface PreprocessedAudioPacket {
  readonly packet_ref: Ref;
  readonly sensor_id: Ref;
  readonly filtered_audio_ref: Ref;
  readonly status: AudioPreprocessingStatus;
  readonly denoised_signal_summary: AudioSignalSummary;
  readonly noise_floor_estimate: number;
  readonly self_noise_score: number;
  readonly signal_quality: number;
  readonly determinism_hash: string;
}

export interface AudioPreprocessingReport {
  readonly schema_version: typeof AUDIO_PREPROCESSOR_SCHEMA_VERSION;
  readonly preprocessing_report_ref: Ref;
  readonly audio_bundle_ref: Ref;
  readonly sync_report_ref: Ref;
  readonly packets: readonly PreprocessedAudioPacket[];
  readonly aggregate_noise_floor: number;
  readonly aggregate_signal_quality: number;
  readonly self_noise_likelihood: number;
  readonly clipped_packet_refs: readonly Ref[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

const DEFAULT_POLICY = Object.freeze({
  ambient_noise_floor: 0.025,
  high_pass_hz: 80,
  low_pass_hz: 12000,
  clipping_ratio_block_threshold: 0.18,
  self_noise_reference_sensor_patterns: freezeArray(["torso", "chest", "reference", "wrist", "body", "speaker"]),
});

export class AudioPreprocessor {
  private readonly policy: Required<AudioPreprocessingPolicy>;

  public constructor(policy: AudioPreprocessingPolicy = {}) {
    this.policy = Object.freeze({
      ambient_noise_floor: policy.ambient_noise_floor ?? DEFAULT_POLICY.ambient_noise_floor,
      high_pass_hz: policy.high_pass_hz ?? DEFAULT_POLICY.high_pass_hz,
      low_pass_hz: policy.low_pass_hz ?? DEFAULT_POLICY.low_pass_hz,
      clipping_ratio_block_threshold: policy.clipping_ratio_block_threshold ?? DEFAULT_POLICY.clipping_ratio_block_threshold,
      self_noise_reference_sensor_patterns: freezeArray(policy.self_noise_reference_sensor_patterns ?? DEFAULT_POLICY.self_noise_reference_sensor_patterns),
    });
  }

  /**
   * Applies deterministic filtering summaries and self-noise estimation.
   */
  public preprocessAudioBundle(bundle: AudioArrayBundle, syncReport: AudioSynchronizationReport): AudioPreprocessingReport {
    const issues: ValidationIssue[] = [];
    const packets = bundle.packets.map((packet) => this.preprocessPacket(packet, issues));
    const clippedRefs = packets.filter((packet) => packet.status === "clipped" || packet.status === "corrupted").map((packet) => packet.packet_ref);
    const aggregateNoise = packets.length === 0 ? 0 : round6(packets.reduce((sum, packet) => sum + packet.noise_floor_estimate, 0) / packets.length);
    const aggregateQuality = packets.length === 0 ? 0 : round6(packets.reduce((sum, packet) => sum + packet.signal_quality, 0) / packets.length);
    const selfNoise = packets.length === 0 ? 0 : round6(packets.reduce((sum, packet) => sum + packet.self_noise_score, 0) / packets.length);
    if (syncReport.sync_status === "desynchronized") {
      issues.push(makeAudioIssue("warning", "AudioStageInputInvalid", "$.sync_report", "Preprocessing continued with desynchronized audio, but localization should be blocked.", "Use this output for detection only or recapture synchronized microphones."));
    }
    const base = {
      schema_version: AUDIO_PREPROCESSOR_SCHEMA_VERSION,
      preprocessing_report_ref: makeAcousticRef("audio_preprocessing", bundle.audio_bundle_ref, aggregateQuality),
      audio_bundle_ref: bundle.audio_bundle_ref,
      sync_report_ref: syncReport.sync_report_ref,
      packets: freezeArray(packets),
      aggregate_noise_floor: aggregateNoise,
      aggregate_signal_quality: aggregateQuality,
      self_noise_likelihood: selfNoise,
      clipped_packet_refs: freezeArray(clippedRefs),
      issues: freezeArray([...bundle.issues, ...syncReport.issues, ...issues]),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  private preprocessPacket(packet: AudioSensorPacket, issues: ValidationIssue[]): PreprocessedAudioPacket {
    const signal = packet.signal_summary;
    const clipped = signal.clipping_ratio >= this.policy.clipping_ratio_block_threshold || signal.peak_amplitude > 1;
    const band = signal.band_energy;
    const passBandEnergy = Math.max(0, band.mid_hz_energy + band.high_hz_energy * 0.88 + band.low_hz_energy * 0.42);
    const noiseFloor = round6(Math.max(this.policy.ambient_noise_floor, signal.rms_energy * signal.silence_ratio));
    const denoisedRms = round6(Math.max(0, signal.rms_energy - noiseFloor));
    const status: AudioPreprocessingStatus = clipped
      ? "clipped"
      : packet.preprocessing_status === "corrupted"
        ? "corrupted"
        : "denoised";
    if (status === "clipped") {
      issues.push(makeAudioIssue("warning", "AudioSignalInvalid", `$.packets.${packet.audio_packet_ref}.clipping_ratio`, "Packet contains clipping that lowers classification reliability.", "Lower confidence or recapture with better gain."));
    }
    const referenceMic = this.policy.self_noise_reference_sensor_patterns.some((pattern) => packet.sensor_id.includes(pattern));
    const selfNoiseScore = clamp01((referenceMic ? 0.35 : 0.08) + signal.silence_ratio * 0.12 + signal.band_energy.low_hz_energy * 0.18 + signal.clipping_ratio * 0.2);
    const quality = clamp01(denoisedRms * 1.8 + passBandEnergy * 0.3 - signal.clipping_ratio * 0.8 - signal.silence_ratio * 0.2);
    const denoisedSignal = Object.freeze({
      rms_energy: denoisedRms,
      peak_amplitude: round6(Math.min(1, signal.peak_amplitude)),
      silence_ratio: round6(clamp01(signal.silence_ratio)),
      clipping_ratio: round6(clamp01(signal.clipping_ratio)),
      dominant_frequency_hz: Math.max(this.policy.high_pass_hz, Math.min(this.policy.low_pass_hz, signal.dominant_frequency_hz)),
      spectral_centroid_hz: signal.spectral_centroid_hz === undefined ? signal.dominant_frequency_hz : Math.max(this.policy.high_pass_hz, Math.min(this.policy.low_pass_hz, signal.spectral_centroid_hz)),
      band_energy: Object.freeze({
        low_hz_energy: round6(band.low_hz_energy * 0.42),
        mid_hz_energy: round6(band.mid_hz_energy),
        high_hz_energy: round6(band.high_hz_energy * 0.88),
      }),
    });
    const base = {
      packet_ref: packet.audio_packet_ref,
      sensor_id: cleanAcousticRef(packet.sensor_id),
      filtered_audio_ref: cleanAcousticRef(packet.raw_audio_ref ?? makeAcousticRef("filtered_audio", packet.audio_packet_ref)),
      status,
      denoised_signal_summary: denoisedSignal,
      noise_floor_estimate: noiseFloor,
      self_noise_score: round6(selfNoiseScore),
      signal_quality: round6(quality),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function preprocessAudioBundle(
  bundle: AudioArrayBundle,
  syncReport: AudioSynchronizationReport,
  policy: AudioPreprocessingPolicy = {},
): AudioPreprocessingReport {
  return new AudioPreprocessor(policy).preprocessAudioBundle(bundle, syncReport);
}
