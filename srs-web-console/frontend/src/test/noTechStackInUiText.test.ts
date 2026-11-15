import { describe, expect, it } from 'vitest'

// 界面文字不暴露技术栈（产品要求）：流媒体服务、参数库、AI识别历史库这类业务说法代替
// 具体组件名（SRS / PostgreSQL / MongoDB / 推理框架 / 模型名……）。
// 判定"用户可见"：含中文的字符串字面量、模板串，以及 JSX 文本。代码标识符和配置值
// （如 adapter: 'yolo26_trt'）不含中文，不在检查范围。

// 用 Vite 的 import.meta.glob 把源码当原始文本读进来（不依赖 Node 类型）
const SOURCES = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../test/**', '!../mock/**', '!../**/*.test.*'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

const TECH = /(?<![A-Za-z0-9_])(SRS|srs|Mongo(DB)?|mongo(db)?|Postgre(SQL|s)?|postgres|PG|GStreamer|FFmpeg|ffmpeg|TensorRT|CUDA|ONNX|Jetson|NVIDIA|Docker|systemd|nginx|Fastify|React|hls\.js|flv\.js|mpegts|YOLO\w*|yolo\w*|SCRFD|scrfd|GPEN|CodeFormer|NetworkManager|SQLite|Redis|FastAPI|uvicorn|ByteTrack|BYTETracker)(?![A-Za-z0-9_])/
const CJK = /[一-鿿]/
const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/gs
const JSX_TEXT = />([^<>{}]+)</g
// Text between two JSX expressions, e.g. `{a}SRS {b}`; judged with its line,
// since the Chinese words around it sit inside the neighbouring expressions.
const JSX_BETWEEN = /\}([^<>{}\n]+)\{/g
// `a > b ... c < d` in code is not JSX text.
const CODE = /===|!==|&&|\|\||\breturn\b/

// 有意保留：外部系统对接的示例代码必须是真实可用的代码；连接串输入框必须提示格式
const ALLOW: Array<{ file: string; pattern: RegExp }> = [
  { file: 'pages/RecognitionHistory/apiExampleCode.ts', pattern: /./ },
  { file: 'pages/ConfigCenter/DatabaseConfigForm.tsx', pattern: /^"mongodb:\/\/用户:密码@主机:端口\/数据库\?authSource=认证库"$/ },
]

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
}

function findOffenders(sources: Record<string, string>): string[] {
  const offenders: string[] = []
  for (const [path, raw] of Object.entries(sources)) {
    const rel = path.replace(/^\.\.\//, '')
    const text = stripComments(raw)
    const candidates = [...text.matchAll(STR)].map((m) => m[0])
      .concat([...text.matchAll(JSX_TEXT)].map((m) => m[1]!).filter((s) => !CODE.test(s)))
    for (const m of text.matchAll(JSX_BETWEEN)) {
      const start = text.lastIndexOf('\n', m.index) + 1, end = text.indexOf('\n', m.index)
      const line = text.slice(start, end < 0 ? undefined : end)
      if (TECH.test(m[1]!) && CJK.test(line) && !CODE.test(m[1]!)) offenders.push(`${rel}: ${m[1]!.trim().slice(0, 120)}`)
    }
    for (const s of candidates) {
      if (!CJK.test(s) || !TECH.test(s)) continue
      if (ALLOW.some((a) => a.file === rel && a.pattern.test(s.trim()))) continue
      offenders.push(`${rel}: ${s.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  return offenders
}

describe('界面文字不暴露技术栈', () => {
  it('检测规则本身有效：抓得住旧写法，放过代码标识符与注释', () => {
    const found = findOffenders({
      '../a.tsx': `const a = <p>暂无 SRS 通道，请先添加</p>\nconst b = '模型：YOLOv12 人脸检测'`,
      '../b.ts': `// 注释里写 MongoDB 没关系\nconst adapter = 'yolo26_trt'\nconst label = '参数库'`,
      '../c.tsx': `const c = <p>{off ? '已停用' : '正常'}{' · '}SRS {ok ? '已收到' : '未收到'}</p>`,
      '../d.ts': `if (n > (adapter === 'yoloe_bpu' ? 300 : 1000)) return '超出范围' ; if (m < 2) x()`,
    })
    expect(found).toHaveLength(3)
    expect(found.join('\n')).toMatch(/c\.tsx: SRS/)
    expect(found.join('\n')).toMatch(/a\.tsx: .*SRS/)
  })

  it('含中文的界面文字里没有具体技术/组件/模型名', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50) // 确实读到了源码
    expect(findOffenders(SOURCES)).toEqual([])
  })
})
