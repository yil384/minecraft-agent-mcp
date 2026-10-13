# the orbit around an enclosed bot: 5 blocks out and 3.5 up, turned to the bot, 0.3 degrees a tick (a round a minute),
# only through good spots (agentcam:good); blocked one way it turns back; blocked both ways it stays while its own spot
# is good, else a new spot is chosen (agentcam:choose, in the same tick)
execute at @a[tag=agentcam_target,limit=1] run tp @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] ~ ~ ~
scoreboard players set #ok agentcam_y 0
function agentcam:orbit_step
execute if score #ok agentcam_y matches 0 run scoreboard players operation #od agentcam_y *= #m1 agentcam_y
execute if score #ok agentcam_y matches 0 run function agentcam:orbit_step
execute if score #ok agentcam_y matches 0 as @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] at @s run function agentcam:good
execute if score #ok agentcam_y matches 0 if score #g agentcam_y matches 1 as @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] at @s run tp @s ~ ~ ~ facing entity @a[tag=agentcam_target,limit=1] eyes
execute if score #ok agentcam_y matches 0 if score #g agentcam_y matches 0 run scoreboard players set #on agentcam_y 0
