import { describe, expect, it } from 'vitest'
import { captionOf } from '@/ui/components/caption'
import type { Attachment } from '@/core/models/attachment'

/**
 * A bubble shows the words someone wrote beside an attachment, never the ones
 * written for clients that cannot show it (ADR-083) — in whichever language
 * the sender's Textor wrote them, and in the words older builds used.
 */

const attachment = { kind: 'image' } as Attachment
const shown = (body: string) => captionOf({ body, attachment })

describe('what a bubble says beside its attachment', () => {
  it('says nothing that only names what is attached', () => {
    for (const body of ['Photo', 'Video', 'Voice message', 'File', 'عکس', 'ویدیو', 'پیام صوتی', 'فایل']) {
      expect(shown(body)).toBe('')
    }
  })

  it('says nothing that names it with its length or its file name', () => {
    expect(shown('Voice message · 0:12')).toBe('')
    expect(shown('پیام صوتی · 1:05')).toBe('')
    expect(shown('File · notes.pdf')).toBe('')
    expect(shown('فایل · گزارش.pdf')).toBe('')
    // Persian for a file before it took Telegram's word.
    expect(shown('پرونده · notes.pdf')).toBe('')
  })

  it('says what someone wrote, even when it starts with one of those words', () => {
    expect(shown('Sunset at Darband')).toBe('Sunset at Darband')
    expect(shown('Photo of the receipt')).toBe('Photo of the receipt')
    expect(shown('Photos · 3')).toBe('Photos · 3')
    expect(shown('عکس‌های سفر')).toBe('عکس‌های سفر')
  })

  it('leaves a message with nothing attached as it is', () => {
    expect(captionOf({ body: 'Photo' })).toBe('Photo')
    expect(captionOf({ body: '' })).toBe('')
  })
})
