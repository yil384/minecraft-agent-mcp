# a new eye at the bot's head, and the marker (server-only, never drawn) that holds the camera's smoothed yaw
kill @e[type=minecraft:marker,tag=agentcam_yaw]
summon minecraft:item_display ~ ~1.6 ~ {Tags:["agentcam_eye"],teleport_duration:3}
summon minecraft:marker ~ ~ ~ {Tags:["agentcam_yaw"]}
execute store result score #c agentcam_y run data get entity @a[tag=agentcam_target,limit=1] Rotation[0] 10
