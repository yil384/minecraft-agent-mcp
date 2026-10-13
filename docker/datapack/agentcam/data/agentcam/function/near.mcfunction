# the nearest good spot within 8 blocks: rings 3 to 8 blocks out (1.5 to 5 up, 5.4 blocks or more away), nearest first, each from
# behind the bot turning out both ways; the eye stays there (agentcam:hold)
scoreboard players set #np agentcam_y 1
function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 2
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 3
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 4
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 5
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 6
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 0 run scoreboard players set #np agentcam_y 7
execute if score #f agentcam_y matches 0 run function agentcam:near_dirs
execute if score #f agentcam_y matches 1 run scoreboard players set #on agentcam_y 2
execute if score #f agentcam_y matches 1 run scoreboard players set #hv agentcam_y 0
