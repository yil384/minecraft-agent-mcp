# the camera turns after the bot instead of with it: each tick its yaw closes 30 % of the gap to the bot's (the short
# way round), so a snapped 180 degree turn becomes a quarter-second swing around the bot, never a cut through it
execute store result score #b agentcam_y run data get entity @a[tag=agentcam_target,limit=1] Rotation[0] 10
scoreboard players operation #d agentcam_y = #b agentcam_y
scoreboard players operation #d agentcam_y -= #c agentcam_y
scoreboard players add #d agentcam_y 1800
scoreboard players operation #d agentcam_y %= #3600 agentcam_y
scoreboard players remove #d agentcam_y 1800
scoreboard players operation #d agentcam_y *= #15 agentcam_y
scoreboard players operation #d agentcam_y /= #100 agentcam_y
scoreboard players operation #c agentcam_y += #d agentcam_y
scoreboard players operation #c agentcam_y %= #3600 agentcam_y
# the marker that holds it stays at the bot (a teleport with no rotation keeps its own); no other line touches it
execute unless entity @e[type=minecraft:marker,tag=agentcam_yaw] at @a[tag=agentcam_target,limit=1] run summon minecraft:marker ~ ~ ~ {Tags:["agentcam_yaw"]}
execute at @a[tag=agentcam_target,limit=1] run tp @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] ~ ~ ~
execute store result entity @e[type=minecraft:marker,tag=agentcam_yaw,limit=1] Rotation[0] float 0.1 run scoreboard players get #c agentcam_y
