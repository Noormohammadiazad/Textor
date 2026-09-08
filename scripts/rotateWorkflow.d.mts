/**
 * Types for the workflow rotation, so the test suite can typecheck against it.
 * The implementation is plain ESM because it runs from the push, not the app.
 */

export declare const WORKFLOW_DIR: string
export declare const ROTATED_FILE: RegExp

export declare function readWorkflowName(source: string): string
export declare function workflowSlug(name: string): string
export declare function releaseStamp(date: Date): string
export declare function nextWorkflowFile(input: { current: string; name: string; now: Date }): string
export declare function findWorkflow(root: string): string
export declare function rotateWorkflow(input: { root: string; now?: Date }): { from: string; to: string }
