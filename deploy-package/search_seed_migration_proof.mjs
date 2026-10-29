// Read-only proof for exactly migration 020. Never returns config/secret values.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const migrationSha = '7c0216e379778852b2741fe20108826dfac959f5167d4935c83717bb1f285002';

export async function searchSeed020Proof(client, root) {
  const sql = await readFile(path.join(root, 'srs-web-console/backend/src/store/migrations/020_search_siglip2_default.sql'), 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== migrationSha) throw new Error('migration_proof_contract');
  const seedLiteral = sql.match(/legacy_seed JSONB := '([\s\S]*?)'::jsonb;/);
  const qualification = sql.match(/SELECT d\.id, state\.desired_version INTO document_id, previous_version\s+(FROM[\s\S]+?)\s+FOR UPDATE OF d,state;/);
  if (!seedLiteral || !qualification) throw new Error('migration_proof_contract');
  const legacy = JSON.parse(seedLiteral[1]);
  if (legacy.model?.package_id !== 'siglip-so400m-i18n-full-int8' || legacy.enabled !== false)
    throw new Error('migration_proof_contract');
  const target = { ...legacy, model: { package_id: 'siglip2-base-full-int8' } };
  // Reuse the trusted migration's complete qualification, without FOR UPDATE
  // or writes. A later migration edit cannot silently broaden this predicate.
  const from = qualification[1].replace(/\blegacy_seed\b/g, () => '$1::jsonb');
  const eligibleRows = (await client.query(`SELECT d.id::text AS document_id,state.desired_version,
    to_jsonb(d)-ARRAY['created_at','updated_at'] AS document,
    jsonb_set(to_jsonb(d)-ARRAY['created_at','updated_at'],'{config,model,package_id}',
      to_jsonb('siglip2-base-full-int8'::text),false) AS expected_document ${from}`, [legacy])).rows;
  if (eligibleRows.length > 1) throw new Error('migration_proof_ambiguous');
  const completedRows = (await client.query(`SELECT d.id::text AS document_id,a.version_before,a.version_after,
    to_jsonb(d)-ARRAY['created_at','updated_at'] AS document
    FROM config_documents d
    JOIN config_service_states state ON state.service_name='search-service'
    JOIN config_audit_logs a ON a.service='search-service' AND a.actor='migration' AND a.action='publish'
      AND a."group"='system' AND a.config_name='settings'
      AND a.detail='{"initial_default_only":true,"previous_package":"siglip-so400m-i18n-full-int8","package":"siglip2-base-full-int8","enabled":false}'::jsonb
    JOIN config_versions v ON v.version=a.version_after AND v.status='published' AND v.published_by='migration'
      AND v.change_summary='智能搜索未修改默认选型调整为 SigLIP2 Base 256；保持关闭'
    JOIN config_snapshots snapshot ON snapshot.version_id=v.id AND snapshot.service=d.service
      AND snapshot."group"=d."group" AND snapshot.name=d.name AND snapshot.config=$2::jsonb
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings'
      AND d.config=$2::jsonb AND d.description='智能录像搜索（默认关闭）'
      AND state.desired_version=a.version_after AND a.version_before<a.version_after
      AND d.updated_at=a.created_at AND v.created_at=a.created_at AND v.published_at=v.created_at
      AND snapshot.created_at=a.created_at
      AND (SELECT count(*) FROM config_documents WHERE service='search-service')=1
      AND (SELECT count(*) FROM config_audit_logs WHERE service='search-service')=1
      AND NOT EXISTS(SELECT 1 FROM config_secrets WHERE key_path LIKE 'search-service/%')
      AND EXISTS(SELECT 1 FROM config_versions initial JOIN config_snapshots original ON original.version_id=initial.id
        WHERE initial.published_by='migration' AND initial.change_summary='初始化智能录像搜索：保持关闭'
          AND initial.created_at=d.created_at AND original.created_at=d.created_at
          AND original.service=d.service AND original."group"=d."group" AND original.name=d.name AND original.config=$1::jsonb)
      AND EXISTS(SELECT 1 FROM config_versions previous JOIN config_snapshots old ON old.version_id=previous.id
        WHERE previous.version=a.version_before AND old.service=d.service AND old."group"=d."group" AND old.name=d.name AND old.config=$1::jsonb)
      AND NOT EXISTS((SELECT service,"group",name,config FROM config_documents)
        EXCEPT (SELECT service,"group",name,config FROM config_snapshots WHERE version_id=v.id))
      AND NOT EXISTS((SELECT service,"group",name,config FROM config_snapshots WHERE version_id=v.id)
        EXCEPT (SELECT service,"group",name,config FROM config_documents))`, [legacy, target])).rows;
  if (completedRows.length > 1) throw new Error('migration_proof_ambiguous');
  const eligible = eligibleRows[0]; const completed = completedRows[0];
  return {
    migration_sha256: migrationSha,
    eligible: eligible ? { document_id: eligible.document_id, desired_version: eligible.desired_version,
      document_hash: hash(eligible.document), expected_after_hash: hash(eligible.expected_document) } : null,
    completed: completed ? { document_id: completed.document_id, version_before: completed.version_before,
      version_after: completed.version_after, document_hash: hash(completed.document) } : null,
  };
}
