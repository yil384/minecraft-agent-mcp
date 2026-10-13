# a fixed spot: kept while it stays good, turned to the bot; else a new spot.
# Every 10 s the ring is tried again (the orbit is livelier).
execute unless score #hv agentcam_y matches 2 as @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] at @s run function agentcam:good
execute if score #hv agentcam_y matches 2 as @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] at @s run function agentcam:good_far
execute if score #g agentcam_y matches 1 as @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] at @s run tp @s ~ ~ ~ facing entity @a[tag=agentcam_target,limit=1] eyes
execute if score #g agentcam_y matches 0 run scoreboard players set #on agentcam_y 0
scoreboard players add #hold agentcam_y 1
execute if score #hold agentcam_y matches 200.. run scoreboard players set #on agentcam_y 0
