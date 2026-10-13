# the spots behind: 2.3 (14) and 3.2 blocks (15). #p14 and #p15: the way to it open (the camera never stands in a
# block); #v14 and #v15: the bot seen from it, a straight line from its eyes and one from its shoulders to the spot
# through open blocks only (agentcam:sight; leaves block it, the camera draws them opaque). gc950fd: the bot two blocks
# down in a hole in a canopy top, the spot behind in the open over the leaves: a picture of leaves, the bot unseen.
scoreboard players set #p14 agentcam_y 0
scoreboard players set #p15 agentcam_y 0
scoreboard players set #v14 agentcam_y 0
scoreboard players set #v15 agentcam_y 0
execute as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 if block ^-0.3 ^0.2 ^-0.8 #agentcam:open if block ^-0.4 ^0.3 ^-1.5 #agentcam:open if block ^-0.5 ^0.45 ^-2.3 #agentcam:open run scoreboard players set #p14 agentcam_y 1
execute as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 if block ^-0.3 ^0.2 ^-0.8 #agentcam:open if block ^-0.4 ^0.3 ^-1.5 #agentcam:open if block ^-0.5 ^0.45 ^-2.3 #agentcam:open if block ^-0.6 ^0.55 ^-2.8 #agentcam:open if block ^-0.7 ^0.6 ^-3.2 #agentcam:open run scoreboard players set #p15 agentcam_y 1
execute unless entity @e[type=minecraft:marker,tag=agentcam_try] at @a[tag=agentcam_target,limit=1] run summon minecraft:marker ~ ~ ~ {Tags:["agentcam_try"]}
execute if score #p14 agentcam_y matches 1 as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 run tp @e[type=minecraft:marker,tag=agentcam_try,limit=1] ^-0.5 ^0.45 ^-2.3
execute if score #p14 agentcam_y matches 1 run scoreboard players set #sd agentcam_y 10
execute if score #p14 agentcam_y matches 1 run function agentcam:sight_try
execute if score #p14 agentcam_y matches 1 run scoreboard players operation #v14 agentcam_y = #so agentcam_y
execute if score #p15 agentcam_y matches 1 as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 run tp @e[type=minecraft:marker,tag=agentcam_try,limit=1] ^-0.7 ^0.6 ^-3.2
execute if score #p15 agentcam_y matches 1 run scoreboard players set #sd agentcam_y 14
execute if score #p15 agentcam_y matches 1 run function agentcam:sight_try
execute if score #p15 agentcam_y matches 1 run scoreboard players operation #v15 agentcam_y = #so agentcam_y
