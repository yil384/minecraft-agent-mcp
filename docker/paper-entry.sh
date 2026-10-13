#!/bin/sh
# docker/paper-entry.sh - Paper in its container. The world and its config live in /data (./data/world), the console is
# the FIFO /console/console.in (the agent writes whitelist and spreadplayers lines there; the camera its spectator
# commands). Settings come from compose.yaml (from .env): MINECRAFT_EULA, SEED, DIFFICULTY, DAYLIGHT=cycle|locked,
# NETHER, BORDER (the Overworld's world border as a width in blocks; the Nether's is an eighth), MEMORY, MOTD, BSTATS.
#
# Offline mode and no password: anyone who can open a connection could join under a bot's name. So the server listens
# on 127.0.0.1 inside the stack's own network namespace (nothing outside the stack reaches it), only listed players get
# in (the agent lists each bot just before it joins, MC_WHITELIST; the camera lists itself), the server list shows no
# names, and bots have names nobody can guess.
set -eu

if [ "${MINECRAFT_EULA:-false}" != "true" ]; then
  echo "The Minecraft EULA has not been accepted, so the server does not start." >&2
  echo "Read it at https://aka.ms/MinecraftEULA and, if you agree, set MINECRAFT_EULA=true in .env (./setup.sh asks)." >&2
  exit 64
fi

cd /data
echo "eula=true" > eula.txt   # MINECRAFT_EULA=true: the person who runs this server accepted the Minecraft EULA
# one line for server.properties: no line breaks or backslashes (they would add settings), at most 59 characters
MOTD_LINE=$(printf '%s' "${MOTD:-Agent game server}" | tr -d '\r\n\\' | cut -c1-59)
cat > server.properties <<P
online-mode=false
server-ip=${SERVER_IP:-127.0.0.1}
server-port=25565
level-seed=${SEED:-}
spawn-protection=0
difficulty=${DIFFICULTY:-normal}
gamemode=survival
max-players=${MAX_PLAYERS:-16}
view-distance=8
simulation-distance=6
enable-command-block=false
motd=${MOTD_LINE}
white-list=true
enforce-whitelist=true
hide-online-players=true
allow-nether=${NETHER:-true}
P
# every bot (and the camera) joins from one address: Paper's per-address connection throttle (4 s) would refuse the
# second of two joins within 4 s. The server is private: no throttle.
if [ -f bukkit.yml ]; then sed -i 's/^\( *connection-throttle:\).*/\1 -1/' bukkit.yml; else printf 'settings:\n  connection-throttle: -1\n' > bukkit.yml; fi
# bStats (bundled with Paper) sends anonymous server statistics to bstats.org unless it is turned off: off by default
mkdir -p plugins/bStats
if [ "${BSTATS:-false}" = "true" ]; then B=true; else B=false; fi
printf 'enabled: %s\nserverUuid: %s\nlogFailedRequests: false\n' "$B" "$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo 00000000-0000-0000-0000-000000000000)" > plugins/bStats/config.yml.new
if [ -f plugins/bStats/config.yml ]; then sed -i "s/^enabled:.*/enabled: $B/" plugins/bStats/config.yml; rm -f plugins/bStats/config.yml.new; else mv plugins/bStats/config.yml.new plugins/bStats/config.yml; fi
# the camera's datapack, fresh at every start; Paper enables a new one by itself
mkdir -p world/datapacks && rm -rf world/datapacks/agentcam && cp -r /opt/paper/datapacks/agentcam world/datapacks/
rm -f /console/console.in && mkfifo /console/console.in && chmod 666 /console/console.in
# the world keeps its game rules and difficulty in level.dat, so both are set again at every start, either way:
# DAYLIGHT=locked stops the clock at morning, cycle starts it again (a world that was locked stays locked otherwise)
( until grep -q 'Done (' logs/latest.log 2>/dev/null; do sleep 2; done
  if [ "${DAYLIGHT:-cycle}" = locked ]; then printf 'gamerule doDaylightCycle false\ntime set day\n' > /console/console.in
  else printf 'gamerule doDaylightCycle true\n' > /console/console.in; fi
  printf 'difficulty %s\n' "${DIFFICULTY:-normal}" > /console/console.in
  # the world border, Overworld and Nether (Paper keeps one per world): the world on disk stays bounded
  B=${BORDER:-20000}
  printf 'worldborder center 0 0\nworldborder set %s\nexecute in minecraft:the_nether run worldborder center 0 0\nexecute in minecraft:the_nether run worldborder set %s\n' "$B" "$((B / 8))" > /console/console.in ) &
exec java -Xms1G -Xmx"${MEMORY:-3G}" -jar /opt/paper/paper.jar --nogui <> /console/console.in
