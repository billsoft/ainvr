import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandingService } from '@/api/brandingService'
import { resetBrandingForTest } from '@/store/branding'
import type { Branding } from '@/types/branding'
import AboutPage from '@/pages/About'
import { Topbar } from '@/components/layout/Topbar'
import { Sidebar } from '@/components/layout/Sidebar'
import { PRODUCT } from '@/utils/product'

// OEM 品牌：顶栏、侧栏、关于页、浏览器标题都来自 /api/branding（部署目录的
// branding.yaml），不写死在代码里；留空的项不显示。

vi.mock('@/api/brandingService', () => ({ brandingService: { get: vi.fn() } }))
vi.mock('@/hooks/useSystemStatus', () => ({ useSystemStatus: () => ({ data: null, error: null }) }))
vi.mock('@/api/observabilityService', () => ({ observabilityService: { summary: vi.fn().mockResolvedValue(null) } }))

const OEM: Branding = {
  productName: '某某智能视频平台', subtitle: '安防管理中心', shortName: '某某', versionLabel: '',
  tagline: '接入 · 监看 · 回放', copyrightHolder: '某某科技有限公司', copyrightStartYear: 2021,
  contactName: '张三', contactPhone: '400-800-1234',
}

function withRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

beforeEach(() => {
  resetBrandingForTest()
  document.title = ''
})
afterEach(() => vi.mocked(brandingService.get).mockReset())

describe('OEM 品牌可配置', () => {
  it('顶栏显示配置的产品名与副标题，浏览器标题随之变化', async () => {
    vi.mocked(brandingService.get).mockResolvedValue(OEM)
    withRouter(<Topbar />)
    expect(await screen.findByText('某某智能视频平台')).toBeInTheDocument()
    expect(screen.getByText('安防管理中心')).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('某某智能视频平台'))
  })

  it('读取完成前不显示任何品牌（OEM 设备上不会先闪出默认品牌）', () => {
    vi.mocked(brandingService.get).mockReturnValue(new Promise(() => {}))
    withRouter(<Topbar />)
    expect(screen.queryByText(/AINVR/)).toBeNull()
  })

  it('侧栏：简称 + 真实版本；配置了 version_label 时显示覆盖值', async () => {
    vi.mocked(brandingService.get).mockResolvedValue(OEM)
    const { unmount } = withRouter(<Sidebar />)
    expect(await screen.findByText(`某某 v${PRODUCT.version}`)).toBeInTheDocument()
    unmount()
    resetBrandingForTest()
    vi.mocked(brandingService.get).mockResolvedValue({ ...OEM, versionLabel: 'V3.1' })
    withRouter(<Sidebar />)
    expect(await screen.findByText('某某 V3.1')).toBeInTheDocument()
  })

  it('关于页整页按配置填空', async () => {
    vi.mocked(brandingService.get).mockResolvedValue(OEM)
    withRouter(<AboutPage />)
    expect(await screen.findByRole('heading', { name: '某某智能视频平台' })).toBeInTheDocument()
    expect(screen.getByText('接入 · 监看 · 回放')).toBeInTheDocument()
    const year = new Date().getFullYear()
    expect(screen.getAllByText(new RegExp(`© 2021-${year} 某某科技有限公司`)).length).toBeGreaterThan(0)
    expect(screen.getByText('张三')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '400-800-1234' })).toHaveAttribute('href', 'tel:400-800-1234')
    expect(screen.getByText(`v${PRODUCT.version}`)).toBeInTheDocument()
    expect(screen.queryByText(/AINVR/)).toBeNull()
  })

  it('留空的项不显示（联系人、电话、版权方、宣传语）', async () => {
    vi.mocked(brandingService.get).mockResolvedValue({
      ...OEM, contactName: '', contactPhone: '', copyrightHolder: '', tagline: '', copyrightStartYear: null,
    })
    withRouter(<AboutPage />)
    await screen.findByRole('heading', { name: '某某智能视频平台' })
    expect(screen.queryByText('联系人')).toBeNull()
    expect(screen.queryByText('联系电话')).toBeNull()
    expect(screen.queryByText('版权所有')).toBeNull()
    expect(screen.queryByText(/©/)).toBeNull()
  })

  it('取不到品牌信息时不崩，标题用中性说法', async () => {
    vi.mocked(brandingService.get).mockRejectedValue(new Error('offline'))
    withRouter(<Topbar />)
    await waitFor(() => expect(document.title).toBe('AINVR'))
  })
})
