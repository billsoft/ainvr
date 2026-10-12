# 离线授权 v3：签名、安装绑定与恢复

## 范围与边界

面向开发母版和离线设备，不要求联网、不增加业务数据库依赖、不烧熔丝。目标是防止取得设备对称密钥后自行签发、重复注册码重新计时、删除一个授权目录后旧码续期。不承诺防止 root 修改程序、完整磁盘回滚、窃取发行方私钥或回滚全部本地信任记录。

## 信任与数据

- 注册机使用 Ed25519 私钥签发。私钥和 SQLite 签发台账只在发行方电脑，禁止进入 Git、设备、发布包。
- `license-service/src/trusted_keys.hpp` 内置公钥与密钥编号；公钥允许公开。更换签发私钥需要明确的公钥升级和兼容迁移，不能重新运行初始化覆盖现有私钥。
- 设备原 `device_key` 仅用于本地状态完整性等现有用途，不能签发 v3 注册码。消费者信号协议仍为 v2，保持 Python/C++/TS 客户端的连续运行策略。
- 三份计时状态继续使用主文件唯一提交点和异步副本。独立安装登记必须显式配置 `installation_path`，标准供应路径为 `/var/lib/ainvr-license-identity/identity.json`，与 `/var/lib/ainvr-license/` 分离。它记录随机安装标识、授权序号高水位、注销记录和恢复挑战值；服务同时独占主状态和登记，测试不能共用生产文件。
- 安装登记用独立域的 HMAC 保护。它是普通文件，不是硬件信任根；目录分离用于防误删和简单清空攻击。

## 注册码与申请

完整申请前缀 `AINVR-REQ3-`，包含机器码、随机安装标识、授权序号下限、用途及恢复挑战值。短机器码保留用于识别设备，不能单独签发 v3。

注册码为 `AINVR-LIC3-<base64url JSON>.<base64url signature>`。签名覆盖域分隔串 `AINVR/license/v3|` 和原始编码载荷，禁止重编码后验签。验证编码规范、签名、产品、版本、整数范围、机器与安装绑定。

载荷含 v、product、policy、kid、machine_code、installation_id、license_id、grant_seq、duration_minutes、issued_at、purpose、challenge、legacy_token_hash、activation_wall。正常授权与恢复授权的最后两字段为空和零，只有受控迁移凭据携带旧授权摘要与原激活时间。

`issued_at` 用于台账审计，不用不可信系统墙钟实现虚假的强防重放。不设置隐式几天激活窗口，以免离线延期安装失效。防重放依据安装标识、授权序号和恢复挑战。

## 激活与计时

- 正常授权成功后以本次激活作为起点，替换旧剩余时长；不做时长叠加。
- 当前相同注册码重试幂等，不重置计时；已注销授权和旧序号不可重用。
- 继续使用现有内部单调计时、系统时间只快进、持久化预算和消费者已验证授权截止机制。
- 身份高水位先落盘，主状态后提交；中间断电最多要求恢复，不能产生额外权益。身份登记只在激活、注销和恢复等低频事件更新，不跟随每次计时预算写盘。
- 主状态提交成功后才返回激活成功。副本异步，不能拖住可用预算发布。

## 丢失与恢复

- 主文件存在且有效、仅副本缺失：正常运行并补写副本。
- 主文件损坏、缺失，或已激活安装的所有状态缺失：`recovery_required`，生成并持久化随机恢复挑战；普通旧码不能激活。
- 安装登记损坏且主状态仍能通过当前设备密钥认证：保留 `.invalid.<随机值>` 取证副本，创建新安装标识并要求恢复。若登记与主状态均无法认证，拒绝启动且保留文件，先排查错密钥或存储损坏，不自动替换安装标识。
- 安装登记与状态全部删除：会产生全新随机安装标识，原注册码不匹配；需要发行方重新签发。发行方应按机器码台账识别同一设备，不能自动赠送完整时长。
- 恢复申请只在进入恢复状态时创建一次；刷新页面和重启不会换掉有效挑战。恢复成功消耗挑战；下一次状态丢失生成新挑战，旧恢复码不能再次重置时长。
- 发行方使用 `--recover` 显式确认剩余分钟数。完全离线且状态全部丢失时，无法准确推导已用时间，必须人工核对权益，不能把请求中的序号/时长当作可信凭据。
- 临时存储故障不等同于确认篡改；沿用现有存储降级策略。时钟错误需修正时钟并重启，恢复码不能作为绕过时钟校验的手段。
- 登录、授权管理、系统管理等恢复基础服务保持可访问，业务按现有门控处理。

