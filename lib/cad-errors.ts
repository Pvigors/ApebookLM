/**
 * CAD v3 contract errors are deliberately independent from the queue and UI.
 *
 * `terminal` means that replaying the same frozen request cannot make progress;
 * the caller must ask the user to change the target, sources, or constraints.
 * `repairable` means that one bounded, issue-directed IR/geometry repair is
 * allowed. It never means that the whole job may be blindly replayed.
 */
export type CadFailureDisposition = "terminal" | "repairable";

export const CAD_ERROR_DEFINITIONS = {
  cad_request_invalid: { disposition: "terminal" },
  cad_idempotency_conflict: { disposition: "terminal" },
  cad_source_required: { disposition: "terminal" },
  cad_source_unavailable: { disposition: "terminal" },
  cad_source_budget_exceeded: { disposition: "terminal" },
  cad_target_required: { disposition: "terminal" },
  cad_object_conflict: { disposition: "terminal" },
  cad_source_conflict: { disposition: "terminal" },
  cad_template_invalid: { disposition: "terminal" },
  cad_template_conflict: { disposition: "terminal" },
  cad_capability_limit: { disposition: "terminal" },
  cad_invalid_explicit_constraint: { disposition: "terminal" },
  cad_ir_schema_invalid: { disposition: "repairable" },
  cad_constraint_not_implemented: { disposition: "repairable" },
  cad_boolean_no_effect: { disposition: "repairable" },
  cad_part_interference: { disposition: "repairable" },
  cad_bounds_mismatch: { disposition: "repairable" },
  cad_step_roundtrip_failed: { disposition: "repairable" },
} as const satisfies Record<string, { disposition: CadFailureDisposition }>;

export type CadErrorCode = keyof typeof CAD_ERROR_DEFINITIONS;

export type CadErrorDetails = Readonly<Record<string, unknown>>;

export function cadFailureDisposition(code: CadErrorCode): CadFailureDisposition {
  return CAD_ERROR_DEFINITIONS[code].disposition;
}

export function isTerminalCadErrorCode(code: CadErrorCode): boolean {
  return cadFailureDisposition(code) === "terminal";
}

export function isRepairableCadErrorCode(code: CadErrorCode): boolean {
  return cadFailureDisposition(code) === "repairable";
}

export class CadContractError extends Error {
  readonly code: CadErrorCode;
  readonly disposition: CadFailureDisposition;
  readonly field?: string;
  readonly hint?: string;
  readonly details?: CadErrorDetails;

  constructor(args: {
    code: CadErrorCode;
    message: string;
    field?: string;
    hint?: string;
    details?: CadErrorDetails;
  }) {
    super(args.message);
    this.name = "CadContractError";
    this.code = args.code;
    this.disposition = cadFailureDisposition(args.code);
    this.field = args.field;
    this.hint = args.hint;
    this.details = args.details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      disposition: this.disposition,
      ...(this.field ? { field: this.field } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isCadContractError(error: unknown): error is CadContractError {
  return error instanceof CadContractError;
}
