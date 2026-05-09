/**
 * Deterministic sound-event classification and risk labeling.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.5.4, 16.8, 16.10, 16.14, 16.15, 16.18, and 16.21.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AudioEvent,
  AudioEventClass,
  AudioEventSubclass,
  AudioExpectednessStatus,
  AudioRiskLevel,
  AudioRoute,
  AudioTaskPhaseCorrelation,
  SoundEventCandidate,
  clamp01,
  freezeArray,
  makeAcousticRef,
  riskRank,
  round6,
  uniqueRefs,
} from "./audio_sensor_bus";
import type { SoundEventCandidateSet } from "./sound_event_detector";

export const SOUND_CLASSIFIER_SCHEMA_VERSION = "mebsuta.sound_classifier.v1" as const;

export interface SoundClassificationPolicy {
  readonly impact_peak_threshold?: number;
  readonly roll_low_band_threshold?: number;
  readonly voice_frequency_min_hz?: number;
  readonly voice_frequency_max_hz?: number;
  readonly self_noise_threshold?: number;
}

export interface AudioEventSet {
  readonly schema_version: typeof SOUND_CLASSIFIER_SCHEMA_VERSION;
  readonly audio_event_set_ref: Ref;
  readonly candidate_set_ref: Ref;
  readonly audio_events: readonly AudioEvent[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

const DEFAULT_POLICY = Object.freeze({
  impact_peak_threshold: 0.62,
  roll_low_band_threshold: 0.48,
  voice_frequency_min_hz: 120,
  voice_frequency_max_hz: 3600,
  self_noise_threshold: 0.78,
});

export class SoundClassifier {
  private readonly policy: Required<SoundClassificationPolicy>;

  public constructor(policy: SoundClassificationPolicy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
  }

  /**
   * Classifies each candidate into prompt-safe acoustic event records.
   */
  public classifySoundEvents(
    candidateSet: SoundEventCandidateSet,
    taskContext: AudioTaskPhaseCorrelation,
    provenanceManifestRef: Ref,
  ): AudioEventSet {
    const audioEvents = candidateSet.candidates.map((candidate) => classifyCandidate(candidate, taskContext, provenanceManifestRef, this.policy));
    const base = {
      schema_version: SOUND_CLASSIFIER_SCHEMA_VERSION,
      audio_event_set_ref: makeAcousticRef("audio_event_set", candidateSet.candidate_set_ref, audioEvents.length),
      candidate_set_ref: candidateSet.candidate_set_ref,
      audio_events: freezeArray(audioEvents.sort(compareAudioEvents)),
      issues: candidateSet.issues,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function classifySoundEvents(
  candidateSet: SoundEventCandidateSet,
  taskContext: AudioTaskPhaseCorrelation,
  provenanceManifestRef: Ref,
  policy: SoundClassificationPolicy = {},
): AudioEventSet {
  return new SoundClassifier(policy).classifySoundEvents(candidateSet, taskContext, provenanceManifestRef);
}

function classifyCandidate(
  candidate: SoundEventCandidate,
  taskContext: AudioTaskPhaseCorrelation,
  provenanceManifestRef: Ref,
  policy: Required<SoundClassificationPolicy>,
): AudioEvent {
  const [eventClass, subclass] = classAndSubclass(candidate, policy);
  const expectedness = expectednessFor(eventClass, candidate, taskContext);
  const risk = riskFor(eventClass, subclass, candidate, expectedness, taskContext);
  const route = routeFor(eventClass, risk, expectedness, candidate.self_noise_likelihood);
  const confidence = confidenceFor(candidate, eventClass, policy);
  const base = {
    audio_event_ref: makeAcousticRef("audio_event", candidate.sound_candidate_ref, eventClass),
    source_candidate_ref: candidate.sound_candidate_ref,
    event_class: eventClass,
    event_subclass: subclass,
    classification_confidence: round6(confidence),
    task_phase_correlation: Object.freeze({
      ...taskContext,
      active_goal_ref: taskContext.active_goal_ref === undefined ? undefined : makeAcousticRef(taskContext.active_goal_ref),
      expected_sound_classes: freezeArray(taskContext.expected_sound_classes),
      controller_anomaly_refs: uniqueRefs(taskContext.controller_anomaly_refs),
      contact_evidence_refs: uniqueRefs(taskContext.contact_evidence_refs),
    }),
    expectedness_status: expectedness,
    risk_level: risk,
    recommended_route: route,
    prompt_safe_summary: summaryFor(eventClass, subclass, route, expectedness, risk),
    provenance_manifest_ref: makeAcousticRef(provenanceManifestRef),
    evidence_refs: uniqueRefs([candidate.sound_candidate_ref, ...candidate.supporting_packet_refs]),
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

function classAndSubclass(candidate: SoundEventCandidate, policy: Required<SoundClassificationPolicy>): readonly [AudioEventClass, AudioEventSubclass] {
  const ratio = candidate.frequency_profile.low_mid_high_ratio;
  if (candidate.self_noise_likelihood >= policy.self_noise_threshold) return ["self_noise", "actuator_body_noise"];
  if (candidate.frequency_profile.dominant_frequency_hz >= policy.voice_frequency_min_hz && candidate.frequency_profile.dominant_frequency_hz <= policy.voice_frequency_max_hz && ratio[1] >= 0.38 && candidate.duration_class !== "impulse") return ["voice", "speech_like"];
  if (candidate.energy_profile.peak_amplitude >= policy.impact_peak_threshold && candidate.duration_class === "impulse") return ["impact", candidate.energy_profile.peak_amplitude > 0.85 ? "hard_collision" : "drop_like_impact"];
  if (ratio[0] >= policy.roll_low_band_threshold && candidate.duration_class === "repeating") return ["roll", "rolling_away"];
  if (ratio[2] >= 0.42 && candidate.duration_class !== "impulse") return ["scrape", "surface_scrape"];
  if (ratio[1] >= 0.45 && candidate.duration_class === "short") return ["tool_contact", "tool_surface_contact"];
  if (candidate.duration_class === "sustained") return ["slide", "surface_scrape"];
  return ["unknown", "unclassified"];
}

function expectednessFor(eventClass: AudioEventClass, candidate: SoundEventCandidate, taskContext: AudioTaskPhaseCorrelation): AudioExpectednessStatus {
  if (eventClass === "self_noise") return "expected";
  if (taskContext.speaker_active && eventClass === "voice") return "expected";
  if (taskContext.expected_sound_classes.includes(eventClass)) return "expected";
  if (candidate.candidate_confidence < 0.25) return "impossible_to_judge";
  if (eventClass === "unknown") return "ambiguous";
  return "unexpected";
}

function riskFor(eventClass: AudioEventClass, subclass: AudioEventSubclass, candidate: SoundEventCandidate, expectedness: AudioExpectednessStatus, taskContext: AudioTaskPhaseCorrelation): AudioRiskLevel {
  if (eventClass === "self_noise" || eventClass === "ambient") return "none";
  const anomalyBoost = taskContext.controller_anomaly_refs.length > 0 || taskContext.contact_evidence_refs.length > 0 ? 1 : 0;
  const base = eventClass === "impact" && subclass === "hard_collision"
    ? 3
    : eventClass === "impact" || eventClass === "roll"
      ? 2
      : eventClass === "scrape" || eventClass === "tool_contact" || eventClass === "slide"
        ? 1
        : 0;
  const unexpectedBoost = expectedness === "unexpected" ? 1 : 0;
  const confidenceBoost = candidate.candidate_confidence > 0.7 ? 1 : 0;
  const score = Math.min(4, base + anomalyBoost + unexpectedBoost + confidenceBoost);
  return ["none", "low", "medium", "high", "blocking"][score] as AudioRiskLevel;
}

function routeFor(eventClass: AudioEventClass, risk: AudioRiskLevel, expectedness: AudioExpectednessStatus, selfNoise: number): AudioRoute {
  if (eventClass === "self_noise" || selfNoise >= 0.88) return "ignore";
  if (risk === "blocking") return "safe_hold";
  if (risk === "high") return "oops";
  if (risk === "medium") return "verify";
  if (expectedness === "ambiguous" || eventClass === "unknown" || eventClass === "roll") return "reobserve";
  if (riskRank(risk) > 0) return "note";
  return expectedness === "expected" ? "note" : "reobserve";
}

function confidenceFor(candidate: SoundEventCandidate, eventClass: AudioEventClass, policy: Required<SoundClassificationPolicy>): number {
  const classEvidence = eventClass === "unknown" ? 0.2 : eventClass === "self_noise" ? candidate.self_noise_likelihood : 0.55;
  return clamp01(candidate.candidate_confidence * 0.68 + classEvidence * 0.22 + (1 - candidate.self_noise_likelihood) * (policy.self_noise_threshold <= 0 ? 0 : 0.1));
}

function summaryFor(eventClass: AudioEventClass, subclass: AudioEventSubclass, route: AudioRoute, expectedness: AudioExpectednessStatus, risk: AudioRiskLevel): string {
  if (route === "safe_hold") return `Heard a ${subclass} ${eventClass} cue with ${risk} risk; pause and inspect before motion.`;
  if (route === "oops") return `Heard an unexpected ${eventClass} cue that may indicate failure; verify visually or tactually before correction.`;
  if (route === "verify") return `Heard a ${eventClass} cue during the task; run verification before declaring success.`;
  if (route === "reobserve") return `Heard a ${eventClass} cue with ${expectedness} expectedness; look toward the estimated region before acting.`;
  if (route === "ignore") return "The sound is likely self-generated robot audio or body noise and is not external task evidence.";
  return `Heard a ${eventClass} cue and recorded it as acoustic context only.`;
}

function compareAudioEvents(a: AudioEvent, b: AudioEvent): number {
  return riskRank(b.risk_level) - riskRank(a.risk_level) || b.classification_confidence - a.classification_confidence || a.audio_event_ref.localeCompare(b.audio_event_ref);
}
