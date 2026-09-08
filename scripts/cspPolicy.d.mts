/**
 * Types for the content-policy check, so the test suite can typecheck against
 * it. The implementation is plain ESM because it runs from the build, not the app.
 */

export declare const ALLOWED_REMOTE: Readonly<Record<string, readonly string[]>>
export declare function parseCsp(csp: string): Map<string, string[]>
export declare function cspFailures(csp: string): string[]
