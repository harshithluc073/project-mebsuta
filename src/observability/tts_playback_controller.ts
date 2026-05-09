/**
 * TTS playback controller for Project Mebsuta observability.
 *
 * Blueprint: `architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md`
 * sections 17.4.1, 17.6.4, 17.11, 17.12.3, 17.15, 17.16, 17.18, and 17.19.
 *
 * The controller prepares deterministic synthesis requests and playback
 * receipts. It also emits self-audio suppression markers before playback so
 * the acoustic subsystem can ignore the agent's own speech.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  freezeArray,
  makeIssue,
  makeObservabilityRef,
  makeTextRef,
  validateRef,
  validateTimestamp,
} from "./observability_event_emitter";
import type {
  AcousticSuppressionMarker,
  ApprovedMonologueUtterance,
  PlaybackPolicy,
  TTSPlaybackEvent,
  TTSProfile,
  TTSRequest,
} from "./observability_event_emitter";

export const TTS_PLAYBACK_CONTROLLER_SCHEMA_VERSION = "mebsuta.tts_playback_controller.v1" as const;

export interface TTSPreparationReport {
  readonly preparation_report_ref: Ref;
  readonly request?: TTSRequest;
  readonly acoustic_suppression_marker?: AcousticSuppressionMarker;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

export interface TTSPlaybackReceipt {
  readonly playback_event: TTSPlaybackEvent;
  readonly acoustic_suppression_marker?: AcousticSuppressionMarker;
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

/**
 * Builds TTS requests and normalized playback events without depending on a
 * concrete speech provider.
 */
