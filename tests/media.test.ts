import { describe, expect, it } from 'vitest'
import {
  bucketPeaks,
  formatDuration,
  frameLevel,
  normalizeBars,
  waveformFrom,
  WAVEFORM_BARS,
} from '@/media/waveform'
import { scaleToFit } from '@/media/image'
import { MAX_WAVEFORM_BARS } from '@/core/models/attachment'

describe('reducing a recording to a waveform', () => {
  it('always produces the requested number of bars', () => {
    expect(bucketPeaks([1, 2, 3], 8)).toHaveLength(8)
    expect(bucketPeaks(new Array(1000).fill(0.5), 12)).toHaveLength(12)
  })

  it('never exceeds the wire limit, whatever it is asked for', () => {
    // The bar array ships inside the message, and the recipient's parser
    // rejects anything longer.
    expect(bucketPeaks([1, 2, 3], 5000).length).toBeLessThanOrEqual(MAX_WAVEFORM_BARS)
  })

  it('takes the peak of each bucket, not the mean', () => {
    // Speech is mostly quiet; averaging flattens a normal sentence into a line.
    expect(bucketPeaks([0, 0, 0, 1], 2)).toEqual([0, 1])
  })

  it('handles a recording shorter than one bar', () => {
    expect(bucketPeaks([0.5], 4)).toEqual([0.5, 0.5, 0.5, 0.5])
  })

  it('handles no samples at all', () => {
    expect(bucketPeaks([], 4)).toEqual([0, 0, 0, 0])
  })

  it('treats negative samples by magnitude', () => {
    // Time-domain audio swings both ways; a trough is as loud as a peak.
    expect(bucketPeaks([-0.9, 0.1], 1)).toEqual([0.9])
  })
})

describe('scaling bars for display', () => {
  it('normalises against the loudest bar, not full scale', () => {
    // A quiet recording must still be legible.
    expect(normalizeBars([0.1, 0.05, 0.025])).toEqual([100, 50, 25])
  })

  it('keeps silence visible as a floor rather than a gap', () => {
    const bars = normalizeBars([1, 0, 0.5])
    expect(bars[1]).toBeGreaterThan(0)
    expect(bars[0]).toBe(100)
  })

  it('does not divide by zero on pure silence', () => {
    expect(normalizeBars([0, 0, 0])).toEqual([4, 4, 4])
  })

  it('clamps into the range the wire format allows', () => {
    for (const bar of waveformFrom([0.2, 5, 0.001], WAVEFORM_BARS)) {
      expect(bar).toBeGreaterThanOrEqual(0)
      expect(bar).toBeLessThanOrEqual(100)
      expect(Number.isInteger(bar)).toBe(true)
    }
  })
})

describe('level metering', () => {
  it('is zero for silence', () => {
    expect(frameLevel(new Float32Array(64))).toBe(0)
  })

  it('is the RMS of the frame, so one click does not dominate', () => {
    const frame = new Float32Array([1, 0, 0, 0])
    expect(frameLevel(frame)).toBeCloseTo(0.5, 5)
  })

  it('handles an empty frame', () => {
    expect(frameLevel(new Float32Array(0))).toBe(0)
  })
})

describe('duration display', () => {
  it.each([
    [0, '0:00'],
    [7_000, '0:07'],
    [83_000, '1:23'],
    [724_000, '12:04'],
  ])('renders %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('never renders a single-digit seconds field', () => {
    expect(formatDuration(61_000)).toBe('1:01')
  })

  it('does not go negative', () => {
    expect(formatDuration(-5000)).toBe('0:00')
  })
})

describe('fitting an image', () => {
  it('scales the longest edge down to the bound', () => {
    expect(scaleToFit(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(scaleToFit(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 })
  })

  it('never upscales', () => {
    // Enlarging a small image costs bytes and adds nothing.
    expect(scaleToFit(100, 80, 1600)).toEqual({ width: 100, height: 80 })
  })

  it('keeps a very wide image at least one pixel tall', () => {
    expect(scaleToFit(10000, 3, 100).height).toBeGreaterThanOrEqual(1)
  })

  it('handles a degenerate size', () => {
    expect(scaleToFit(0, 0, 100)).toEqual({ width: 0, height: 0 })
  })
})
