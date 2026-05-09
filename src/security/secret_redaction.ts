/**
 * Secret configuration references and redaction for PIT-B05.
 *
 * Blueprint: `production_readiness_docs/07_AUTH_SECURITY_AND_POLICY_PLAN.md`
 * sections 17, 18, 19, 21, 22, and 23.
 */

import { computeDeterminismHash } from "../simulation/world_manifest";
import type { Ref, ValidationIssue } from "../simulation/world_manifest";
import {
  AUTH_SECURITY_BLUEPRINT_REF,
  authIssue,
  compactAuthText,
  containsForbiddenAuthText,
  freezeAuthArray,
  makeAuthRef,
  uniqueAuthRefs,
  validateAuthRef,
  validateSafeAuthText,
} from "../auth/actor_context";

export const SECRET_REDACTION_SCHEMA_VERSION = "mebsuta.security.secret_redaction.v1" as const;

export type SecretCategory = "gemini_api" | "identity_provider" | "session_signing" | "csrf" | "database" | "object_store" | "vector_store" | "message_bus" | "tts_provider" | "observability_sink" | "ci_cd" | "export_destination" | "service_to_service";

export interface SecretConfigRefInput {
  readonly config_ref: Ref;
  readonly category: SecretCategory;
  readonly environment_ref: Ref;
  readonly secret_store_ref: Ref;
  readonly credential_ref: Ref;
  readonly rotation_policy_ref: Ref;
  readonly consumer_component_refs: readonly Ref[];
  readonly loaded_at_ms: number;
}

export interface SecretConfigRef {
  readonly schema_version: typeof SECRET_REDACTION_SCHEMA_VERSION;
  readonly config_ref: Ref;
  readonly category: SecretCategory;
  readonly environment_ref: Ref;
  readonly secret_store_ref: Ref;
  readonly credential_ref: Ref;
  readonly rotation_policy_ref: Ref;
  readonly consumer_component_refs: readonly Ref[];
  readonly loaded_at_ms: number;
  readonly determinism_hash: string;
}

export interface RedactionResult {
  readonly schema_version: typeof SECRET_REDACTION_SCHEMA_VERSION;
  readonly redaction_ref: Ref;
  readonly input_ref: Ref;
  readonly redacted_text: string;
  readonly redacted: boolean;
  readonly redacted_categories: readonly SecretCategory[];
  readonly redaction_token_count: number;
  readonly audit_refs: readonly Ref[];
  readonly determinism_hash: string;
}

const SECRET_VALUE_PATTERNS: readonly { readonly category: SecretCategory; readonly pattern: RegExp }[] = freezeAuthArray([
  { category: "gemini_api", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { category: "database", pattern: /\b(?:postgres|mysql|mongodb):\/\/[^\s]+/gi },
  { category: "service_to_service", pattern: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { category: "session_signing", pattern: /\b(?:session|csrf|jwt)[_-]?(?:secret|token|key)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi },
  { category: "ci_cd", pattern: /\b(?:api|access|private)[_-]?key\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi },
]);

export function buildSecretConfigRef(input: SecretConfigRefInput): SecretConfigRef {
  const base = {
    schema_version: SECRET_REDACTION_SCHEMA_VERSION,
    config_ref: input.config_ref,
    category: input.category,
    environment_ref: input.environment_ref,
    secret_store_ref: input.secret_store_ref,
    credential_ref: input.credential_ref,
    rotation_policy_ref: input.rotation_policy_ref,
    consumer_component_refs: uniqueAuthRefs(input.consumer_component_refs),
    loaded_at_ms: input.loaded_at_ms,
  };
  const record = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  const issues = validateSecretConfigRef(record);
  if (issues.some((issue) => issue.severity === "error")) {
    throw new SecretRedactionError("Secret config ref failed validation.", issues);
  }
  return record;
}

export function redactSecrets(input: { readonly input_ref: Ref; readonly text: string; readonly config_refs?: readonly SecretConfigRef[]; readonly audit_refs?: readonly Ref[] }): RedactionResult {
  const issues: ValidationIssue[] = [];
  validateAuthRef(input.input_ref, "$.input_ref", issues);
  let redactedText = input.text;
  const categories = new Set<SecretCategory>();
  for (const candidate of SECRET_VALUE_PATTERNS) {
    redactedText = redactedText.replace(candidate.pattern, () => {
      categories.add(candidate.category);
      return `[redacted:${candidate.category}]`;
    });
  }
  if (containsForbiddenAuthText(redactedText)) {
    redactedText = compactAuthText(redactedText);
  }
  const categoryRefs = input.config_refs?.map((config) => config.config_ref) ?? [];
  const base = {
    schema_version: SECRET_REDACTION_SCHEMA_VERSION,
    redaction_ref: makeAuthRef("secret_redaction", input.input_ref, computeDeterminismHash(redactedText)),
    input_ref: input.input_ref,
    redacted_text: redactedText,
    redacted: categories.size > 0 || redactedText !== input.text,
    redacted_categories: freezeAuthArray([...categories].sort()),
    redaction_token_count: categories.size,
    audit_refs: uniqueAuthRefs([input.input_ref, ...categoryRefs, ...(input.audit_refs ?? [])]),
  };
  const result = Object.freeze({ ...base, determinism_hash: computeDeterminismHash(base) });
  if (issues.some((issue) => issue.severity === "error")) {
    throw new SecretRedactionError("Secret redaction request failed validation.", issues);
  }
  return result;
}

export class SecretRedactionError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = "SecretRedactionError";
    this.issues = freezeAuthArray(issues);
  }
}

export function validateSecretConfigRef(record: SecretConfigRef): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAuthRef(record.config_ref, "$.config_ref", issues);
  validateAuthRef(record.environment_ref, "$.environment_ref", issues);
  validateAuthRef(record.secret_store_ref, "$.secret_store_ref", issues);
  validateAuthRef(record.credential_ref, "$.credential_ref", issues);
  validateAuthRef(record.rotation_policy_ref, "$.rotation_policy_ref", issues);
  if (record.consumer_component_refs.length === 0) {
    issues.push(authIssue("error", "SecretConsumersMissing", "$.consumer_component_refs", "Secret config ref must name at least one consumer component.", "Attach bounded service consumers."));
  }
  validateSafeAuthText(record.category, "$.category", true, issues);
  return freezeAuthArray(issues);
}

export const SECRET_REDACTION_BLUEPRINT_ALIGNMENT = Object.freeze({
  schema_version: SECRET_REDACTION_SCHEMA_VERSION,
  blueprint: AUTH_SECURITY_BLUEPRINT_REF,
  sections: freezeAuthArray(["17", "18", "19", "21", "22", "23"]),
  component: "SecretRedaction",
});
