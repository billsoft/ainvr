import { describe, expect, it } from 'vitest'
import { timelineCoveragePath } from '@/pages/Playback/timelineCoverage'

describe('timeline display coverage', () => {
  it('bounds a full day of frame marks to screen geometry', () => {
    const marks = Array.from({ length: 600000 }, (_, i) => ({ start: i * 100, end: i * 100 + 30 }))
    const before = { ...marks[0]! }
    const path = timelineCoveragePath(marks, { from: 0, to: 60000000 }, 1000)
    expect(path).toBe('M0.0000 0H100.0000V24H0.0000Z')
    expect(marks[0]).toEqual(before)
  })
  it('clips to the window and retains visible gaps', () => {
    expect(timelineCoveragePath([{start:-100,end:200},{start:500,end:1200}], {from:0,to:1000},1000))
      .toBe('M0.0000 0H20.0000V24H0.0000ZM50.0000 0H100.0000V24H50.0000Z')
  })
  it('ignores unavailable width, invalid and out-of-window marks', () => {
    expect(timelineCoveragePath([{start:0,end:1}], {from:0,to:10},0)).toBe('')
    expect(timelineCoveragePath([{start:NaN,end:1},{start:11,end:20},{start:5,end:3}], {from:0,to:10},100)).toBe('')
  })
})
