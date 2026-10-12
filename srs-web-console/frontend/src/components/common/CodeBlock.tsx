/**
 * 轻量代码高亮查看器（2026-09-18）——包一层 prism-react-renderer，而不是
 * 到处直接用 <Highlight>，方便所有"贴代码给人看"的场景（目前是检测接口
 * 示例弹窗）统一换主题/换语言。
 *
 * 配色故意复用 tailwind.config.js 里已有的品牌色值（primary/success/
 * warning/ink 的十六进制），不用 Prism 自带的 vsDark/oneLight 之类独立
 * 主题——那些是给通用文档站配的，颜色跟控制台其余界面对不上。
 */
import { Highlight, type Language, type PrismTheme } from 'prism-react-renderer'

const consoleCodeTheme: PrismTheme = {
  plain: { color: '#1f2937', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#9ca3af', fontStyle: 'italic' } },
    { types: ['string', 'char', 'inserted', 'attr-value'], style: { color: '#10b981' } },
    { types: ['number'], style: { color: '#f59e0b' } },
    { types: ['keyword', 'boolean', 'builtin', 'atrule'], style: { color: '#1677ff' } },
    { types: ['function', 'class-name'], style: { color: '#003eb3' } },
    { types: ['property', 'tag', 'attr-name', 'symbol'], style: { color: '#0958d9' } },
    { types: ['operator', 'punctuation'], style: { color: '#6b7280' } },
    { types: ['deleted'], style: { color: '#ef4444' } },
  ],
}

interface Props {
  code: string
  /** prism-react-renderer 的 language 实际就是个字符串，交给调用方保证拼对 */
  language: Language
  className?: string
  /** 高亮后原文本会被拆成一堆 <span>，测试里按整段文字 getByText 基本会失配——
   *  留个稳定选择器，测试改成断言这个容器的 textContent */
  testId?: string
}

export function CodeBlock({ code, language, className, testId }: Props) {
  return (
    <Highlight theme={consoleCodeTheme} code={code.replace(/\n$/, '')} language={language}>
      {({ className: prismClassName, style, tokens, getLineProps, getTokenProps }) => (
        <pre data-testid={testId} className={[prismClassName, className].filter(Boolean).join(' ')} style={style}>
          {tokens.map((line, lineIndex) => (
            <div key={lineIndex} {...getLineProps({ line })}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  )
}
