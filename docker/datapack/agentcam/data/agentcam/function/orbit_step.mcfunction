# one step of the orbit in its direction: the next angle on the orbit marker; a good spot there: the eye goes there
scoreboard players operation #oc agentcam_y = #oa agentcam_y
scoreboard players operation #oc agentcam_y += #od agentcam_y
scoreboard players operation #oc agentcam_y += #3600 agentcam_y
scoreboard players operation #oc agentcam_y %= #3600 agentcam_y
execute store result entity @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] Rotation[0] float 0.1 run scoreboard players get #oc agentcam_y
execute as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^3.5 ^-5 run function agentcam:good
execute if score #g agentcam_y matches 1 run scoreboard players set #ok agentcam_y 1
execute if score #ok agentcam_y matches 1 run scoreboard players operation #oa agentcam_y = #oc agentcam_y
execute if score #ok agentcam_y matches 1 run function agentcam:to_spot
