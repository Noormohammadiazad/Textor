/**
 * Types for the brand geometry, so the test suite can typecheck against it.
 * The implementation is plain ESM because it runs from `npm run icons`, not the app.
 */

export type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r: number }
  | { t: 'circle'; cx: number; cy: number; r: number }
  | { t: 'poly'; pts: [number, number][] }
  | { t: 'arc'; cx: number; cy: number; R: number; r: number; a0: number; a1: number }

export interface Layer {
  fill: string | null
  shapes: Shape[]
}

export interface Art {
  viewBox: [number, number, number, number]
  layers: Layer[]
}

export type BrandFile =
  | { path: string; svg: string }
  | { path: string; art: Art; width: number; height: number; svg?: undefined }

export declare const COLOURS: {
  brand: string
  white: string
  ink: string
  paper: string
  night: string
  dusk: string
}
export declare const MARK: { badge: Shape; bubble: Shape[]; link: Shape[] }
export declare const MASKABLE_SCALE: number
export declare const WORDMARK: { shapes: Shape[]; width: number; xHeight: number; ascent: number }
export declare const LOCKUP_WIDTH: number
export declare const PREVIEW: { width: number; height: number; scale: number }
export declare const SAMPLES: number

export declare function iconArt(form: 'rounded' | 'bleed' | 'maskable'): Art
export declare function pinnedTabArt(): Art
export declare function lockupArt(ink: string): Art
export declare function previewArt(): Art
export declare function toSvg(art: Art, label?: string): string
export declare function rasterize(art: Art, width: number, height: number): Uint8Array
export declare function encodePng(pixels: Uint8Array, width: number, height: number): Buffer
export declare function brandFiles(): BrandFile[]
