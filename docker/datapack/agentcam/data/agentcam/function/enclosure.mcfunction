# enclosed: a roof right above the bot's head (neither open nor leaves; a portal block counts as open: a bot waiting
# in a portal stays over the shoulder) and walls on all four sides at head height (a closed shelter, a sealed hole).
# A tunnel or a shaft is not enclosed: its open side or top is where the camera follows from. A second of it before
# the view changes, a second without it before it changes back.
scoreboard players set @a[tag=agentcam_target] agentcam_t 0
execute as @a[tag=agentcam_target] at @s unless block ~ ~2 ~ #agentcam:open unless block ~ ~2 ~ #minecraft:leaves unless block ~1 ~1 ~ #agentcam:open unless block ~-1 ~1 ~ #agentcam:open unless block ~ ~1 ~1 #agentcam:open unless block ~ ~1 ~-1 #agentcam:open run scoreboard players set @s agentcam_t 1
execute as @a[tag=agentcam_target,scores={agentcam_t=1}] run scoreboard players add @s agentcam_enc 1
execute as @a[tag=agentcam_target,scores={agentcam_t=1}] run scoreboard players set @s agentcam_open 0
execute as @a[tag=agentcam_target,scores={agentcam_t=0}] run scoreboard players add @s agentcam_open 1
execute as @a[tag=agentcam_target,scores={agentcam_open=1..}] run scoreboard players set @s agentcam_enc 0
execute as @a[tag=agentcam_target,scores={agentcam_enc=20..}] run tag @s add agentcam_shut
execute as @a[tag=agentcam_target,scores={agentcam_open=20..}] run tag @s remove agentcam_shut
scoreboard players set @a[scores={agentcam_enc=100..}] agentcam_enc 100
scoreboard players set @a[scores={agentcam_open=100..}] agentcam_open 100
