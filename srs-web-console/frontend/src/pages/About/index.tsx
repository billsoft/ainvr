import { useEffect } from 'react'
import { Building2, Phone, UserRound, Video, Package, Radio } from 'lucide-react'
import { copyrightYears, displayVersion, useBranding } from '@/store/branding'
import { useSystemStatus } from '@/hooks/useSystemStatus'
import { useSettingsStore } from '@/store/settings'
import { describeLocalSupport, describeSrs } from '@/utils/capabilityText'
import { getCodecSupport } from '@/utils/codec'

export default function AboutPage() {
  const { settings, fetchSettings } = useSettingsStore()
  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])
  const { data, error } = useSystemStatus(settings?.pollIntervalMs ?? 5000)
  // 品牌与版权信息全部来自部署目录的 branding.yaml（OEM 改配置即可），留空的项不显示
  const b = useBranding()
  const copyright = b?.copyrightHolder ? `© ${copyrightYears(b)} ${b.copyrightHolder}` : ''

  return (
    <section aria-labelledby="about-title" className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 id="about-title" className="page-title">关于</h1>
        <p className="page-description">产品版本、版权与技术支持</p>
      </header>
      <div className="ui-panel overflow-hidden">
        <div className="flex items-start gap-4 border-b border-line bg-primary-50 p-5 sm:p-6">
          <div className="rounded-panel bg-primary p-3 text-white"><Video size={26} aria-hidden /></div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">{b?.productName}</h2>
            {b?.tagline && <p className="mt-2 text-sm leading-6 text-ink-subtle">{b.tagline}</p>}
            {copyright && <p className="mt-1 text-xs text-ink-faint">{copyright}. All Rights Reserved.</p>}
          </div>
        </div>
        <dl className="grid gap-6 p-5 sm:grid-cols-2 sm:p-6">
          <div><dt className="flex items-center gap-2 text-sm text-ink-subtle"><Package size={16} aria-hidden />产品版本</dt>
            <dd className="mt-2 text-lg font-semibold tabular-nums">{b && displayVersion(b)}</dd></div>
          <div><dt className="flex items-center gap-2 text-sm text-ink-subtle"><Radio size={16} aria-hidden />流媒体服务</dt>
            <dd className="mt-2 flex flex-wrap items-center gap-2"><span className="text-lg font-semibold">{data?.srsVersion ? `v${data.srsVersion}` : '—'}</span>
              <span className={`rounded-full px-2 py-1 text-xs ${!data || error ? 'bg-surface-page text-ink-subtle' : data.srsOnline ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>{error ? '状态更新失败' : !data ? '检测中' : data.srsOnline ? '运行中' : '连接不可用'}</span></dd></div>
        </dl>
      </div>
      <section className="ui-panel p-5 sm:p-6" aria-labelledby="codec-title" data-testid="about-codec">
        <h2 id="codec-title" className="text-base font-semibold">H.265 播放能力</h2>
        <p className="mt-2 text-sm text-ink-subtle">{data ? describeSrs(data) : '服务端：检测中…'}</p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {describeLocalSupport(getCodecSupport()).map(([k, v]) => (
            <div key={k}><dt className="text-xs text-ink-faint">本机 · {k}</dt><dd className="mt-1">{v}</dd></div>
          ))}
        </dl>
      </section>
      {b && (b.copyrightHolder || b.contactName || b.contactPhone) && (
        <section className="ui-panel p-5 sm:p-6" aria-labelledby="support-title">
          <h2 id="support-title" className="text-base font-semibold">版权与技术支持</h2>
          <dl className="mt-5 space-y-5 text-sm">
            {b.copyrightHolder && (
              <div><dt className="flex items-center gap-2 text-ink-subtle"><Building2 size={16} aria-hidden />版权所有</dt><dd className="mt-1.5 font-medium">{b.copyrightHolder}</dd></div>
            )}
            {(b.contactName || b.contactPhone) && (
              <div className="grid gap-5 sm:grid-cols-2">
                {b.contactName && (
                  <div><dt className="flex items-center gap-2 text-ink-subtle"><UserRound size={16} aria-hidden />联系人</dt><dd className="mt-1.5 font-medium">{b.contactName}</dd></div>
                )}
                {b.contactPhone && (
                  <div><dt className="flex items-center gap-2 text-ink-subtle"><Phone size={16} aria-hidden />联系电话</dt><dd className="mt-1.5"><a className="font-medium text-primary-600 hover:underline" href={`tel:${b.contactPhone}`}>{b.contactPhone}</a></dd></div>
                )}
              </div>
            )}
          </dl>
        </section>
      )}

      {copyright && <p className="text-center text-xs text-ink-subtle">{copyright} · 版权所有 · All Rights Reserved</p>}
    </section>
  )
}
