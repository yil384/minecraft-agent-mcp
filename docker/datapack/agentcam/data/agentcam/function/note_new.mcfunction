# the evidence of the camera's spot, when the rule (#rl) or the eye's block changed since the last record: no line
# for a spot chosen again in the same place
execute store result score #ex agentcam_y run data get entity @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] Pos[0]
execute store result score #ey agentcam_y run data get entity @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] Pos[1]
execute store result score #ez agentcam_y run data get entity @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] Pos[2]
execute if score #rl agentcam_y = #lr agentcam_y if score #ex agentcam_y = #lx agentcam_y if score #ey agentcam_y = #ly agentcam_y if score #ez agentcam_y = #lz agentcam_y run return 0
scoreboard players operation #lr agentcam_y = #rl agentcam_y
scoreboard players operation #lx agentcam_y = #ex agentcam_y
scoreboard players operation #ly agentcam_y = #ey agentcam_y
scoreboard players operation #lz agentcam_y = #ez agentcam_y
function agentcam:note
