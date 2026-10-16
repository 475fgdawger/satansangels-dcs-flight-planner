import { describe, expect, it } from 'vitest'
import { stalePages } from '../src/ui/folder'

describe('kneeboard folder', () => {
  it('finds pages left over from a longer kneeboard with the same name', () => {
    const names = ['Op_1.jpg', 'Op_2.jpg', 'Op_3.jpg', 'Op_12.jpg', 'Other_4.jpg', 'Op_4.jpeg', 'Op_navlog_5.jpg']
    expect(stalePages(names, 'Op', 2)).toEqual(['Op_3.jpg', 'Op_12.jpg'])
    expect(stalePages(names, 'Op', 12)).toEqual([])
  })

  it('removes PNG pages left from before the export was JPEG', () => {
    expect(stalePages(['Op_1.png', 'Op_2.png', 'Op_1.jpg', 'Other_1.png'], 'Op', 2)).toEqual(['Op_1.png', 'Op_2.png'])
  })
})
