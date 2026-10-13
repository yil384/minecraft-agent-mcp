# one ring of agentcam:near (#np), 8 directions
scoreboard players set #rd agentcam_y 0
function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 450
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -450
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 900
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -900
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 1350
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -1350
execute if score #f agentcam_y matches 0 run function agentcam:near_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 1800
execute if score #f agentcam_y matches 0 run function agentcam:near_at
