// 播放器异常诊断进入统一日志；不维护第二套文件归档，不记录健康心跳。
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { operationalLog } from '../services/operationalLog.js';

const ClockOffsetEventSchema = z.object({
  channelId: z.string().min(1).max(100),
  event: z.enum(['recalibrate', 'heartbeat']),
  offsetS: z.number(),
  offsetJumpMs: z.number(),
  nowS: z.number(),
  matchGapMs: z.number().nullable(),
  // 2026-09-11 web OSD 同步重构诊断增强——只增不改，老前端的载荷没有这些
  // 字段照常通过（.optional()）；新字段缺失语义等价于旧版。
  signedGapMs: z.number().nullable().optional(),
  jitterBufferDelayS: z.number().nullable().optional(),
  protocol: z.string().max(20).optional(),
  // 2026-09-17 逐帧 SEI 路径上线：'sei' = 识别框直接来自当前显示帧自带的
  // SEI（Chrome/Edge 的 Encoded Transform 路径，框与画面天然同步）；
  // 'result'/'none' = 旧的"轮询 /results + 墙钟匹配"回退路径（Firefox/
  // Safari 没有 Encoded Transform 会落到这里，框会随延迟超前）。
  // 这个字段是排查"用户浏览器到底走了哪条路"的唯一依据，别删。
  matchType: z.enum(['result', 'none', 'sei', 'sei-approx']).optional(),
  // 逐帧路径下这一帧画了几个框（墙钟路径不填）——确认"走通了但一个框都
  // 没有"和"压根没走通"是两回事
  detCount: z.number().int().min(0).optional(),
});

const WebrtcStatsEventSchema = z.object({
  channelId: z.string().min(1).max(100),
  event: z.literal('webrtc-stats'),
  jitterBufferDelayS: z.number().nullable(),
  framesDecoded: z.number().nullable(),
  freezeCount: z.number().nullable(),
  pauseCount: z.number().nullable(),
});

const EventSchema = z.union([ClockOffsetEventSchema, WebrtcStatsEventSchema]);

export async function diagOverlayRoutes(fastify: FastifyInstance) {

  // ============================================================
  // POST /api/diag/overlay — 上报一条叠加层时序诊断事件
  // ============================================================
  fastify.post('/diag/overlay', async (req, reply) => {
    // 排查完成后设 OVERLAY_DIAG_ENABLED=false 即可整体关闭，不需要重新
    // 构建前端——前端该发的请求照发，这里直接丢弃不落盘，容器重启一次生效。
    if (process.env.OVERLAY_DIAG_ENABLED === 'false') {
      reply.send({ code: 0, data: { logged: false } });
      return;
    }

    const parse = EventSchema.safeParse(req.body);
    if (!parse.success) {
      reply.status(400).send({ code: 400, error: '参数错误' });
      return;
    }

    const event = parse.data;
    const abnormal = event.event === 'recalibrate' ? Math.abs(event.offsetJumpMs) > 500
      : event.event === 'heartbeat' ? Math.abs(event.matchGapMs ?? 0) > 500
      : (event.jitterBufferDelayS ?? 0) > 2;
    if (!abnormal) return reply.send({code:0,data:{logged:false}});
    operationalLog('WARN','player-diagnostics',`通道 ${event.channelId} ${event.event} 时序异常`,'runtime',
      {diagnostic:event});
    reply.send({ code: 0, data: { logged: true } });
  });
}
