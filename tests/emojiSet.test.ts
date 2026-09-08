import { describe, expect, it } from 'vitest'
import { isReactionBody } from '@/core/models/protocol'
import { EMOJI_GROUPS, type EmojiGroupKey } from '@/ui/emoji/emojiSet'
import { QUICK_REACTIONS } from '@/ui/components/quickReactions'
import { PICKER_TEXT } from '@/ui/emoji/pickerText'

/**
 * The picker's contents are data, and data can be wrong in ways types cannot
 * catch: an emoji the reaction validator rejects would throw when tapped, and
 * a category with no heading would render a blank label.
 */

const CANONICAL_ORDER: EmojiGroupKey[] = [
  'smileys',
  'people',
  'animals',
  'food',
  'activities',
  'travel',
  'objects',
  'symbols',
]

describe('the emoji set', () => {
  it('uses the Unicode categories, in their standard order', () => {
    expect(EMOJI_GROUPS.map((group) => group.key)).toEqual(CANONICAL_ORDER)
  })

  it('offers nothing the reaction path would refuse', () => {
    // Tapping one of these in reaction mode calls `react`, which throws on a
    // body that is not an emoji. Anything here must therefore pass that check.
    const rejected: string[] = []
    for (const group of EMOJI_GROUPS) {
      for (const emoji of group.emoji) {
        if (!isReactionBody(emoji)) rejected.push(`${group.key}: ${emoji}`)
      }
    }
    expect(rejected).toEqual([])
  })

  it('offers the quick reactions through the full picker too', () => {
    const all = new Set(EMOJI_GROUPS.flatMap((group) => [...group.emoji]))
    for (const emoji of QUICK_REACTIONS) {
      expect(isReactionBody(emoji)).toBe(true)
      expect(all.has(emoji)).toBe(true)
    }
  })

  it('lists no emoji twice', () => {
    const seen = new Map<string, EmojiGroupKey>()
    const duplicates: string[] = []
    for (const group of EMOJI_GROUPS) {
      for (const emoji of group.emoji) {
        const first = seen.get(emoji)
        if (first) duplicates.push(`${emoji} in ${first} and ${group.key}`)
        else seen.set(emoji, group.key)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('has a heading in both languages for every category', () => {
    for (const group of EMOJI_GROUPS) {
      expect(PICKER_TEXT.en[group.key]).not.toBe('')
      expect(PICKER_TEXT.fa[group.key]).not.toBe('')
    }
  })
})
