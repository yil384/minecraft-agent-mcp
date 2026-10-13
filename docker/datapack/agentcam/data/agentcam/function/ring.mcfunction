# the orbit's ring: 8 angles from behind the bot (the camera's yaw), turning out both ways; the first good one starts
# the orbit there
scoreboard players set #rd agentcam_y 0
function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 450
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -450
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 900
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -900
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 1350
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y -1350
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
execute if score #f agentcam_y matches 0 run scoreboard players set #rd agentcam_y 1800
execute if score #f agentcam_y matches 0 run function agentcam:ring_at
