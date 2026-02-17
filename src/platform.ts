/**
 * Platform detection and cross-platform utilities.
 *
 * Central module for all platform-specific branching. Import IS_WINDOWS
 * and helper functions instead of scattering process.platform checks.
 */

import { basename } from "node:path";

/** True when running on Windows (any variant). */
export const IS_WINDOWS = process.platform === "win32";

/**
 * Get the user's home directory path.
 *
 * Windows: USERPROFILE (set by default on all Windows versions).
 * Unix: HOME.
 */
export function getHomeDir(): string {
	if (IS_WINDOWS) {
		return process.env.USERPROFILE ?? process.env.HOMEPATH ?? "";
	}
	return process.env.HOME ?? "";
}

/**
 * Extract the project name from an absolute root path.
 *
 * Uses node:path.basename which handles both forward and backslash
 * separators on all platforms.
 */
export function extractProjectName(rootPath: string): string {
	return basename(rootPath) || "unknown";
}

/**
 * The CLI command to resolve a binary on the system PATH.
 *
 * Windows: "where" (built-in cmd.exe command).
 * Unix: "which".
 */
export function whichCommand(): string {
	return IS_WINDOWS ? "where" : "which";
}