export class TTSPlaybackController {
  public prepareTTSRequest(utterance: ApprovedMonologueUtterance, ttsProfile: TTSProfile, playbackPolicy: PlaybackPolicy, requestedStartTimeMs: number): TTSPreparationReport {
    const issues: ValidationIssue[] = [];
    validateInputs(utterance, ttsProfile, playbackPolicy, requestedStartTimeMs, issues);
    if (!playbackPolicy.allow_tts || utterance.display_only) {
      const base = {
        preparation_report_ref: makeObservabilityRef("tts_preparation_report", utterance.utterance_ref, "display_only"),
        request: undefined,
        acoustic_suppression_marker: undefined,
        issues: freezeArray([...issues, makeIssue("warning", "TTSPlaybackDisabled", "$.playback_policy.allow_tts", "TTS playback is disabled or utterance is display-only.", "Render dashboard text without synthesis.")]),
      };
      return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
    }
    const estimatedEnd = requestedStartTimeMs + estimateSpeechDurationMs(utterance.final_message, ttsProfile);
    const markerRef = makeObservabilityRef("tts_acoustic_suppression_marker", utterance.utterance_ref, requestedStartTimeMs);
    const requestBase = {
      tts_request_ref: makeObservabilityRef("tts_request", utterance.utterance_ref, playbackPolicy.speaker_device_ref, requestedStartTimeMs),
      utterance_ref: utterance.utterance_ref,
      final_message: utterance.final_message,
      tts_profile: ttsProfile,
      playback_policy_ref: playbackPolicy.playback_policy_ref,
      speaker_device_ref: playbackPolicy.speaker_device_ref,
      requested_start_time_ms: requestedStartTimeMs,
      estimated_end_time_ms: Math.min(estimatedEnd, requestedStartTimeMs + ttsProfile.max_duration_ms),
      acoustic_suppression_marker_ref: markerRef,
    };
    const request = Object.freeze({ ...requestBase, determinism_hash: computeDeterminismHash(requestBase) });
    const marker = playbackPolicy.require_acoustic_suppression_marker ? this.buildAcousticSuppressionMarker(request) : undefined;
    const base = {
      preparation_report_ref: makeObservabilityRef("tts_preparation_report", request.tts_request_ref),
      request,
      acoustic_suppression_marker: marker,
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  public playTTSUtterance(ttsRequest: TTSRequest, speakerDeviceRef: Ref, acousticSuppressionMarker: AcousticSuppressionMarker | undefined): TTSPlaybackReceipt {
    const issues: ValidationIssue[] = [];
    validateRef(ttsRequest.tts_request_ref, "$.tts_request.tts_request_ref", issues);
    validateRef(speakerDeviceRef, "$.speaker_device_ref", issues);
    if (acousticSuppressionMarker === undefined) {
      issues.push(makeIssue("error", "TTSAcousticMarkerMissing", "$.acoustic_suppression_marker", "TTS playback requires a self-audio suppression marker.", "Emit marker before playback starts."));
    }
    const event = buildPlaybackEvent(ttsRequest, speakerDeviceRef, "completed", ttsRequest.requested_start_time_ms, ttsRequest.estimated_end_time_ms, acousticSuppressionMarker?.marker_ref, undefined);
    const base = {
      playback_event: event,
      acoustic_suppression_marker: acousticSuppressionMarker,
      issues: freezeArray(issues),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }

  public interruptTTSPlayback(activePlayback: TTSPlaybackEvent, interruptReason: string, interruptedAtMs: number): TTSPlaybackEvent {
    return buildPlaybackEvent(
      {
        tts_request_ref: makeObservabilityRef("tts_interrupt_request", activePlayback.tts_playback_ref),
        utterance_ref: activePlayback.utterance_ref,
        final_message: interruptReason,
        tts_profile: {
          tts_profile_ref: "tts_profile:interrupt",
          voice_ref: "voice:interrupt",
          language: "en-US",
          speaking_rate_wpm: 155,
          volume_gain: 1,
          max_duration_ms: 1_000,
        },
        playback_policy_ref: "playback_policy:interrupt",
        speaker_device_ref: activePlayback.speaker_device_ref,
        requested_start_time_ms: activePlayback.playback_start_time_ms ?? interruptedAtMs,
        estimated_end_time_ms: interruptedAtMs,
        acoustic_suppression_marker_ref: activePlayback.audio_leakage_marker_ref ?? makeObservabilityRef("tts_interrupt_marker", activePlayback.utterance_ref),
        determinism_hash: activePlayback.determinism_hash,
      },
      activePlayback.speaker_device_ref,
      "interrupted",
      activePlayback.playback_start_time_ms,
      interruptedAtMs,
      activePlayback.audio_leakage_marker_ref,
      interruptReason,
    );
  }

  private buildAcousticSuppressionMarker(request: TTSRequest): AcousticSuppressionMarker {
    const base = {
      marker_ref: request.acoustic_suppression_marker_ref,
      utterance_ref: request.utterance_ref,
      speaker_device_ref: request.speaker_device_ref,
      expected_start_time_ms: request.requested_start_time_ms,
      expected_end_time_ms: request.estimated_end_time_ms,
      reason: "self_generated_tts" as const,
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

function validateInputs(utterance: ApprovedMonologueUtterance, profile: TTSProfile, policy: PlaybackPolicy, startMs: number, issues: ValidationIssue[]): void {
  validateRef(utterance.utterance_ref, "$.utterance.utterance_ref", issues);
  validateRef(profile.tts_profile_ref, "$.tts_profile.tts_profile_ref", issues);
  validateRef(profile.voice_ref, "$.tts_profile.voice_ref", issues);
  validateRef(policy.playback_policy_ref, "$.playback_policy.playback_policy_ref", issues);
  validateRef(policy.speaker_device_ref, "$.playback_policy.speaker_device_ref", issues);
  validateTimestamp(startMs, "$.requested_start_time_ms", issues);
  if (profile.speaking_rate_wpm < 80 || profile.speaking_rate_wpm > 240) {
    issues.push(makeIssue("warning", "TTSSpeakingRateOutOfBand", "$.tts_profile.speaking_rate_wpm", "Speaking rate is outside the comfortable TTS band.", "Use 80 to 240 words per minute."));
  }
  if (profile.max_duration_ms <= 0) {
    issues.push(makeIssue("error", "TTSMaxDurationInvalid", "$.tts_profile.max_duration_ms", "TTS max duration must be positive.", "Provide a bounded duration budget."));
  }
}

function estimateSpeechDurationMs(message: string, profile: TTSProfile): number {
  const words = message.trim().split(/\s+/).filter((word) => word.length > 0).length;
  return Math.ceil(words / Math.max(1, profile.speaking_rate_wpm) * 60_000) + 150;
}

function buildPlaybackEvent(
  request: TTSRequest,
  speakerDeviceRef: Ref,
  status: TTSPlaybackEvent["playback_status"],
  startMs: number | undefined,
  endMs: number | undefined,
  markerRef: Ref | undefined,
  failureReason: string | undefined,
): TTSPlaybackEvent {
  const base = {
    tts_playback_ref: makeObservabilityRef("tts_playback", request.utterance_ref, status, endMs),
    utterance_ref: request.utterance_ref,
    speaker_device_ref: speakerDeviceRef,
    playback_start_time_ms: startMs,
    playback_end_time_ms: endMs,
    playback_status: status,
    audio_leakage_marker_ref: markerRef,
    operator_visible_text_ref: makeTextRef(request.utterance_ref, request.final_message),
    failure_reason: failureReason,
  };
  return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
}

export const TTS_PLAYBACK_CONTROLLER_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: TTS_PLAYBACK_CONTROLLER_SCHEMA_VERSION,
  blueprint: "architecture_docs/17_INTERNAL_MONOLOGUE_TTS_OBSERVABILITY.md",
  sections: freezeArray(["17.4.1", "17.6.4", "17.11", "17.12.3", "17.15", "17.16", "17.18", "17.19"]),
  component: "TTSPlaybackController",
});
