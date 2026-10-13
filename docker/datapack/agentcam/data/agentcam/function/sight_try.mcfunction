# the bot seen from the spot the agentcam_try marker stands at (agentcam:shoulder): #so 1 when a line from the bot's eyes
# and one from its shoulders (0.5 lower) reach it through open blocks (#sd quarter-block steps each, to about 0.4 short of
# the spot, whose own way agentcam:shoulder checked)
scoreboard players set #so agentcam_y 0
scoreboard players operation #sn agentcam_y = #sd agentcam_y
execute as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ facing entity @e[type=minecraft:marker,tag=agentcam_try,limit=1] feet run function agentcam:sight
execute if score #so agentcam_y matches 0 run return 0
scoreboard players set #so agentcam_y 0
scoreboard players operation #sn agentcam_y = #sd agentcam_y
scoreboard players add #sn agentcam_y 1
execute as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ positioned ~ ~-0.5 ~ facing entity @e[type=minecraft:marker,tag=agentcam_try,limit=1] feet run function agentcam:sight
