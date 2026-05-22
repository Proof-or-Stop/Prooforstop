import type { VerificationEvidence } from './types.js';

export type EvidenceQuality = 'strong' | 'weak';

export type EvidenceWeaknessReason =
  | 'echo_pass_only'        // command is echo/true/no-op; result trivially passes
  | 'version_help_only'     // command only runs --version or --help
  | 'commandless_fileless'  // manual_transcript with no command and no file
  | 'build_only'            // compile/build command with no assertion or test signal
  ;

export interface EvidenceQualityResult {
  quality: EvidenceQuality;
  weaknessReason?: EvidenceWeaknessReason;
  detail?: string;
}

// Patterns for strong signal in command or note
const STRONG_CMD_RE = /\b(test|spec|jest|mocha|vitest|pytest|rspec|cypress|playwright|smoke|e2e|assert|verify|check)\b/i;
const STRONG_NOTE_RE = /\b(assert|verif\w*|regression|test|spec|smoke|pass|scenario|coverage|validate\w*|confirm\w*)\b/i;
const STRONG_FILE_RE = /\.(test|spec)\.[a-z]+$/i;

// Echo / pass-only commands
const ECHO_PASS_RE = /^\s*(echo|true|:|printf|exit\s+0)\b/i;

// Version/help-only
const VERSION_HELP_RE = /^[^\s]+\s+(--version|-v|--help|-h)\s*$/i;

// Build-only (compile or install, no test signal)
const BUILD_ONLY_CMD_RE = /^\s*(tsc|npx\s+tsc|npm\s+run\s+build|npm\s+install|yarn\s+build|pnpm\s+build|make\s+build|cargo\s+build|go\s+build)\b/i;

export function classifyEvidenceQuality(evidence: VerificationEvidence): EvidenceQualityResult {
  const { kind, command, file, note } = evidence;

  // Waivers are intentional deferrals — classify as strong (handled elsewhere)
  if (kind === 'waiver') return { quality: 'strong' };

  // Strong file signal: test/spec file referenced
  if (file && STRONG_FILE_RE.test(file)) return { quality: 'strong' };

  // Strong command signal: test runner or assertion keyword
  if (command && STRONG_CMD_RE.test(command)) return { quality: 'strong' };

  // Strong note signal: assertion/regression/test keywords
  if (note && STRONG_NOTE_RE.test(note)) return { quality: 'strong' };

  // --- Weak pattern detection ---

  // manual_transcript with no command and no file → commandless/fileless
  if (kind === 'manual_transcript' && !command && !file) {
    return {
      quality: 'weak',
      weaknessReason: 'commandless_fileless',
      detail: 'manual_transcript evidence has no command or file reference',
    };
  }

  if (command) {
    // Echo / pass-only
    if (ECHO_PASS_RE.test(command)) {
      return {
        quality: 'weak',
        weaknessReason: 'echo_pass_only',
        detail: `command "${command}" is a trivial no-op or echo`,
      };
    }

    // Version/help only
    if (VERSION_HELP_RE.test(command)) {
      return {
        quality: 'weak',
        weaknessReason: 'version_help_only',
        detail: `command "${command}" only checks version/help, not behavior`,
      };
    }

    // Build-only without test/assertion signal in note
    if (BUILD_ONLY_CMD_RE.test(command) && !(note && STRONG_NOTE_RE.test(note))) {
      return {
        quality: 'weak',
        weaknessReason: 'build_only',
        detail: `command "${command}" only compiles/builds; no test or assertion signal found`,
      };
    }
  }

  return { quality: 'strong' };
}

export type EvidenceQualityProfile = 'light' | 'balanced' | 'strict';

export interface EvidenceQualityIssue {
  intentRef: string;
  itemId: string;
  weaknessReason: EvidenceWeaknessReason;
  detail: string;
  blocking: boolean;
}

export function getEvidenceQualityIssues(
  intentRef: string,
  itemId: string,
  evidence: VerificationEvidence,
  profile: EvidenceQualityProfile,
): EvidenceQualityIssue | undefined {
  if (profile === 'light') return undefined;
  const result = classifyEvidenceQuality(evidence);
  if (result.quality === 'strong') return undefined;
  return {
    intentRef,
    itemId,
    weaknessReason: result.weaknessReason!,
    detail: result.detail ?? result.weaknessReason!,
    blocking: profile === 'strict',
  };
}
