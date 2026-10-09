#!/usr/bin/env bash
# Tests for extensions/workspace-swarm.ts (run through pi, needs a model for T1).
#
# -ne (not -na): only what we name with -e loads, so a user-level install of this same
# package cannot double-load the extension under test. -ne also drops package-provided
# *providers*, so the model's provider must be named too — override the list with
# PI_TEST_PACKAGES (e.g. PI_TEST_PACKAGES="-e npm:pi-anthropic") if you use another.
# Deterministic: each case runs pi in print mode (the way loop.sh does) with a
# probe that dumps the outbound message array and then exits, so delivery is
# asserted from the request itself — no model call, no asking a model to quote
# its own context. T1 is the one real turn, to prove print mode still exits.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
R="$(cd "$D/../.." && pwd)"
EXT="$R/extensions/workspace-swarm.ts"
PROBE="$D/probe.ts"
read -ra PKGS <<< "${PI_TEST_PACKAGES:--e npm:pi-lmstudio}"
P="$D/.tmp"
rm -rf "$P"; mkdir -p "$P/.pi/cursors"
BUS="$P/.pi/swarm.jsonl"; : > "$BUS"
pass=0 fail=0
ok()  { printf '  PASS  %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  FAIL  %s  [%s]\n' "$1" "$2"; fail=$((fail+1)); }

say() { # sender chan content
  SWARM_BUS="$BUS" SWARM_SENDER="$1" SWARM_CHAN="$2" SWARM_CONTENT="$3" python3 -c '
import json,os,datetime
open(os.environ["SWARM_BUS"],"a").write(json.dumps({
  "sender":os.environ["SWARM_SENDER"],"channel":os.environ["SWARM_CHAN"],
  "content":os.environ["SWARM_CONTENT"],"timestamp":datetime.datetime.now().isoformat()})+"\n")'
}
run() { # tag [pi tool flag: -nt default, -t <names>] -> context dumped to $P/$tag.json
  local tag="$1" tools="${2--nt}"   # ${2:-} would turn an explicit "" back into -nt
  ( export SWARM_DUMP="$P/$tag.json" SWARM_TOOLS="$P/tools.json" PI_AGENT_NAME="$tag" \
      PI_SWARM_CURSOR="${CS:-}" PI_SWARM_SELF_PREFIX="loop-" PI_SWARM_CHANNEL=loop
    cd "$P" && pi -ne ${PKGS[@]+"${PKGS[@]}"} -e "$EXT" -e "$PROBE" --mode json $tools -p "x" >"$P/$tag.log" 2>&1 )
}
got()   { [ -s "$P/$1.json" ] && grep -qF -- "$2" "$P/$1.json"; }        # in outbound context
nogot() { ! got "$1" "$2"; }

sender() { # tag msg — runs the extension's real send_swarm_message execute, no model call
  local tag="$1" msg="$2"
  ( export SWARM_TOOL_CALL="$msg" SWARM_TOOL_OUT="$P/$tag.send.json" EXT_UNDER_TEST="$EXT" \
      PI_AGENT_NAME="$tag" PI_SWARM_CHANNEL=loop
    # The probe imports the extension itself (pi hands each extension a private
    # API closure, so this is the only way to reach the real execute).
    cd "$P" && pi -ne ${PKGS[@]+"${PKGS[@]}"} -e "$PROBE" --mode json -nt -p "x" >"$P/$tag.send.log" 2>&1 )
}

CS=brandnew
echo "T0 a brand-new read head starts at EOF (nobody drowns in old history)"
say old-guy loop "CANARY-OLD predates this agent"
run a0;  nogot a0 "CANARY-OLD" && ok "old backlog not injected" || bad T0a "injected old history"
say old-guy loop "CANARY-NEW arrived after it joined"
run a1;  got a1 "CANARY-NEW"   && ok "live traffic delivered" || bad T0b "missed live traffic"

echo "T1 a print-mode run still completes and exits (old bug: never exited)"
( export PI_AGENT_NAME=t1 PI_SWARM_CURSOR=t1c PI_SWARM_CHANNEL=loop PI_SWARM_SELF_PREFIX=loop-
  cd "$P" && pi -ne ${PKGS[@]+"${PKGS[@]}"} -e "$EXT" --mode json -nt -p "Reply with exactly: OK" >"$P/t1.log" 2>&1 )
rc=$?; grep -qiE '"text":"ok' "$P/t1.log" && [ "$rc" = 0 ] \
  && ok "real turn finished, rc=0" || bad T1 "rc=$rc $(tail -c 200 "$P/t1.log")"

CS=loop
echo "T2 one shared read head = one conversation across fresh contexts"
run b0                                  # establishes the shared head at EOF
say loop-1 loop "CANARY-7F3 handoff: try a lower LR"
run b1;  got b1 "CANARY-7F3"  && ok "loop-2 read what loop-1 said" || bad T2a "not delivered"
got b1 "PRIOR ITERATIONS OF YOU" && ok "own-loop senders labelled as self, not peers" || bad T2b "no self label"
say human-9 loop "CANARY-PEER from outside the loop"
run b2;  got b2 "PEER AGENTS" && ok "foreign senders still labelled as peers" || bad T2c "no peer label"
run b3;  nogot b3 "CANARY"    && ok "nothing replayed (read head advanced)" || bad T2d "replayed"

