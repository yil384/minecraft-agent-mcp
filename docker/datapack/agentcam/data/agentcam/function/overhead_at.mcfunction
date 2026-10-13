# a view from above at the agentcam_try marker (agentcam:overhead): #oc 1 when it has 0.4 blocks of open room around it
# and the bot is seen from it (agentcam:sight_try, #sd quarter-block steps)
scoreboard players set #oc agentcam_y 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~ ~ ~ #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~0.4 ~ ~ #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~-0.4 ~ ~ #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~ ~ ~0.4 #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~ ~ ~-0.4 #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~ ~0.4 ~ #agentcam:open run return 0
execute at @e[type=minecraft:marker,tag=agentcam_try,limit=1] unless block ~ ~-0.4 ~ #agentcam:open run return 0
function agentcam:sight_try
scoreboard players operation #oc agentcam_y = #so agentcam_y
