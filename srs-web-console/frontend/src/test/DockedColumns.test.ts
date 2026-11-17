import { expect, it } from 'vitest'
import { dockedLayout, LEFT_WIDTH, MIDDLE_MIN, RIGHT_WIDTH, STACK_BELOW } from '@/pages/Playback/useDockedColumns'

const both = LEFT_WIDTH + RIGHT_WIDTH + MIDDLE_MIN + 32

it('shows both side columns when the player still has its minimum width', () => {
  expect(dockedLayout(both, true, true, 'left')).toMatchObject({ stacked: false, showLeft: true, showRight: true })
})
it('folds the column that was not asked for last when both do not fit', () => {
  expect(dockedLayout(both - 1, true, true, 'right')).toMatchObject({ showLeft: false, showRight: true })
  expect(dockedLayout(both - 1, true, true, 'left')).toMatchObject({ showLeft: true, showRight: false })
})
it('hides search when even alone it would squeeze the player', () => {
  expect(dockedLayout(RIGHT_WIDTH + MIDDLE_MIN + 31, false, true, 'right')).toMatchObject({ stacked: false, showRight: false })
})
it('keeps the old two-column page (list and player) down to the stacking width, and stacks below it', () => {
  expect(dockedLayout(STACK_BELOW, true, false, 'left')).toMatchObject({ stacked: false, showLeft: true })
  // 1024-wide tablets sit well above it: the list keeps its column beside the player.
  expect(dockedLayout(770, true, false, 'left')).toMatchObject({ stacked: false, showLeft: true })
  // Stacked, the player comes first: only the column asked for last stays open.
  expect(dockedLayout(STACK_BELOW - 1, true, true, 'left')).toMatchObject({ stacked: true, showLeft: true, showRight: false })
  expect(dockedLayout(STACK_BELOW - 1, true, true, 'right')).toMatchObject({ stacked: true, showLeft: false, showRight: true })
})
