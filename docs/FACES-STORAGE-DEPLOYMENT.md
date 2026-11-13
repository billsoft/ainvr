# 人脸照片 SSD namespace 部署检查

人脸照片复用 OS Helper `/storage/volumes` 返回的唯一可选、已挂载、非系统、可写卷；文件位于卷根目录的 `ainvr-faces/`。卷标识和实际设备号均需通过后端校验，不使用系统盘兜底。

## 初始化与权限

必须在 SSD 挂载验证之后、启动 BFF 之前初始化私有 namespace。不要把 `selectable:true` 理解为“挂载根目录对 BFF 用户可写”。`.190` 的 `ainvr-backend.service` 使用 `sunrise`；SSD 根目录由 `root:root` 持有且权限为 755。

以下命令用于当前 `.190` 部署，由部署管理员执行；更换设备时应先核对 OS Helper 返回的卷路径和实际 BFF 用户：

```sh
mountpoint -q /mnt/ainvr-ssd || exit 1
test "$(stat -c %d /mnt/ainvr-ssd)" != "$(stat -c %d /)" || exit 1
test ! -L /mnt/ainvr-ssd/ainvr-faces || exit 1
if test -e /mnt/ainvr-ssd/ainvr-faces; then
  test -d /mnt/ainvr-ssd/ainvr-faces || exit 1
fi
install -d -m 0700 -o sunrise -g sunrise /mnt/ainvr-ssd/ainvr-faces
runuser -u sunrise -- test -w /mnt/ainvr-ssd/ainvr-faces
```

不得修改 SSD 根目录权限、递归修改其他业务目录、提升后端运行用户为 root，或在 SSD 未挂载时创建系统盘回退目录。目录初始化只调整上述 namespace；不修改既有证据文件。

## 现网诊断与验收

2026-11-12 `.190` 故障为 namespace 未预建，非 root BFF 创建目录遭遇 `EACCES`。OS Helper 卷数据、SSD 设备号和录像存储均正常。`capture-sources` 返回空数组仅代表没有配置抓拍来源，与照片 maintenance 故障无关。

预建目录可使原有 maintenance 在下一周期重试恢复，不需要为此重编或重启服务。若仍失败，分别检查 BFF 用户、卷挂载、设备号与 namespace 权限；不能仅凭录像 health 成功推定所有业务目录可写。

实际 IO 必须使用 BFF 用户和现有卷回调，创建唯一 UUID 照片，验证 `publish → read/hash → 同请求重试 → remove`，并在 finally 中只清理本次 UUID。不得以 root 的写入成功或内存照片替身作为验收。

本次 `sunrise`（uid 1000）真实 JPEG 12,852 字节验收通过，临时照片已删除。脚本及日志位于 ignored 目录 `test/results/face-storage-20261113/`（目录名为留存标识）：`faces-ssd-smoke.mts`、`smoke.log`。没有启动 native 或覆盖 dist。

另有独立代码修补：临时 hardlink 恢复后，对已固定的 `/proc/self/fd/N/.` 打开目录并同步；不能对 fd 符号链接本身使用末级 `O_NOFOLLOW`。它不影响本次 EACCES 的权限修复，随后续 BFF 增量发布应用。
