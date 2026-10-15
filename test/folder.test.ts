import { describe, expect, it } from 'vitest'
import { stalePages } from '../src/ui/folder'

describe('kneeboard folder', () => {
  it('finds pages left over from a longer kneeboard with the same name', () => {
    const names = ['Op_1.png', 'Op_2.png', 'Op_3.png', 'Op_12.png', 'Other_4.png', 'Op_4.jpg', 'Op_navlog_5.png']
    expect(stalePages(names, 'Op', 2)).toEqual(['Op_3.png', 'Op_12.png'])
    expect(stalePages(names, 'Op', 12)).toEqual([])
  })
})
