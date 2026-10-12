interface Props {
  online: boolean
}

/** 在线状态徽章：信号灯 + 文字（颜色不是唯一信息） */
export function StatusBadge({ online }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <span
        aria-hidden
        className={[
          'h-2 w-2 shrink-0 rounded-full',
          online ? 'bg-success' : 'bg-ink-faint',
        ].join(' ')}
      />
      <span className={online ? 'text-success-700' : 'text-ink-faint'}>
        {online ? '在线' : '离线'}
      </span>
    </span>
  )
}
