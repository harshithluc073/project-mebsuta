/**
 * Microphone and cross-modal synchronization for File 16 acoustic reasoning.
 *
 * Blueprint: `architecture_docs/16_ACOUSTIC_EMBODIMENT_AUDIO_REASONING.md`
 * sections 16.5.2, 16.7.2, 16.8, 16.18, and 16.20.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AudioArrayBundle,
  AudioSensorPacket,
  AudioSyncStatus,
  AcousticTimeWindow,
  cleanAcousticRef,
  freezeArray,
  makeAcousticRef,
  makeAudioIssue,
  midpoint,
  round3,
  uniqueRefs,
} from "./audio_sensor_bus";

export const AUDIO_SYNCHRONIZER_SCHEMA_VERSION = "mebsuta.audio_synchronizer.v1" as const;

export interface CrossModalSyncReference {
  readonly stream_ref: Ref;
  readonly stream_kind: "camera" | "controller" | "contact" | "primitive_phase" | "tts" | "memory" | "other";
  readonly timestamp_ms: number;
  readonly tolerance_ms: number;
}

export interface AudioSynchronizationPolicy {
  readonly microphone_sync_tolerance_ms?: number;
  readonly cross_modal_sync_tolerance_ms?: number;
  readonly block_localization_when_desynchronized?: boolean;
}

export interface AudioSynchronizationReport {
  readonly schema_version: typeof AUDIO_SYNCHRONIZER_SCHEMA_VERSION;
  readonly sync_report_ref: Ref;
  readonly audio_bundle_ref: Ref;
  readonly packet_refs: readonly Ref[];
  readonly capture_time_window: AcousticTimeWindow;
  readonly microphone_spread_ms: number;
  readonly sync_status: AudioSyncStatus;
  readonly localization_allowed: boolean;
  readonly cross_modal_matches: readonly {
    readonly stream_ref: Ref;
    readonly stream_kind: CrossModalSyncReference["stream_kind"];
    readonly delta_ms: number;
    readonly status: "aligned" | "near" | "out_of_window";
  }[];
  readonly issues: readonly ValidationIssue[];
  readonly determinism_hash: string;
}

const DEFAULT_POLICY = Object.freeze({
  microphone_sync_tolerance_ms: 24,
  cross_modal_sync_tolerance_ms: 40,
  block_localization_when_desynchronized: true,
});

export class AudioSynchronizer {
  private readonly policy: Required<AudioSynchronizationPolicy>;

  public constructor(policy: AudioSynchronizationPolicy = {}) {
    this.policy = Object.freeze({ ...DEFAULT_POLICY, ...policy });
  }

  /**
   * Produces the synchronization report required before localization.
   */
  public synchronizeAudioBundle(
    bundle: AudioArrayBundle,
    crossModalRefs: readonly CrossModalSyncReference[] = [],
  ): AudioSynchronizationReport {
    const issues: ValidationIssue[] = [];
    const spreadMs = computePacketSpreadMs(bundle.packets);
    const syncStatus = resolveSyncStatus(spreadMs, this.policy.microphone_sync_tolerance_ms, bundle.sync_status);
    if (syncStatus === "desynchronized") {
      issues.push(makeAudioIssue("error", "AudioBundleInvalid", "$.audio_bundle_ref", "Microphone packets are too far apart for direction estimation.", "Recapture synchronized microphone evidence before localization."));
    }
    const windowMid = (bundle.capture_time_window.start_ms + bundle.capture_time_window.end_ms) / 2;
    const matches = crossModalRefs.map((ref) => {
      const tolerance = Math.max(0, ref.tolerance_ms || this.policy.cross_modal_sync_tolerance_ms);
      const delta = round3(Math.abs(ref.timestamp_ms - windowMid));
      const status = delta <= tolerance * 0.5 ? "aligned" as const : delta <= tolerance ? "near" as const : "out_of_window" as const;
      if (status === "out_of_window") {
        issues.push(makeAudioIssue("warning", "AudioBundleInvalid", `$.cross_modal_refs.${ref.stream_ref}`, "Cross-modal evidence is outside the synchronization window.", "Treat task correlation as uncertain or recapture related sensors."));
      }
      return Object.freeze({
        stream_ref: cleanAcousticRef(ref.stream_ref),
        stream_kind: ref.stream_kind,
        delta_ms: delta,
        status,
      });
    });
    const localizationAllowed = syncStatus !== "desynchronized" || !this.policy.block_localization_when_desynchronized;
    const base = {
      schema_version: AUDIO_SYNCHRONIZER_SCHEMA_VERSION,
      sync_report_ref: makeAcousticRef("audio_sync_report", bundle.audio_bundle_ref, spreadMs),
      audio_bundle_ref: bundle.audio_bundle_ref,
      packet_refs: uniqueRefs(bundle.packet_refs),
      capture_time_window: bundle.capture_time_window,
      microphone_spread_ms: round3(spreadMs),
      sync_status: syncStatus,
      localization_allowed: localizationAllowed,
      cross_modal_matches: freezeArray(matches),
      issues: freezeArray([...bundle.issues, ...issues]),
    };
    return Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  }
}

export function synchronizeAudioBundle(
  bundle: AudioArrayBundle,
  crossModalRefs: readonly CrossModalSyncReference[] = [],
  policy: AudioSynchronizationPolicy = {},
): AudioSynchronizationReport {
  return new AudioSynchronizer(policy).synchronizeAudioBundle(bundle, crossModalRefs);
}

function computePacketSpreadMs(packets: readonly AudioSensorPacket[]): number {
  if (packets.length <= 1) return 0;
  const mids = packets.map(midpoint);
  return Math.max(...mids) - Math.min(...mids);
}

function resolveSyncStatus(spreadMs: number, toleranceMs: number, priorStatus: AudioSyncStatus): AudioSyncStatus {
  if (priorStatus === "desynchronized") return "desynchronized";
  if (spreadMs <= toleranceMs * 0.35) return "synchronized";
  if (spreadMs <= toleranceMs) return "partially_synchronized";
  return "desynchronized";
}
