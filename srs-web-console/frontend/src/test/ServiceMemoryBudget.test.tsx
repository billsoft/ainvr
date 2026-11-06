import {render,screen} from '@testing-library/react'
import {describe,it,expect} from 'vitest'
import {ServiceMemoryBudget} from '../pages/Dashboard/ServiceMemoryBudget'
describe('memory budget semantics',()=>{
 it('distinguishes reserved buffer from resident memory and shows draining',()=>{
  render(<ServiceMemoryBudget budget={{scope:'recording_gop_buffer',budget_bytes:256*1048576,reserved_bytes:128*1048576,retiring_bytes:32*1048576}}/>)
  expect(screen.getByText('录像缓冲预留')).toBeTruthy()
  expect(screen.getByText('128 MiB / 256 MiB')).toBeTruthy()
  expect(screen.getByText('收尾占用 32 MiB')).toBeTruthy()
 })
 it('does not pretend container ceiling is a reservation',()=>{
  render(<ServiceMemoryBudget budget={{scope:'container',budget_bytes:768*1048576}}/>)
  expect(screen.getByText('容器上限 768 MiB')).toBeTruthy()
  expect(screen.queryByText('编码缓冲预留')).toBeNull()
 })
 it('does not invent budgets for older services',()=>{
  const {container}=render(<ServiceMemoryBudget/>);expect(container.textContent).toBe('')
 })
})
