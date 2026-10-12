import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

interface Props {
  value: string
  label?: string
  className?: string
  onCopied?: () => void
}

/** 复制按钮：clipboard API + execCommand 兜底，2 秒视觉反馈 */
export function CopyButton({ value, label, className, onCopied }: Props) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    let ok = false
    try {
      await navigator.clipboard.writeText(value)
      ok = true
    } catch {
      // 兜底：临时 textarea + execCommand（非 https 场景）
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        ok = document.execCommand('copy')
        ta.remove()
      } catch {
        ok = false
      }
    }
    if (ok) {
      setCopied(true)
      onCopied?.()
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`复制: ${value}`}
      className={[
        'inline-flex items-center gap-1 rounded-base px-1.5 py-1 text-xs text-ink-subtle transition-colors hover:bg-primary-50 hover:text-primary',
        className ?? '',
      ].join(' ')}
    >
      {copied ? (
        <Check size={14} className="text-success" aria-hidden />
      ) : (
        <Copy size={14} aria-hidden />
      )}
      {label ?? (copied ? '已复制' : '复制')}
    </button>
  )
}
