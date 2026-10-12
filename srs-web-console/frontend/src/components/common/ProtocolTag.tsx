/** 协议标签（蓝底浅蓝字，等宽字体） */
export function ProtocolTag({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-base bg-primary-100 px-2 py-0.5 font-mono text-xs font-medium text-primary-600">
      {label}
    </span>
  )
}
