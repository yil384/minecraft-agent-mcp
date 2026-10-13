# one angle of the ring: the camera's yaw turned by #rd tenths of a degree, 5 blocks out and 3.5 up
function agentcam:turn
execute as @a[tag=agentcam_target,limit=1] at @s rotated as @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] rotated ~ 0 positioned ^ ^3.5 ^-5 run function agentcam:good
execute if score #g agentcam_y matches 1 run scoreboard players operation #oa agentcam_y = #oc agentcam_y
execute if score #g agentcam_y matches 1 run scoreboard players set #od agentcam_y 3
execute if score #g agentcam_y matches 1 run scoreboard players set #on agentcam_y 1
execute if score #g agentcam_y matches 1 run function agentcam:to_spot
execute if score #g agentcam_y matches 1 run scoreboard players set #f agentcam_y 1
