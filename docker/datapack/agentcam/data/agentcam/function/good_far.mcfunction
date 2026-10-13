# a spot for a view of the place from outside when no spot sees the shelter (agentcam:far): it and the air 0.4 around it
# open, 5.4 blocks or more from the bot, and its line toward the bot open for 4 blocks (a hillside, a canopy, the ground
# over a shelter dug in: never a block in front of the lens). #g 1 when it is; the spot is kept on the agentcam_spot marker.
scoreboard players set #g agentcam_y 0
execute unless block ~ ~ ~ #agentcam:open run return 0
execute unless block ~0.4 ~ ~ #agentcam:open run return 0
execute unless block ~-0.4 ~ ~ #agentcam:open run return 0
execute unless block ~ ~ ~0.4 #agentcam:open run return 0
execute unless block ~ ~ ~-0.4 #agentcam:open run return 0
execute unless block ~ ~0.4 ~ #agentcam:open run return 0
execute unless block ~ ~-0.4 ~ #agentcam:open run return 0
execute if entity @a[tag=agentcam_target,limit=1,distance=..5.4] run return 0
scoreboard players set #ls agentcam_y 72
scoreboard players set #lo agentcam_y 0
execute facing entity @a[tag=agentcam_target,limit=1] eyes run function agentcam:los
execute if score #lo agentcam_y matches 0 if score #ls agentcam_y matches ..79 run return 0
scoreboard players set #g agentcam_y 1
tp @e[type=minecraft:marker,tag=agentcam_spot,limit=1] ~ ~ ~
