import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { snapshotService } from '@/api/snapshotService'

interface Props {
  channelId: string
  imageId: string
  alt: string
  className?: string
  /** 'cover'（默认）用于网格缩略图裁切铺满；'contain' 用于大图/放大层——
   * 审计场景要看清完整截图，不能被 cover 裁掉边缘。 */
  objectFit?: 'cover' | 'contain'
  variant?: 'processed' | 'original'
}

/**
 * 懒加载的鉴权图片——用在识别历史时间轴里。<img src> 标签没法附带自定义
 * 请求头，认证图片只能 fetch blob 再转 object URL（见 httpClient.ts::
 * requestBlob 头注）；懒加载靠 IntersectionObserver，进视口前不发请求——
 * 一页几十条记录如果全部立即请求，首屏要一口气拉完所有图片数据，这是
 * 设计阶段就定下的效率要求（见识别历史设计：/image 独立路由 + 前端懒
 * 加载配合，不是内嵌 base64）。
 *
 * 404（记录已被淘汰——可能是保留上限触发的滚动淘汰，也可能是被手动删除）
 * 时显示占位图标，不是让整张卡片跟着崩掉：浏览页面是异步游标分页，允许
 * 列表加载完之后、用户实际看到某一条之前，这条记录已经被淘汰。
 */
export function AuthImage({ channelId, imageId, alt, className, objectFit = 'cover', variant = 'processed' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'missing' | 'error'>('idle')

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // rootMargin 提前 200px 触发——用户滚动到附近时图片已经在路上，避免
    // 滚到眼前才看见加载中的空白闪一下。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!inView) return
    let cancelled = false
    setUrl(null)
    setStatus('loading')
    const fetchImage = variant === 'original'
      ? snapshotService.getImageBlob(channelId, imageId, 'original')
      : snapshotService.getImageBlob(channelId, imageId)
    void fetchImage.then((blob) => {
      if (cancelled) return
      if (!blob) {
        setStatus('missing')
        return
      }
      setUrl(URL.createObjectURL(blob))
      setStatus('ok')
    }).catch(() => {
      if (!cancelled) setStatus('error')
    })
    return () => {
      cancelled = true
    }
  }, [inView, channelId, imageId, variant])

  // object URL 是浏览器进程级资源，组件卸载/图片换了都必须显式释放，
  // 不然长时间浏览会积累内存泄漏（朋友圈式时间轴一次会话可能滚过几百条）。
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [url])

  return (
    <div ref={containerRef} className={className}>
      {status === 'ok' && url ? (
        <img src={url} alt={alt} className={`h-full w-full ${objectFit === 'contain' ? 'object-contain' : 'object-cover'}`} />
      ) : status === 'missing' || status === 'error' ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-page text-ink-faint" title={status === 'error' ? '图片暂时无法加载' : variant === 'original' ? '这条历史记录未保存原图或已被淘汰' : '记录已被淘汰'}>
          <ImageOff size={20} aria-hidden />
          {variant === 'original' && <span className="text-sm">{status === 'error' ? '原图暂时无法加载' : '原图未保存或已被淘汰'}</span>}
        </div>
      ) : (
        <div className="h-full w-full animate-pulse bg-surface-page" aria-label="加载中" />
      )}
    </div>
  )
}
