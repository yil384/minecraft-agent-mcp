# the eye's block and its 6 neighbours: itself, east, west, up, down, south, north (agentcam:note)
execute positioned ~ ~ ~ run function agentcam:nb
execute positioned ~1 ~ ~ run function agentcam:nb
execute positioned ~-1 ~ ~ run function agentcam:nb
execute positioned ~ ~1 ~ run function agentcam:nb
execute positioned ~ ~-1 ~ run function agentcam:nb
execute positioned ~ ~ ~1 run function agentcam:nb
execute positioned ~ ~ ~-1 run function agentcam:nb
