# what the camera rides: the eye in third person (agentcam_third), and in first person while the bot is enclosed;
# otherwise the bot's head (and while it is enclosed with no spot outside). Every 5 s the ride is asked for again (a client that reconnected lost it).
scoreboard players add #t agentcam_t 1
execute if score #t agentcam_t matches 100.. run tag @a[tag=agentcam] remove agentcam_ineye
execute if score #t agentcam_t matches 100.. run tag @a[tag=agentcam] remove agentcam_inhead
execute if score #t agentcam_t matches 100.. run scoreboard players set #t agentcam_t 0
# enclosed with no spot outside (agentcam:deep): through the bot's own eyes
execute if entity @a[tag=agentcam_target,tag=agentcam_shut,tag=agentcam_deep] as @a[tag=agentcam,tag=!agentcam_inhead] run function agentcam:to_head
execute if entity @a[tag=agentcam_target,tag=agentcam_shut,tag=agentcam_deep] run return 0
execute as @a[tag=agentcam,tag=agentcam_third,tag=!agentcam_ineye] run function agentcam:to_eye
execute if entity @a[tag=agentcam_target,tag=agentcam_shut] as @a[tag=agentcam,tag=!agentcam_third,tag=!agentcam_ineye] run function agentcam:to_eye
execute unless entity @a[tag=agentcam_target,tag=agentcam_shut] as @a[tag=agentcam,tag=!agentcam_third,tag=!agentcam_inhead] run function agentcam:to_head
