# 里程碑修复生产部署记录

## 范围和验收

2026-10-05 14:29 开始部署（北京时间）。9 项已确认问题修复；部署前 524 个文件哈希与已验证版本一致，git diff --check 通过。此前针对性测试：后端 40、录像 10、C++ 71 项通过。

- AI：原子替换独立目录构建产物；运行文件 SHA256 为 `269addc4bc8ae59659442ea88af980dba0fdf33639618c2fe0947232d93707cb`。
- 后端：重新构建并单独重建容器；镜像 `4f4a5ad86e04a692e6d2d951a0895759259d24529570e5657ba38d0ea6a471f6`。
- 录像：确认运行模块指向项目 src，重启加载修复。四路录像恢复且有新 MP4 产出。
- AI 两路 running、两路归档连接正常，归档日志持续写入、write_error_count=0；网页 HTTP 200；后端 PG 启动成功，授权 valid。
- AI/录像/后端自动重启计数均 0。SRS 保持 10 月 3 日的启动时间；数据库、授权服务未替换。

## 观察边界

这是部署后短时验收，不代表长期零故障保证。启动日志仍有 TensorRT engine 跨设备型号提示、OpenCV 提示和发布队列反压提示；尚不能仅凭这些提示判断功能失败。录像启动后有一次压力现场日志，需继续观察；当前未见新的丢弃或 ERROR/CRITICAL。服务重启本身会造成短暂录像/AI 输出间断，请从部署结束后评估自发故障。

## 后续日志入口

在 /home/sunrise/ainvr 下：

```sh
tail -F ai-service/logs/ai_service.log
journalctl -u ainvr-recorder --since '2026-10-05 14:30:02' -f
docker logs --since 2026-10-05T06:30:16Z -f ainvr-backend
```

重点关注 AI archive_pipeline 的 write_error_count、dropped_count、queue_depth 与帧率；录像 backlog、dropping、writerWaitSec；后端 PG/鉴权失败及发布审计错误。日志可能含内部标识，分享前检查敏感内容。

## 回退与交付状态

旧 AI 程序：out/deploy-backups/milestone-20261005/ai_service.before；旧后端镜像：ainvr-backend:before-milestone-20261005。AI 删除代次协议的回退限制见重构设计，不可直接回退并重放旧 pending。

本记录对应 14:29 部署时点；后续回放修复已更新前端及录像，并于 15:29 恢复生产，离线包同步更新。最新产物及校验清单见 out/RELEASE-20261005-152709.md，提交状态以 Git 为准。
