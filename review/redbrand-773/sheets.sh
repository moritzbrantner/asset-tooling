#!/bin/bash
# sheets.sh <dir> <view> <clip>... : one sheet per call, rows of the clip's stills
d=$1; vw=$2; out=$3; shift 3
args=()
for c in "$@"; do for f in $(ls $d/$c-$vw-*.png | sort); do k=$(basename $f .png); args+=("${c}@${k##*-}=$f"); done; done
python3 $(dirname $0)/sheet.py $out 6 "${args[@]}"