## 旧授权迁移

一次性签名迁移票据绑定旧授权编号、序号、时长、token_hash、激活起点及新安装标识。通过配置 `migration_file` 提供，不能通过普通激活 API 使用。

服务读取经原 HMAC 验证的旧状态，对照票据后保留 used_ns、reserved_ns、activation_wall 等字段，并按原启动算法处理间隔。新状态为 schema 3，包含签名凭据与安装标识。安装登记提交高水位后不能再次以旧状态迁移。完成后移除 `migration_file` 配置并封存票据；新装设备无需此字段。

程序在创建或更新登记前检查旧状态和迁移票据。缺票据或票据与旧授权不匹配时直接退出，不生成安装标识或恢复挑战，补正票据后可重试。登记写入保留独占锁；授权申请使用原子发布的只读快照，不等待管理器锁或登记 fsync。仅成功持久化后发布新快照，日志 `identity_write` 记录耗时、成败、序号及注销标志，不记录密钥或注册码。

禁止用重新签发完整六个月代替迁移。回滚程序时也应保留授权已用量；旧二进制不理解 schema 3，不能直接降级上线。

迁移材料的生成与签发（不包含设备密钥）：

```bash
# 旧板，只读导出；目标目录必须不存在
sudo python3 license-service/deploy/export_migration.py --out /受保护目录/迁移申请
# 签发电脑，MINUTES 必须等于原 total_seconds / 60；人工核对原权益
python tools/license-keygen/issuer_v3.py --request-file request.txt \
  --migration-record migration-record.json --minutes "$MINUTES" --output migration.lic
```

只把签名票据传回原板，设为 root:ainvr、0640，在服务配置中用绝对路径指定。先用状态副本在独立端口/状态目录预演，验证激活起点、授权编号、总时长相同且已用量不减，再备份并迁移正式状态。Windows CRLF 票据与 Linux LF 均可读取。迁移会沿用现有启动时预留预算结算，可能保守扣除尚未使用的预留时间，不会重置或增加权益。

## 注册机用法

默认私有目录为发行方用户目录下 `.ainvr-license-issuer/v3`。备份私钥、public.json、issued-v3.sqlite3；Windows 用用户 ACL 限制目录访问。Python 依赖 cryptography。

```bash
# 仅首次生成签发密钥；已有密钥会拒绝覆盖
python tools/license-keygen/issuer_v3.py --init-key --export-header license-service/src/trusted_keys.hpp
# 授权页面复制完整申请，保存为 request.txt
python tools/license-keygen/keygen.py --request-file request.txt --minutes 259200 --output license.txt
# 恢复：分钟数是核对后的剩余权益，不默认给完整原时长
python tools/license-keygen/keygen.py --request-file recovery.txt --minutes 12345 --recover --output recovery-license.txt
```

相同申请、用途与分钟数重复签发返回台账中同一个注册码，避免误操作产生新权益。并发签发使用 SQLite 写事务；签发完成先持久化台账后输出注册码。

## 验证与部署

隔离测试覆盖签名/字段篡改、设备和安装不匹配、拒绝旧格式、重复激活、删除三份状态、删除身份与状态、恢复码二次重放、注销后回滚旧授权、身份损坏、只缺副本、迁移保留计时、网页复制完整申请。

编译在独立 out/build 目录，绝不覆盖运行中的文件；原子安装二进制。systemd 同时允许写 `ainvr-license` 和 `ainvr-license-identity` 两个状态目录。部署包校验授权二进制 `--license-policy` 必须返回 `mandatory-v3-ed25519`，禁止把旧授权二进制打包到新版。
