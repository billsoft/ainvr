import { useEffect, useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

/** Confirm only disposal of local drafts; actions never undo saved records. */
export function useDiscardConfirmation(active = true) {
  const [pending, setPending] = useState<{ content: string; action: () => void } | null>(null)
  useEffect(() => {
    if (!active) setPending(null)
  }, [active])
  function requestDiscard(dirty: boolean, content: string, action: () => void) {
    if (dirty) setPending({ content, action })
    else action()
  }
  return {
    requestDiscard,
    dialog: (
      <ConfirmDialog
        open={pending !== null}
        title="放弃未保存的修改？"
        content={pending?.content}
        cancelText="继续编辑"
        confirmText="放弃修改"
        autoClose={false}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const action = pending?.action
          setPending(null)
          action?.()
        }}
      />
    ),
  }
}
