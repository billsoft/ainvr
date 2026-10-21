#!/bin/bash
# Move D: directories to F: (copy -> verify every file's size, plus sha256 where a .sha256 exists -> delete source).
# usage: move_to_f_v1.sh SRC_DIR DST_PARENT
set -u
SRC=$1; DST=$2/$(basename "$SRC"); LOG=/f/move-to-f.log
mkdir -p "$2"; [ -e "$DST" ] && { echo "$(date -Is) SKIP exists $DST" >> $LOG; exit 1; }
cp -a "$SRC" "$DST" || { echo "$(date -Is) FAIL copy $SRC" >> $LOG; exit 1; }
bad=0
while IFS= read -r -d '' f; do
  rel=${f#$SRC/}; [ "$(stat -c %s "$f")" = "$(stat -c %s "$DST/$rel")" ] || { echo "size mismatch $rel" >> $LOG; bad=1; }
done < <(find "$SRC" -type f -print0)
for s in $(find "$DST" -name '*.sha256'); do
  want=$(cut -d' ' -f1 "$s"); f=${s%.sha256}; [ -f "$f" ] && [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$want" ] && { echo "sha mismatch $f" >> $LOG; bad=1; }
done
if [ $bad = 0 ]; then
  n=$(find "$SRC" -type f | wc -l); rm -rf "$SRC"
  echo "$(date -Is) MOVED $SRC -> $DST files=$n size=$(du -sh "$DST" | cut -f1)" >> $LOG
else
  echo "$(date -Is) VERIFY FAILED $SRC (source kept)" >> $LOG; exit 1
fi
