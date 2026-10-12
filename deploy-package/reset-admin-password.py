#!/usr/bin/env python3
"""Local sudo-only console password recovery; no default/backdoor password."""
import argparse
import getpass
import json
import os
import subprocess
import sys

# Reuse the deployed backend's hashing, encryption, transaction and audit code.
# Only code is passed in argv; the password travels through an anonymous pipe.
NODE_PROGRAM = r"""
import fs from 'node:fs';
import {PgConfigStore} from './dist/store/pgStore.js';
import {hashPassword, verifyPassword} from './dist/services/passwordHash.js';
import {ADMIN_PASSWORD_SECRET_KEY} from './dist/services/adminPasswordMigration.js';
let store;
try {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  const env=process.env;
  if(!env.CONFIG_PG_HOST || !env.CONFIG_PG_DATABASE || !env.CONFIG_MASTER_KEY_PATH)
    throw new Error('missing configuration');
  // CryptoStore normally generates missing keys. Recovery must NEVER do that.
  if(fs.readFileSync(env.CONFIG_MASTER_KEY_PATH).length<32)throw new Error('invalid master key');
  store=new PgConfigStore({masterKeyPath:env.CONFIG_MASTER_KEY_PATH,poolConfig:{
    host:env.CONFIG_PG_HOST,port:Number(env.CONFIG_PG_PORT||5432),
    user:env.CONFIG_PG_USER||'postgres',password:env.CONFIG_PG_PASSWORD||'',
    database:env.CONFIG_PG_DATABASE,max:1
  }});
  await store.getSecret(ADMIN_PASSWORD_SECRET_KEY);
  if(input.operation==='check') {
    process.stdout.write('CHECK_OK\n');
  } else if(input.operation==='reset') {
    if(typeof input.password!=='string' || input.password.length<8 || input.password.length>100)
      throw new Error('invalid password length');
    const hash=await hashPassword(input.password);
    await store.setSecret(ADMIN_PASSWORD_SECRET_KEY,hash,'local-root-reset');
    if(!await verifyPassword(input.password,await store.getSecret(ADMIN_PASSWORD_SECRET_KEY)))
      throw new Error('verification failed');
    process.stdout.write('RESET_OK\n');
  } else throw new Error('invalid operation');
} catch {
  // Database errors may include connection credentials. Never forward them.
  process.stderr.write('RESET_TOOL_FAILED\n');process.exitCode=1;
} finally {
  if(store)await store.pool.end();
}
"""


def run_backend(container, operation, password=None):
    payload = {'operation': operation}
    if password is not None:
        payload['password'] = password
    return subprocess.run(
        ['docker', 'exec', '-i', '--workdir', '/app', container,
         'node', '--input-type=module', '-e', NODE_PROGRAM],
        input=json.dumps(payload), text=True, capture_output=True, timeout=75,
        check=False,
    )


def valid_password(password):
    # Match JavaScript/Zod length (UTF-16 code units), including emoji passwords.
    return 8 <= len(password.encode('utf-16-le')) // 2 <= 100


def reset(container, password):
    result = None
    try:
        result = run_backend(container, 'reset', password)
    finally:
        # Even a timeout can mean COMMIT succeeded. Expire old in-memory sessions
        # and password caches without ever opening a password-free window.
        restarted = subprocess.run(
            ['docker', 'restart', '--time', '10', container],
            capture_output=True, text=True, timeout=60, check=False,
        )
        if restarted.returncode:
            raise RuntimeError('密码可能已写入，但控制台后端重启失败；请重启后端后再登录。')
    if result is None or result.returncode or 'RESET_OK' not in result.stdout.splitlines():
        raise RuntimeError('重置结果未确认，旧会话已清除；请检查数据库后重试，勿清空密码或主密钥。')


def main():
    parser = argparse.ArgumentParser(description='sudo 本地重置 Web 管理密码（不修改设备授权与业务数据）')
    parser.add_argument('--check', action='store_true', help='只读检查依赖、数据库与密钥；不改密码、不重启')
    parser.add_argument('--container', default='ainvr-backend', help='控制台后端容器名')
    args = parser.parse_args()
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        parser.exit(1, '请在开发板上用 sudo python3 运行本脚本。\n')
    if not args.container or args.container.startswith('-'):
        parser.error('无效容器名')
    try:
        checked = run_backend(args.container, 'check')
        if checked.returncode or 'CHECK_OK' not in checked.stdout.splitlines():
            raise RuntimeError('预检失败：请确认后端容器、数据库、现有主密钥及新版后端模块正常。未修改密码。')
        if args.check:
            print('检查通过：数据库和现有主密钥可用。未修改密码，未重启服务。')
            return 0
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise RuntimeError('必须在交互终端运行；不接受命令行、环境变量或管道传入密码。')
        print('此操作仅重置 Web 管理密码，并重启控制台后端、清除所有旧登录会话。')
        print('AI、录像、SRS、数据库和授权服务不会重启；控制台会短暂不可用。')
        password = getpass.getpass('新管理密码（8–100 字符）：')
        if not valid_password(password):
            raise RuntimeError('密码长度必须为 8–100（与网页相同）；未修改密码。')
        if password != getpass.getpass('再次输入新管理密码：'):
            raise RuntimeError('两次密码不一致；未修改密码。')
        if input('输入“重置管理密码”确认：').strip() != '重置管理密码':
            print('已取消，未修改密码。')
            return 0
        reset(args.container, password)
        print('管理密码已重置，旧会话已清除，已记录数据库审计。请稍候用新密码登录网页。')
        return 0
    except (KeyboardInterrupt, EOFError):
        print('\n操作中断；若已确认重置，请用新密码检查登录结果。', file=sys.stderr)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
    except (OSError, subprocess.SubprocessError):
        print('工具执行失败或超时；若已确认重置，结果可能已写入。请检查后端状态，必要时重启后端。', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