echo "T3 a half-written line is not consumed (old bug: offset ate it)"
printf '{"sender":"loop-1","channel":"loop","content":"CANARY-8A2 done"}\n{"sender":"loop-1","channel":"loop","content":"CANARY-9B' >> "$BUS"
run c1
got c1 "CANARY-8A2" && ok "complete line delivered" || bad T3a "complete line lost"
nogot c1 "CANARY-9B" && ok "partial line left for the next drain" || bad T3b "consumed a partial line"
off=$(python3 -c "import json;print(json.load(open('$P/.pi/cursors/loop.json'))['lastByteOffset'])")
size=$(wc -c <"$BUS" | tr -d ' ')
[ "$off" -lt "$size" ] && ok "read head stopped at the last newline ($off < $size)" || bad T3c "head ran past ($off)"
printf 'tail"}\n' >> "$BUS"
run c2;  got c2 "CANARY-9B" && ok "the finished line arrived on the next drain" || bad T3d "partial lost for good"

echo "T4 cursor garbage collection (old bug: corpses accumulate forever)"
now=$(date -u +%FT%T.000Z); old=$(date -u -v-60d +%FT%T.000Z)
printf '{"lastByteOffset":7,"channel":"general","agent":"agent-111","updatedAt":"%s"}' "$old" > "$P/.pi/cursors/agent-111.json"
printf '{"lastByteOffset":7,"channel":"general","agent":"agent-222","updatedAt":"%s"}' "$now" > "$P/.pi/cursors/agent-222.json"
run c3
[ ! -f "$P/.pi/cursors/agent-111.json" ] && ok "60-day corpse pruned" || bad T4a "stale kept"
[ -f "$P/.pi/cursors/agent-222.json" ] && ok "fresh peer kept" || bad T4b "fresh pruned"
[ "$(python3 -c "import json;print(json.load(open('$P/.pi/cursors/agent-222.json'))['lastByteOffset'])")" = 7 ] \
  && ok "another agent's read head untouched" || bad T4c "clobbered"
[ -f "$P/.pi/cursors/loop.json" ] && ok "own cursor survives its own GC" || bad T4d "pruned myself"

echo "T5 tools registered, and identity is no longer baked in as the empty string"
CS=t5 run t5 ""          # tools enabled: -nt would legitimately hide them
for t in send_swarm_message get_swarm_history swarm_status; do
  grep -qF "\"name\":\"$t\"" "$P/tools.json" && ok "$t registered" || bad T5a "$t missing"
done
grep -qF "You are ''" "$P/tools.json" && bad T5b "tool still says You are ''" || ok "no 'You are \`\`' identity bug"

echo "T6 send_swarm_message writes to the bus, and a peer receives it (old bug: appendFileSync(data,'a') threw ERR_INVALID_ARG_VALUE, so every send died)"
sender t7peer "CANARY-SENDER 4C91 from a peer"
grep -qF "CANARY-SENDER 4C91" "$BUS" && ok "the tool put a line on the bus" || bad T6a "bus untouched: $(tail -c 200 "$P/t7peer.send.log" | tr '\n' ' ')"
if grep -qF 'Sent to #loop' "$P/t7peer.send.json" 2>/dev/null && grep -qF 'CANARY-SENDER 4C91' "$P/t7peer.send.json"; then ok "execute returned its sent-receipt with the record appended"
else bad T6b "execute failed: $(head -c 300 "$P/t7peer.send.json" 2>/dev/null)"; fi
if grep -qiE "invalid encoding|ERR_INVALID_ARG_VALUE" "$P/t7peer.send.log" "$P/t7peer.send.json" 2>/dev/null; then bad T6c "appendFileSync still gets an open flag as encoding"
else ok "no encoding error"; fi
CS=t7bus run t7head                            # shared head joins at EOF
sender t7peer2 "CANARY-ROUNDTRIP 8D22 handoff"
CS=t7bus run t7read; got t7read "CANARY-ROUNDTRIP 8D22" && ok "a fresh context read what the tool sent" || bad T6d "sent but never delivered"
CS=t7bus run t7read2; nogot t7read2 "CANARY-ROUNDTRIP" && ok "and read it exactly once" || bad T6e "replayed"

echo "T7 bus is never read whole into memory (get_swarm_history tail-reads)"
python3 -c "
import json,datetime
open('$BUS','a').write(json.dumps({'sender':'x','channel':'loop','content':'PAD-'+'z'*900000,'timestamp':datetime.datetime.now().isoformat()})+'\n')"
run d1; [ -s "$P/d1.json" ] && ok "survived a 900KB log (context built fine)" || bad T7 "context never built"

echo; echo "PASS=$pass FAIL=$fail"; [ "$fail" = 0 ] || exit 1
