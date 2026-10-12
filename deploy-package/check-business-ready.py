#!/usr/bin/env python3
"""Read-only post-activation acceptance; process liveness is not readiness."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
import urllib.parse

ROOT=Path(__file__).resolve().parents[1]


def readiness(health, require_archive=False, *, channels=None, archive_views=None, require_inference=False):
    if not isinstance(health,dict):return False, 'AI 健康响应格式无效'
    if not str(health.get('version','')).startswith('ainvr-s100p-reused-control-'):
        return False, '需要部署复用原控制器的 S100P BPU 服务'
    business = health.get('business', {})
    if not isinstance(business,dict) or business.get('license_phase') != 'valid':
        return False, '授权未生效或授权状态未知'
    capabilities=health.get('capabilities',{})
    if (health.get('status')!='ok' or business.get('ready') is not True or
            not isinstance(capabilities,dict) or capabilities.get('model_providers')!=['bpu']):
        return False, 'S100P BPU 服务依赖尚未就绪'
    if require_archive or require_inference:
        if not isinstance(channels,list) or any(not isinstance(c,dict) or
                not isinstance(c.get('config'),dict) or not isinstance(c.get('id'),str) for c in channels):
            return False, '无法确认 AI 通道状态'
        enabled=[c for c in channels if c['config'].get('enabled') is True]
        if require_archive:
            archived=[c for c in enabled if isinstance(c['config'].get('snapshot'),dict)
                and c['config']['snapshot'].get('enabled') is True]
            if not archived:return False, '尚未启用识别归档通道'
            if not isinstance(archive_views,dict) or any(not isinstance(archive_views.get(c['id']),dict)
                    or archive_views[c['id']].get('connected') is not True for c in archived):
                return False, '识别归档库尚未确认连接'
        if require_inference:
            if not enabled:return False, '尚未启用 AI 识别通道'
            for c in enabled:
                model=c['config'].get('model',{});stats=c.get('stats',{})
                if not isinstance(model,dict) or model.get('provider')!='bpu':
                    return False, '通道尚未配置 BPU 模型'
                if c.get('state')!='running':return False, 'AI 通道尚未启动识别'
                if (not isinstance(stats,dict) or type(stats.get('frame_count')) is not int or
                        type(stats.get('inference_count')) is not int or stats['frame_count']<=0 or
                        stats['inference_count']<=0 or stats.get('last_error')):
                    return False, '尚未确认当前通道产生真实推理结果'
    checks='授权与 BPU 服务依赖就绪'
    if require_archive:checks+='，归档连接已确认'
    if require_inference:checks+='，启用通道已产生推理计数'
    return True, checks+'；模型精度、真实归档写入和浏览器播放仍需专项验收'


def observations(opener, health, require_archive, require_inference):
    if not (require_archive or require_inference):return None,None
    # Credentials come from the locally provisioned service configuration and
    # are never printed or written to a result. This is a legitimate API read.
    config=json.loads((ROOT/'deploy/s100p/runtime/ai-service.json').read_text())
    server=config['server']
    headers={'X-Api-Key':server.get('api_key','')}
    base='http://127.0.0.1:'+str(server['port'])
    def read(route):
        with opener.open(urllib.request.Request(base+route,headers=headers),timeout=3) as r:return json.load(r)
    channels=read('/api/v1/channels')['channels']
    views={}
    if require_archive:
        for c in channels:
            if c.get('config',{}).get('enabled') is True and c['config'].get('snapshot',{}).get('enabled') is True:
                views[c['id']]=read('/api/v1/channels/'+urllib.parse.quote(c['id'],safe='')+'/snapshots/overview')
    return channels,views


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-archive', action='store_true')
    parser.add_argument('--require-inference',action='store_true',help='Require real inference counts for every enabled AI channel')
    parser.add_argument('--wait-seconds', type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.wait_seconds <= 300:
        parser.error('--wait-seconds must be between 0 and 300')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + args.wait_seconds
    while True:
        try:
            with opener.open('http://127.0.0.1:8000/health', timeout=3) as response:
                health=json.load(response)
            ok,message=readiness(health)
            if ok:
                channels,views=observations(opener,health,args.require_archive,args.require_inference)
                ok,message=readiness(health,args.require_archive,channels=channels,archive_views=views,
                    require_inference=args.require_inference)
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            ok, message = False, 'AI 健康接口不可用或响应无效'
        if ok or time.monotonic() >= deadline:
            print(message)
            raise SystemExit(0 if ok else 1)
        time.sleep(min(1, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()
