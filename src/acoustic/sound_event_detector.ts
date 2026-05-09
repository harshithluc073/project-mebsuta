/**
 * Sound event detection from preprocessed microphone evidence.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.5.3, 16.7.1, 16.8, 16.14, 16.18, and 16.20.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { ValidationIssue } from "../simulation/world_manifest";
import {
  AudioDurationClass,
  AudioOnsetShape,
  EnergyProfile,
  FrequencyProfile,
  OnsetProfile,
  SoundEventCandidate,
  clamp01,
  freezeArray,
  makeAcousticRef,
  makeAudioIssue,
  round6,
  uniqueRefs,
} from "./audio_sensor_bus";
import type { AudioPreprocessingReport, PreprocessedAudioPacket } from "./audio_preprocessor";

export const SOUND_EVENT_DETECTOR_SCHEMA_VERSION = "mebsuta.sound_event_detector.v1" as const;

export interface SoundDetectionPolicy {
  readonly min_energy_delta?: number;
  readonly min_signal_quality?: number;
  readonly suppress_self_noise_above?: number;
  readonly allow_self_noise_candidates?: boolean;
}

export interface SoundEventCandidateSet {
  readonly schema_version: typeof SOUND_EVENT_DETECTOR_SCHEMA_VERSION;
  readonly candidate_set_ref: string;
  readonly preprocessing_report_ref: string;
  readonly candidates: readonly SoundEventCandidate[];
  readonly suppressed_packet_refs: readonly string[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

const DEFAULT_POLICY = Object.freeze({
  min_energy_delta: 0.045,
  min_signal_quality: 0.08,
  suppress_self_noise_above: 0.86,
  allow_self_noise_candidates: true,
});

export class SoundEventDetector {
  private readonly policy: Required<SoundDetectionPolicy>;

  public constructor(policy: SoundDetectionPolicy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
  }

  /**
   * Converts filtered microphone summaries into candidate acoustic events.
   */
  public detectSoundEvents(report: AudioPreprocessingReport): SoundEventCandidateSet {
    const issues: ValidationIssue[] = [];
    const candidatePackets = report.packets
      .filter((packet) => packet.signal_quality >= this.policy.min_signal_quality)
      .filter((packet) => this.policy.allow_self_noise_candidates || packet.self_noise_score < this.policy.suppress_self_noise_above);
    const suppressed = report.packets
      .filter((packet) => !candidatePackets.includes(packet))
      .map((packet) => packet.packet_ref);
    if (candidatePackets.length === 0 && report.packets.length > 0) {
      issues.push(makeAudioIssue("warning", "AudioStageInputInvalid", "$.packets", "No packet crossed the configured sound event threshold.", "Treat this window as ambient or lower the threshold for low-volume tasks."));
    }
    const grouped = groupPacketsByOnset(candidatePackets);
    const candidates = grouped.map((packets, index) => buildCandidate(report, packets, index, this.policy));
    const base = {
      schema_version: SOUND_EVENT_DETECTOR_SCHEMA_VERSION,
      candidate_set_ref: makeAcousticRef("sound_candidate_set", report.preprocessing_report_ref, candidates.length),
      preprocessing_report_ref: report.preprocessing_report_ref,
      candidates: freezeArray(candidates),
      suppressed_packet_refs: freezeArray(suppressed),
      issues: freezeArray([...report.issues, ...issues]),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function detectSoundEvents(report: AudioPreprocessingReport, policy: SoundDetectionPolicy = {}): SoundEventCandidateSet {
  return new SoundEventDetector(policy).detectSoundEvents(report);
}

function groupPacketsByOnset(packets: readonly PreprocessedAudioPacket[]): readonly (readonly PreprocessedAudioPacket[])[] {
  const sorted = [...packets].sort((a, b) => a.packet_ref.localeCompare(b.packet_ref));
  if (sorted.length === 0) return freezeArray([]);
  const highQuality = sorted.filter((packet) => packet.signal_quality >= 0.22 || packet.denoised_signal_summary.peak_amplitude >= 0.18);
  return freezeArray([(highQuality.length > 0 ? highQuality : sorted).sort((a, b) => b.signal_quality - a.signal_quality || a.packet_ref.localeCompare(b.packet_ref))]);
}

function buildCandidate(
  report: AudioPreprocessingReport,
  packets: readonly PreprocessedAudioPacket[],
  index: number,
  policy: Required<SoundDetectionPolicy>,
): SoundEventCandidate {
  const energy = buildEnergyProfile(packets, policy.min_energy_delta);
  const frequency = buildFrequencyProfile(packets);
  const onset = buildOnsetProfile(packets, energy);
  const duration = durationClassFor(onset, energy);
  const confidence = clamp01(energy.energy_delta * 1.8 + energy.peak_amplitude * 0.45 + (1 - report.self_noise_likelihood) * 0.2 + report.aggregate_signal_quality * 0.25);
  const selfNoise = clamp01((packets.reduce((sum, packet) => sum + packet.self_noise_score, 0) / packets.length) || 0);
  const window = {
    start_ms: report.packets.length === 0 ? 0 : Math.min(...report.packets.map((packet) => packet.denoised_signal_summary.rms_energy)) * 0 + 0,
    end_ms: report.packets.length === 0 ? 0 : Math.max(1, duration === "impulse" ? 40 : duration === "short" ? 180 : 800),
  };
  const base = {
    sound_candidate_ref: makeAcousticRef("sound_candidate", report.preprocessing_report_ref, index, confidence),
    audio_bundle_ref: report.audio_bundle_ref,
    event_time_window: Object.freeze(window),
    energy_profile: energy,
    frequency_profile: frequency,
    onset_profile: onset,
    duration_class: duration,
    candidate_confidence: round6(confidence),
    self_noise_likelihood: round6(selfNoise),
    supporting_packet_refs: uniqueRefs(packets.map((packet) => packet.packet_ref)),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function buildEnergyProfile(packets: readonly PreprocessedAudioPacket[], minDelta: number): EnergyProfile {
  const rms = packets.map((packet) => packet.denoised_signal_summary.rms_energy);
  const peaks = packets.map((packet) => packet.denoised_signal_summary.peak_amplitude);
  const silence = packets.map((packet) => packet.denoised_signal_summary.silence_ratio);
  const clipping = packets.map((packet) => packet.denoised_signal_summary.clipping_ratio);
  const mean = average(rms);
  const peak = Math.max(...peaks, 0);
  return Object.freeze({
    mean_rms_energy: round6(mean),
    peak_amplitude: round6(peak),
    energy_delta: round6(Math.max(minDelta, peak - mean * average(silence))),
    silence_ratio: round6(average(silence)),
    clipping_ratio: round6(average(clipping)),
  });
}

function buildFrequencyProfile(packets: readonly PreprocessedAudioPacket[]): FrequencyProfile {
  const lows = packets.map((packet) => packet.denoised_signal_summary.band_energy.low_hz_energy);
  const mids = packets.map((packet) => packet.denoised_signal_summary.band_energy.mid_hz_energy);
  const highs = packets.map((packet) => packet.denoised_signal_summary.band_energy.high_hz_energy);
  const low = average(lows);
  const mid = average(mids);
  const high = average(highs);
  const total = Math.max(1e-9, low + mid + high);
  const dominant = weightedAverage(packets.map((packet) => packet.denoised_signal_summary.dominant_frequency_hz), packets.map((packet) => packet.signal_quality));
  const centroid = weightedAverage(packets.map((packet) => packet.denoised_signal_summary.spectral_centroid_hz ?? packet.denoised_signal_summary.dominant_frequency_hz), packets.map((packet) => packet.signal_quality));
  return Object.freeze({
    dominant_frequency_hz: round6(dominant),
    spectral_centroid_hz: round6(centroid),
    low_mid_high_ratio: Object.freeze([round6(low / total), round6(mid / total), round6(high / total)]) as readonly [number, number, number],
    tonal_score: round6(clamp01(Math.abs(mid - high) + Math.abs(mid - low))),
  });
}

function buildOnsetProfile(packets: readonly PreprocessedAudioPacket[], energy: EnergyProfile): OnsetProfile {
  const shape: AudioOnsetShape = energy.peak_amplitude > 0.65 || energy.energy_delta > 0.42
    ? "sudden"
    : energy.silence_ratio < 0.18 && energy.mean_rms_energy > 0.18
      ? "continuous"
      : packets.length > 2
        ? "repeated"
        : "gradual";
  return Object.freeze({
    onset_shape: shape,
    onset_strength: round6(clamp01(energy.energy_delta + energy.peak_amplitude * 0.5)),
    repetition_count: shape === "repeated" ? Math.max(2, packets.length) : shape === "continuous" ? 1 : packets.length,
  });
}

function durationClassFor(onset: OnsetProfile, energy: EnergyProfile): AudioDurationClass {
  if (onset.onset_shape === "sudden" && energy.peak_amplitude >= 0.45) return "impulse";
  if (onset.onset_shape === "repeated") return "repeating";
  if (onset.onset_shape === "continuous") return "sustained";
  return "short";
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function weightedAverage(values: readonly number[], weights: readonly number[]): number {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 1e-9) return average(values);
  return values.reduce((sum, value, index) => sum + value * Math.max(0, weights[index] ?? 0), 0) / total;
}
