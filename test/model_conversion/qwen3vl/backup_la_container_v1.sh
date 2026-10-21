#!/bin/bash
# Back up the LocateAnything compile container before deletion (user decision 2026-10-21):
#  1) current v320 lineage dirs in full (tar, symlinks/owners preserved);
#  2) every other /opt entry: small files only (status/logs/json/scripts/md), big binaries excluded.
# Each archive is verified by re-listing it; results in $B/backup-report.txt.
export MSYS_NO_PATHCONV=1
B=/f/la-container-backup-20261021; C=ainvr-locateanything-w4-20261014; R=$B/backup-report.txt
LINEAGE="locate-text-gptq-row8-v307 locate-official-qwen-group-gptq8-0-8-v312 locate-official-qwen-group-gptq8-9-17-v312 locate-official-qwen-group-gptq8-18-26-v312 locate-official-qwen-group-gptq8-27-35-v312 locate-text-gptq8-group-0-8-o2-v318 locate-text-gptq8-group-9-17-o2-v318 text-gptq8-packages-v312 locate-vocabulary-embedding-v1 locate-vocabulary-head-v1 locate-oellm-research-v1"
: > $R
for d in $LINEAGE; do
  src=$(docker exec $C bash -c "cd /opt && find $d | wc -l")
  docker exec $C tar cf - -C /opt $d > $B/$d.tar
  got=$(tar tf $B/$d.tar | wc -l)
  echo "$d files_in_container=$src entries_in_tar=$got size=$(du -h $B/$d.tar | cut -f1) $([ $src = $got ] && echo OK || echo MISMATCH)" >> $R
done
docker exec $C bash -c "cd /opt && ls" > $B/opt-listing.txt
docker exec $C bash -c "cd /opt && tar cf - --exclude='*.bc' --exclude='*.hbo' --exclude='*.hbm' --exclude='*.npy' --exclude='*.npz' --exclude='*.safetensors' --exclude='*.pt' --exclude='*.pth' --exclude='*.bin' --exclude='*.onnx' --exclude='*.tar' --exclude='*.tar.gz' --exclude='*.zip' --exclude='*.whl' --exclude='*.so' --exclude='*.jpg' --exclude='*.png' --exclude='*.mlir' ." > $B/opt-metadata-only.tar
echo "opt-metadata-only entries=$(tar tf $B/opt-metadata-only.tar | wc -l) size=$(du -h $B/opt-metadata-only.tar | cut -f1)" >> $R
echo DONE >> $R
