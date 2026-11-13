import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AnalysisPipelineEditor } from '@/pages/AiChannels/AnalysisPipelineEditor'
import { ModelParametersDialog } from '@/pages/AiChannels/ModelParametersDialog'
import { DEFAULT_WIZARD_VALUE, buildModelAndPreprocess, wizardModelList, type AiWizardFormValue } from '@/features/aiChannelForm'
import { type AiAnalysisNode } from '@/types/aiChannel'

function renderEditor(initial: AiWizardFormValue = DEFAULT_WIZARD_VALUE) {
  const onChange = vi.fn()
  let latest = initial
  function Harness() {
    const [value, setValue] = useState(initial)
    latest = value
    return <AnalysisPipelineEditor value={value} onChange={next => { onChange(next); setValue(next) }} />
  }
  return { ...render(<Harness />), onChange, value: () => latest }
}

describe('independent model parameter drafts', () => {
  it.each(['取消', '关闭', 'Escape'] as const)('%s restores the configuration button after nested discard cleanup inside a parent wizard', async action => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onParentClose = vi.fn()
    render(<div role="dialog" aria-modal="true" aria-label="父向导">
      <button type="button" onClick={onParentClose}>关闭向导</button>
      <AnalysisPipelineEditor value={DEFAULT_WIZARD_VALUE} onChange={onChange} />
    </div>)
    const parent = screen.getByRole('dialog', { name: '父向导' })
    const opener = within(parent).getByRole('button', { name: /^配置 / })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: /^配置模型/ })
    fireEvent.change(within(dialog).getByLabelText(/检测置信度/), { target: { value: '.67' } })
    const close = async () => {
      if (action === 'Escape') await user.keyboard('{Escape}')
      else await user.click(within(dialog).getByRole('button', { name: action }))
    }
    await close()
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(within(dialog).getByLabelText(/检测置信度/)).toHaveValue(.67)
    await close()
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.getAllByRole('dialog')).toEqual([parent])
    await waitFor(() => expect(opener).toHaveFocus())
    expect(onChange).not.toHaveBeenCalled()
    expect(onParentClose).not.toHaveBeenCalled()
    await user.click(opener)
    expect(screen.getByLabelText(/检测置信度/)).toHaveValue(.25)
  })

  it('starts with a summary, opens a portal and closes unchanged apply without onChange', async () => {
    const user = userEvent.setup()
    const { container, onChange } = renderEditor()
    expect(screen.queryByLabelText(/检测置信度/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-model-select')).not.toBeInTheDocument()
    const opener = screen.getByRole('button', { name: /^配置 / })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: /^配置模型/ })
    expect(document.body).toContainElement(dialog)
    expect(container).not.toContainElement(dialog)
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(1)
    expect(within(dialog).queryByLabelText('推理帧率或采集间隔')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '应用到通道草稿' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it.each(['取消', '关闭', 'Escape'] as const)('%s confirms dirty discard, continuing retains edits and discarding preserves the channel draft', async action => {
    const user = userEvent.setup()
    const initial = { ...DEFAULT_WIZARD_VALUE, inferenceFps: 7 }
    const { onChange, value } = renderEditor(initial)
    const opener = screen.getByRole('button', { name: /^配置 / })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: /^配置模型/ })
    const threshold = within(dialog).getByLabelText(/检测置信度/)
    fireEvent.change(threshold, { target: { value: '0.67' } })
    const close = async () => {
      if (action === 'Escape') await user.keyboard('{Escape}')
      else await user.click(within(dialog).getByRole('button', { name: action }))
    }
    await close()
    expect(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(threshold).toHaveValue(.67)
    await close()
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(value()).toEqual(initial)
    expect(opener).toHaveFocus()
    await user.click(opener)
    expect(screen.getByLabelText(/检测置信度/)).toHaveValue(.25)
  })

  it('applies a model change atomically, preserves common FPS and leaves the input object untouched', async () => {
    const user = userEvent.setup()
    const initial = { ...DEFAULT_WIZARD_VALUE, inferenceFps: 7 }
    const original = structuredClone(initial)
    const { onChange, value } = renderEditor(initial)
    await user.click(screen.getByRole('button', { name: /^配置 / }))
    await user.selectOptions(screen.getByTestId('wizard-model-select'), 'face-det-scrfd-500m')
    fireEvent.change(screen.getByLabelText(/检测置信度/), { target: { value: '.48' } })
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(value().inferenceFps).toBe(7)
    expect(wizardModelList(value())[0]).toMatchObject({ id: 'primary',
      model: { name: 'face-det-scrfd-500m', adapter: 'scrfd_bpu' },
      preprocess: { mean: [127.5, 127.5, 127.5], std: [128, 128, 128] },
      postprocess: { conf_threshold: .48 } })
    expect(initial).toEqual(original)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('rejects invalid values and the combined budget without applying any draft', () => {
    const node = wizardModelList(DEFAULT_WIZARD_VALUE)[0]!
    const others: AiAnalysisNode[] = [{ id: 'face', ...buildModelAndPreprocess('yolo26x-face', DEFAULT_WIZARD_VALUE), postprocess: { conf_threshold: .25, iou_threshold: .45, max_detections: 300 } }]
    const onApply = vi.fn()
    render(<ModelParametersDialog node={node} others={others} allowSameCapability={false} onApply={onApply} onClose={vi.fn()} />)
    const maximum = screen.getByLabelText(/最大检测数/)
    fireEvent.change(maximum, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/最大检测数/)
    fireEvent.change(maximum, { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/合计不能超过 1000/)
    expect(onApply).not.toHaveBeenCalled()
    expect(node.postprocess.max_detections).toBe(300)
  })

  it('validates basic parameters of an unknown imported model without replacing its profile', () => {
    const node = structuredClone(wizardModelList(DEFAULT_WIZARD_VALUE)[0]!)
    node.model.name = 'imported-detector'
    node.model.path = '/custom/imported.hbm'
    const onApply = vi.fn()
    render(<ModelParametersDialog node={node} others={[]} allowSameCapability={false} onApply={onApply} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/检测置信度/), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/置信度/)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(/检测置信度/), { target: { value: '.4' } })
    fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
    expect(onApply).toHaveBeenCalledWith({ ...node, postprocess: { ...node.postprocess, conf_threshold: .4 } })
  })

  it('warns about the slow model common interval and cancellation preserves FPS', async () => {
    const user = userEvent.setup()
    const { value, onChange } = renderEditor({ ...DEFAULT_WIZARD_VALUE, inferenceFps: 7 })
    await user.click(screen.getByRole('button', { name: /^配置 / }))
    await user.selectOptions(screen.getByTestId('wizard-model-select'), 'locateanything-3b')
    expect(screen.getByText(/通道采集间隔会设为120秒/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/检测置信度/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(value().inferenceFps).toBe(7)
    expect(value().modelPreset).toBe(DEFAULT_WIZARD_VALUE.modelPreset)
    expect(onChange).not.toHaveBeenCalled()
  })
})
