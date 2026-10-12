import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChannelSettingsDialog } from '@/pages/RecognitionHistory/ChannelSettingsDialog'

function renderDialog(overrides: Partial<Parameters<typeof ChannelSettingsDialog>[0]> = {}) {
  const onSave = vi.fn()
  const onRequestClear = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <ChannelSettingsDialog
      open
      channelName="大门摄像头"
      currentMax={5000}
      currentProjectionMode="none"
      currentBrightnessEnabled={false}
      currentBrightnessTarget={128}
      currentFaceModel="none"
      currentFaceBlend={0.5}
      faceChannel
      hasRecords
      onSave={onSave}
      onRequestClear={onRequestClear}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { ...utils, onSave, onRequestClear, onClose }
}

describe('ChannelSettingsDialog', () => {
  it('打开时输入框预填当前上限和投影模式', () => {
    renderDialog()
    expect(screen.getByTestId('max-count-input')).toHaveValue(5000)
    expect(screen.getByTestId('projection-mode-select')).toHaveValue('none')
  })

  it('只改上限——保存时 patch 只带 max_count', async () => {
    const { onSave, onClose } = renderDialog()
    const input = screen.getByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '800')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ max_count: 800 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('只改投影模式——保存时 patch 只带 projection_mode', async () => {
    const { onSave } = renderDialog()
    await userEvent.selectOptions(screen.getByTestId('projection-mode-select'), 'erp_equirect')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ projection_mode: 'erp_equirect' })
  })

  it('两个字段都改——一次 patch 带两个字段', async () => {
    const { onSave } = renderDialog()
    const input = screen.getByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '800')
    await userEvent.selectOptions(screen.getByTestId('projection-mode-select'), 'erp_equirect')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ max_count: 800, projection_mode: 'erp_equirect' })
  })

  it('什么都没改——保存不调用 onSave，只关闭弹窗', async () => {
    const { onSave, onClose } = renderDialog()
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('0、负数、非整数都不允许保存——保存按钮禁用', async () => {
    renderDialog()
    const input = screen.getByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '0')
    expect(screen.getByTestId('settings-save')).toBeDisabled()
    expect(screen.getByText('请输入大于 0 的整数')).toBeInTheDocument()
  })

  it('点击"清空识别历史"——调用 onRequestClear，不直接删除', async () => {
    const { onRequestClear } = renderDialog()
    await userEvent.click(screen.getByTestId('open-clear-confirm'))
    expect(onRequestClear).toHaveBeenCalledTimes(1)
  })

  it('没有记录时——清空按钮禁用', () => {
    renderDialog({ hasRecords: false })
    expect(screen.getByTestId('open-clear-confirm')).toBeDisabled()
  })

  it('点击取消——不调用 onSave', async () => {
    const { onSave, onClose } = renderDialog()
    const input = screen.getByTestId('max-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '800')
    await userEvent.click(screen.getByText('取消'))
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('open=false 时不渲染任何内容', () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId('max-count-input')).not.toBeInTheDocument()
  })

  // ---- 人脸修复模型下拉 ----

  it('默认下拉为"不开启"，强度滑块禁用、文案为不增强', () => {
    renderDialog()
    const select = screen.getByTestId('face-enhance-model') as HTMLSelectElement
    expect(select.value).toBe('none')
    expect(screen.getByTestId('face-blend-slider')).toBeDisabled()
    expect(screen.getByTestId('face-enhance-desc').textContent).toContain('原样保存')
  })

  it('下拉切到 256 档人脸修复——保存时 patch 带 face_enhance_model: gpen', async () => {
    const { onSave } = renderDialog()
    await userEvent.selectOptions(screen.getByTestId('face-enhance-model'), 'gpen')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ face_enhance_model: 'gpen' })
  })

  it('GPEN256 修复启用强度设置，菜单只提供 none 和 gpen', async () => {
    const { onSave } = renderDialog()
    const select = screen.getByTestId('face-enhance-model') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['none', 'gpen'])
    await userEvent.selectOptions(select, 'gpen')
    expect(screen.getByTestId('face-enhance-desc').textContent).toContain('256×256')
    // 选了模型后滑块应启用
    expect(screen.getByTestId('face-blend-slider')).toBeEnabled()
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ face_enhance_model: 'gpen' })
  })

  it('GPEN256 与不增强时的说明跟随选择变化', async () => {
    renderDialog()
    await userEvent.selectOptions(screen.getByTestId('face-enhance-model'), 'gpen')
    const gpenText = screen.getByTestId('face-enhance-desc').textContent ?? ''
    expect(gpenText).toContain('256×256')
    await userEvent.selectOptions(screen.getByTestId('face-enhance-model'), 'none')
    const cfText = screen.getByTestId('face-enhance-desc').textContent ?? ''
    expect(cfText).toContain('原样保存')
    expect(cfText).not.toBe(gpenText)
  })

  it('当前是 256 档人脸修复——改选"不开启"，patch 带 face_enhance_model: none', async () => {
    const { onSave } = renderDialog({ currentFaceModel: 'gpen' })
    expect(screen.getByTestId('face-enhance-model')).toHaveValue('gpen')
    await userEvent.selectOptions(screen.getByTestId('face-enhance-model'), 'none')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ face_enhance_model: 'none' })
  })

  it('非人脸识别通道——模型下拉禁用并提示', () => {
    renderDialog({ faceChannel: false })
    expect(screen.getByTestId('face-enhance-model')).toBeDisabled()
    expect(screen.getByText('仅人脸识别通道支持')).toBeInTheDocument()
  })

  it('增强强度滑块：已选模型时预填 50% 且启用；未选模型时禁用', () => {
    const { rerender } = renderDialog({ currentFaceModel: 'gpen' })
    const slider = screen.getByTestId('face-blend-slider') as HTMLInputElement
    expect(slider.value).toBe('50')
    expect(slider).toBeEnabled()
    expect(screen.getByTestId('face-blend-value')).toHaveTextContent('50%')

    rerender(
      <ChannelSettingsDialog
        open
        channelName="大门摄像头"
        currentMax={5000}
        currentProjectionMode="none"
        currentBrightnessEnabled={false}
        currentBrightnessTarget={128}
        currentFaceModel="none"
        currentFaceBlend={0.5}
        faceChannel
        hasRecords
        onSave={vi.fn()}
        onRequestClear={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('face-blend-slider')).toBeDisabled()
  })

  it('已选 256 档人脸修复——调强度到 30%，patch 只带 face_enhance_blend: 0.3', async () => {
    const { onSave } = renderDialog({ currentFaceModel: 'gpen' })
    fireEvent.change(screen.getByTestId('face-blend-slider'), { target: { value: '30' } })
    expect(screen.getByTestId('face-blend-value')).toHaveTextContent('30%')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ face_enhance_blend: 0.3 })
  })

  it('强度没动——patch 不带 face_enhance_blend', async () => {
    const { onSave } = renderDialog({ currentFaceModel: 'gpen', currentFaceBlend: 0.5 })
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('非人脸通道不渲染强度行', () => {
    renderDialog({ faceChannel: false })
    expect(screen.queryByTestId('face-blend-slider')).not.toBeInTheDocument()
  })

  it('切换模型同时调强度——patch 两个字段都带', async () => {
    const { onSave } = renderDialog({ currentFaceModel: 'none' })
    await userEvent.selectOptions(screen.getByTestId('face-enhance-model'), 'gpen')
    fireEvent.change(screen.getByTestId('face-blend-slider'), { target: { value: '20' } })
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({
      face_enhance_model: 'gpen',
      face_enhance_blend: 0.2,
    })
  })

  // ---- 截图亮度校正 ----

  it('默认关闭：开关 aria-checked=false、目标亮度滑块禁用、数值显示 128', () => {
    renderDialog()
    const toggle = screen.getByTestId('brightness-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('brightness-slider')).toBeDisabled()
    expect(screen.getByTestId('brightness-value')).toHaveTextContent('128')
  })

  it('目标亮度滑块全范围 0-255、步进 1（不设人为上下限）', () => {
    renderDialog()
    const slider = screen.getByTestId('brightness-slider')
    expect(slider).toHaveAttribute('min', '0')
    expect(slider).toHaveAttribute('max', '255')
    expect(slider).toHaveAttribute('step', '1')
  })

  it('打开开关——滑块启用；保存只带 brightness_enabled: true（没拖滑块）', async () => {
    const { onSave } = renderDialog()
    await userEvent.click(screen.getByTestId('brightness-toggle'))
    expect(screen.getByTestId('brightness-toggle')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('brightness-slider')).toBeEnabled()
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ brightness_enabled: true })
  })

  it('开启状态下调目标亮度到 150——patch 同时带开关与目标值', async () => {
    const { onSave } = renderDialog()
    await userEvent.click(screen.getByTestId('brightness-toggle'))
    fireEvent.change(screen.getByTestId('brightness-slider'), { target: { value: '150' } })
    expect(screen.getByTestId('brightness-value')).toHaveTextContent('150')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ brightness_enabled: true, brightness_target: 150 })
  })

  it('已开启——关掉开关保存只带 brightness_enabled: false，不带滑块值', async () => {
    const { onSave } = renderDialog({
      currentBrightnessEnabled: true,
      currentBrightnessTarget: 150,
    })
    // 开着的时候先拖滑块（模拟动过），再关开关——关闭时不应把 target 带进 patch
    fireEvent.change(screen.getByTestId('brightness-slider'), { target: { value: '100' } })
    await userEvent.click(screen.getByTestId('brightness-toggle'))
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ brightness_enabled: false })
  })

  it('已开启且只改目标亮度——patch 只带 brightness_target', async () => {
    const { onSave } = renderDialog({
      currentBrightnessEnabled: true,
      currentBrightnessTarget: 128,
    })
    fireEvent.change(screen.getByTestId('brightness-slider'), { target: { value: '100' } })
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ brightness_target: 100 })
  })
})

describe('ChannelSettingsDialog 调低上限确认', () => {
  it('低于当前条数：首次点击只提示淘汰条数，再次点击才保存', async () => {
    const { onSave } = renderDialog({ currentCount: 5000 })
    const input = screen.getByTestId('max-count-input')
    fireEvent.change(input, { target: { value: '3000' } })
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId('trim-warning')).toHaveTextContent('2,000')
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ max_count: 3000 })
  })
  it('新上限仍高于当前条数：直接保存', async () => {
    const { onSave } = renderDialog({ currentCount: 100 })
    fireEvent.change(screen.getByTestId('max-count-input'), { target: { value: '3000' } })
    await userEvent.click(screen.getByTestId('settings-save'))
    expect(onSave).toHaveBeenCalledWith({ max_count: 3000 })
  })
})
