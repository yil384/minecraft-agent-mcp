# enclosed with room inside (a hut, not a one-block cell): a spot behind the bot inside it, only while the way to it is
# open and the bot is seen from it (agentcam:behind: both lines, eyes and shoulders); #in the spot taken (14, 15), 0 for
# none: then the views from outside (agentcam:outside)
scoreboard players set #in agentcam_y 0
function agentcam:behind
execute if score #p14 agentcam_y matches 1 if score #v14 agentcam_y matches 1 as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 run tp @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] ^-0.5 ^0.45 ^-2.3 facing ^ ^ ^12
execute if score #p14 agentcam_y matches 1 if score #v14 agentcam_y matches 1 run scoreboard players set #in agentcam_y 14
execute if score #p15 agentcam_y matches 1 if score #v15 agentcam_y matches 1 as @a[tag=agentcam_target,limit=1] at @s anchored eyes positioned ^ ^ ^ rotated as @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] rotated ~ 20 run tp @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] ^-0.7 ^0.6 ^-3.2 facing ^ ^ ^12
execute if score #p15 agentcam_y matches 1 if score #v15 agentcam_y matches 1 run scoreboard players set #in agentcam_y 15
# the evidence: rule 24 once when the view goes inside
execute if score #in agentcam_y matches 14.. unless score #rl agentcam_y matches 24 run function agentcam:note_inside
